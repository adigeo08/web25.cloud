// @ts-check

import { bytesToBase64, textToBytes } from './Base64.js';

export async function createBlockKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportBlockKeyRaw(blockKey) {
    const raw = await crypto.subtle.exportKey('raw', blockKey);
    return new Uint8Array(raw);
}

export async function encryptHtmlBlock(html, blockKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = textToBytes(html);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, blockKey, plaintext);
    return {
        alg: 'AES-GCM',
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
}
