// @ts-check

const DB_NAME = 'web25-access';
const DB_VERSION = 1;
const STORE_GRANTS = 'grants';
const STORE_ACCESS_KEYS = 'access_keys';
const STORE_WRAPPING_KEYS = 'wrapping_keys';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_GRANTS)) {
                const grants = db.createObjectStore(STORE_GRANTS, { keyPath: 'grantId' });
                grants.createIndex('siteId', 'siteId', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_ACCESS_KEYS)) {
                db.createObjectStore(STORE_ACCESS_KEYS, { keyPath: 'walletAddress' });
            }
            if (!db.objectStoreNames.contains(STORE_WRAPPING_KEYS)) {
                db.createObjectStore(STORE_WRAPPING_KEYS, { keyPath: 'walletAddress' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function putRecord(db, storeName, value) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const req = tx.objectStore(storeName).put(value);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

function getRecord(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export async function saveGrant(grant) {
    const db = await openDb();
    await putRecord(db, STORE_GRANTS, grant);
}

export async function getGrantsBySite(siteId) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_GRANTS, 'readonly');
        const index = tx.objectStore(STORE_GRANTS).index('siteId');
        const req = index.getAll(siteId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export async function listAllGrants() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_GRANTS, 'readonly');
        const req = tx.objectStore(STORE_GRANTS).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export async function getAccessKeyRecord(walletAddress) {
    const db = await openDb();
    return getRecord(db, STORE_ACCESS_KEYS, walletAddress.toLowerCase());
}

export async function saveAccessKeyRecord(record) {
    const db = await openDb();
    await putRecord(db, STORE_ACCESS_KEYS, {
        ...record,
        walletAddress: record.walletAddress.toLowerCase()
    });
}

export async function getWrappingKeyRecord(walletAddress) {
    const db = await openDb();
    return getRecord(db, STORE_WRAPPING_KEYS, walletAddress.toLowerCase());
}

export async function saveWrappingKeyRecord(walletAddress, wrappingKey) {
    const db = await openDb();
    await putRecord(db, STORE_WRAPPING_KEYS, { walletAddress: walletAddress.toLowerCase(), wrappingKey });
}
