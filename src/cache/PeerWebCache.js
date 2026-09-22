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
        /**
         * A third store: what it would take to put a site back on the air.
         *
         * Kept apart from the site itself because the two answer different
         * questions. `sites` holds the site as it *renders* — the unpacked
         * bundle the sandbox reads from. This holds the payload as it
         * *travelled*, which is what the swarm serves and the only form that
         * hashes to the info hash the link names; in bundle mode those are not
         * the same bytes, and re-packing the rendered files would not
         * reproduce them.
         *
         * Separate stores also mean a payload can exist without a rendered
         * copy and the other way round: a site deployed from here is
         * reseedable before anybody has ever opened it, and a site that has
         * only been read can be reseeded once it has been captured.
         */
        this.payloadStore = 'payloads';
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
        if (
            db.objectStoreNames.contains(this.storeName) &&
            db.objectStoreNames.contains(this.libraryStore) &&
            db.objectStoreNames.contains(this.payloadStore)
        ) {
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
                if (!db.objectStoreNames.contains(this.payloadStore)) {
                    db.createObjectStore(this.payloadStore, { keyPath: 'hash' });
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

    /**
     * Await a write the way `SeedingSessionStore` does: on the transaction.
     *
     * A successful `put` is not a durable write. IndexedDB reports the request
     * as soon as it is applied *inside* the transaction, and the transaction
     * can still abort afterwards — a quota the browser only discovers while
     * flushing, a version change, a tab being killed. For a cached site that
     * is a cache miss later, which is survivable; for a payload it is not,
     * because a publisher who is told the copy is safe may then delete the
     * session that holds the only other one.
     *
     * @param {IDBTransaction} transaction
     * @param {IDBRequest} request
     */
    _commit(transaction, request) {
        return new Promise((resolve, reject) => {
            let result;
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                reject(error instanceof Error ? error : new Error(`${error || 'The cache transaction failed.'}`));
            };

            request.onsuccess = () => {
                result = request.result;
            };
            request.onerror = () => fail(request.error || new Error('The cache rejected a request.'));

            // A double with no transaction events would never settle; falling
            // back to the request keeps it working rather than hanging.
            if (
                !transaction ||
                (typeof transaction.addEventListener !== 'function' && !('oncomplete' in transaction))
            ) {
                request.onsuccess = () => {
                    if (settled) return;
                    settled = true;
                    resolve(request.result);
                };
                return;
            }

            transaction.oncomplete = () => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            transaction.onabort = () => fail(transaction.error || new Error('The cache transaction was aborted.'));
            transaction.onerror = () => fail(transaction.error || new Error('The cache transaction failed.'));
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

        // Its own transaction, for the same reason indexing gets one: a site
        // that is cached but not reseedable is a small loss, and must not
        // become a site that failed to cache.
        if (metadata.payload) await this.setPayload(hash, metadata.payload);

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
     * Keep the payload that would let this browser reseed one site.
     *
     * Best-effort: nothing that depends on this is load-bearing for rendering
     * a site, caching it or finding it again, so a failure is reported and
     * swallowed rather than failing whatever was going on.
     *
     * @param {string} hash
     * @param {{ torrentFile: Uint8Array, files: { path: string, type?: string, bytes: Uint8Array }[],
     *          gofileLocator?: string }} payload
     * @returns {Promise<boolean>} whether the copy is durable, not merely applied
     */
    async setPayload(hash, payload) {
        if (!payload?.torrentFile || !payload?.files?.length) return false;
        try {
            // A locator already known about this site is not forgotten by a
            // later write that happens not to carry one. The mirror is part of
            // the site's address rather than of whichever load noticed it, and
            // most loads do not: somebody opening a bare hash knows nothing
            // about a mirror that a previous visit resolved through.
            const known = `${payload.gofileLocator || ''}` || (await this.storedMirrorLocator(hash));

            const db = await this.openDB();
            const transaction = db.transaction([this.payloadStore], 'readwrite');
            // Settled on the commit, not on the request: what this returns is
            // acted on — a publisher told the copy is safe may delete the
            // session holding the only other one.
            await this._commit(
                transaction,
                transaction.objectStore(this.payloadStore).put({
                    hash,
                    torrentFile: payload.torrentFile,
                    files: payload.files,
                    gofileLocator: known || '',
                    savedAt: Date.now()
                })
            );
            return true;
        } catch (error) {
            console.warn('[PeerWebCache] Site is not reseedable from storage:', error);
            return false;
        }
    }

    /**
     * The mirror locator this browser last knew for one site, if any.
     *
     * Kept next to the payload because it is the same kind of fact: part of
     * what it takes to put the site back exactly as it was reachable before.
     *
     * @param {string} hash
     * @returns {Promise<string>}
     */
    async storedMirrorLocator(hash) {
        try {
            const stored = await this.getPayload(hash);
            return `${stored?.gofileLocator || ''}`;
        } catch (_) {
            return '';
        }
    }

    /**
     * Note a mirror locator for a site whose payload may not be here yet.
     *
     * A load resolves the locator long before anything decides whether the
     * site is worth keeping a payload for, and a visitor who never presses
     * Reseed should not have written one. So this only fills in a row that
     * already exists, and says whether it did.
     *
     * @param {string} hash
     * @param {string} locator
     */
    async rememberMirrorLocator(hash, locator) {
        const value = `${locator || ''}`.trim();
        if (!value) return false;
        try {
            const stored = await this.getPayload(hash);
            if (!stored?.torrentFile || !stored?.files?.length) return false;
            if (stored.gofileLocator === value) return true;
            return await this.setPayload(hash, { ...stored, gofileLocator: value });
        } catch (error) {
            console.warn('[PeerWebCache] Could not record the mirror locator:', error);
            return false;
        }
    }

    /**
     * The stored payload for one site, or null.
     *
     * Falls back to the field the payload used to be written into, inside the
     * site record itself, so a browser that cached a site under the previous
     * build can still reseed it.
     *
     * @param {string} hash
     */
    async getPayload(hash) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.payloadStore], 'readonly');
            const stored = await this._request(transaction.objectStore(this.payloadStore).get(hash));
            if (stored?.torrentFile && stored?.files?.length) return stored;
        } catch (error) {
            console.warn('[PeerWebCache] Could not read the stored payload:', error);
        }

        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.storeName], 'readonly');
            const record = await this._request(transaction.objectStore(this.storeName).get(hash));
            const legacy = record?.payload || null;
            return legacy?.torrentFile && legacy?.files?.length ? legacy : null;
        } catch (_) {
            return null;
        }
    }

    /** @param {string} hash */
    async deletePayload(hash) {
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.payloadStore], 'readwrite');
            await this._request(transaction.objectStore(this.payloadStore).delete(hash));
        } catch (error) {
            console.warn('[PeerWebCache] Could not delete the stored payload:', error);
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
        // And so does the payload. Deleting one site's data means all of it.
        await this.deletePayload(hash);
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
        try {
            const db = await this.openDB();
            const transaction = db.transaction([this.payloadStore], 'readwrite');
            await this._request(transaction.objectStore(this.payloadStore).clear());
        } catch (_) {}
    }
}

export default PeerWebCache;
