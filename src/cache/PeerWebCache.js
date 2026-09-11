// @ts-check

import { PEERWEB_CONFIG } from '../config/peerweb.config.js';
import { buildLibraryEntry, searchLibrary } from './SiteLibraryIndex.js';

class PeerWebCache {
    constructor() {
        this.dbName = 'PeerWebCache';
        this.storeName = 'sites';
        /**
         * A second, tiny store holding only what a site can be searched by.
         *
         * The cached sites themselves are whole websites — reading them all
         * back to answer "which of these mentions photography?" would pull
         * every byte of every site into memory for a keystroke. The index row
         * is a few hundred bytes: title, file names, publisher, hash.
         */
        this.libraryStore = 'library';
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
        if (db.objectStoreNames.contains(this.storeName) && db.objectStoreNames.contains(this.libraryStore)) {
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
                if (!db.objectStoreNames.contains(this.libraryStore)) {
                    db.createObjectStore(this.libraryStore, { keyPath: 'hash' });
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
        const timestamp = Date.now();
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            const record = {
                hash,
                data: siteData,
                signatureState: metadata.signatureState || null,
                timestamp
            };

            await this._request(store.put(record));
            console.log(`[PeerWebCache] Cached site: ${hash}`);
        } catch (error) {
            console.error('[PeerWebCache] Error caching site:', error);
            return;
        }

        // Indexing is a separate transaction on purpose: a site that is cached
        // but unsearchable is a small loss, and must not become a site that
        // failed to cache.
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.libraryStore], 'readwrite');
            await this._request(
                transaction.objectStore(this.libraryStore).put(
                    buildLibraryEntry({
                        hash,
                        siteData,
                        signatureState: metadata.signatureState || null,
                        timestamp,
                        url: metadata.url || ''
                    })
                )
            );
        } catch (error) {
            console.warn('[PeerWebCache] Site cached but not indexed:', error);
        }
    }

    /**
     * Index the sites that were cached before the library existed.
     *
     * Adding the store does not populate it, so without this every site a
     * visitor had already loaded would be missing from the library until they
     * happened to open it again — which is exactly the case the library is for.
     * Runs once per page, reads one site at a time rather than pulling every
     * cached website into memory at once, and never blocks a search: a
     * half-finished backfill just means fewer results this time.
     *
     * @returns {Promise<number>} how many rows were added
     */
    async backfillLibrary() {
        if (this._backfilled) return 0;
        this._backfilled = true;

        try {
            const db = await this.openDB();
            const cached = await this._request(
                db.transaction([this.storeName], 'readonly').objectStore(this.storeName).getAllKeys()
            );
            const hashes = Array.isArray(cached) ? cached : [];
            if (hashes.length === 0) return 0;

            const existing = await this._request(
                db.transaction([this.libraryStore], 'readonly').objectStore(this.libraryStore).getAllKeys()
            );
            const indexed = new Set(Array.isArray(existing) ? existing : []);
            const missing = hashes.filter((hash) => !indexed.has(hash));
            if (missing.length === 0) return 0;

            let added = 0;
            for (const hash of missing) {
                const record = await this._request(
                    db.transaction([this.storeName], 'readonly').objectStore(this.storeName).get(hash)
                );
                if (!record?.data) continue;
                await this._request(
                    db
                        .transaction([this.libraryStore], 'readwrite')
                        .objectStore(this.libraryStore)
                        .put(
                            buildLibraryEntry({
                                hash,
                                siteData: record.data,
                                signatureState: record.signatureState || null,
                                timestamp: record.timestamp || Date.now()
                            })
                        )
                );
                added += 1;
            }
            if (added > 0) console.log(`[PeerWebCache] Indexed ${added} previously cached site(s)`);
            return added;
        } catch (error) {
            console.warn('[PeerWebCache] Could not index previously cached sites:', error);
            return 0;
        }
    }

    /**
     * Every indexed site in this browser, newest first.
     * @returns {Promise<any[]>}
     */
    async listLibrary() {
        await this.backfillLibrary();
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.libraryStore], 'readonly');
            const rows = await this._request(transaction.objectStore(this.libraryStore).getAll());
            const entries = Array.isArray(rows) ? rows : [];
            // An index row outliving its site would open onto a cache miss.
            const fresh = entries.filter((entry) => Date.now() - (entry.savedAt || 0) < this.maxAge);
            return searchLibrary(fresh, '');
        } catch (error) {
            console.error('[PeerWebCache] Error listing the local library:', error);
            return [];
        }
    }

    /**
     * Free-text search across the local library.
     * @param {string} query
     */
    async searchLibrary(query) {
        return searchLibrary(await this.listLibrary(), query);
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
        // The index follows the site: a row pointing at bytes that are gone
        // would offer the user a result that opens onto a cache miss.
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.libraryStore], 'readwrite');
            await this._request(transaction.objectStore(this.libraryStore).delete(hash));
        } catch (_) {}
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
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.libraryStore], 'readwrite');
            await this._request(transaction.objectStore(this.libraryStore).clear());
        } catch (_) {}
    }
}

export default PeerWebCache;
