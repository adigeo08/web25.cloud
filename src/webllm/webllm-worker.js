// @ts-check
/**
 * The dedicated WebLLM inference worker.
 *
 * WebGPU work, tokenisation and generation all happen here, off the page's
 * main thread. It holds no wallet state and talks to nothing but the page that
 * started it; terminating it releases the GPU device and everything on it.
 *
 * The first message says whether a real GPU is reachable from a worker in this
 * browser — an adapter is requested with the same options the page uses, and a
 * CPU-emulated (fallback) one does not count — so the page can run the engine
 * itself where the worker would only get the CPU.
 */

import { createEngineHost } from './webllmEngineHost.js';
import { WEBLLM_ADAPTER_OPTIONS, isFallbackAdapter } from './webgpuSupport.js';

const scope = /** @type {any} */ (self);

const host = createEngineHost({ post: (message) => scope.postMessage(message) });

scope.addEventListener('message', (event) => {
    void host.handle(event.data);
});

async function probeAdapter() {
    const gpu = scope.navigator?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
        return { webgpu: false, adapter: false, fallbackAdapter: false };
    }
    try {
        const adapter = await gpu.requestAdapter({ ...WEBLLM_ADAPTER_OPTIONS });
        return { webgpu: true, adapter: Boolean(adapter), fallbackAdapter: isFallbackAdapter(adapter) };
    } catch (_) {
        return { webgpu: true, adapter: false, fallbackAdapter: false };
    }
}

void probeAdapter().then((probe) => scope.postMessage({ type: 'hello', ...probe }));
