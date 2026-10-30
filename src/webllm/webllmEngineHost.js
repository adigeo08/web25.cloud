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
 *   { type: 'load', profile? }           download if needed, then initialise the
 *                                        profile's model with its context window and
 *                                        reply limit
 *   { type: 'chat', messages, maxTokens?, schema? }   one streamed chat completion;
 *                                        with a JSON schema, constrained to it
 *   { type: 'continue', messages, partial, maxTokens? }  more of a reply cut at
 *                                        the length limit, appended to it
 *
 * A request's `maxTokens` can only shorten a reply: the profile's own limit,
 * when it has one, still applies.
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
    WEBLLM_CONTEXT_WINDOW,
    WEBLLM_LIBRARY_INTEGRITY,
    WEBLLM_LIBRARY_URL,
    chatOptionsFor,
    createAppConfig,
    getWebLLMModel
} from './webllmConfig.js';
import { asksForRepetition, createLoopGuard } from './webllmLoopGuard.js';
import { formatContinuationPrompt } from './webllmPromptFormat.js';

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
 * The model and memory settings a `load` asked for, reduced to values WebLLM
 * accepts. A missing or malformed profile is the desktop one: the default never
 * shrinks, and a model that is not in `WEBLLM_MODELS` is Llama.
 *
 * @param {any} profile
 * @returns {{ model: import('./webllmConfig.js').WebLLMModelKey, contextWindow: number, maxTokens: number|null }}
 */
export function sanitizeProfile(profile) {
    const window = Number(profile?.contextWindow);
    const contextWindow =
        Number.isInteger(window) && window >= 512 && window <= WEBLLM_CONTEXT_WINDOW ? window : WEBLLM_CONTEXT_WINDOW;
    const tokens = Number(profile?.maxTokens);
    const maxTokens = Number.isInteger(tokens) && tokens > 0 && tokens < contextWindow ? tokens : null;
    return { model: getWebLLMModel(profile?.model).key, contextWindow, maxTokens };
}

/**
 * The reply limit for one request: the shorter of the profile's and the
 * request's, either of which may be absent.
 * @param {number|null} profileLimit
 * @param {any} requested
 * @returns {number|null}
 */
export function replyLimit(profileLimit, requested) {
    const asked = Number(requested);
    const valid = Number.isInteger(asked) && asked > 0 ? asked : null;
    if (profileLimit && valid) return Math.min(profileLimit, valid);
    return profileLimit || valid;
}

/**
 * WebLLM's `response_format` for a JSON schema: the schema as a string, which
 * is how its grammar compiler takes it. Anything that is not a plain object is
 * no schema.
 * @param {any} schema
 */
export function jsonResponseFormat(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
    return { type: 'json_object', schema: JSON.stringify(schema) };
}

/**
 * @param {{ post: (message: any) => void,
 *           loadLibrary?: () => Promise<any>,
 *           modelId?: string|null,
 *           appConfig?: any,
 *           chatOptions?: Record<string, number>|null }} options
 *   `modelId`, `appConfig` and `chatOptions` replace what the profile's model
 *   would use; by default they are that model's own.
 */
