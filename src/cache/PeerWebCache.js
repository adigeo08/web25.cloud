// @ts-check

import { PEERWEB_CONFIG } from '../config/peerweb.config.js';

class PeerWebCache {
    constructor() {
        this.dbName = 'PeerWebCache';
        this.version = 2;
        this.storeName = 'sites';
        this.sessionStoreName = 'sessions';
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
                if (!db.objectStoreNames.contains(this.sessionStoreName)) {
                    db.createObjectStore(this.sessionStoreName, { keyPath: 'key' });
                }
            };
        });
    }

    async set(hash, data) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const record = {
                hash: hash,
                data: data,
                timestamp: Date.now()
            };

            await store.put(record);
            console.log(`[PeerWebCache] Cached site: ${hash}`);
        } catch (error) {
            console.error('[PeerWebCache] Error caching site:', error);
        }
    }

    async get(hash) {
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
                        resolve(result.data);
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

    async setSession(key, value) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.sessionStoreName], 'readwrite');
            const store = transaction.objectStore(this.sessionStoreName);
            await store.put({ key, value, timestamp: Date.now() });
        } catch (error) {
            console.error('[PeerWebCache] Error storing session cache:', error);
        }
    }

    async getSession(key) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.sessionStoreName], 'readonly');
            const store = transaction.objectStore(this.sessionStoreName);
            return await new Promise((resolve, reject) => {
                const request = store.get(key);
                request.onsuccess = () => resolve(request.result?.value ?? null);
                request.onerror = () => reject(request.error);
            });
        } catch (error) {
            console.error('[PeerWebCache] Error reading session cache:', error);
            return null;
        }
    }

    async deleteSession(key) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.sessionStoreName], 'readwrite');
            const store = transaction.objectStore(this.sessionStoreName);
            await store.delete(key);
        } catch (error) {
            console.error('[PeerWebCache] Error deleting session cache:', error);
        }
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
            const transaction = db.transaction([this.storeName, this.sessionStoreName], 'readwrite');
            await transaction.objectStore(this.storeName).clear();
            await transaction.objectStore(this.sessionStoreName).clear();
            console.log('[PeerWebCache] Cache cleared');
        } catch (error) {
            console.error('[PeerWebCache] Error clearing cache:', error);
        }
    }
}

export default PeerWebCache;
