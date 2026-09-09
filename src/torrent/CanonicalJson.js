// @ts-check
/**
 * Deterministic serialisation and hashing helpers shared by everything that
 * signs, verifies or binds protected-asset material.
 *
 * Two parties must agree byte for byte on what a signature or a hash covers,
 * so this module refuses anything whose serialisation is ambiguous: object key
 * order is normalised, and values JSON cannot represent losslessly (undefined,
 * NaN, functions, cycles) are rejected instead of being silently dropped.
 *
 * It has no imports on purpose: the dedicated wallet worker loads it without an
 * import map, and it must behave identically there, on the main thread and in
 * Node-based tests.
 */

export class CanonicalJsonError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CanonicalJsonError';
    }
}

/**
 * JSON with every object's keys in code-unit order. Arrays keep their order —
 * callers that need a canonical ordering inside an array sort it themselves,
 * because only they know which field identifies an element.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    return serialize(value, new Set());
}

/**
 * @param {unknown} value
 * @param {Set<unknown>} seen
 * @returns {string}
 */
function serialize(value, seen) {
    if (value === null) return 'null';

    const type = typeof value;
    if (type === 'boolean') return value ? 'true' : 'false';
    if (type === 'string') return JSON.stringify(value);
    if (type === 'number') {
        if (!Number.isFinite(value)) {
            throw new CanonicalJsonError('Canonical JSON cannot represent a non-finite number.');
        }
        return JSON.stringify(value);
    }
    if (type !== 'object') {
        throw new CanonicalJsonError(`Canonical JSON cannot represent a value of type ${type}.`);
    }

    if (seen.has(value)) {
        throw new CanonicalJsonError('Canonical JSON cannot represent a cyclic structure.');
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return `[${value.map((entry) => serialize(entry, seen)).join(',')}]`;
        }

        const source = /** @type {Record<string, unknown>} */ (value);
        const keys = Object.keys(source).sort();
        const parts = [];
        for (const key of keys) {
            const entry = source[key];
            if (entry === undefined) {
                throw new CanonicalJsonError(`Canonical JSON cannot represent undefined (key "${key}").`);
            }
            parts.push(`${JSON.stringify(key)}:${serialize(entry, seen)}`);
        }
        return `{${parts.join(',')}}`;
    } finally {
        seen.delete(value);
    }
}

const HEX_RE = /^[0-9a-fA-F]*$/;

/** @param {Uint8Array} bytes */
export function bytesToHex(bytes) {
    let hex = '';
    for (let index = 0; index < bytes.length; index += 1) {
        hex += bytes[index].toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * @param {string} hex with or without a `0x` prefix
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
    const normalized = `${hex}`.startsWith('0x') ? `${hex}`.slice(2) : `${hex}`;
    if (normalized.length % 2 !== 0 || !HEX_RE.test(normalized)) {
        throw new CanonicalJsonError('Expected an even-length hex string.');
    }
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
    if (typeof btoa === 'function') {
        let binary = '';
        for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
        return btoa(binary);
    }
    // Node test runtime.
    return Buffer.from(bytes).toString('base64');
}

/** @param {string} base64 */
export function base64ToBytes(base64) {
    if (typeof atob === 'function') {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** @param {string} text */
export function utf8Bytes(text) {
    return new TextEncoder().encode(text);
}

/** @param {Uint8Array} bytes */
export function utf8Text(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * @param {...Uint8Array} parts
 * @returns {Uint8Array}
 */
export function concatBytes(...parts) {
    let length = 0;
    for (const part of parts) length += part.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function sha256Bytes(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const digest = await crypto.subtle.digest('SHA-256', view);
    return new Uint8Array(digest);
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256Hex(bytes) {
    return bytesToHex(await sha256Bytes(bytes));
}

/**
 * SHA-256 over the canonical JSON of `value`.
 * @param {unknown} value
 * @returns {Promise<string>}
 */
export async function sha256CanonicalHex(value) {
    return sha256Hex(utf8Bytes(canonicalJson(value)));
}

/**
 * Length-independent comparison for hex digests and other public tags.
 * @param {string} left
 * @param {string} right
 */
export function timingSafeEqualHex(left, right) {
    const a = `${left || ''}`.toLowerCase();
    const b = `${right || ''}`.toLowerCase();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let index = 0; index < a.length; index += 1) {
        diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
    }
    return diff === 0;
}
