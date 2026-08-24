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
 *
 * The algorithms live in `eciesCore.js` so the dedicated wallet worker — which
 * cannot use the page import map — can build the very same primitives.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { createEcies } from './eciesCore.js';

const ecies = createEcies({ secp256k1, keccak_256 });

/**
 * Derive the secp256k1 uncompressed public key from a private key.
 * @param {string} privateKeyHex  — 0x-prefixed or bare 64-char hex
 * @returns {string}  — 130-char hex string ("04" + x + y), no "0x" prefix
 */
export const getPublicKeyFromPrivateKey = ecies.getPublicKeyFromPrivateKey;

/**
 * Derive the EVM address from a secp256k1 uncompressed public key.
 * Implements: keccak256(pubKey[1:])[-20:]
 * @param {string} publicKeyHex  — "04..." 130-char hex (with or without "0x")
 * @returns {string}  — "0x"-prefixed, lowercase EVM address
 */
export const evmAddressFromPublicKey = ecies.evmAddressFromPublicKey;

/**
 * Encrypt `plaintext` for a recipient identified by their secp256k1 public key.
 * @param {string} plaintext
 * @param {string} recipientPublicKeyHex  — uncompressed "04..." public key
 * @returns {Promise<string>}  hex-encoded wire payload
 */
export const eciesEncrypt = ecies.eciesEncrypt;

/**
 * Decrypt an ECIES-encrypted ciphertext using own private key.
 * @param {string} encryptedHex  — wire payload from eciesEncrypt
 * @param {string} ownPrivateKeyHex  — 0x-prefixed or bare private key
 * @returns {Promise<string>}  decrypted plaintext
 */
export const eciesDecrypt = ecies.eciesDecrypt;

/**
 * Sign a UTF-8 message string with a secp256k1 private key.
 * @param {string} message
 * @param {string} privateKeyHex
 * @returns {Promise<string>}  — 64-byte compact signature as hex
 */
export const signMessage = ecies.signMessage;

/**
 * Verify a secp256k1 signature on a UTF-8 message.
 * @param {string} message
 * @param {string} signatureHex  — 64-byte compact signature as hex
 * @param {string} publicKeyHex  — uncompressed public key as hex
 * @returns {Promise<boolean>}
 */
export const verifySignature = ecies.verifySignature;

/**
 * EIP-191 `personal_sign` over a UTF-8 string.
 * @param {string} message
 * @param {string} privateKeyHex
 * @returns {`0x${string}`}
 */
export const signEvmMessage = ecies.signEvmMessage;
