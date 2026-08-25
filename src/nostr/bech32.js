// @ts-check
/**
 * Minimal bech32 (BIP-173) codec used for NIP-19 `npub` encoding.
 *
 * Implemented locally rather than pulled from a CDN so the only remote module
 * graph the browser needs stays the existing `@noble/*` set. The codec is
 * deliberately limited to what NIP-19 bare entities require: a human readable
 * part plus a 5-bit data payload, checksummed with the original bech32
 * constant (NIP-19 does not use bech32m).
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
/** NIP-19 entities are short; this cap is far above any `npub`/`nprofile`. */
const MAX_LENGTH = 512;

/** @type {Record<string, number>} */
const CHARSET_REV = {};
for (let i = 0; i < CHARSET.length; i++) CHARSET_REV[CHARSET[i]] = i;

export class Bech32Error extends Error {
    constructor(message) {
        super(message);
        this.name = 'Bech32Error';
    }
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function polymod(values) {
    let chk = 1;
    for (const value of values) {
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        for (let i = 0; i < 5; i++) {
            if ((top >> i) & 1) chk ^= GENERATOR[i];
        }
    }
    return chk;
}

/**
 * @param {string} hrp
 * @returns {number[]}
 */
function hrpExpand(hrp) {
    const high = [];
    const low = [];
    for (let i = 0; i < hrp.length; i++) {
        const code = hrp.charCodeAt(i);
        high.push(code >> 5);
        low.push(code & 31);
    }
    return [...high, 0, ...low];
}

/**
 * Regroup bit-widths (8 → 5 for encoding, 5 → 8 for decoding).
 *
 * @param {ArrayLike<number>} data
 * @param {number} fromBits
 * @param {number} toBits
 * @param {boolean} pad
 * @returns {number[]}
 */
export function convertBits(data, fromBits, toBits, pad) {
    let acc = 0;
    let bits = 0;
    const result = [];
    const maxv = (1 << toBits) - 1;
    const maxAcc = (1 << (fromBits + toBits - 1)) - 1;

    for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (value < 0 || value >> fromBits !== 0) throw new Bech32Error('Value out of range for bit conversion.');
        acc = ((acc << fromBits) | value) & maxAcc;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            result.push((acc >> bits) & maxv);
        }
    }

    if (pad) {
        if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
        throw new Bech32Error('Invalid padding in bit conversion.');
    }

    return result;
}

/**
 * @param {string} hrp
 * @param {number[]} data 5-bit words
 * @returns {string}
 */
export function bech32Encode(hrp, data) {
    if (!hrp || typeof hrp !== 'string' || !/^[\x21-\x7e]+$/.test(hrp)) {
        throw new Bech32Error('Invalid bech32 human readable part.');
    }
    const lowerHrp = hrp.toLowerCase();
    const values = [...hrpExpand(lowerHrp), ...data];
    const mod = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ BECH32_CONST;
    const checksum = [];
    for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);

    const encoded = `${lowerHrp}1${[...data, ...checksum].map((value) => CHARSET[value]).join('')}`;
    if (encoded.length > MAX_LENGTH) throw new Bech32Error('Bech32 string exceeds the maximum supported length.');
    return encoded;
}

/**
 * @param {string} value
 * @returns {{ hrp: string, words: number[] }}
 */
export function bech32Decode(value) {
    const input = `${value || ''}`;
    if (!input || input.length > MAX_LENGTH) throw new Bech32Error('Invalid bech32 string length.');

    const lower = input.toLowerCase();
    const upper = input.toUpperCase();
    if (input !== lower && input !== upper) throw new Bech32Error('Bech32 strings must not mix letter cases.');

    const separator = lower.lastIndexOf('1');
    if (separator < 1 || separator + 7 > lower.length) throw new Bech32Error('Malformed bech32 string.');

    const hrp = lower.slice(0, separator);
    if (!/^[\x21-\x7e]+$/.test(hrp)) throw new Bech32Error('Invalid bech32 human readable part.');

    const dataPart = lower.slice(separator + 1);
    const words = [];
    for (const char of dataPart) {
        const index = CHARSET_REV[char];
        if (index === undefined) throw new Bech32Error('Invalid character in bech32 payload.');
        words.push(index);
    }

    if (polymod([...hrpExpand(hrp), ...words]) !== BECH32_CONST) throw new Bech32Error('Bech32 checksum mismatch.');
    return { hrp, words: words.slice(0, -6) };
}
