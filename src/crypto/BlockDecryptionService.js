// @ts-check

import { base64ToBytes, bytesToText } from './Base64.js';

export async function decryptHtmlBlock({ ivBase64, ciphertextBase64, blockKey }) {
    const iv = base64ToBytes(ivBase64);
    const ciphertext = base64ToBytes(ciphertextBase64);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, blockKey, ciphertext);
    return bytesToText(new Uint8Array(plaintext));
}
