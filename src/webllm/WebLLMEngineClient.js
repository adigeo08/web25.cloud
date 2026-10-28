// @ts-check
/**
 * The page's handle on the WebLLM engine.
 *
 * Inference runs in a dedicated module worker wherever the browser exposes
 * WebGPU to workers. Where it does not, the very same engine host runs on the
 * page behind the same messages: slower to keep the page responsive, but the
 * chat still works. The controller only ever sees this client.
 *
 * Which of the two is used is decided once and remembered by the controller
 * (with the chat's settings): a worker that reported no real GPU (none at all,
 * or only CPU emulation) is not tried again on the next load, so the engine
 * does not alternate between a worker that got the CPU and a page that got
 * the GPU. Only a worker that answered — never one that was merely slow —
 * decides that.
 */

import { createEngineHost } from './webllmEngineHost.js';

const WORKER_HELLO_TIMEOUT_MS = 10000;

/**
 * @typedef {{ post: (message: any) => void,
 *             onMessage: (handler: (message: any) => void) => void,
 *             onCrash: (handler: (error: { name: string, message: string }) => void) => void,
 *             terminate: () => void,
 *             kind: 'worker'|'page' }} EngineTransport
 */

/**
 * Start the dedicated worker and wait for it to say whether it has a real GPU.
 * Resolves null when there is no worker to be had; `onNoGpu` is called when
 * the worker answered and said so (as opposed to not answering in time).
 *
 * @param {() => Worker} [factory]
 * @param {{ onNoGpu?: () => void }} [options]
 * @returns {Promise<EngineTransport|null>}
 */
export function createWorkerTransport(
    factory = () =>
        new Worker(new URL('./webllm-worker.js', import.meta.url), { type: 'module', name: 'web25-webllm' }),
    { onNoGpu = () => {} } = {}
) {
    /** @type {Worker} */
    let worker;
    try {
        // Throws where there are no module workers at all.
        worker = factory();
    } catch (_) {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        /** @type {((message: any) => void)|null} */
        let handler = null;
        /** @type {((error: any) => void)|null} */
        let crashHandler = null;
        let settled = false;

        const settle = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!value) worker.terminate();
            resolve(value);
        };
        const timer = setTimeout(() => settle(null), WORKER_HELLO_TIMEOUT_MS);

        worker.addEventListener('message', (event) => {
            const message = event.data;
            if (!settled) {
                if (message?.type !== 'hello') return;
                // A worker without a real GPU is no use for inference; the page
                // may still have one, and the caller falls back to that.
                if (!message.webgpu || message.adapter === false || message.fallbackAdapter) {
                    onNoGpu();
                    return settle(null);
                }
                return settle({
                    kind: 'worker',
                    post: (outbound) => worker.postMessage(outbound),
                    onMessage: (next) => {
                        handler = next;
                    },
                    onCrash: (next) => {
                        crashHandler = next;
                    },
                    terminate: () => worker.terminate()
                });
            }
            handler?.(message);
        });

        worker.addEventListener('error', (event) => {
            if (!settled) return settle(null);
            event?.preventDefault?.();
            crashHandler?.({
                name: 'WorkerCrashed',
                message: 'The AI worker stopped unexpectedly. The device may have run out of memory.'
            });
        });
    });
}

/**
 * The fallback: the engine host on the page itself.
 * @param {(options: { post: (message: any) => void }) => { handle: (message: any) => Promise<void> }} [hostFactory]
 * @returns {EngineTransport}
 */
export function createPageTransport(hostFactory = createEngineHost) {
    /** @type {((message: any) => void)|null} */
    let handler = null;
    let terminated = false;
    const host = hostFactory({
        post: (message) => {
            if (!terminated) queueMicrotask(() => handler?.(message));
        }
    });
    return {
        kind: 'page',
        post: (message) => {
            if (!terminated) void host.handle(message);
        },
        onMessage: (next) => {
            handler = next;
        },
        onCrash: () => {},
        terminate: () => {
            if (terminated) return;
            // No thread to kill: unloading is what frees the GPU here.
            void host.handle({ type: 'unload' });
            terminated = true;
        }
    };
}

