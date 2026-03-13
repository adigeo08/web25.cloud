// @ts-check

const DB_NAME = 'web25-auth';
const DB_VERSION = 1;
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
            if (!db.objectStoreNames.contains(STORE_KEYS)) {
                db.createObjectStore(STORE_KEYS, { keyPath: 'keyId' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function ensureKeyRecord() {
    const db = await openDb();
    const existing = await readRecord(db, STORE_KEYS, LOCAL_WALLET_ID);
    if (existing) {
        return existing.wrappingKey;
    }

    const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt'
    ]);

    await writeRecord(db, STORE_KEYS, { keyId: LOCAL_WALLET_ID, wrappingKey });
    return wrappingKey;
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

export async function getLocalWalletRecord() {
    const db = await openDb();
    return readRecord(db, STORE_WALLETS, LOCAL_WALLET_ID);
}

export async function encryptPrivateKey(privateKeyHex) {
    const wrappingKey = await ensureKeyRecord();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(privateKeyHex);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, data);
    return {
        encryptedPrivateKey: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
        iv: btoa(String.fromCharCode(...iv))
    };
}

export async function decryptPrivateKey(encryptedPrivateKey, ivBase64) {
    const wrappingKey = await ensureKeyRecord();
    const iv = Uint8Array.from(atob(ivBase64), (char) => char.charCodeAt(0));
    const encrypted = Uint8Array.from(atob(encryptedPrivateKey), (char) => char.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrappingKey, encrypted);
    return new TextDecoder().decode(decrypted);
}

export async function saveLocalWallet(record) {
    const db = await openDb();
    await writeRecord(db, STORE_WALLETS, {
        ...record,
        walletId: LOCAL_WALLET_ID,
        lastUsedAt: new Date().toISOString()
    });
}

export async function deleteLocalWallet() {
    const db = await openDb();
    await Promise.all([
        new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_WALLETS, 'readwrite');
            const req = tx.objectStore(STORE_WALLETS).delete(LOCAL_WALLET_ID);
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.error);
        }),
        new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_KEYS, 'readwrite');
            const req = tx.objectStore(STORE_KEYS).delete(LOCAL_WALLET_ID);
            req.onsuccess = () => resolve(true);
            req.onerror = () => reject(req.error);
        })
    ]);
}
