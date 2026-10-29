// @ts-check
/**
 * What WebLLM's progress reports and errors mean, in words for the user.
 *
 * WebLLM reports loading as `{ progress, timeElapsed, text }` through a single
 * callback, and the phase only shows in the text. These are the phrases the
 * pinned version writes (see `fetchTensorCacheInternal` and the shader loader
 * in `@mlc-ai/web-llm@0.2.85`); anything unrecognised is shown as generic
 * initialisation so a wording change upstream degrades, never breaks.
 *
 * It also holds what the controller needs to keep a conversation inside the
 * model's context window (token estimate, which exchanges to pass back, trimming)
 * and the wording shown when a reply ends early.
 *
 * Pure functions, no DOM: the controller and the tests share them.
 */

import {
    WEBLLM_HISTORY_MESSAGES,
    WEBLLM_MODELS,
    WEBLLM_MESSAGE_FRAMING_TOKENS,
    WEBLLM_PROMPT_TOKEN_BUDGET,
    WEBLLM_REQUEST_FRAMING_TOKENS
} from './webllmConfig.js';

/** Shown under a reply the loop guard cut off. */
export const LOOP_NOTICE =
    'Stopped automatically: the model started repeating itself. Try rephrasing, or start a new chat.';

/**
 * Shown under a reply that stopped at the length limit and cannot be continued:
 * the question, the reply so far and the room for more no longer fit the
 * context window.
 */
export const CONTINUE_EXHAUSTED_NOTICE =
    'This reply has filled the model’s memory and can’t be continued. Ask a follow-up question, or start a new chat.';

/** Shown when an MDN lookup was tried and failed: the answer is the model's own. */
export const MDN_UNAVAILABLE_NOTE =
    'MDN documentation couldn’t be reached, so this answer comes from the model’s own knowledge.';

/** Shown when the newest message alone is more than the model can read at once. */
export const MESSAGE_TOO_LONG = 'That message is too long for the model to read at once. Try a shorter one.';

/**
 * @typedef {'download'|'cache'|'shaders'|'init'|'done'} LoadPhase
 * @typedef {{ phase: LoadPhase, percent: number, loadedMB: number|null, totalMB: number|null,
 *             shard: number|null, shards: number|null, text: string }} LoadProgress
 */

const FETCHING = /^Fetching param cache\[(\d+)\/(\d+)\]:\s*(\d+)MB fetched\.\s*(\d+)% completed/;
const FROM_CACHE = /^Loading model from cache\[(\d+)\/(\d+)\]:\s*(\d+)MB loaded\.\s*(\d+)% completed/;
const SHADERS = /^Loading GPU shader modules\[(\d+)\/(\d+)\]/;

/** @param {number} value */
function clampPercent(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.floor(value)));
}

/**
 * @param {{ progress?: number, text?: string }} report
 * @returns {LoadProgress}
 */
export function parseInitProgress(report) {
    const text = `${report?.text || ''}`;
    const fraction = Number(report?.progress);
    const percent = clampPercent(fraction * 100);

    let match = text.match(FETCHING);
    if (match) {
        const loadedMB = Number(match[3]);
        const shown = clampPercent(Number(match[4]));
        // WebLLM's text carries the MB so far; the total follows from the
        // fraction it reports alongside it.
        const totalMB = fraction > 0 ? Math.round(loadedMB / fraction) : null;
        return {
            phase: 'download',
            percent: Number.isFinite(fraction) ? percent : shown,
            loadedMB,
            totalMB,
            shard: Number(match[1]),
            shards: Number(match[2]),
            text
        };
    }

    match = text.match(FROM_CACHE);
    if (match) {
        return {
            phase: 'cache',
            percent: Number.isFinite(fraction) ? percent : clampPercent(Number(match[4])),
            loadedMB: Number(match[3]),
            totalMB: null,
            shard: Number(match[1]),
            shards: Number(match[2]),
            text
        };
    }

    match = text.match(SHADERS);
    if (match) {
        return {
            phase: 'shaders',
            percent,
            loadedMB: null,
            totalMB: null,
            shard: Number(match[1]),
            shards: Number(match[2]),
            text
        };
    }

    if (/^Start to fetch params/.test(text)) {
        return { phase: 'download', percent: 0, loadedMB: 0, totalMB: null, shard: 0, shards: null, text };
    }

    if (/^Finish loading/.test(text)) {
        return { phase: 'done', percent: 100, loadedMB: null, totalMB: null, shard: null, shards: null, text };
    }

    return { phase: 'init', percent, loadedMB: null, totalMB: null, shard: null, shards: null, text };
}

