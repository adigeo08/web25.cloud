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
 *
 * Where the bytes live: in OPFS, as a git repository per site
 * (`/web25/pages/<hash>`, see `GitWorkspace`), whenever the browser can write
 * there. The IndexedDB record then keeps everything but the bytes — the
 * ordered file list with each file's type and size — and is marked
 * `payloadStorage: 'opfs'`; `get` and `list` put the bytes back, so nothing
 * that reads a record can tell the difference. Every write of a payload is
 * also committed, in the background: a deployment and a reseed both leave
 * history in the repository, and neither waits for git to load to be saved.
 * Without OPFS, or for a payload whose paths cannot be stored as a tree, the
 * bytes stay inline in the record exactly as before.
 */

import { getGitWorkspace, safeTreePath } from '../../storage/GitWorkspace.js';

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
 *   reseeded?: boolean,
 *   payloadStorage?: 'opfs',
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

/** @param {any} value @returns {Uint8Array} */
function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value);
    return new Uint8Array(0);
}

/**
 * Whether these payload files can be a tree: every path stored as itself, and
 * no path twice. Order is kept by the record, not by the tree.
 * @param {{ path: string }[]} files
 */
/** A record with its bytes inline, nothing claiming they are elsewhere. @param {any} record */
function inline(record) {
    if (record?.payloadStorage === undefined && record?.git === undefined) return record;
    const rest = { ...record };
    delete rest.payloadStorage;
    delete rest.git;
    return rest;
}

function storableAsTree(files) {
    const seen = new Set();
    for (const file of files) {
        if (safeTreePath(file.path) !== file.path || seen.has(file.path)) return false;
        seen.add(file.path);
    }
    return true;
}

export default class SeedingSessionStore {
    /**
     * @param {{ workspace?: import('../../storage/GitWorkspace.js').GitWorkspace|null }} [options]
     *   where payloads go; null keeps every payload inline in IndexedDB
     */
    constructor({ workspace } = {}) {
        /** @type {IDBDatabase|null} */
        this._db = null;
        this._workspace = workspace === undefined ? null : workspace;
        this._workspaceDefault = workspace === undefined;
    }

    /** The workspace when OPFS can be written here, otherwise null. */
    async workspace() {
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (!workspace) return null;
        return (await workspace.isAvailable()) ? workspace : null;
    }

    /**
     * Move a record's payload into its repository and return what IndexedDB
     * keeps of it. Falls back to the record itself, bytes inline, whenever the
     * payload cannot go to OPFS — the record must be storable either way.
     *
     * @param {SeedingSessionRecord} record
     */
    async _detachPayload(record) {
        const files = Array.isArray(record.files) ? record.files : [];
        if (files.length === 0 || !files.every((file) => file?.bytes)) {
            // Metadata only, as `patch` and a migration hand it over: it
            // already says where its bytes are.
            return record;
        }
        const workspace = await this.workspace();
        if (!workspace || !storableAsTree(files)) return inline(record);

        const dir = workspace.pageDir(record.hash);
        try {
            await workspace.snapshot(
                dir,
                files.map((file) => ({ path: file.path, bytes: toBytes(file.bytes) })),
                {
                    message: `${record.reseeded ? 'Reseed' : 'Deploy'} ${record.siteName || 'website'} (${record.hash})`,
                    author: {
                        name: record.deploy?.signedBy || 'WEB25.cloud',
                        email: 'publisher@web25.cloud'
                    }
                }
            );
            return {
                ...record,
                payloadStorage: /** @type {'opfs'} */ ('opfs'),
                files: files.map((file) => ({
                    path: file.path,
                    type: file.type || 'application/octet-stream',
                    size: toBytes(file.bytes).length
                }))
            };
        } catch (error) {
            console.warn('[SeedingSessionStore] Payload kept in IndexedDB; OPFS write failed:', error);
            return inline(record);
        }
    }

