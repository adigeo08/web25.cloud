// @ts-check

import { PEERWEB_CONFIG } from '../config/peerweb.config.js';

class PeerWebCache {
    constructor() {
        this.dbName = 'PeerWebCache';
        this.storeName = 'sites';
        this.maxAge = PEERWEB_CONFIG.CACHE_MAX_AGE;
    }

    /**
     * Open the cache without pinning a version.
     *
     * Pinning one meant that a browser whose database had reached a higher
     * version — for whatever reason, this origin has had several builds —
     * answered every read with `VersionError: The requested version (1) is less
     * than the existing version (2)`, and the cache silently stopped working.
     * Asking for whatever exists cannot collide; the store is created on a
     * single upgrade only when it is genuinely absent.
     */
    async openDB() {
        if (this._db) return this._db;
        const db = await this._open();
        if (db.objectStoreNames.contains(this.storeName)) {
            this._db = db;
            return db;
        }
        // An existing database without our store: one upgrade adds it, at
        // whatever version that browser has reached.
        const version = db.version + 1;
        db.close();
        this._db = await this._open(version);
        return this._db;
    }

    /** @param {number} [version] omit to accept the existing one */
    _open(version) {
        return new Promise((resolve, reject) => {
            const request = version === undefined ? indexedDB.open(this.dbName) : indexedDB.open(this.dbName, version);

            request.onerror = () => reject(request.error);
            request.onblocked = () =>
                reject(new Error('The site cache is open in another tab and cannot be upgraded.'));
            request.onsuccess = () => {
                const opened = request.result;
                // Another tab upgrading later would leave this handle stale.
                opened.onversionchange = () => {
                    opened.close();
                    if (this._db === opened) this._db = null;
                };
                resolve(opened);
            };

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

    /**
     * Await one store operation.
     *
     * `await store.put(record)` reads well and does nothing: an `IDBRequest` is
     * not a promise, so the write was never actually waited for and a failed
     * one was never reported.
     *
     * @param {IDBRequest} request
     */
    _request(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
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

            await this._request(store.put(record));
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

            const result = await this._request(store.get(hash));
            if (result && Date.now() - result.timestamp < this.maxAge) {
                console.log(`[PeerWebCache] Cache hit: ${hash}`);
                return result;
            }
            // A read that fails now reports null like every other cache miss,
            // instead of rejecting out of a caller that never expected it to.
            if (result) await this.delete(hash);
            return null;
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
            await this._request(store.delete(hash));
        } catch (error) {
            console.error('[PeerWebCache] Error deleting from cache:', error);
        }
    }

    async clear() {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            await this._request(store.clear());
            console.log('[PeerWebCache] Cache cleared');
        } catch (error) {
            console.error('[PeerWebCache] Error clearing cache:', error);
        }
    }
}

export default PeerWebCache;
