// @ts-check

import {
    addPasskey,
    clearBiometricSession,
    createPasskey,
    deletePasskey,
    openData,
    passkeySupported,
    sealData,
    unlockPasskey
} from './PasskeyVault.js';

const DB_NAME = 'web25-auth';
const DB_VERSION = 2;
const STORE_WALLETS = 'wallets';
const STORE_KEYS = 'keys';
const LOCAL_WALLET_ID = 'default-local-wallet';

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

export async function getLocalWalletRecord() {
    const db = await openDb();
    return readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
}

export async function encryptPrivateKey(privateKeyHex, encPK) {
    const encryptedBlob = await sealData(privateKeyHex, encPK);
    return { encryptedBlob };
}

export async function decryptPrivateKey(encryptedBlob, credentialId) {
    const { encSK } = await unlockPasskey(credentialId);
    return openData(encryptedBlob, encSK);
}

export async function saveLocalWallet(record) {
    const db = await openDb();
    await writeRecord(db, STORE_WALLETS, {
        ...record,
        walletId: LOCAL_WALLET_ID,
        lastUsedAt: new Date().toISOString()
    });
}

export async function addAlternatePasskey(credentialId) {
    await addPasskey(credentialId);
}

export { clearBiometricSession, passkeySupported };

export async function deleteLocalWallet() {
    const db = await openDb();
    const record = await readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
    await deleteRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);

    if (record?.credentialId) {
        await deletePasskey(record.credentialId);
    }
}

export async function createPasskeyLock(address) {
    const passkey = await createPasskey({
        username: address.slice(0, 10),
        displayName: `web25 wallet ${address.slice(0, 6)}`
    });
    return {
        credentialId: passkey.credentialId,
        encPK: passkey.encPK,
        encPKStored: passkey.encPK
    };
}
