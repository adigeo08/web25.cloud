// @ts-check
/**
 * Can this device run Llama in the browser?
 *
 * Asks for a WebGPU adapter and reads its limits. An adapter is only a
 * description of the GPU: no device is created and nothing is allocated, so
 * this is safe to run when the WebLLM tab opens. The engine creates the real
 * device later, in its worker, and only after Install.
 */

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
        adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch (error) {
        return unsupported(`WebGPU adapter request failed: ${error?.message || error}`);
    }
    if (!adapter) {
        return unsupported('No compatible GPU was found. WebGPU may be disabled or blocked on this device.');
    }

    const info = adapter.info || {};
    const maxBuffer = Number(adapter.limits?.maxBufferSize) || 0;
    return {
        supported: true,
        reason: null,
        vendor: `${info.vendor || ''}`,
        description: `${info.description || info.architecture || ''}`,
        shaderF16: Boolean(adapter.features?.has?.('shader-f16')),
        maxBufferMB: maxBuffer ? Math.floor(maxBuffer / (1024 * 1024)) : null,
        fallbackAdapter: Boolean(adapter.isFallbackAdapter || info.isFallbackAdapter)
    };
}
