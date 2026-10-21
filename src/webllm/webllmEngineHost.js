// @ts-check
/**
 * The WebLLM engine, behind a message protocol.
 *
 * This is the only code that touches WebLLM itself, and it runs in the
 * dedicated inference worker (`webllm-worker.js`). Where a browser cannot run
 * WebGPU inside a worker, the same host runs on the page instead, behind the
 * same messages — so the controller never knows or cares which it got.
 *
 * Inbound (all carry a `requestId` the reply echoes):
 *   { type: 'load' }                     download if needed, then initialise
 *   { type: 'chat', messages, options }  one streamed chat completion
 *   { type: 'interrupt' }                stop the current generation
 *   { type: 'unload' }                   release the GPU; the cache stays
 *
 * Outbound:
 *   { type: 'progress', progress, text, timeElapsed }
 *   { type: 'delta', requestId, text }
 *   { type: 'result', requestId, ok: true, value } | { …, ok: false, error: { name, message } }
 *
 * A chat result's `finishReason` is WebLLM's (`stop`, `length`, or `abort` for
 * the user's Stop) or `loop`, when the loop guard ended the reply itself — with
 * `keepChars`, how much of the text to keep.
 *
 * Never imported by a service worker: inference does not run there.
 */

import {
    WEBLLM_ASSET_CACHE,
    WEBLLM_GENERATION,
    WEBLLM_LIBRARY_INTEGRITY,
    WEBLLM_LIBRARY_URL,
    WEBLLM_MODEL_ID,
    createAppConfig
} from './webllmConfig.js';
import { asksForRepetition, createLoopGuard } from './webllmLoopGuard.js';

/**
 * Compare bytes against an SRI string (`sha384-…`).
 * @param {ArrayBuffer} bytes
 * @param {string} integrity
 */
export async function matchesIntegrity(bytes, integrity) {
    const [algorithm, expected] = `${integrity}`.split('-', 2);
    const name = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[algorithm];
    if (!name || !expected) return false;
    const digest = new Uint8Array(await crypto.subtle.digest(name, bytes));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary) === expected;
}

/**
 * Fetch the WebLLM library and import it.
 *
 * The WebLLM service worker keeps a verified copy in its own cache, and that
 * copy is read first, so a second session does not download 6 MB of
 * JavaScript again. Without it (no service worker, or not prepared yet) the
 * file comes from jsDelivr. Either way the bytes are checked against the
 * pinned hash before a single line of them runs.
 *
 * @param {{ url?: string, integrity?: string, cacheName?: string,
 *           importer?: (url: string) => Promise<any> }} [options]
 */
