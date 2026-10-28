// @ts-check
/**
 * A vector for a thought, computed on the CPU in plain JavaScript.
 *
 * Feature hashing: the text's words (short ones weighed down), word pairs and
 * three-letter pieces of words are hashed into a fixed number of slots, with a sign from the hash so
 * collisions cancel out rather than pile up, and the result is scaled to unit
 * length so cosine similarity compares content, not length. No model, no
 * download, no GPU: Llama keeps the GPU to itself, and a thought is embedded
 * in well under a millisecond.
 *
 * What it captures is shared vocabulary — the identifiers, element and API
 * names a step and an earlier thought have in common — which is what recalling
 * earlier steps of the same task needs. It is not a semantic model; a learned
 * embedding can replace it behind the same signature.
 */

export const THOUGHT_VECTOR_DIMENSIONS = 256;

/** A letter, digit, `_` or `$`: what identifiers and words are made of. */
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** FNV-1a, 32-bit. @param {string} text */
function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** @param {string} text */
export function words(text) {
    /** @type {string[]} */
    const out = [];
    let current = '';
    for (const char of `${text || ''}`.toLowerCase()) {
        if (WORD_CHAR.test(char)) {
            current += char;
        } else if (current) {
            out.push(current);
            current = '';
        }
    }
    if (current) out.push(current);
    return out;
}

/**
 * @param {string} text
 * @param {number} [dimensions]
 * @returns {number[]} a plain array: what idb-vector stores and compares
 */
export function embedText(text, dimensions = THOUGHT_VECTOR_DIMENSIONS) {
    const vector = new Array(dimensions).fill(0);
    const add = (feature, weight) => {
        const h = hash(feature);
        vector[h % dimensions] += h & 0x80000000 ? -weight : weight;
    };
    const tokens = words(text);
    tokens.forEach((word, index) => {
        // Short words are mostly glue ("the", "for", "de", "și"): they count
        // for little, without a list of them to keep.
        add(`w:${word}`, word.length <= 3 ? 0.2 : 1);
        if (index > 0) add(`b:${tokens[index - 1]} ${word}`, 0.5);
        if (word.length > 3) {
            for (let i = 0; i + 3 <= word.length; i += 1) add(`t:${word.slice(i, i + 3)}`, 0.25);
        }
    });
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map((value) => value / norm) : vector;
}

/** Cosine similarity of two unit vectors. @param {number[]} a @param {number[]} b */
export function similarity(a, b) {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i] * b[i];
    return dot;
}
