// @ts-check
/**
 * NIP-19 bare `npub` encoding.
 *
 * Only the public entity is implemented. There is deliberately no `nsec`
 * encoder anywhere in this codebase: the private key never leaves the wallet
 * worker, so an `nsec` could never be produced or persisted.
 */

import { bech32Decode, bech32Encode, convertBits } from './bech32.js';

export const NPUB_PREFIX = 'npub';

const HEX32_RE = /^[0-9a-f]{64}$/;

/**
 * @param {string} publicKeyHex 32-byte x-only public key
 * @returns {string} `npub1…`
 */
export function npubEncode(publicKeyHex) {
    const normalized = `${publicKeyHex || ''}`.trim().replace(/^0x/, '').toLowerCase();
    if (!HEX32_RE.test(normalized)) throw new Error('Nostr public key must be 32 bytes of hex.');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    return bech32Encode(NPUB_PREFIX, convertBits(bytes, 8, 5, true));
}

/**
 * @param {string} npub
 * @returns {string} 64-char lowercase hex
 */
export function npubDecode(npub) {
    const { hrp, words } = bech32Decode(`${npub || ''}`.trim());
    if (hrp !== NPUB_PREFIX) throw new Error(`Expected an ${NPUB_PREFIX} address, received "${hrp}".`);
    const bytes = convertBits(words, 5, 8, false);
    if (bytes.length !== 32) throw new Error('Malformed npub: payload is not 32 bytes.');
    return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Accept either an `npub1…` address or a raw 32-byte hex public key and
 * return the canonical lowercase hex form.
 * @param {string} value
 * @returns {string}
 */
export function normalizeNostrPublicKey(value) {
    const input = `${value || ''}`.trim();
    if (!input) throw new Error('A Nostr address (npub…) is required.');
    if (input.toLowerCase().startsWith(`${NPUB_PREFIX}1`)) return npubDecode(input);
    const hex = input.replace(/^0x/, '').toLowerCase();
    if (HEX32_RE.test(hex)) return hex;
    throw new Error('Enter a valid Nostr address (npub1…) or a 32-byte hex public key.');
}

/**
 * Short display form for the UI: `npub1abcd…wxyz`.
 * @param {string} npub
 */
export function shortNpub(npub) {
    const value = `${npub || ''}`;
    if (value.length < 20) return value;
    return `${value.slice(0, 12)}…${value.slice(-6)}`;
}
