// @ts-check
/**
 * Spotting a reply that has fallen into a loop.
 *
 * A small model that loses the thread repeats itself: one sentence, a
 * question-and-answer pair, or a stretch of characters, over and over until
 * something stops it. The sampling penalties make that less likely; this makes
 * it harmless, by recognising the loop in the streamed text and letting the
 * engine host stop the generation.
 *
 * Three detectors, each built to leave ordinary repetition alone:
 *
 *   cycle     the last few completed sentences are the same sentence, or the
 *             same short run of sentences ("Hey! How are you?" × 3), repeating.
 *   circling  one long sentence (6+ words) keeps coming back, even with other
 *             text in between.
 *   period    the end of the text is a stretch of characters repeating with a
 *             fixed period — a loop that never forms a sentence.
 *
 * What is deliberately not a loop: short words and short sentences ("no no no",
 * "Yes."), numbered or bulleted lists (the numbers differ; markers are ignored
 * only when they lead a line), table rules and separators (no letters or
 * digits), and code — inside a ``` fence only the period detector runs, with
 * far higher thresholds. When the user's own message asks for repetition
 * ("say it five times", "write a chorus") or for something whose form repeats (a
 * song, a poem, a chant) every threshold is raised well out of the way.
 *
 * Pure functions on strings: no engine, no DOM, safe in the worker and in tests.
 */

/** @typedef {{ keepChars: number, reason: 'cycle'|'circling'|'period' }} LoopVerdict */

const DEFAULTS = {
    /** Consecutive repeats of a sentence cycle that make it a loop. */
    cycleRepeats: 3,
    /** Times one long sentence may appear in a reply before it is circling. */
    circlingCount: 6,
    /** Repeats of a character period that make it a loop (prose). */
    periodRepeats: 3,
    /** Characters a short period must span (units under 8 characters). */
    shortPeriodSpan: 160,
    /** Characters any periodic stretch must span. */
    minPeriodSpan: 48
};

/** Raised thresholds when the user asked for repetition, and inside code. */
const RELAXED = { cycleRepeats: 12, circlingCount: 12, periodRepeats: 9, shortPeriodSpan: 480, minPeriodSpan: 144 };
const CODE = { periodRepeats: 8, shortPeriodSpan: 200, minPeriodSpan: 200 };

/** How far back the period detector looks, and the longest unit it tries. */
const WINDOW_CHARS = 1600;
const MAX_PERIOD = 400;

/** Text this short cannot be a loop yet. */
const MIN_TEXT_CHARS = 48;

const REPEAT_REQUEST =
    /\b(repeat\w*|again and again|over and over|on repeat|times|chorus|refrain|loop|echo|songs?|lyrics|chant|rhymes?|poems?)\b/i;

/**
 * Whether the user asked for the same thing to be said more than once.
 * @param {string} userText
 */
export function asksForRepetition(userText) {
    return REPEAT_REQUEST.test(`${userText || ''}`);
}

