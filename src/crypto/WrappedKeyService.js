// @ts-check

import { base64ToBytes, bytesToBase64 } from './Base64.js';

export async function importRecipientEncryptionPublicKey(base64PublicKey) {
    const bytes = base64ToBytes(base64PublicKey);
    return crypto.subtle.importKey(
        'spki',
        bytes.buffer,
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true,
        ['wrapKey']
    );
}

export async function wrapBlockKeyForRecipient(blockKey, recipientPublicKey) {
    const wrapped = await crypto.subtle.wrapKey('raw', blockKey, recipientPublicKey, { name: 'RSA-OAEP' });
    return bytesToBase64(new Uint8Array(wrapped));
}

export async function unwrapBlockKey(wrappedKeyBase64, privateKey) {
    const wrappedBytes = base64ToBytes(wrappedKeyBase64);
    return crypto.subtle.unwrapKey(
        'raw',
        wrappedBytes,
        privateKey,
        { name: 'RSA-OAEP' },
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
    );
}
