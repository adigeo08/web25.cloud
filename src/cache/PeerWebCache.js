// @ts-check

import { PEERWEB_CONFIG } from '../config/peerweb.config.js';
import { buildLibraryEntry, searchLibrary } from './SiteLibraryIndex.js';
import { WORKSPACE_DIRS, getGitWorkspace, safeTreePath } from '../storage/GitWorkspace.js';

/**
 * A site file's content as bytes, and what it was before, so it reads back
 * as the same kind of value it was written as.
 * @param {any} content
 * @returns {{ bytes: Uint8Array, kind: 'string'|'bytes' }|null}
 */
function contentBytes(content) {
    if (typeof content === 'string') return { bytes: new TextEncoder().encode(content), kind: 'string' };
    if (content instanceof Uint8Array) return { bytes: content, kind: 'bytes' };
    if (content instanceof ArrayBuffer) return { bytes: new Uint8Array(content), kind: 'bytes' };
    if (ArrayBuffer.isView(content)) {
        return { bytes: new Uint8Array(content.buffer, content.byteOffset, content.byteLength), kind: 'bytes' };
    }
    return null;
}

/** Whether every path can be a file of its own in a tree. @param {string[]} paths */
function storableAsTree(paths) {
    const seen = new Set();
    for (const path of paths) {
        if (safeTreePath(path) !== path || seen.has(path)) return false;
        seen.add(path);
    }
    return true;
}

