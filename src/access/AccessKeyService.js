// @ts-check

import { signWithLocalWallet } from '../auth/LocalWalletService.js';
import { base64ToBytes, bytesToBase64 } from '../crypto/Base64.js';
import {
    getAccessKeyRecord,
    getWrappingKeyRecord,
    saveAccessKeyRecord,
    saveWrappingKeyRecord
} from './AccessGrantStore.js';

async function ensureWrappingKey(walletAddress) {
    const existing = await getWrappingKeyRecord(walletAddress);
    if (existing?.wrappingKey) return existing.wrappingKey;

    const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await saveWrappingKeyRecord(walletAddress, wrappingKey);
    return wrappingKey;
}

async function encryptPrivateKey(pkcs8Bytes, walletAddress) {
    const wrappingKey = await ensureWrappingKey(walletAddress);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, pkcs8Bytes);
    return {
        encryptedPrivateKey: bytesToBase64(new Uint8Array(encrypted)),
        iv: bytesToBase64(iv)
    };
}

async function decryptPrivateKey(record) {
    const wrappingKey = await ensureWrappingKey(record.walletAddress);
    const iv = base64ToBytes(record.iv);
    const encrypted = base64ToBytes(record.encryptedPrivateKey);
    const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, encrypted);
    return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['unwrapKey']);
}

export async function ensureAccessKeyPair(walletAddress) {
    const normalized = walletAddress.toLowerCase();
    const existing = await getAccessKeyRecord(normalized);
    if (existing?.publicKey && existing?.encryptedPrivateKey && existing?.bindingSignature) {
        return existing;
    }

    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
        },
        true,
        ['wrapKey', 'unwrapKey']
    );

    const publicKeySpki = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    const privateKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const publicKey = bytesToBase64(new Uint8Array(publicKeySpki));
    const encryptedPrivate = await encryptPrivateKey(privateKeyPkcs8, normalized);
    const bindMessage = `Bind Web25 content access key: ${publicKey}`;
    const bindingSignature = await signWithLocalWallet(bindMessage);

    const record = {
        walletAddress: normalized,
        publicKey,
        encryptedPrivateKey: encryptedPrivate.encryptedPrivateKey,
        iv: encryptedPrivate.iv,
        bindingSignature,
        createdAt: Date.now()
    };

    await saveAccessKeyRecord(record);
    return record;
}

export async function getAccessPublicKey(walletAddress) {
    const normalized = walletAddress.toLowerCase();
    const record = await getAccessKeyRecord(normalized);
    if (!record) return null;
    return record.publicKey;
}

export async function getAccessPrivateKey(walletAddress) {
    const normalized = walletAddress.toLowerCase();
    const record = await getAccessKeyRecord(normalized);
    if (!record) return null;
    return decryptPrivateKey(record);
}