export class WebLLMEngineClient {
    /** @param {EngineTransport} transport */
    constructor(transport) {
        this.transport = transport;
        this.kind = transport.kind;
        this.nextId = 1;
        /** @type {Map<number, { resolve: Function, reject: Function, onDelta?: (text: string) => void }>} */
        this.pending = new Map();
        /** @type {((report: any) => void)|null} */
        this.onProgress = null;
        this.disposed = false;
        /** Set by `createEngineClient` when the worker answered without a real GPU. */
        this.workerHasNoGpu = false;

        transport.onMessage((message) => this.receive(message));
        transport.onCrash((error) => this.rejectAll(error));
    }

    receive(message) {
        if (!message || this.disposed) return;
        if (message.type === 'progress') {
            this.onProgress?.(message);
            return;
        }
        const entry = this.pending.get(message.requestId);
        if (!entry) return;
        if (message.type === 'delta') {
            entry.onDelta?.(message.text);
            return;
        }
        if (message.type === 'result') {
            this.pending.delete(message.requestId);
            if (message.ok) entry.resolve(message.value);
            else entry.reject(Object.assign(new Error(message.error?.message), { name: message.error?.name }));
        }
    }

    rejectAll(error) {
        const failure = Object.assign(new Error(error?.message || 'The AI engine stopped.'), {
            name: error?.name || 'Error'
        });
        for (const entry of this.pending.values()) entry.reject(failure);
        this.pending.clear();
    }

    request(type, payload = {}, onDelta) {
        if (this.disposed) {
            return Promise.reject(Object.assign(new Error('The AI engine was released.'), { name: 'AbortError' }));
        }
        const requestId = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject, onDelta });
            this.transport.post({ type, requestId, ...payload });
        });
    }

    /**
     * @param {(report: { progress: number, text: string, timeElapsed: number }) => void} onProgress
     * @param {{ contextWindow: number, maxTokens: number|null }} [profile] the memory profile to load with
     */
    load(onProgress, profile) {
        this.onProgress = onProgress;
        return this.request(
            'load',
            profile ? { profile: { contextWindow: profile.contextWindow, maxTokens: profile.maxTokens } } : {}
        );
    }

    /**
     * @param {{ role: string, content: string }[]} messages
     * @param {(text: string) => void} onDelta
     * @param {{ maxTokens?: number|null, schema?: object|null }} [options] a shorter reply limit for this
     *   request, and a JSON schema the reply must follow
     */
    chat(messages, onDelta, { maxTokens = null, schema = null } = {}) {
        return this.request(
            'chat',
            { messages, ...(maxTokens ? { maxTokens } : {}), ...(schema ? { schema } : {}) },
            onDelta
        );
    }

    /**
     * Continue a reply in place; `onDelta` receives only the new text.
     * @param {{ role: string, content: string }[]} messages system first, ending on the question
     * @param {string} partial the reply so far
     * @param {(text: string) => void} onDelta
     * @param {{ maxTokens?: number|null }} [options]
     */
    continue(messages, partial, onDelta, { maxTokens = null } = {}) {
        return this.request('continue', maxTokens ? { messages, partial, maxTokens } : { messages, partial }, onDelta);
    }

    interrupt() {
        if (!this.disposed) this.transport.post({ type: 'interrupt' });
    }

    /**
     * Release everything on the GPU. A worker is terminated outright, which is
     * the one way to be sure its device is gone; the downloaded weights are in
     * Cache Storage and are not touched.
     */
    dispose() {
        if (this.disposed) return;
        this.rejectAll({ name: 'AbortError', message: 'The AI engine was released.' });
        this.disposed = true;
        this.onProgress = null;
        this.transport.terminate();
    }
}

/**
 * A client on the dedicated worker where possible, on the page otherwise —
 * and on the page straight away where the worker already said it has no GPU.
 * The client's `workerHasNoGpu` says whether that was found out just now, so
 * the caller can remember it.
 *
 * @param {{ workerTransport?: (options: { onNoGpu: () => void }) => Promise<EngineTransport|null>,
 *           pageTransport?: () => EngineTransport,
 *           preferred?: 'worker'|'page'|null }} [factories]
 */
export async function createEngineClient({
    workerTransport = (options) => createWorkerTransport(undefined, options),
    pageTransport = () => createPageTransport(),
    preferred = null
} = {}) {
    let transport = null;
    let workerHasNoGpu = false;
    if (preferred !== 'page') {
        transport = await workerTransport({
            onNoGpu: () => {
                workerHasNoGpu = true;
            }
        });
    }
    const client = new WebLLMEngineClient(transport || pageTransport());
    client.workerHasNoGpu = workerHasNoGpu;
    return client;
}
