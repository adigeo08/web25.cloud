// @ts-check

/**
 * Encrypt a UTF-8 string using AES-GCM 256-bit.
 * Returns: "<iv_hex>:<ciphertext_hex>"
 * @param {string} plaintext
 * @param {string} hexKey  — 64-char hex string (32 bytes)
 * @returns {Promise<string>}
 */
export async function encryptMessage(plaintext, hexKey) {
    const keyBytes = hexToBytes(hexKey);
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    return bufToHex(iv) + ':' + bufToHex(new Uint8Array(ciphertext));
}

/**
 * Decrypt a string produced by encryptMessage.
 * @param {string} encrypted  — "<iv_hex>:<ciphertext_hex>"
 * @param {string} hexKey
 * @returns {Promise<string>}
 */
export async function decryptMessage(encrypted, hexKey) {
    const colonIdx = encrypted.indexOf(':');
    if (colonIdx === -1) throw new Error('Invalid encrypted format');
    const ivHex = encrypted.slice(0, colonIdx);
    const ctHex = encrypted.slice(colonIdx + 1);
    const keyBytes = hexToBytes(hexKey);
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex) }, cryptoKey, hexToBytes(ctHex));
    return new TextDecoder().decode(plain);
}

function hexToBytes(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) {
        arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return arr;
}

function bufToHex(buf) {
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
