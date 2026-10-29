// @ts-check
/**
 * Everything the local AI chat is pinned to, in one place.
 *
 * One library version and one model per kind of device: Llama 3.2 1B on
 * desktops and laptops, SmolLM2 360M on phones and tablets (see
 * `WEBLLM_MODELS` and `WEBLLM_PROFILES`). The model records are spelled out
 * here instead of being taken from WebLLM's `prebuiltAppConfig`, so the URLs
 * WebLLM caches under are known before the 6 MB library is ever fetched: the
 * WebLLM service worker reads them to say whether the model is already in this
 * browser, and the engine is handed this exact record to load. The values are
 * the ones `@mlc-ai/web-llm@0.2.85` ships for these models.
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

/** Estimated tokens the whole prompt may take (desktop profile). */
export const WEBLLM_PROMPT_TOKEN_BUDGET = WEBLLM_CONTEXT_WINDOW - WEBLLM_REPLY_RESERVE_TOKENS;

/**
 * Memory profiles: which model runs, how much memory the engine reserves and
 * how long a reply may run. Sampling belongs to the model (`chatOptionsFor`).
 *
 * The KV cache is allocated for the whole context window when the model loads.
 * For Llama 3.2 1B (16 layers × 8 KV heads × 64 dims, keys and values, 32-bit in
 * the q4f32 build) that is 64 KB per token: 256 MB at 4096 tokens. For SmolLM2
 * 360M (32 layers × 5 KV heads × 64 dims, 32-bit) it is 80 KB per token: 160 MB
 * at 2048 — computed from the model shapes, not measured on a device.
 *
 *   desktop  Llama 3.2 1B, 4096 context, no reply limit, 3072-token prompt budget.
 *   mobile   SmolLM2 360M, 2048 context set at engine initialisation,
 *            `max_tokens: 256` on every request, and a prompt budget that leaves
 *            those 256 tokens plus a margin free: 2048 − 256 − 128 = 1664
 *            estimated tokens.
 *
 * @typedef {{ id: 'desktop'|'mobile', model: WebLLMModelKey, contextWindow: number,
 *             maxTokens: number|null, promptTokenBudget: number }} WebLLMProfile
 */
export const WEBLLM_PROFILES = Object.freeze({
    desktop: Object.freeze({
        id: 'desktop',
        model: 'llama',
        contextWindow: WEBLLM_CONTEXT_WINDOW,
        maxTokens: null,
        promptTokenBudget: WEBLLM_PROMPT_TOKEN_BUDGET
    }),
    mobile: Object.freeze({
        id: 'mobile',
        model: 'smollm',
        contextWindow: 2048,
        maxTokens: 256,
        promptTokenBudget: 2048 - 256 - 128
    })
});

/**
 * Dev-only override: `?webllm-profile=mobile` or `?webllm-profile=desktop` in the
 * page URL. Honoured only on development hosts — localhost, loopback, `.local`
 * names and private LAN addresses, so a phone can test against a dev server —
 * and ignored on web25.cloud. Nothing is stored and nothing in the production
 * UI exposes it; the chat's status line names the profile while it is in use.
 */
export const WEBLLM_PROFILE_OVERRIDE_PARAM = 'webllm-profile';

