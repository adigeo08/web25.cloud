// @ts-check
/**
 * Can this device run Llama in the browser?
 *
 * Asks for a WebGPU adapter and reads its limits. An adapter is only a
 * description of the GPU: no device is created and nothing is allocated, so
 * this is safe to run when the WebLLM tab opens. The engine creates the real
 * device later, in its worker, and only after Install.
 *
 * Llama runs on the GPU or not at all. A fallback adapter is WebGPU emulated
 * on the CPU (SwiftShader and the like): a 1B model on it is unusably slow,
 * and a browser that hands one out on some loads and the real GPU on others
 * made the chat switch between the two. So the real GPU is asked for, the
 * request is not allowed to settle for a fallback, and if a fallback is all
 * there is the device is reported unsupported rather than run on the CPU.
 */

/** The one adapter request every WebLLM probe makes: the page, the worker, the engine. */
export const WEBLLM_ADAPTER_OPTIONS = Object.freeze({
    powerPreference: 'high-performance',
    forceFallbackAdapter: false
});

export const FALLBACK_ADAPTER_REASON =
    'Only a software (CPU) WebGPU adapter is available here, which is far too slow for Llama. ' +
    'Enable hardware acceleration in the browser settings, or update the GPU driver, and reload.';

/** Whether an adapter is CPU emulation rather than a GPU. */
export function isFallbackAdapter(adapter) {
    return Boolean(adapter?.isFallbackAdapter || adapter?.info?.isFallbackAdapter);
}

/**
 * @typedef {{ supported: boolean, reason: string|null, vendor: string, description: string,
 *             shaderF16: boolean, maxBufferMB: number|null, fallbackAdapter: boolean }} WebGPUSupport
 */

/**
 * @param {any} [nav]
 * @returns {Promise<WebGPUSupport>}
 */
export async function detectWebGPU(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
    const unsupported = (reason) => ({
        supported: false,
        reason,
        vendor: '',
        description: '',
        shaderF16: false,
        maxBufferMB: null,
        fallbackAdapter: false
    });

    if (!nav?.gpu || typeof nav.gpu.requestAdapter !== 'function') {
        return unsupported('WebGPU is not available in this browser.');
    }

    let adapter = null;
    try {
        adapter = await nav.gpu.requestAdapter({ ...WEBLLM_ADAPTER_OPTIONS });
    } catch (error) {
        return unsupported(`WebGPU adapter request failed: ${error?.message || error}`);
    }
    if (!adapter) {
        return unsupported('No compatible GPU was found. WebGPU may be disabled or blocked on this device.');
    }

    if (isFallbackAdapter(adapter)) return { ...unsupported(FALLBACK_ADAPTER_REASON), fallbackAdapter: true };

    const info = adapter.info || {};
    const maxBuffer = Number(adapter.limits?.maxBufferSize) || 0;
    return {
        supported: true,
        reason: null,
        vendor: `${info.vendor || ''}`,
        description: `${info.description || info.architecture || ''}`,
        shaderF16: Boolean(adapter.features?.has?.('shader-f16')),
        maxBufferMB: maxBuffer ? Math.floor(maxBuffer / (1024 * 1024)) : null,
        fallbackAdapter: false
    };
}