    /**
     * Put the bytes back into a record whose payload lives in OPFS. A tree
     * that cannot be read gives a record with no files, which every caller
     * already treats as a session with nothing to seed.
     *
     * @param {any} record
     * @returns {Promise<SeedingSessionRecord|null>}
     */
    async _attachPayload(record) {
        if (!record || record.payloadStorage !== 'opfs') return record || null;
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (!workspace) return { ...record, files: [] };
        const dir = workspace.pageDir(record.hash);
        try {
            const files = await workspace.read(dir, async () => {
                const out = [];
                for (const file of record.files || []) {
                    out.push({ ...file, bytes: await workspace.readFile(dir, file.path) });
                }
                return out;
            });
            return { ...record, files };
        } catch (error) {
            console.warn('[SeedingSessionStore] Payload could not be read back from OPFS:', error);
            return { ...record, files: [] };
        }
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

    /**
     * Store a record, payload first: into its repository when OPFS is there,
     * which commits it, and the record without its bytes into IndexedDB.
     * @param {SeedingSessionRecord} record
     */
    async put(record) {
        const stored = await this._detachPayload(record);
        await this._putRaw(stored);
        return record.hash;
    }

    /** @param {any} record the record exactly as IndexedDB should hold it */
    async _putRaw(record) {
        await this._withStore('readwrite', (store) => store.put({ ...record, savedAt: Date.now() }));
    }

    /** @param {string} hash */
    async _getRaw(hash) {
        const result = await this._withStore('readonly', (store) => store.get(hash));
        return result || null;
    }

    /** @param {string} hash @returns {Promise<SeedingSessionRecord|null>} */
    async get(hash) {
        return this._attachPayload(await this._getRaw(hash));
    }

    /**
     * @param {{ payload?: boolean }} [options] `payload: false` skips reading
     *   the bytes back — for listings, which only show what a record says
     * @returns {Promise<SeedingSessionRecord[]>} newest deployment first
     */
    async list({ payload = true } = {}) {
        const result = await this._withStore('readonly', (store) => store.getAll());
        const records = (Array.isArray(result) ? result : []).sort(
            (left, right) => (right.savedAt || 0) - (left.savedAt || 0)
        );
        if (!payload) return records;
        const out = [];
        for (const record of records) out.push(await this._attachPayload(record));
        return /** @type {SeedingSessionRecord[]} */ (out);
    }

    /**
     * Move records written before OPFS was used — bytes inline — into their
     * repositories. Each record is rewritten only once its payload is safely
     * committed; one that cannot move stays exactly as it was.
     * @returns {Promise<number>} how many records moved
     */
    async migrateToWorkspace() {
        if (!(await this.workspace())) return 0;
        let moved = 0;
        for (const record of await this.list({ payload: false })) {
            if (record.payloadStorage === 'opfs' || !record.files?.length) continue;
            try {
                const detached = await this._detachPayload(record);
                if (detached.payloadStorage !== 'opfs') continue;
                await this._putRaw({ ...detached, savedAt: record.savedAt });
                moved += 1;
            } catch (error) {
                console.warn('[SeedingSessionStore] A stored session could not move to OPFS:', error);
            }
        }
        return moved;
    }

    /** @param {string} hash */
    async remove(hash) {
        await this._withStore('readwrite', (store) => store.delete(hash));
        // The repository goes with the session: Pages is what is a repository.
        // The reseedable copy the site cache keeps is somewhere else.
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (workspace && (await workspace.isAvailable())) {
            await workspace.remove(workspace.pageDir(hash)).catch((error) => {
                console.warn('[SeedingSessionStore] Repository could not be removed:', error);
            });
        }
    }

    /**
     * The commit a page's repository is at, or null — no repository, nothing
     * committed yet, or no OPFS. Read from `.git` itself; git is not loaded.
     * @param {string} hash
     */
    async repositoryHead(hash) {
        const workspace = this._workspaceDefault ? getGitWorkspace() : this._workspace;
        if (!workspace) return null;
        return workspace.headCommit(workspace.pageDir(hash));
    }

    /**
     * Merge fields into an existing record, leaving the payload untouched.
     * Used when an optional mirror arrives after the deployment is already live.
     *
     * @param {string} hash
     * @param {Partial<SeedingSessionRecord>} patch
     */
    async patch(hash, patch) {
        // The stored form, not the hydrated one: changing a field must not
        // read a whole site back out of OPFS only to write it in again.
        const existing = await this._getRaw(hash);
        if (!existing) return null;
        const merged = {
            ...existing,
            ...patch,
            deploy: { ...existing.deploy, ...(patch.deploy || {}) }
        };
        // A patch that brings bytes is a new payload, and goes where payloads go.
        if (Array.isArray(patch.files)) {
            await this.put(/** @type {SeedingSessionRecord} */ (merged));
            return this.get(hash);
        }
        await this._putRaw(merged);
        return this._attachPayload(merged);
    }
}