/**
 * One line for the progress card. The percentage sits beside it, on its own.
 * @param {LoadProgress} progress
 */
export function describeProgress(progress) {
    switch (progress.phase) {
        case 'download': {
            const amount =
                progress.loadedMB !== null && progress.totalMB
                    ? ` · ${progress.loadedMB} of ${progress.totalMB} MB`
                    : progress.loadedMB
                      ? ` · ${progress.loadedMB} MB`
                      : '';
            return `Downloading model${amount}`;
        }
        case 'cache':
            return 'Loading weights onto the GPU';
        case 'shaders':
            return 'Preparing GPU shaders';
        case 'done':
            return 'Ready';
        default:
            return 'Initializing the engine…';
    }
}

/**
 * @typedef {'unsupported'|'resources'|'storage'|'network'|'context'|'aborted'|'unknown'} ErrorKind
 * @typedef {{ kind: ErrorKind, retryable: boolean, message: string, detail: string }} ClassifiedError
 */

/**
 * Turn whatever the engine threw into something a user can act on.
 *
 * Errors cross a worker boundary, so this works on `{ name, message }` and
 * never on a class.
 *
 * @param {{ name?: string, message?: string } | null | undefined} error
 * @param {import('./webllmConfig.js').WebLLMModel} [model] the model being run, named in the advice
 * @returns {ClassifiedError}
 */
export function classifyError(error, model = WEBLLM_MODELS.llama) {
    const name = `${error?.name || ''}`;
    const detail = `${error?.message || error || ''}`;
    const text = `${name} ${detail}`;

    // Checked first: the message names WebGPU, and the generic advice is wrong here.
    if (/WebGPUFallbackAdapter/.test(name)) {
        return {
            kind: 'unsupported',
            retryable: false,
            message: `This browser only offers WebGPU emulated on the CPU, which is far too slow for ${model.name}. Turn on hardware acceleration in the browser settings (or update the GPU driver) and reload the page.`,
            detail
        };
    }
    if (
        /WebGPUNotAvailable|WebGPUNotFound|WebGPU is not supported|Cannot find WebGPU|requestAdapter|no (gpu|webgpu) adapter/i.test(
            text
        )
    ) {
        return {
            kind: 'unsupported',
            retryable: false,
            message: `WebGPU is not available in this browser, so ${model.name} cannot run here. Try a recent version of Chrome, Edge or Safari on a device with a supported GPU.`,
            detail
        };
    }
    if (/ShaderF16Support|shader-f16|FeatureSupport/i.test(text)) {
        return {
            kind: 'unsupported',
            retryable: false,
            message:
                'Your GPU or browser does not support the 16-bit shaders this model needs. Try a recent version of Chrome or Edge.',
            detail
        };
    }
    if (/QuotaExceeded|quota|storage (is )?full|not enough storage/i.test(text)) {
        return {
            kind: 'storage',
            retryable: true,
            message: `There is not enough storage space in this browser for the model (about ${model.downloadLabel.replace(/^~/, '')}). Free up some space and try again.`,
            detail
        };
    }
    if (/DeviceLost|device was lost|out of memory|\bOOM\b|maxStorageBufferBindingSize|allocat/i.test(text)) {
        return {
            kind: 'resources',
            retryable: true,
            message:
                'Your device ran out of GPU memory while loading the model. Close other tabs or apps that use the GPU and try again.',
            detail
        };
    }
    if (/ContextWindowSizeExceeded|context window/i.test(text)) {
        return {
            kind: 'context',
            retryable: false,
            message: 'This conversation is too long for the model to remember. Start a new chat to continue.',
            detail
        };
    }
    if (/AbortError|aborted|interrupted by user/i.test(text)) {
        return { kind: 'aborted', retryable: true, message: 'Loading was cancelled.', detail };
    }
    if (
        /Failed to fetch|Request failed|NetworkError|network|Cannot fetch|Load failed|ERR_|status (4|5)\d\d|ECONN|timed? ?out/i.test(
            text
        )
    ) {
        return {
            kind: 'network',
            retryable: true,
            message:
                'The download was interrupted. Check your connection and try again — the parts already downloaded are kept.',
            detail
        };
    }
    return {
        kind: 'unknown',
        retryable: true,
        message: `Something went wrong while running ${model.name}. Please try again.`,
        detail
    };
}

