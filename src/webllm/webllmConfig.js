// @ts-check
/**
 * Everything the local AI chat is pinned to, in one place.
 *
 * One library version and one model. The model record is spelled out here
 * instead of being taken from WebLLM's `prebuiltAppConfig`, so the URLs WebLLM
 * caches under are known before the 6 MB library is ever fetched: the WebLLM
 * service worker reads them to say whether the model is already in this
 * browser, and the engine is handed this exact record to load. The values are
 * the ones `@mlc-ai/web-llm@0.2.85` ships for this model.
 */

export const WEBLLM_VERSION = '0.2.85';

/**
 * The official package on jsDelivr. `lib/index.js` is the published browser
 * ESM build: a single self-contained module with no imports of its own, so it
 * loads unchanged from a blob URL as well as from the CDN.
 */
export const WEBLLM_LIBRARY_URL = `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/lib/index.js`;

/** SHA-384 of that file as published on npm. A CDN serving anything else is refused. */
export const WEBLLM_LIBRARY_INTEGRITY = 'sha384-rfElDdXnNkSgbLTTGiKHTrsetCVAYzzLZBD96/rZdD9XYvryEyShqz3ph8j+x7HH';

export const WEBLLM_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
export const WEBLLM_MODEL_LABEL = 'Llama 3.2 1B';

/** Where WebLLM fetches the weights from, normalised the way WebLLM does (`…/resolve/main/`). */
export const WEBLLM_MODEL_URL = 'https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/';

export const WEBLLM_MODEL_LIB_URL =
    'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm';

/** Roughly what the weights take on disk, for the storage check before a download. */
export const WEBLLM_MODEL_DOWNLOAD_BYTES = 750 * 1024 * 1024;

export const WEBLLM_CONTEXT_WINDOW = 4096;

export const LLAMA_LICENSE_URL = 'https://www.llama.com/llama3_2/license/';

/**
 * WebLLM's own Cache Storage buckets (`cacheBackend: 'cache'`). The weights
 * live here and nowhere else: nothing in WEB25 copies them.
 */
export const WEBLLM_NATIVE_CACHES = Object.freeze({
    model: 'webllm/model',
    config: 'webllm/config',
    wasm: 'webllm/wasm'
});

/** The WebLLM service worker: its own script, its own scope, its own cache. */
export const WEBLLM_SW_URL = './webllm-sw.js';
export const WEBLLM_SW_SCOPE = './webllm/';

/** Kept in step with `ASSET_CACHE` in webllm-sw.js. */
export const WEBLLM_ASSET_CACHE = 'web25-webllm-assets-v1';

/** The engine's app config: one model, Cache API storage. */
export function createAppConfig() {
    return {
        cacheBackend: 'cache',
        model_list: [
            {
                model: WEBLLM_MODEL_URL,
                model_id: WEBLLM_MODEL_ID,
                model_lib: WEBLLM_MODEL_LIB_URL,
                vram_required_MB: 879.04,
                low_resource_required: true,
                overrides: { context_window_size: WEBLLM_CONTEXT_WINDOW }
            }
        ]
    };
}

export const WEBLLM_SYSTEM_PROMPT =
    'You are Llama, a helpful assistant running locally in the user’s web browser. ' +
    'Answer clearly and concisely. If you are not sure about something, say so.';
