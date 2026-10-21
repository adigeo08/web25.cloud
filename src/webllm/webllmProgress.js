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
 * Pure functions, no DOM: the controller and the tests share them.
 */

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
 * @returns {ClassifiedError}
 */
export function classifyError(error) {
    const name = `${error?.name || ''}`;
    const detail = `${error?.message || error || ''}`;
    const text = `${name} ${detail}`;

    if (
        /WebGPUNotAvailable|WebGPUNotFound|WebGPU is not supported|Cannot find WebGPU|requestAdapter|no (gpu|webgpu) adapter/i.test(
            text
        )
    ) {
        return {
            kind: 'unsupported',
            retryable: false,
            message:
                'WebGPU is not available in this browser, so Llama cannot run here. Try a recent version of Chrome, Edge or Safari on a device with a supported GPU.',
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
            message:
                'There is not enough storage space in this browser for the model (about 750 MB). Free up some space and try again.',
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
        message: 'Something went wrong while running Llama. Please try again.',
        detail
    };
}

/**
 * Keep the conversation inside the model's context window.
 *
 * Token counts are only known inside the engine, so this budgets characters
 * (about three per token for English, which errs on the safe side) and drops
 * the oldest turns first. The system prompt and the newest message always stay.
 *
 * @param {{ role: string, content: string }[]} messages
 * @param {number} [maxChars]
 */
export function trimHistory(messages, maxChars = 9000) {
    const system = messages.filter((message) => message.role === 'system');
    const turns = messages.filter((message) => message.role !== 'system');
    let budget = maxChars - system.reduce((sum, message) => sum + message.content.length, 0);
    const kept = [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        const size = turns[i].content.length;
        if (kept.length > 0 && size > budget) break;
        kept.unshift(turns[i]);
        budget -= size;
    }
    // A conversation handed to the model starts with the user, never with a
    // reply to a question that was trimmed away.
    while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
    return [...system, ...kept];
}
