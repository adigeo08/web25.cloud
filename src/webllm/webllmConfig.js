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

/**
 * The q4f32_1 build — the one chat.webllm.ai runs by default. Its 4-bit weights
 * carry 32-bit scales and run with 32-bit activations, so it needs no
 * `shader-f16` and does not depend on a GPU's half-precision arithmetic. With
 * the q4f16_1 build WEB25 shipped first, replies were reported incoherent and
 * looping on a device where chat.webllm.ai, running this build, answers well.
 */
export const WEBLLM_MODEL_ID = 'Llama-3.2-1B-Instruct-q4f32_1-MLC';
export const WEBLLM_MODEL_LABEL = 'Llama 3.2 1B';

/** Where WebLLM fetches the weights from, normalised the way WebLLM does (`…/resolve/main/`). */
export const WEBLLM_MODEL_URL = 'https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f32_1-MLC/resolve/main/';

export const WEBLLM_MODEL_LIB_URL =
    'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Llama-3.2-1B-Instruct-q4f32_1_cs1k-webgpu.wasm';

/** From the 0.2.85 prebuilt record. */
export const WEBLLM_MODEL_VRAM_MB = 1128.82;

/**
 * Roughly what the weights take on disk, for the storage check before a
 * download: 1.24 billion parameters at 4 bits plus a 32-bit scale per group of
 * 32 is about 775 MB, rounded up.
 */
export const WEBLLM_MODEL_DOWNLOAD_BYTES = 850 * 1024 * 1024;

/**
 * The build WEB25 used before. Never loaded again; it is only looked for, so a
 * browser that still holds it can be told — and can delete it when the user
 * chooses to. Nothing removes it on its own.
 */
export const WEBLLM_LEGACY_MODELS = Object.freeze([
    Object.freeze({
        modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        modelUrl: 'https://huggingface.co/mlc-ai/Llama-3.2-1B-Instruct-q4f16_1-MLC/resolve/main/',
        modelLibUrl:
            'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm'
    })
]);

export const WEBLLM_CONTEXT_WINDOW = 4096;

/**
 * Generation settings, as chat.webllm.ai uses them for this model: its
 * `recommended_config` (temperature 0.6, top_p 0.9, no presence or frequency
 * penalty) and the record's 4096-token context window.
 *
 * Like the official app, these are given to `engine.reload()` as chat options,
 * where they replace the matching fields of the model's `mlc-chat-config.json`
 * — not sent with every request. Everything else stays the model's own:
 * `repetition_penalty` (1.0), the Llama 3 conversation template and its stop
 * tokens. No reply length limit is set: a reply ends at the model's end-of-turn
 * token, or when the context window is full.
 */
export const WEBLLM_CHAT_OPTIONS = Object.freeze({
    temperature: 0.6,
    top_p: 0.9,
    presence_penalty: 0,
    frequency_penalty: 0,
    context_window_size: WEBLLM_CONTEXT_WINDOW
});

/**
 * History, as the official app sends it: the last four messages before the new
 * one (its `historyMessageCount`), under a token budget.
 *
 * The official app's `max_tokens: 4000` is that budget — it caps the estimated
 * tokens of history sent, and never limits a reply (it is not a chat-config
 * field, so `reload()` ignores it). With no reply limit here either, the budget
 * has to leave the reply room inside the same 4096-token window: the prompt
 * gets 3072 estimated tokens and the reply at least 1024.
 */
export const WEBLLM_HISTORY_MESSAGES = 4;
export const WEBLLM_REPLY_RESERVE_TOKENS = 1024;

/** Tokens the Llama 3 template spends around each message: header start, role, header end, "\n\n", `<|eot_id|>`. */
export const WEBLLM_MESSAGE_FRAMING_TOKENS = 5;

/** `<|begin_of_text|>`, the template's default system message, and the assistant header the reply continues from. */
export const WEBLLM_REQUEST_FRAMING_TOKENS = 24;

/** Estimated tokens the whole prompt may take. */
export const WEBLLM_PROMPT_TOKEN_BUDGET = WEBLLM_CONTEXT_WINDOW - WEBLLM_REPLY_RESERVE_TOKENS;

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

/** The engine's app config: one model, with the same files, VRAM and context window as the 0.2.85 prebuilt record for it, on Cache API storage. */
export function createAppConfig() {
    return {
        cacheBackend: 'cache',
        model_list: [
            {
                model: WEBLLM_MODEL_URL,
                model_id: WEBLLM_MODEL_ID,
                model_lib: WEBLLM_MODEL_LIB_URL,
                vram_required_MB: WEBLLM_MODEL_VRAM_MB,
                low_resource_required: true,
                overrides: { context_window_size: WEBLLM_CONTEXT_WINDOW }
            }
        ]
    };
}
