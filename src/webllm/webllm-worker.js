// @ts-check
/**
 * The dedicated WebLLM inference worker.
 *
 * WebGPU work, tokenisation and generation all happen here, off the page's
 * main thread. It holds no wallet state and talks to nothing but the page that
 * started it; terminating it releases the GPU device and everything on it.
 *
 * The first message says whether WebGPU is reachable from a worker in this
 * browser, so the page can fall back to running the engine itself where it is
 * not.
 */

import { createEngineHost } from './webllmEngineHost.js';

const scope = /** @type {any} */ (self);

const host = createEngineHost({ post: (message) => scope.postMessage(message) });

scope.addEventListener('message', (event) => {
    void host.handle(event.data);
});

scope.postMessage({ type: 'hello', webgpu: Boolean(scope.navigator?.gpu) });