/** A sentence reduced to what makes it the same sentence: no case, punctuation, or list marker. */
function normalise(raw) {
    return raw
        .replace(/^\s*(?:[-*•>]+|\d{1,2}[.)])\s+/, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The completed sentences of `text` — ended by . ! ? … followed by space, or by
 * a newline. A sentence still being written is not one yet.
 * @param {string} text
 */
function completedSentences(text) {
    /** @type {{ key: string, start: number, end: number }[]} */
    const sentences = [];
    const boundary = /[.!?…]+["')\]]*(?=\s)|\n/g;
    let start = 0;
    let match;
    while ((match = boundary.exec(text))) {
        const end = match.index + match[0].length;
        const raw = text.slice(start, end);
        const key = normalise(raw);
        if (key) sentences.push({ key, start: start + (raw.length - raw.trimStart().length), end });
        start = end;
    }
    return sentences;
}

const wordCount = (key) => (key ? key.split(' ').length : 0);

/**
 * The last sentences are one cycle repeating: [A A A], or [A B A B A B].
 * @returns {number|null} where the cycle's second repeat starts
 */
function findCycle(sentences, repeats) {
    const n = sentences.length;
    for (let cycle = 1; cycle <= 6; cycle += 1) {
        if (n < cycle * repeats) continue;
        let periodic = true;
        for (let i = n - cycle * (repeats - 1); i < n; i += 1) {
            if (sentences[i].key !== sentences[i - cycle].key) {
                periodic = false;
                break;
            }
        }
        if (!periodic) continue;

        const unit = sentences.slice(n - cycle, n);
        const chars = unit.reduce((sum, sentence) => sum + sentence.key.length, 0);
        const words = unit.reduce((sum, sentence) => sum + wordCount(sentence.key), 0);
        // One short word, or two, is a reaction ("Ha! Ha! Ha!"), not a loop.
        if (chars < 12 || words < 3) continue;

        // The run may have started before the last `repeats` cycles.
        let first = n - cycle * repeats;
        while (first > 0 && sentences[first - 1].key === sentences[first - 1 + cycle].key) first -= 1;
        return sentences[first + cycle].start;
    }
    return null;
}

/**
 * One long sentence appearing `count` times in the reply.
 * @returns {number|null} where its second appearance starts
 */
function findCircling(sentences, count) {
    /** @type {Map<string, { n: number, second: number }>} */
    const seen = new Map();
    for (const sentence of sentences) {
        if (wordCount(sentence.key) < 6) continue;
        const entry = seen.get(sentence.key);
        if (!entry) {
            seen.set(sentence.key, { n: 1, second: -1 });
            continue;
        }
        entry.n += 1;
        if (entry.n === 2) entry.second = sentence.start;
        if (entry.n >= count) return entry.second;
    }
    return null;
}

/**
 * Move a cut to where a reader would put it.
 *
 * A periodic run can begin a few characters before the unit's natural start
 * (the text before it happens to end like the unit does), which leaves the cut
 * a few characters short of the sentence it belongs to. Look a little ahead
 * for the end of that sentence; failing that, back up to the last whole word.
 *
 * @param {string} text
 * @param {number} index
 * @param {number} reach how far ahead the sentence end may be
 */
function snapToBoundary(text, index, reach) {
    const ahead = text.slice(index, index + Math.min(reach, 48));
    const end = ahead.match(/^[^.!?…\n]*?[.!?…]+["')\]]*(?=\s|$)/);
    if (end) return index + end[0].length;
    if (index >= text.length || /\s/.test(text[index])) return index;
    const word = text.slice(0, index).search(/\S+$/);
    return word > 0 ? word : index;
}

/**
 * The text ends in a stretch repeating with a fixed period.
 * @param {string} text
 * @param {{ periodRepeats: number, shortPeriodSpan: number, minPeriodSpan: number }} limits
 * @returns {{ end: number, unit: number }|null} the end of the first repeat, as an index into `text`, and the period
 */
function findPeriod(text, limits) {
    const window = text.length > WINDOW_CHARS ? text.slice(-WINDOW_CHARS) : text;
    const offset = text.length - window.length;
    const n = window.length;
    if (n < limits.minPeriodSpan) return null;

    const maxPeriod = Math.min(MAX_PERIOD, Math.floor(n / limits.periodRepeats));
    for (let period = 1; period <= maxPeriod; period += 1) {
        let i = n - 1;
        while (i - period >= 0 && window.charCodeAt(i) === window.charCodeAt(i - period)) i -= 1;
        const span = n - 1 - i + period;
        const needed = Math.max(
            limits.minPeriodSpan,
            period * limits.periodRepeats,
            period < 8 ? limits.shortPeriodSpan : 0
        );
        if (span < needed) continue;

        const start = n - span;
        const unit = window.slice(start, start + period);
        // Rules, separators and blank runs have nothing to say; only a very
        // long one is a sign of a model stuck.
        if (!/[\p{L}\p{N}]/u.test(unit) && span < 600) continue;
        return { end: offset + start + period, unit: period };
    }
    return null;
}

/**
 * Look for a loop at the end of a reply.
 *
 * @param {string} text the whole reply so far
 * @param {{ allowRepeats?: boolean }} [options]
 * @returns {LoopVerdict|null} where to cut the reply back to, and which
 *   detector found it
 */
export function detectLoop(text, { allowRepeats = false } = {}) {
    if (!text || text.length < MIN_TEXT_CHARS) return null;

    const limits = { ...DEFAULTS, ...(allowRepeats ? RELAXED : {}) };

    // Prose is whatever follows the last code fence; inside an open fence it is code.
    const fences = [...text.matchAll(/```/g)];
    const inCode = fences.length % 2 === 1;
    const regionStart = fences.length ? fences[fences.length - 1].index + 3 : 0;
    const region = text.slice(regionStart);

    /**
     * @param {number} at an index into the region
     * @param {LoopVerdict['reason']} reason
     * @returns {LoopVerdict}
     */
    const verdict = (at, reason) => ({ keepChars: text.slice(0, regionStart + at).trimEnd().length, reason });

    if (inCode) {
        const found = findPeriod(region, { ...limits, ...CODE, ...(allowRepeats ? RELAXED : {}) });
        return found === null ? null : verdict(found.end, 'period');
    }

    const sentences = completedSentences(region);
    const cycle = findCycle(sentences, limits.cycleRepeats);
    if (cycle !== null) return verdict(cycle, 'cycle');

    const circling = findCircling(sentences, limits.circlingCount);
    if (circling !== null) return verdict(circling, 'circling');

    const period = findPeriod(region, limits);
    if (period !== null) return verdict(snapToBoundary(region, period.end, period.unit), 'period');

    return null;
}

/**
 * The streaming side: feed it each piece of text as it arrives, and it says
 * when — and where — the reply should be cut. Checks run every few characters,
 * not on every token, and once a loop is found it stays found.
 *
 * @param {{ allowRepeats?: boolean, checkEvery?: number }} [options]
 */
export function createLoopGuard({ allowRepeats = false, checkEvery = 16 } = {}) {
    let text = '';
    let sinceCheck = 0;
    /** @type {LoopVerdict|null} */
    let found = null;

    return {
        /**
         * @param {string} delta
         * @returns {LoopVerdict|null}
         */
        push(delta) {
            if (found) return found;
            text += delta;
            sinceCheck += delta.length;
            if (sinceCheck < checkEvery) return null;
            sinceCheck = 0;
            found = detectLoop(text, { allowRepeats });
            return found;
        },
        get text() {
            return text;
        }
    };
}
