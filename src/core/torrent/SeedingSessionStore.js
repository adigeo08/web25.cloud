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
 * A session therefore ends in exactly two ways: the tab is closed (and the
 * record resumes on the next visit), or the publisher presses Stop seeding.
 * Signing out does not end it, and neither does clearing the site cache.
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

    /** @param {IDBRequest} request */
    _request(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * @param {'readonly'|'readwrite'} mode
     * @param {(store: IDBObjectStore) => IDBRequest} run
     */
    async _withStore(mode, run) {
        const db = await this.openDb();
        const tx = db.transaction(STORE_SESSIONS, mode);
        return this._request(run(tx.objectStore(STORE_SESSIONS)));
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