/**
 * Rough token count for a piece of text.
 *
 * The real count lives in the tokenizer, inside the engine, and is not
 * available before the request is sent. This errs high: the Llama 3 tokenizer
 * averages about four characters per token on English prose and about three on
 * code, so three characters per token never undercounts either. SmolLM2's
 * smaller vocabulary (49,152 tokens) can need more tokens for the same text,
 * which is what the mobile profile's 128-token margin is for; characters
 * outside ASCII (accents, CJK, emoji) cost more and are counted at 1.5.
 *
 * @param {string} text
 */
export function estimateTokens(text) {
    const value = `${text || ''}`;
    let ascii = 0;
    for (let i = 0; i < value.length; i += 1) {
        if (value.charCodeAt(i) < 128) ascii += 1;
    }
    return Math.ceil(ascii / 3 + (value.length - ascii) * 1.5);
}

/** @param {{ content: string }} message */
const messageTokens = (message) => estimateTokens(message.content) + WEBLLM_MESSAGE_FRAMING_TOKENS;

/**
 * What of the conversation the model is shown.
 *
 * Only exchanges whose reply finished — it ended on its own, or at the length
 * limit — are passed back. A reply that failed, that the user stopped, or that
 * the loop guard cut off is not context, it is the problem: handing a looping
 * answer back is the quickest way to get another one. Its question goes with
 * it, so what the model sees still alternates user and assistant and no
 * question is answered twice.
 *
 * Of those, only the last `limit` messages are sent — the official WebLLM
 * Chat's `historyMessageCount` of 4, i.e. the two most recent exchanges. A small
 * model stays on topic far better with a short history.
 *
 * @param {{ role: string, content: string, pending?: boolean, error?: string|null,
 *           stopped?: boolean, finishReason?: string|null }[]} messages
 * @param {{ limit?: number }} [options]
 * @returns {{ role: 'user'|'assistant', content: string }[]}
 */
export function selectContextMessages(messages, { limit = WEBLLM_HISTORY_MESSAGES } = {}) {
    /** @type {{ role: 'user'|'assistant', content: string }[]} */
    const context = [];
    for (let i = 0; i + 1 < messages.length; i += 1) {
        const question = messages[i];
        const answer = messages[i + 1];
        if (question.role !== 'user' || answer.role !== 'assistant') continue;
        i += 1;

        const finished =
            !answer.pending &&
            !answer.error &&
            !answer.stopped &&
            (answer.finishReason === 'stop' || answer.finishReason === 'length') &&
            answer.content.trim() !== '';
        if (!finished) continue;
        context.push({ role: 'user', content: question.content }, { role: 'assistant', content: answer.content });
    }
    // Whole exchanges: an odd limit still starts on a question.
    const keep = Math.max(0, limit - (limit % 2));
    return keep === 0 ? [] : context.slice(-keep);
}

/**
 * Keep the prompt inside the model's context window, with room left to reply.
 *
 * The oldest turns go first, and any system message and the newest message
 * always stay. `budget` is in estimated tokens (see `estimateTokens`) and
 * already has room for the reply taken out of the window.
 *
 * @param {{ role: string, content: string }[]} messages the conversation (after an optional system message), ending on the new user message
 * @param {{ budget?: number }} [options]
 * @returns {{ messages: { role: string, content: string }[], tokens: number, dropped: number, fits: boolean }}
 *   `fits` is false when the system message and the newest message alone are
 *   over budget — there is nothing left to drop.
 */
export function trimHistory(messages, { budget = WEBLLM_PROMPT_TOKEN_BUDGET } = {}) {
    const system = messages.filter((message) => message.role === 'system');
    const turns = messages.filter((message) => message.role !== 'system');

    let tokens = WEBLLM_REQUEST_FRAMING_TOKENS + system.reduce((sum, message) => sum + messageTokens(message), 0);
    const newest = turns[turns.length - 1];
    if (newest) tokens += messageTokens(newest);
    const fits = tokens <= budget;

    const kept = newest ? [newest] : [];
    for (let i = turns.length - 2; fits && i >= 0; i -= 1) {
        const cost = messageTokens(turns[i]);
        if (tokens + cost > budget) break;
        kept.unshift(turns[i]);
        tokens += cost;
    }
    // A conversation handed to the model starts with the user, never with a
    // reply to a question that was trimmed away.
    while (kept.length > 1 && kept[0].role !== 'user') {
        tokens -= messageTokens(kept[0]);
        kept.shift();
    }
    return { messages: [...system, ...kept], tokens, dropped: turns.length - kept.length, fits };
}
