// @ts-check
/**
 * What this browser has already acted on from its Nostr inbox.
 *
 * Relays do not deliver an event once. The inbox subscription asks for days of
 * history, so every reconnect, every resubscription (a lock and unlock) and
 * every page load hands back the same gift wraps again. Before this ledger the
 * only guard was an in-memory replay cache, gone on reload — and an old chat
 * request from a trusted contact, delivered again inside its thirty-minute
 * window, made this browser send a fresh request back and then a fresh offer,
 * while an old offer inside its fifteen minutes was answered all over again.
 * One invitation, many sessions.
 *
 * Here an inbound event is claimed the first time it is seen and never acted
 * on again, in this page or any later one: the gift wrap by its event id, and
 * the request or invitation inside it by a hash this browser computes itself
 * (a sender's claimed rumor id is not trusted to be unique).
 *
 * Stored, briefly and opaquely: each row is a truncated hash of the local
 * identity and the event, with the time it was handled — no event id, no key,
 * no content. Rows outlive the furthest any relay will replay (the inbox
 * look-back, plus a day) and are then deleted. Without IndexedDB the ledger
 * still works for the life of the page.
 */

import { sha256 } from '@noble/hashes/sha256';
import { NOSTR_CONFIG } from '../config/nostr.config.js';

const DB_NAME = 'web25-inbox';
const DB_VERSION = 1;
const STORE = 'handled';

/** Longer than any relay will replay to this inbox. */
export const LEDGER_RETENTION_MS = NOSTR_CONFIG.INBOX_LOOKBACK_SECONDS * 1000 + 24 * 60 * 60 * 1000;

/** @param {Uint8Array} bytes */
function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {IDBRequest} request */
function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE)) {
                request.result.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export class InboxLedger {
    /**
     * @param {{ now?: () => number, retentionMs?: number, persistent?: boolean }} [options]
     */
    constructor({
        now = Date.now,
        retentionMs = LEDGER_RETENTION_MS,
        persistent = typeof indexedDB !== 'undefined'
    } = {}) {
        this.now = now;
        this.retentionMs = retentionMs;
        this.persistent = persistent;
        this.owner = '';
        /** @type {Set<string>} */
        this.claimed = new Set();
        /** @type {Promise<void>|null} */
        this._loading = null;
        /** @type {Promise<IDBDatabase>|null} */
        this._db = null;
    }

    /**
     * Read what earlier pages handled for this identity, and drop rows older
     * than anything a relay could still replay. Safe to call repeatedly; a
     * failure leaves the ledger working in memory only.
     *
     * @param {string} ownerNostrPublicKey
     */
    load(ownerNostrPublicKey) {
        const owner = `${ownerNostrPublicKey || ''}`.toLowerCase();
        if (this._loading && this.owner === owner) return this._loading;
        this.owner = owner;
        this.claimed = new Set();
        this._loading = this.persistent ? this._readPersisted().catch(() => {}) : Promise.resolve();
        return this._loading;
    }

    async _readPersisted() {
        this._db = this._db || openDb();
        const db = await this._db;
        const rows = /** @type {Array<{ id: string, at: number }>} */ (
            (await promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) || []
        );
        const cutoff = this.now() - this.retentionMs;
        const expired = rows.filter((row) => !(Number(row.at) > cutoff));
        if (expired.length > 0) {
            // One transaction, every delete issued before anything is awaited.
            const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
            await Promise.all(expired.map((row) => promisify(store.delete(row.id))));
        }
        for (const row of rows) if (Number(row.at) > cutoff) this.claimed.add(row.id);
    }

    /** @param {string} key */
    _id(key) {
        return toHex(sha256(new TextEncoder().encode(`web25-inbox:${this.owner}:${key}`))).slice(0, 32);
    }

    /**
     * Claim an inbox event: true the first time, false ever after.
     *
     * The check and the claim are one synchronous step, so the same event
     * arriving from two relays at once cannot be acted on twice; the write to
     * disk follows on its own.
     *
     * @param {string} key
     */
    claim(key) {
        const id = this._id(key);
        if (this.claimed.has(id)) return false;
        this.claimed.add(id);
        // Stamped now, not whenever the write gets to run.
        if (this.persistent) void this._write(id, this.now()).catch(() => {});
        return true;
    }

    /** @param {string} key */
    has(key) {
        return this.claimed.has(this._id(key));
    }

    /**
     * @param {string} id
     * @param {number} at
     */
    async _write(id, at) {
        this._db = this._db || openDb();
        const db = await this._db;
        await promisify(db.transaction(STORE, 'readwrite').objectStore(STORE).put({ id, at }));
    }
}

export const INBOX_DB_NAME = DB_NAME;
export const INBOX_STORE_NAME = STORE;