/** @param {string} hostname */
export function isDevelopmentHost(hostname) {
    const host = `${hostname || ''}`.toLowerCase();
    return (
        host === 'localhost' ||
        host === '[::1]' ||
        host === '::1' ||
        host.endsWith('.local') ||
        host.endsWith('.localhost') ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
}

/**
 * Whether this is a phone or tablet: User-Agent Client Hints where the browser
 * has them, the user agent string otherwise, and iPadOS — which reports itself
 * as a Mac — by its touch points.
 * @param {any} nav
 */
export function isMobileDevice(nav) {
    if (typeof nav?.userAgentData?.mobile === 'boolean' && nav.userAgentData.mobile) return true;
    const ua = `${nav?.userAgent || ''}`;
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
    return /Macintosh/.test(ua) && Number(nav?.maxTouchPoints) > 1;
}

/**
 * Pick the profile for this page.
 *
 * @param {{ navigator?: any, location?: { hostname?: string, search?: string } }} [env]
 * @returns {WebLLMProfile & { overridden: boolean }}
 */
export function resolveWebLLMProfile({ navigator: nav = globalThis.navigator, location = globalThis.location } = {}) {
    if (isDevelopmentHost(location?.hostname)) {
        let wanted = null;
        try {
            wanted = new URLSearchParams(location?.search || '').get(WEBLLM_PROFILE_OVERRIDE_PARAM);
        } catch (_) {
            wanted = null;
        }
        if (wanted && Object.hasOwn(WEBLLM_PROFILES, wanted)) return { ...WEBLLM_PROFILES[wanted], overridden: true };
    }
    return { ...WEBLLM_PROFILES[isMobileDevice(nav) ? 'mobile' : 'desktop'], overridden: false };
}

export const LLAMA_LICENSE_URL = 'https://www.llama.com/llama3_2/license/';

/**
 * SmolLM2 360M Instruct, for phones and tablets: the q4f32_1 build, for the
 * same reason as Llama's — no `shader-f16`, 32-bit activations. 579.61 MB of
 * VRAM in the 0.2.85 prebuilt record, against Llama's 1128.82.
 */
export const SMOLLM_MODEL_ID = 'SmolLM2-360M-Instruct-q4f32_1-MLC';
export const SMOLLM_MODEL_URL = 'https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f32_1-MLC/resolve/main/';
export const SMOLLM_MODEL_LIB_URL =
    'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/SmolLM2-360M-Instruct-q4f32_1_cs1k-webgpu.wasm';
export const SMOLLM_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

/**
 * The models WEB25 can run, by the key a profile names them with.
 *
 *   modelId, modelUrl, modelLibUrl, vramMB   the WebLLM record
 *   downloadBytes   roughly what the weights take on disk, for the storage check:
 *                   at 4 bits plus a 32-bit scale per group of 32, Llama's 1.24
 *                   billion parameters are about 775 MB and SmolLM2's 362 million
 *                   about 230 MB, each rounded up
 *   downloadLabel   the same, for people
 *   name, label     how the chat refers to it, briefly and in full
 *   chatTemplate    the conversation format of its MLC build (webllmPromptFormat.js)
 *   sampling        replaces the shared chat options' sampling, where the model's
 *                   own recommendation differs: SmolLM2's card uses temperature 0.2
 *   credit, license what the install screen names
 *
 * @typedef {'llama'|'smollm'} WebLLMModelKey
 * @typedef {{ key: WebLLMModelKey, modelId: string, modelUrl: string, modelLibUrl: string,
 *             vramMB: number, downloadBytes: number, downloadLabel: string, name: string, label: string,
 *             icon: string, chatTemplate: 'llama3'|'chatml', sampling: Record<string, number>,
 *             credit: string, license: { label: string, url: string } }} WebLLMModel
 */
export const WEBLLM_MODELS = Object.freeze({
    llama: Object.freeze({
        key: 'llama',
        modelId: WEBLLM_MODEL_ID,
        modelUrl: WEBLLM_MODEL_URL,
        modelLibUrl: WEBLLM_MODEL_LIB_URL,
        vramMB: WEBLLM_MODEL_VRAM_MB,
        downloadBytes: WEBLLM_MODEL_DOWNLOAD_BYTES,
        downloadLabel: '~800 MB',
        name: 'Llama',
        label: WEBLLM_MODEL_LABEL,
        icon: '🦙',
        chatTemplate: 'llama3',
        sampling: Object.freeze({}),
        credit: 'Llama 3.2 by Meta · © Meta Platforms, Inc. ·',
        license: Object.freeze({ label: 'Llama 3.2 Community License', url: LLAMA_LICENSE_URL })
    }),
    smollm: Object.freeze({
        key: 'smollm',
        modelId: SMOLLM_MODEL_ID,
        modelUrl: SMOLLM_MODEL_URL,
        modelLibUrl: SMOLLM_MODEL_LIB_URL,
        vramMB: 579.61,
        downloadBytes: 260 * 1024 * 1024,
        downloadLabel: '~250 MB',
        name: 'SmolLM',
        label: 'SmolLM2 360M',
        icon: '🤖',
        chatTemplate: 'chatml',
        sampling: Object.freeze({ temperature: 0.2 }),
        credit: 'SmolLM2 by Hugging Face ·',
        license: Object.freeze({ label: 'Apache License 2.0', url: SMOLLM_LICENSE_URL })
    })
});

/**
 * The model a profile names; anything unknown is Llama, the desktop default.
 * @param {any} key
 * @returns {WebLLMModel}
 */
export function getWebLLMModel(key) {
    return typeof key === 'string' && Object.hasOwn(WEBLLM_MODELS, key)
        ? /** @type {any} */ (WEBLLM_MODELS)[key]
        : WEBLLM_MODELS.llama;
}

/**
 * The chat options a model is loaded with: the shared ones, with the model's
 * own sampling where it has one.
 * @param {WebLLMModel} model
 */
export function chatOptionsFor(model) {
    return { ...WEBLLM_CHAT_OPTIONS, ...model.sampling };
}

/**
 * Builds this page does not load: the older Llama build, and the other
 * device's model, which a browser may hold from before — a phone that
 * downloaded Llama, say. Only ever looked for, and removed on the user's own
 * request; nothing removes them on its own.
 * @param {WebLLMModel} model the one this page loads
 * @returns {{ modelId: string, modelUrl: string, modelLibUrl: string }[]}
 */
export function otherWebLLMModels(model) {
    return [...WEBLLM_LEGACY_MODELS, ...Object.values(WEBLLM_MODELS).filter((entry) => entry.key !== model.key)].map(
        ({ modelId, modelUrl, modelLibUrl }) => ({ modelId, modelUrl, modelLibUrl })
    );
}

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

/**
 * The engine's app config: one model, with the same files, VRAM and context
 * window as the 0.2.85 prebuilt record for it, on Cache API storage. A profile
 * with a smaller window sets it here too, so the record and the chat options agree.
 *
 * @param {number} [contextWindow]
 * @param {WebLLMModel} [model]
 */
export function createAppConfig(contextWindow = WEBLLM_CONTEXT_WINDOW, model = WEBLLM_MODELS.llama) {
    return {
        cacheBackend: 'cache',
        model_list: [
            {
                model: model.modelUrl,
                model_id: model.modelId,
                model_lib: model.modelLibUrl,
                vram_required_MB: model.vramMB,
                low_resource_required: true,
                overrides: { context_window_size: contextWindow }
            }
        ]
    };
}

/**
 * The developer-focused system prompt, the same for every model, so it names
 * none. Short on purpose: it is sent with every request, and on a phone the
 * whole prompt has 1664 estimated tokens.
 * Documentation, when a lookup found some, is appended below it by
 * `buildSystemPrompt` — never claimed when there was none.
 */
export const WEBLLM_SYSTEM_PROMPT = [
    'You are a local web-development assistant running in the user’s browser.',
    'You specialize in JavaScript, HTML, CSS, Web APIs and browser compatibility, and you also help with general questions.',
    'Give accurate, practical answers, with short code examples when they help.',
    'When you write a whole file, put its file name after the language on the opening fence, for example ```html index.html.',
    'When MDN documentation is included below, base your answer on it and say it comes from MDN.',
    'Otherwise answer from your own knowledge, and never claim to have checked documentation or invent sources or links.'
].join(' ');

/**
 * How long a conversation is kept after its last activity. Local only; the
 * choice is stored per wallet with the history itself.
 */
export const WEBLLM_RETENTION_OPTIONS = Object.freeze([
    Object.freeze({ id: '1d', label: '1 day', ms: 24 * 60 * 60 * 1000 }),
    Object.freeze({ id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 }),
    Object.freeze({ id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 }),
    Object.freeze({ id: 'forever', label: 'Until manually deleted', ms: null })
]);
export const WEBLLM_DEFAULT_RETENTION = '7d';

/**
 * Mozilla's public MDN MCP server (https://developer.mozilla.org/en-US/mcp),
 * spoken to directly from the page over Streamable HTTP; it allows browser
 * origins, so there is no proxy. Only short search terms are sent.
 */
export const MDN_MCP_ENDPOINT = 'https://mcp.mdn.mozilla.net/';
export const MDN_MCP_PROTOCOL_VERSION = '2025-06-18';
export const MDN_ORIGIN = 'https://developer.mozilla.org';

/**
 * How much documentation may go into a prompt, in estimated tokens. Sized so
 * the system prompt, the documentation, the question and some history still
 * fit each profile's prompt budget.
 */
export const MDN_CONTEXT_TOKENS = Object.freeze({ desktop: 900, mobile: 420 });

/**
 * How a reply is written (see webllmThinking.js), chosen in the chat settings:
 *
 *   auto      the model decides, per message, with a one-word structured answer
 *   short     one short answer: a small reply window
 *   thinking  a plan, then one step at a time: a large reply window in total
 */
export const WEBLLM_REPLY_MODES = Object.freeze(['auto', 'short', 'thinking']);
export const WEBLLM_DEFAULT_REPLY_MODE = 'auto';

/**
 * The token windows of each mode, per memory profile.
 *
 *   decideMaxTokens   Auto's structured decision ({"mode": …}): a few tokens
 *   shortMaxTokens    a short answer; Continue is offered if it is cut
 *   planMaxTokens     the structured plan a thinking answer starts with
 *   stepMaxTokens     each step of a thinking answer
 *   stepContinueTokens  the one continuation a step cut at stepMaxTokens may get
 *   maxSteps          the most steps a plan may have
 *   recallTokens      how much of the earlier thoughts a step is shown
 *   recallLimit       how many earlier thoughts are recalled for a step, by similarity,
 *                     besides the latest completed step, which is always shown
 *   recallMinSimilarity  below this a thought is not recalled (see RECALL_MIN_SIMILARITY)
 *   stepDocShare      the part of the profile's MDN budget one step's lookup may use
 */
export const WEBLLM_THINKING = Object.freeze({
    desktop: Object.freeze({
        decideMaxTokens: 16,
        shortMaxTokens: 360,
        planMaxTokens: 200,
        stepMaxTokens: 900,
        stepContinueTokens: 450,
        maxSteps: 4,
        recallTokens: 900,
        recallLimit: 4,
        recallMinSimilarity: 0.2,
        stepDocShare: 0.6
    }),
    mobile: Object.freeze({
        decideMaxTokens: 16,
        shortMaxTokens: 200,
        planMaxTokens: 140,
        stepMaxTokens: 256,
        stepContinueTokens: 160,
        maxSteps: 3,
        recallTokens: 300,
        recallLimit: 2,
        recallMinSimilarity: 0.2,
        stepDocShare: 0.6
    })
});

/**
 * idb-vector (Paul Kinlan, Apache-2.0): a small vector store over IndexedDB,
 * used to recall earlier thoughts by similarity. Two files, both pinned: the
 * page fetches them from jsDelivr, checks each against its hash, and only then
 * imports them — the same rule as the WebLLM library.
 */
export const IDB_VECTOR_VERSION = '0.2.0';
export const IDB_VECTOR_FILES = Object.freeze({
    index: Object.freeze({
        url: `https://cdn.jsdelivr.net/npm/idb-vector@${IDB_VECTOR_VERSION}/index.js`,
        integrity: 'sha384-SPRCEZwWvCOk1re2an6bhn5nbB3vZY1PXR1wSgBQ6kgHXrB0IDFbbgHkAvOOXHD5'
    }),
    sortedArray: Object.freeze({
        url: `https://cdn.jsdelivr.net/npm/idb-vector@${IDB_VECTOR_VERSION}/utils/sortedarray.js`,
        integrity: 'sha384-s83t0Zg9cAfA7GV1T5qGHpAByciLc4I9MnPAoOkMWhaot7HW2fr3Om6+bdyHlBhh',
        /** How index.js imports it, verbatim. */
        specifier: './utils/sortedarray.js'
    })
});
