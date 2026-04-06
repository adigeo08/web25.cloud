// @ts-check
/**
 * ECIES (Elliptic Curve Integrated Encryption Scheme) on secp256k1.
 *
 * Encryption:  ephemeral ECDH → HKDF-SHA256 → AES-256-GCM
 * Signing:     ECDSA / SHA-256 on secp256k1 (compact 64-byte signature)
 * Identity:    keccak256(pubKey[1:])[-20:] → EVM address
 *
 * Wire format for encrypted messages (hex):
 *   ephPubKey(65B) || iv(12B) || aesCiphertext(variable)
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

// ─── internal helpers ────────────────────────────────────────────────────

function hexToBytes(hex) {
    const clean = `${hex}`.startsWith('0x') ? hex.slice(2) : hex;
    const arr = new Uint8Array(clean.length / 2);
    for (let i = 0; i < arr.length; i++) {
        arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return arr;
}

function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HKDF-SHA256 using WebCrypto — returns `length` derived bytes. */
async function hkdfSha256(inputKeyMaterial, length = 32) {
    const ikm = inputKeyMaterial instanceof Uint8Array ? inputKeyMaterial : new Uint8Array(inputKeyMaterial);
    const keyMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode('web25-ecies-salt'),
            info: new TextEncoder().encode('web25-ecies-v1')
        },
        keyMaterial,
        length * 8
    );
    return new Uint8Array(bits);
}

/** SHA-256 of arbitrary bytes using WebCrypto. */
async function sha256(data) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// ─── public API ──────────────────────────────────────────────────────────

/**
 * Derive the secp256k1 uncompressed public key from a private key.
 * @param {string} privateKeyHex  — 0x-prefixed or bare 64-char hex
 * @returns {string}  — 130-char hex string ("04" + x + y), no "0x" prefix
 */
export function getPublicKeyFromPrivateKey(privateKeyHex) {
    return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKeyHex), false));
}

/**
 * Derive the EVM address from a secp256k1 uncompressed public key.
 * Implements: keccak256(pubKey[1:])[-20:]
 * @param {string} publicKeyHex  — "04..." 130-char hex (with or without "0x")
 * @returns {string}  — "0x"-prefixed, lowercase EVM address
 */
export function evmAddressFromPublicKey(publicKeyHex) {
    const pubKeyBytes = hexToBytes(publicKeyHex);
    // Drop the first byte (0x04 uncompressed marker or 0x02/0x03 compressed marker)
    const keyBody = pubKeyBytes.slice(1);
    const hash = keccak_256(keyBody);
    return '0x' + bytesToHex(hash.slice(-20));
}

/**
 * Encrypt `plaintext` for a recipient identified by their secp256k1 public key.
 * Uses ECIES: ephemeral ECDH + HKDF-SHA256 + AES-256-GCM.
 * @param {string} plaintext
 * @param {string} recipientPublicKeyHex  — uncompressed "04..." public key
 * @returns {Promise<string>}  hex-encoded wire payload
 */
export async function eciesEncrypt(plaintext, recipientPublicKeyHex) {
    // 1. Generate ephemeral key pair
    const ephPrivKey = secp256k1.utils.randomPrivateKey();
    const ephPubKey = secp256k1.getPublicKey(ephPrivKey, false); // 65 bytes uncompressed

    // 2. ECDH shared point (compressed 33 bytes)
    const recipPubKeyBytes = hexToBytes(recipientPublicKeyHex);
    const sharedPoint = secp256k1.getSharedSecret(ephPrivKey, recipPubKeyBytes, true);

    // 3. Derive AES-GCM key via HKDF-SHA256
    const encKey = await hkdfSha256(sharedPoint);

    // 4. Encrypt with AES-256-GCM
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        new TextEncoder().encode(plaintext)
    );

    // 5. Wire: ephPubKey(65B) || iv(12B) || ciphertext
    return bytesToHex(ephPubKey) + bytesToHex(iv) + bytesToHex(new Uint8Array(ciphertext));
}

/**
 * Decrypt an ECIES-encrypted ciphertext using own private key.
 * @param {string} encryptedHex  — wire payload from eciesEncrypt
 * @param {string} ownPrivateKeyHex  — 0x-prefixed or bare private key
 * @returns {Promise<string>}  decrypted plaintext
 */
export async function eciesDecrypt(encryptedHex, ownPrivateKeyHex) {
    const EPH_HEX = 65 * 2; // 130 chars
    const IV_HEX = 12 * 2; // 24 chars

    const ephPubKeyBytes = hexToBytes(encryptedHex.slice(0, EPH_HEX));
    const iv = hexToBytes(encryptedHex.slice(EPH_HEX, EPH_HEX + IV_HEX));
    const ciphertext = hexToBytes(encryptedHex.slice(EPH_HEX + IV_HEX));

    const ownPrivKeyBytes = hexToBytes(ownPrivateKeyHex);
    const sharedPoint = secp256k1.getSharedSecret(ownPrivKeyBytes, ephPubKeyBytes, true);

    const encKey = await hkdfSha256(sharedPoint);

    const aesKey = await crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);

    return new TextDecoder().decode(plaintext);
}

/**
 * Sign a UTF-8 message string with a secp256k1 private key.
 * Hash: SHA-256(message bytes) → 32 bytes, then ECDSA.
 * @param {string} message
 * @param {string} privateKeyHex
 * @returns {Promise<string>}  — 64-byte compact DER-less signature as hex
 */
export async function signMessage(message, privateKeyHex) {
    const msgHash = await sha256(new TextEncoder().encode(message));
    const sig = secp256k1.sign(msgHash, hexToBytes(privateKeyHex), { lowS: true });
    return bytesToHex(sig.toCompactRawBytes());
}

/**
 * Verify a secp256k1 signature on a UTF-8 message.
 * @param {string} message
 * @param {string} signatureHex  — 64-byte compact signature as hex
 * @param {string} publicKeyHex  — uncompressed public key as hex
 * @returns {Promise<boolean>}
 */
export async function verifySignature(message, signatureHex, publicKeyHex) {
    try {
        const msgHash = await sha256(new TextEncoder().encode(message));
        const sig = secp256k1.Signature.fromCompact(hexToBytes(signatureHex));
        return secp256k1.verify(sig, msgHash, hexToBytes(publicKeyHex));
    } catch (_) {
        return false;
    }
}
