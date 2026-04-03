// @ts-check

import { PEERWEB_CONFIG } from '../config/peerweb.config.js';

class PeerWebCache {
    constructor() {
        this.dbName = 'PeerWebCache';
        this.version = 1;
        this.storeName = 'sites';
        this.maxAge = PEERWEB_CONFIG.CACHE_MAX_AGE;
    }

    async openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const target = /** @type {IDBOpenDBRequest} */ (event.target);
                const db = target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'hash' });
                    store.createIndex('timestamp', 'timestamp');
                }
            };
        });
    }

    async set(hash, siteData, metadata = {}) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const record = {
                hash,
                data: siteData,
                signatureState: metadata.signatureState || null,
                timestamp: Date.now()
            };

            await store.put(record);
            console.log(`[PeerWebCache] Cached site: ${hash}`);
        } catch (error) {
            console.error('[PeerWebCache] Error caching site:', error);
        }
    }

    async getEntry(hash) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);

            return new Promise((resolve, reject) => {
                const request = store.get(hash);
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && Date.now() - result.timestamp < this.maxAge) {
                        console.log(`[PeerWebCache] Cache hit: ${hash}`);
                        resolve(result);
                    } else {
                        if (result) {
                            this.delete(hash);
                        }
                        resolve(null);
                    }
                };
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('[PeerWebCache] Error retrieving from cache:', error);
            return null;
        }
    }

    async get(hash) {
        const entry = await this.getEntry(hash);
        return entry?.data || null;
    }

    async delete(hash) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            await store.delete(hash);
        } catch (error) {
            console.error('[PeerWebCache] Error deleting from cache:', error);
        }
    }

    async clear() {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            await store.clear();
            console.log('[PeerWebCache] Cache cleared');
        } catch (error) {
            console.error('[PeerWebCache] Error clearing cache:', error);
        }
    }
}

export default PeerWebCache;
