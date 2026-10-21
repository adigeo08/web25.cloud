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

/**
 * How the model is sampled. Sent with every chat completion; WebLLM's own
 * defaults (the model's `mlc-chat-config.json`) apply to anything left out.
 *
 *   temperature 0.6, top_p 0.9   Meta's recommended sampling for the Llama 3
 *                                Instruct models. A 1B model drifts and loops
 *                                more the hotter it is run.
 *   repetition_penalty 1.1       WebLLM applies it to the tokens the model has
 *                                itself generated in this reply — never to the
 *                                prompt — dividing a seen token's positive
 *                                logit by 1.1. Mild on purpose: it is applied
 *                                to every distinct token already used, so a
 *                                stronger value starts to hurt ordinary words.
 *   frequency/presence 0         Off. Their additive, count-scaled penalty is
 *                                what a looping 1B model would need to break
 *                                out of a cycle, but it also pushes it away from
 *                                words it has to reuse; the loop guard is the
 *                                safety net instead.
 *   max_tokens 384               About 280 words. The system prompt asks for
 *                                short answers, so this is a ceiling, not a
 *                                target; hitting it ends the reply with
 *                                `finish_reason: "length"`.
 *
 * The ranges WebLLM enforces (`postInitAndCheckGenerationConfigValues` in
 * @mlc-ai/web-llm@0.2.85): temperature >= 0, 0 < top_p <= 1, repetition_penalty
 * > 0, -2 <= frequency/presence_penalty <= 2, max_tokens > 0.
 */
export const WEBLLM_GENERATION = Object.freeze({
    temperature: 0.6,
    top_p: 0.9,
    repetition_penalty: 1.1,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_tokens: 384
});

/**
 * The prompt and the reply share the 4096-token KV cache, so the prompt may
 * only use what the reply and a margin leave over. A prompt that does not fit
 * is rejected (`ContextWindowSizeExceededError`); one that only just fits has
 * its reply cut short by the cache filling up (`finish_reason: "length"`).
 */
export const WEBLLM_CONTEXT_SAFETY_TOKENS = 192;

/** Tokens the Llama 3 template spends around each message: header start, role, header end, "\n\n", `<|eot_id|>`. */
export const WEBLLM_MESSAGE_FRAMING_TOKENS = 5;

/** `<|begin_of_text|>` plus the assistant header the reply continues from. */
export const WEBLLM_REQUEST_FRAMING_TOKENS = 5;

/** Estimated tokens the whole prompt may take. */
export const WEBLLM_PROMPT_TOKEN_BUDGET =
    WEBLLM_CONTEXT_WINDOW - WEBLLM_GENERATION.max_tokens - WEBLLM_CONTEXT_SAFETY_TOKENS;

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

/**
 * Short and concrete: a 1B model follows a few plain sentences far better than
 * a long list of rules, and echoes example phrases it is shown. The greeting
 * rule is spelled out because "hey" is where it rambles most.
 */
export const WEBLLM_SYSTEM_PROMPT = [
    'You are Llama, a friendly assistant running locally in the user’s browser.',
    'Reply in natural, direct English and get to the point.',
    'Match the size of your answer to the question: a greeting or a simple question gets one or two short sentences.',
    'Explain bigger topics in a few short paragraphs or a short list, and finish your thought.',
    'Never repeat a sentence or phrase you already wrote, and leave out filler openers, closers and apologies.',
    'If you do not know something, say so briefly.'
].join(' ');