class PeerWebCache {
    /**
     * @param {{ workspace?: import('../storage/GitWorkspace.js').GitWorkspace|null }} [options]
     *   where file bytes go; null keeps them inline in IndexedDB
     */
    constructor({ workspace } = {}) {
        /**
         * Where the bytes live. With OPFS, a cached site is a tree of files
         * under `/web25/sites/<hash>` and a stored payload one under
         * `/web25/payloads/<hash>`; IndexedDB keeps the rows that describe
         * them — what a file is called, its type, its size — and the reads
         * here put the bytes back. Plain trees, not repositories: a site
         * becomes a repository by being reseeded, which makes it a page.
         * Without OPFS, everything stays inline as before.
         */
        this._workspace = workspace === undefined ? null : workspace;
        this._workspaceDefault = workspace === undefined;
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

    /** The workspace when OPFS can be written here, otherwise null. */
    async workspace() {
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (!workspace) return null;
        try {
            return (await workspace.isAvailable()) ? workspace : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Write a site's files to its tree and return what IndexedDB keeps: every
     * entry as it was, minus its content. Null when the site stays inline —
     * no OPFS, a path that cannot be a file of its own, a write that failed.
     *
     * @param {string} hash
     * @param {Record<string, any>} siteData
     */
    async _detachSite(hash, siteData) {
        const workspace = await this.workspace();
        if (!workspace || !siteData || typeof siteData !== 'object') return null;

        const files = [];
        /** @type {Record<string, any>} */
        const data = {};
        for (const [path, entry] of Object.entries(siteData)) {
            const content = contentBytes(entry?.content);
            if (!content) {
                data[path] = entry;
                continue;
            }
            const rest = { ...entry, contentKind: content.kind };
            delete rest.content;
            data[path] = rest;
            files.push({ path, bytes: content.bytes });
        }
        if (files.length === 0 || !storableAsTree(files.map((file) => file.path))) return null;

        const dir = workspace.siteDir(hash);
        try {
            await workspace.replaceTree(dir, files);
            return data;
        } catch (error) {
            console.warn('[PeerWebCache] Site kept in IndexedDB; OPFS write failed:', error);
            await workspace.remove(dir).catch(() => {});
            return null;
        }
    }

    /**
     * The site a row describes, bytes read back from its tree. Null when the
     * tree is gone or unreadable, which is a cache miss like any other.
     *
     * @param {string} hash
     * @param {Record<string, any>} data
     */
    async _attachSite(hash, data) {
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (!workspace) return null;
        const dir = workspace.siteDir(hash);
        try {
            return await workspace.read(dir, async () => {
                /** @type {Record<string, any>} */
                const siteData = {};
                for (const [path, entry] of Object.entries(data || {})) {
                    if (!entry?.contentKind) {
                        siteData[path] = entry;
                        continue;
                    }
                    const { contentKind, ...rest } = entry;
                    const bytes = await workspace.readFile(dir, path);
                    siteData[path] = {
                        ...rest,
                        content: contentKind === 'string' ? new TextDecoder().decode(bytes) : bytes
                    };
                }
                return siteData;
            });
        } catch (error) {
            console.warn('[PeerWebCache] Cached site could not be read back from OPFS:', error);
            return null;
        }
    }

    /**
     * Move one cached site's files out of its row and into its tree, after
     * the fact and off the load path.
     *
     * A site is cached the moment it renders, and the render waits for that
     * write: writing every file to OPFS first would put one file write per
     * site file in front of the page. So the row goes in as it always has,
     * and this moves it afterwards — queued per site, and only if the row is
     * still the one it was asked to move: a newer copy of the site, or a
     * deletion, wins over a move that started before it.
     *
     * @param {string} hash
     * @param {number} timestamp the row this move is for
     */
    _scheduleMove(hash, timestamp) {
        if (!this._moves) this._moves = new Map();
        const tail = this._moves.get(hash) || Promise.resolve();
        const run = tail
            .then(() => this._moveIfCurrent(hash, timestamp))
            .catch((error) => {
                console.warn('[PeerWebCache] Cached site stays in IndexedDB:', error);
                return false;
            });
        this._moves.set(hash, run);
        void run.then(() => {
            if (this._moves.get(hash) === run) this._moves.delete(hash);
        });
        return run;
    }

    /** Resolves once every move scheduled so far has run. */
    async whenSettled() {
        while (this._moves?.size) await Promise.all([...this._moves.values()]);
    }

    /** @param {string} hash @param {number} timestamp */
    async _moveIfCurrent(hash, timestamp) {
        const workspace = await this.workspace();
        if (!workspace) return false;
        const db = await this.openDB();
        const record = await this._request(
            db.transaction([this.storeName], 'readonly').objectStore(this.storeName).get(hash)
        );
        if (!record?.data || record.dataStorage === 'opfs' || record.timestamp !== timestamp) return false;

        const data = await this._detachSite(hash, record.data);
        if (!data) return false;
        const replaced = await this._replaceIfCurrent(hash, timestamp, { ...record, data, dataStorage: 'opfs' });
        if (!replaced) {
            // Somebody got there first. A newer copy has its own move queued
            // behind this one; a deleted site must not keep the tree just
            // written for it.
            const current = await this._request(
                db.transaction([this.storeName], 'readonly').objectStore(this.storeName).get(hash)
            ).catch(() => null);
            if (!current) await workspace.remove(workspace.siteDir(hash)).catch(() => {});
        }
        return replaced;
    }

    /**
     * Put `next` in place of the row for `hash` only while that row is still
     * the inline one written at `timestamp` — checked and written in one
     * transaction, so nothing can land in between.
     * @param {string} hash
     * @param {number} timestamp
     * @param {any} next
     * @returns {Promise<boolean>}
     */
    async _replaceIfCurrent(hash, timestamp, next) {
        const db = await this.openDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            let replaced = false;
            const read = store.get(hash);
            read.onsuccess = () => {
                const current = read.result;
                if (current && current.timestamp === timestamp && current.dataStorage !== 'opfs') {
                    store.put(next);
                    replaced = true;
                }
            };
            read.onerror = () => reject(read.error);
            transaction.oncomplete = () => resolve(replaced);
            transaction.onabort = () => reject(transaction.error || new Error('The cache transaction was aborted.'));
            transaction.onerror = () => reject(transaction.error || new Error('The cache transaction failed.'));
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

        // Then the files move to OPFS, once nothing is waiting on them.
        void this._scheduleMove(hash, timestamp);

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
                const siteData =
                    record.dataStorage === 'opfs' ? await this._attachSite(hash, record.data) : record.data;
                if (!siteData) continue;
                await this._request(
                    db
                        .transaction([this.libraryStore], 'readwrite')
                        .objectStore(this.libraryStore)
                        .put(
                            buildLibraryEntry({
                                hash,
                                siteData,
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
            const files = await this._detachPayloadFiles(hash, payload.files);

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
                    files: files || payload.files,
                    ...(files ? { payloadStorage: 'opfs' } : {}),
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
     * Write a payload's files to its tree; the rows IndexedDB keeps instead,
     * in the payload's order, or null to keep the bytes inline.
     * @param {string} hash
     * @param {{ path: string, type?: string, bytes: any }[]} files
     */
    async _detachPayloadFiles(hash, files) {
        const workspace = await this.workspace();
        if (!workspace || !files.every((file) => contentBytes(file?.bytes))) return null;
        if (!storableAsTree(files.map((file) => file.path))) return null;
        const dir = workspace.payloadDir(hash);
        try {
            const written = files.map((file) => ({ path: file.path, bytes: contentBytes(file.bytes)?.bytes }));
            await workspace.replaceTree(dir, written);
            return files.map((file, index) => ({
                path: file.path,
                type: file.type || 'application/octet-stream',
                size: written[index].bytes?.length || 0
            }));
        } catch (error) {
            console.warn('[PeerWebCache] Payload kept in IndexedDB; OPFS write failed:', error);
            return null;
        }
    }

    /**
     * A payload row with its bytes read back, or null when its tree is gone.
     * @param {any} stored
     */
    async _attachPayloadFiles(stored) {
        if (stored?.payloadStorage !== 'opfs') return stored;
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (!workspace) return null;
        const dir = workspace.payloadDir(stored.hash);
        try {
            const files = await workspace.read(dir, async () => {
                const out = [];
                for (const file of stored.files || []) {
                    out.push({ ...file, bytes: await workspace.readFile(dir, file.path) });
                }
                return out;
            });
            const rest = { ...stored, files };
            delete rest.payloadStorage;
            return rest;
        } catch (error) {
            console.warn('[PeerWebCache] Stored payload could not be read back from OPFS:', error);
            return null;
        }
    }

    /** Remove one site's trees, best-effort. @param {string} hash */
    async _removeTrees(hash) {
        const workspace = await this.workspace();
        if (!workspace) return;
        for (const dir of [workspace.siteDir(hash), workspace.payloadDir(hash)]) {
            await workspace.remove(dir).catch(() => {});
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
            const row = await this._request(transaction.objectStore(this.payloadStore).get(hash));
            const stored = await this._attachPayloadFiles(row);
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
        const workspace = await this.workspace();
        if (workspace) {
            const dir = workspace.payloadDir(hash);
            await workspace.remove(dir).catch(() => {});
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
                if (result.dataStorage === 'opfs') {
                    const data = await this._attachSite(hash, result.data);
                    // A tree that cannot be read is a miss; the next load of
                    // the site writes a fresh copy over this row.
                    if (!data) return null;
                    console.log(`[PeerWebCache] Cache hit: ${hash}`);
                    return { ...result, data };
                }
                console.log(`[PeerWebCache] Cache hit: ${hash}`);
                // Still inline — cached before the files moved to OPFS, or
                // just now: they move after this read, not during it.
                if (result.data) void this._scheduleMove(hash, result.timestamp);
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
        await this._removeTrees(hash);
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
        const workspace = await this.workspace();
        if (workspace) {
            for (const dir of [WORKSPACE_DIRS.sites, WORKSPACE_DIRS.payloads]) {
                await workspace.remove(dir).catch(() => {});
            }
        }
    }
}

export default PeerWebCache;