export function createEngineHost({
    post,
    loadLibrary = () => loadWebLLMLibrary(),
    modelId = null,
    appConfig = null,
    chatOptions = null
}) {
    /** The profile the engine was loaded with; fixed until it is unloaded. */
    let limits = sanitizeProfile(null);
    /** A fully loaded engine, or null. */
    let engine = null;
    /** The engine while `reload` is still running, so `unload` can abort it. */
    let loadingEngine = null;
    /** @type {Promise<void>|null} */
    let loading = null;
    let generating = false;
    /**
     * Stop was asked for during this generation. WebLLM clears its own
     * interrupt flag when a stream starts, so an interrupt that lands while
     * `create()` is still setting up would be lost; this one is re-applied
     * on every chunk until the stream ends.
     */
    let interruptRequested = false;

    const reply = (requestId, value) => post({ type: 'result', requestId, ok: true, value });
    const fail = (requestId, error) => post({ type: 'result', requestId, ok: false, error: serializeError(error) });

    /** @param {any} profile */
    async function load(profile) {
        if (engine) return { alreadyLoaded: true, ...limits };
        // Two loads at once share one download: WebLLM would otherwise fetch
        // every shard twice and fight over the GPU.
        if (!loading) {
            limits = sanitizeProfile(profile);
            const model = getWebLLMModel(limits.model);
            loading = (async () => {
                const webllm = await loadLibrary();
                const candidate = new webllm.MLCEngine({
                    appConfig: appConfig || createAppConfig(limits.contextWindow, model),
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
                    // As chat.webllm.ai does it: the sampling settings become the
                    // model's chat config here, once, instead of riding on each request.
                    // The context window is set here, at initialisation: the KV
                    // cache is allocated for it, so a smaller one is less memory.
                    await candidate.reload(modelId || model.modelId, {
                        ...(chatOptions || chatOptionsFor(model)),
                        context_window_size: limits.contextWindow
                    });
                } finally {
                    loadingEngine = null;
                }
                engine = candidate;
            })().finally(() => {
                loading = null;
            });
        }
        await loading;
        return { alreadyLoaded: false, ...limits };
    }

    /**
     * Stream one reply: post its text as it comes, stop it if it loops, and
     * report how it ended. `partial` is text the reply already had (a
     * continuation): the loop guard reads it too, so a continuation that
     * starts repeating the reply is caught, but it is never cut.
     *
     * @param {number} requestId
     * @param {AsyncIterable<any>} stream
     * @param {{ allowRepeats: boolean, partial?: string }} options
     */
    async function streamReply(requestId, stream, { allowRepeats, partial = '' }) {
        const guard = createLoopGuard({ allowRepeats });
        if (partial) guard.push(partial);

        let finishReason = null;
        let usage = null;
        /** @type {import('./webllmLoopGuard.js').LoopVerdict|null} */
        let loop = null;
        for await (const chunk of stream) {
            if (interruptRequested) void engine.interruptGenerate();
            const choice = chunk?.choices?.[0];
            // Chat chunks carry `delta.content`; text-completion chunks carry `text`.
            const text = choice?.delta?.content ?? choice?.text;
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
        if (loop) {
            return {
                finishReason: 'loop',
                keepChars: Math.max(loop.keepChars, partial.length),
                loopKind: loop.reason,
                usage
            };
        }
        return { finishReason, usage };
    }

    /** @param {{ role: string, content: string }[]} messages */
    const lastUserText = (messages) => [...messages].reverse().find((message) => message.role === 'user')?.content;

    async function chat(requestId, messages, requestedMax, schema) {
        if (!engine) throw new Error('The model is not loaded.');
        if (generating) throw new Error('A reply is already being generated.');
        generating = true;
        interruptRequested = false;
        try {
            // What the official client sends — the messages and a stream —
            // with sampling from the chat config set at reload. The mobile
            // profile caps the reply; desktop leaves it to the end-of-turn
            // token — unless the request itself asks for a short reply.
            const maxTokens = replyLimit(limits.maxTokens, requestedMax);
            const responseFormat = jsonResponseFormat(schema);
            const stream = await engine.chat.completions.create({
                messages,
                stream: true,
                stream_options: { include_usage: true },
                ...(maxTokens ? { max_tokens: maxTokens } : {}),
                ...(responseFormat ? { response_format: responseFormat } : {})
            });
            // Somebody asking for the same line five times is not a loop; nor
            // is a grammar-constrained answer, which is short and structured.
            return await streamReply(requestId, stream, {
                allowRepeats: Boolean(responseFormat) || asksForRepetition(lastUserText(messages))
            });
        } finally {
            generating = false;
        }
    }

    /**
     * Continue a reply in place: a text completion whose prompt ends inside
     * the unfinished assistant turn (see webllmPromptFormat.js). The same
     * sampling, stop tokens and reply limit apply.
     *
     * @param {number} requestId
     * @param {{ role: string, content: string }[]} messages system first, ending on the question
     * @param {string} partial
     * @param {any} [requestedMax]
     */
    async function continueReply(requestId, messages, partial, requestedMax) {
        if (!engine) throw new Error('The model is not loaded.');
        if (generating) throw new Error('A reply is already being generated.');
        if (typeof partial !== 'string' || !partial) throw new Error('There is no reply to continue.');
        generating = true;
        interruptRequested = false;
        try {
            const maxTokens = replyLimit(limits.maxTokens, requestedMax);
            const stream = await engine.completions.create({
                prompt: formatContinuationPrompt(messages, partial, getWebLLMModel(limits.model).chatTemplate),
                stream: true,
                stream_options: { include_usage: true },
                ...(maxTokens ? { max_tokens: maxTokens } : {})
            });
            return await streamReply(requestId, stream, {
                allowRepeats: asksForRepetition(lastUserText(messages)),
                partial
            });
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
                    reply(requestId, await load(message.profile));
                    break;
                case 'chat':
                    reply(requestId, await chat(requestId, message.messages, message.maxTokens, message.schema));
                    break;
                case 'continue':
                    reply(
                        requestId,
                        await continueReply(requestId, message.messages, message.partial, message.maxTokens)
                    );
                    break;
                case 'interrupt':
                    if (generating) interruptRequested = true;
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