export async function loadWebLLMLibrary({
    url = WEBLLM_LIBRARY_URL,
    integrity = WEBLLM_LIBRARY_INTEGRITY,
    cacheName = WEBLLM_ASSET_CACHE,
    importer = (moduleUrl) => import(moduleUrl)
} = {}) {
    /** @type {ArrayBuffer|null} */
    let bytes = null;

    if (typeof caches !== 'undefined') {
        try {
            // `has` first: opening a cache that does not exist would create it.
            if (await caches.has(cacheName)) {
                const hit = await (await caches.open(cacheName)).match(url);
                if (hit) bytes = await hit.arrayBuffer();
            }
        } catch (_) {
            bytes = null;
        }
    }

    if (bytes && !(await matchesIntegrity(bytes, integrity))) bytes = null;

    if (!bytes) {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error(`WebLLM library download failed (status ${response.status})`);
        bytes = await response.arrayBuffer();
        if (!(await matchesIntegrity(bytes, integrity))) {
            throw new Error('The WebLLM library did not match its pinned integrity hash and was not loaded.');
        }
    }

    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
    try {
        return await importer(blobUrl);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

/** Errors cross a thread boundary as plain data. */
function serializeError(error) {
    return {
        name: `${error?.name || 'Error'}`,
        message: `${error?.message || error || 'Unknown error'}`
    };
}

/**
 * The sampling settings for one request: the pinned defaults, with any number
 * the caller supplied for a known setting laid over them. Unknown keys are
 * ignored, so the request WebLLM sees can only carry values it validates.
 *
 * @param {Record<string, any>} [options]
 */
export function generationParams(options = {}) {
    /** @type {Record<string, number>} */
    const params = { ...WEBLLM_GENERATION };
    for (const key of Object.keys(params)) {
        const value = options?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    }
    return params;
}

/**
 * @param {{ post: (message: any) => void,
 *           loadLibrary?: () => Promise<any>,
 *           modelId?: string,
 *           appConfig?: any }} options
 */
export function createEngineHost({
    post,
    loadLibrary = () => loadWebLLMLibrary(),
    modelId = WEBLLM_MODEL_ID,
    appConfig = createAppConfig()
}) {
    /** A fully loaded engine, or null. */
    let engine = null;
    /** The engine while `reload` is still running, so `unload` can abort it. */
    let loadingEngine = null;
    /** @type {Promise<void>|null} */
    let loading = null;
    let generating = false;

    const reply = (requestId, value) => post({ type: 'result', requestId, ok: true, value });
    const fail = (requestId, error) => post({ type: 'result', requestId, ok: false, error: serializeError(error) });

    async function load() {
        if (engine) return { alreadyLoaded: true };
        // Two loads at once share one download: WebLLM would otherwise fetch
        // every shard twice and fight over the GPU.
        if (!loading) {
            loading = (async () => {
                const webllm = await loadLibrary();
                const candidate = new webllm.MLCEngine({
                    appConfig,
                    initProgressCallback: (report) =>
                        post({
                            type: 'progress',
                            progress: Number(report?.progress) || 0,
                            text: `${report?.text || ''}`,
                            timeElapsed: Number(report?.timeElapsed) || 0
                        })
                });
                loadingEngine = candidate;
                try {
                    await candidate.reload(modelId);
                } finally {
                    loadingEngine = null;
                }
                engine = candidate;
            })().finally(() => {
                loading = null;
            });
        }
        await loading;
        return { alreadyLoaded: false };
    }

    async function chat(requestId, messages, options = {}) {
        if (!engine) throw new Error('The model is not loaded.');
        if (generating) throw new Error('A reply is already being generated.');
        generating = true;
        try {
            const stream = await engine.chat.completions.create({
                messages,
                stream: true,
                stream_options: { include_usage: true },
                ...generationParams(options)
            });

            // Somebody asking for the same line five times is not a loop.
            const lastUser = [...messages].reverse().find((message) => message.role === 'user');
            const guard = createLoopGuard({ allowRepeats: asksForRepetition(lastUser?.content) });

            let finishReason = null;
            let usage = null;
            /** @type {import('./webllmLoopGuard.js').LoopVerdict|null} */
            let loop = null;
            for await (const chunk of stream) {
                const choice = chunk?.choices?.[0];
                const text = choice?.delta?.content;
                // After a loop is found the stream is only drained: WebLLM ends
                // it once the interrupt lands, and nothing more is shown.
                if (text && !loop) {
                    loop = guard.push(text);
                    if (loop) void engine.interruptGenerate();
                    else post({ type: 'delta', requestId, text });
                }
                if (choice?.finish_reason) finishReason = choice.finish_reason;
                if (chunk?.usage) usage = chunk.usage;
            }

            // The engine reports its own interrupt as `abort`, which is what a
            // user pressing Stop gets too; `loop` is how the page tells them apart.
            if (loop) return { finishReason: 'loop', keepChars: loop.keepChars, loopKind: loop.reason, usage };
            return { finishReason, usage };
        } finally {
            generating = false;
        }
    }

    async function unload() {
        const current = engine || loadingEngine;
        engine = null;
        loadingEngine = null;
        if (current) await current.unload();
    }

    /** @param {any} message */
    async function handle(message) {
        const { type, requestId } = message || {};
        try {
            switch (type) {
                case 'load':
                    reply(requestId, await load());
                    break;
                case 'chat':
                    reply(requestId, await chat(requestId, message.messages, message.options));
                    break;
                case 'interrupt':
                    engine?.interruptGenerate();
                    if (requestId !== undefined) reply(requestId, { interrupted: generating });
                    break;
                case 'unload':
                    await unload();
                    if (requestId !== undefined) reply(requestId, { unloaded: true });
                    break;
                default:
                    if (requestId !== undefined) fail(requestId, new Error(`Unknown request: ${type}`));
            }
        } catch (error) {
            fail(requestId, error);
        }
    }

    return { handle };
}
