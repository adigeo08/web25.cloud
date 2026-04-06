// @ts-check

import {
    clearLockKeyCache,
    getLockKey,
    isPasskeySupported,
    lockData,
    removeLocalAccount,
    unlockData
} from '../vendor/local-data-lock/ldl.js';

const DB_NAME = 'web25-auth';
const DB_VERSION = 2;
const STORE_WALLETS = 'wallets';
const STORE_KEYS = 'keys';
const LOCAL_WALLET_ID = 'default-local-wallet';
const LOCAL_IDENTITY_STORAGE_KEY = 'web25.passkey.localIdentityID';

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_WALLETS)) {
                db.createObjectStore(STORE_WALLETS, { keyPath: 'walletId' });
            }
            if (db.objectStoreNames.contains(STORE_KEYS)) {
                db.deleteObjectStore(STORE_KEYS);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function readRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

function writeRecord(db, storeName, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).put(value);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

function deleteRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
}

function fromBase64(base64) {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function getStoredLocalIdentityID() {
    return localStorage.getItem(LOCAL_IDENTITY_STORAGE_KEY);
}

export async function getLocalWalletRecord() {
    const db = await openDb();
    return readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
}

export async function encryptPrivateKey(privateKeyHex, lockKey) {
    const payload = new TextEncoder().encode(privateKeyHex);
    const encryptedBytes = await lockData(payload, lockKey);
    return {
        encryptedBlob: toBase64(encryptedBytes)
    };
}

export async function decryptPrivateKey(encryptedBlob, localIdentityID) {
    const encryptedBytes = fromBase64(encryptedBlob);
    const lockKey = await getLockKey({ localIdentity: localIdentityID || getStoredLocalIdentityID() || undefined });
    const decryptedBytes = await unlockData(encryptedBytes, lockKey);
    return new TextDecoder().decode(decryptedBytes);
}

export async function saveLocalWallet(record) {
    const db = await openDb();
    await writeRecord(db, STORE_WALLETS, {
        ...record,
        walletId: LOCAL_WALLET_ID,
        lastUsedAt: new Date().toISOString()
    });
    if (record.localIdentityID) {
        localStorage.setItem(LOCAL_IDENTITY_STORAGE_KEY, record.localIdentityID);
    }
}

export async function addAlternatePasskey(localIdentityID) {
    await getLockKey({
        localIdentity: localIdentityID || getStoredLocalIdentityID() || undefined,
        addNewPasskey: true
    });
}

export function clearBiometricSession() {
    clearLockKeyCache();
}

export function passkeySupported() {
    return isPasskeySupported();
}

export async function deleteLocalWallet() {
    const db = await openDb();
    const record = await readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
    await deleteRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);

    if (record?.localIdentityID) {
        await removeLocalAccount(record.localIdentityID);
    }
    localStorage.removeItem(LOCAL_IDENTITY_STORAGE_KEY);
}

export async function createPasskeyLock(address) {
    const lockKey = await getLockKey({
        addNewPasskey: true,
        username: address.slice(0, 10),
        displayName: `web25 wallet ${address.slice(0, 6)}`
    });

    localStorage.setItem(LOCAL_IDENTITY_STORAGE_KEY, lockKey.localIdentity);
    return lockKey;
}
