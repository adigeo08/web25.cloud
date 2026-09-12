// @ts-check
/**
 * Durable store for the sites this browser is seeding.
 *
 * A deployment used to live only in the page: the payload was seeded from an
 * in-memory bundle, so a refresh — or anything that dropped the tab's state —
 * ended the only copy of the site that existed. `localStorage` held the signed
 * `.torrent` but never the bytes, so what came back after a reload announced a
 * deployment it could not serve.
 *
 * This store holds the payload itself, which makes seeding survive a reload:
 * the page re-seeds every record on start, **with the wallet locked**. Nothing
 * here is signed, decrypted or verified — re-seeding is just handing the same
 * bytes back to WebTorrent — so a locked wallet is no reason to stop hosting
 * somebody's site.
 *
 * Announcing therefore stops in exactly three ways: the tab is closed (and the
 * record resumes on the next visit), the publisher presses Stop seeding (the
 * record stays, marked paused, and Resume puts it back on the air), or the
 * publisher presses Delete website (the record goes, payload and all). Signing
 * out does not end it, and neither does clearing the site cache.
 */

const DB_NAME = 'web25-seeding';
const STORE_SESSIONS = 'sessions';

/**
 * @typedef {{
 *   path: string,
 *   type: string,
 *   bytes: Uint8Array
 * }} SeedingPayloadFile
 *
 * @typedef {{
 *   hash: string,
 *   siteName: string,
 *   torrentName: string,
 *   pieceLength: number|null,
 *   createdAt: string,
 *   savedAt: number,
 *   length: number,
 *   fileCount: number,
 *   torrentFile: Uint8Array|null,
 *   files: SeedingPayloadFile[],
 *   paused?: boolean,
 *   pausedAt?: number|null,
 *   deploy: {
 *     url: string,
 *     signedBy: string,
 *     signature: string,
 *     signatureAlgorithm: string,
 *     signedAt: string,
 *     mirror: { locator: string, filename: string }|null,
 *     mirrorState: string
 *   }
 * }} SeedingSessionRecord
 */

export default class SeedingSessionStore {
    constructor() {
        /** @type {IDBDatabase|null} */
        this._db = null;
    }

    /**
     * Open the database without pinning a version, for the same reason
     * `PeerWebCache` does: a browser whose database already reached a higher
     * version answers every request for a lower one with `VersionError`, and
     * the store silently stops working.
     */
    async openDb() {
        if (this._db) return this._db;
        const db = await this._open();
        if (db.objectStoreNames.contains(STORE_SESSIONS)) {
            this._db = db;
            return db;
        }
        const version = db.version + 1;
        db.close();
        this._db = await this._open(version);
        return this._db;
    }

    /** @param {number} [version] omit to accept whatever exists */
    _open(version) {
        return new Promise((resolve, reject) => {
            const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
            request.onerror = () => reject(request.error);
            request.onblocked = () =>
                reject(new Error('The seeding store is open in another tab and cannot be upgraded.'));
            request.onsuccess = () => {
                const opened = request.result;
                opened.onversionchange = () => {
                    opened.close();
                    if (this._db === opened) this._db = null;
                };
                resolve(opened);
            };
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
                    db.createObjectStore(STORE_SESSIONS, { keyPath: 'hash' });
                }
            };
        });
    }

    /**
     * Run one transaction and resolve only once it has committed.
     *
     * A successful `put` request is not a durable write: IndexedDB reports the
     * request as soon as it is applied inside the transaction, and the
     * transaction can still abort afterwards — a quota the browser only
     * discovers while flushing, a version change, a tab being killed. Resolving
     * on the request is therefore a promise that the bytes are safe when they
     * may not be, and this store's whole job is the opposite of that: a
     * deployment counts as saved when it will still be there on the next load.
     *
     * So the result of the request is held, and the promise settles on the
     * transaction's `complete` — or rejects on `abort`/`error`, which is how a
     * failed write reaches the caller instead of being silently lost.
     *
     * @param {'readonly'|'readwrite'} mode
     * @param {(store: IDBObjectStore) => IDBRequest} run
     */
    async _withStore(mode, run) {
        const db = await this.openDb();
        return new Promise((resolve, reject) => {
            let tx;
            let request;
            try {
                tx = db.transaction(STORE_SESSIONS, mode);
                request = run(tx.objectStore(STORE_SESSIONS));
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            let result;
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                reject(
                    error instanceof Error ? error : new Error(`${error || 'The seeding store transaction failed.'}`)
                );
            };

            request.onsuccess = () => {
                result = request.result;
            };
            request.onerror = () => fail(request.error || new Error('The seeding store rejected a request.'));

            // A transaction-less double (or a very old implementation) would
            // never commit; falling back to the request keeps it working rather
            // than hanging.
            if (!tx || (typeof tx.addEventListener !== 'function' && !('oncomplete' in tx))) {
                request.onsuccess = () => {
                    if (settled) return;
                    settled = true;
                    resolve(request.result);
                };
                return;
            }

            tx.oncomplete = () => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            tx.onabort = () => fail(tx.error || new Error('The seeding store transaction was aborted.'));
            tx.onerror = () => fail(tx.error || new Error('The seeding store transaction failed.'));
        });
    }

    /** @param {SeedingSessionRecord} record */
    async put(record) {
        await this._withStore('readwrite', (store) => store.put({ ...record, savedAt: Date.now() }));
        return record.hash;
    }

    /** @param {string} hash @returns {Promise<SeedingSessionRecord|null>} */
    async get(hash) {
        const result = await this._withStore('readonly', (store) => store.get(hash));
        return /** @type {SeedingSessionRecord|null} */ (result || null);
    }

    /** @returns {Promise<SeedingSessionRecord[]>} newest deployment first */
    async list() {
        const result = await this._withStore('readonly', (store) => store.getAll());
        const records = Array.isArray(result) ? result : [];
        return records.sort((left, right) => (right.savedAt || 0) - (left.savedAt || 0));
    }

    /** @param {string} hash */
    async remove(hash) {
        await this._withStore('readwrite', (store) => store.delete(hash));
    }

    /**
     * Merge fields into an existing record, leaving the payload untouched.
     * Used when an optional mirror arrives after the deployment is already live.
     *
     * @param {string} hash
     * @param {Partial<SeedingSessionRecord>} patch
     */
    async patch(hash, patch) {
        const existing = await this.get(hash);
        if (!existing) return null;
        const merged = {
            ...existing,
            ...patch,
            deploy: { ...existing.deploy, ...(patch.deploy || {}) }
        };
        await this.put(/** @type {SeedingSessionRecord} */ (merged));
        return merged;
    }
}
