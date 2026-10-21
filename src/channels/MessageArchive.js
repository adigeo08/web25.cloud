// @ts-check
/**
 * Messages kept on this device, per conversation, for a limited time.
 *
 * Off by default: a conversation is live-only unless the local user chooses to
 * keep it, per conversation, for at most seven days. What is kept is what was
 * shown in the thread — chat text, both directions — and nothing else: no
 * files, no service notices, no keys.
 *
 * Protection model, the same as the contacts store
 * ------------------------------------------------
 *   - every message is sealed with NIP-44 v2 to the wallet's own Nostr key,
 *     through the wallet worker. A locked wallet can neither read nor write
 *     history; no key, PRF output or derived secret is ever stored here;
 *   - IndexedDB holds opaque ids, a per-conversation tag (a hash of both
 *     public keys), the message time and its expiry — never a peer key, an
 *     address, a name or message text;
 *   - expiry is enforced by time alone. Deleting an expired row needs no
 *     decryption, so the purge runs whether the wallet is unlocked or not.
 *
 * Expiry is the message's own timestamp plus the conversation's retention. A
 * timestamp comes from the peer for an incoming message, so one that claims to
 * be in the future is clamped to now: nobody can make a message outlive the
 * window by dating it ahead. Retention is capped at seven days whatever is
 * asked for.
 *
 * Held until read
 * ---------------
 * A saved contact can write while their conversation is closed here. Such a
 * message is *held*: sealed the same way, marked unread, and kept until the
 * conversation is opened and it has been shown — whatever the conversation's
 * retention, because a message nobody has seen yet is not history. It is
 * still bounded by the same clock: a held message goes, read or not, seven
 * days after it was sent, the most anything is ever kept. Once it has been
 * shown it is released onto the conversation's own terms — kept for its
 * retention, or deleted at once when retention is off. The thread says which.
 *
 * Its own IndexedDB database, so it never shares a connection or an upgrade
 * path with the wallet vault or the contacts.
 */

import { sha256 } from '@noble/hashes/sha256';

const DB_NAME = 'web25-messages';
const DB_VERSION = 1;
const STORE_MESSAGES = 'secure_messages';
const STORE_SETTINGS = 'conversation_settings';
const INDEX_CONVERSATION = 'byConversation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The most any conversation may keep. */
export const MAX_RETENTION_MS = 7 * DAY_MS;

/** The choices offered: off, a day, three days, a week. */
export const RETENTION_CHOICES = Object.freeze([0, DAY_MS, 3 * DAY_MS, MAX_RETENTION_MS]);

/** NIP-44 v2 refuses plaintexts above this; such a message is simply not kept. */
const MAX_SEALED_BYTES = 65535;

const HEX32_RE = /^[0-9a-f]{64}$/;

/** @param {Uint8Array} bytes */
function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {string} text */
function hashHex(text) {
    return toHex(sha256(new TextEncoder().encode(text)));
}

/**
 * Opaque tag for one conversation: both parties' public keys, hashed, so a
 * stored row names neither of them.
 *
 * @param {string} ownerNostrPublicKey
 * @param {string} peerNostrPublicKey
 */
export function conversationTag(ownerNostrPublicKey, peerNostrPublicKey) {
    return hashHex(`web25-conversation:${ownerNostrPublicKey}:${peerNostrPublicKey}`);
}

/**
 * Snap a requested retention onto the choices offered, never above the cap.
 * Anything unrecognised means off — keeping nothing is the safe default.
 *
 * @param {number} ms
 */
export function normalizeRetention(ms) {
    const value = Number(ms) || 0;
    if (value <= 0) return 0;
    return RETENTION_CHOICES.includes(value) ? value : Math.min(value, MAX_RETENTION_MS);
}

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
                const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
                messages.createIndex(INDEX_CONVERSATION, 'conversationTag', { unique: false });
            }
            if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
                db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @param {IDBDatabase} db
 * @param {string} name
 * @param {IDBTransactionMode} mode
 */
function store(db, name, mode) {
    return db.transaction(name, mode).objectStore(name);
}

/** @param {IDBRequest} request */
function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export class MessageArchive {
    /**
     * @param {{ signer: { getNostrIdentity: () => Promise<any>,
     *                    nostrEncrypt: (plaintext: string, peerPublicKey: string) => Promise<string>,
     *                    nostrDecrypt: (payload: string, peerPublicKey: string) => Promise<string> },
     *           now?: () => number }} options
     */
    constructor({ signer, now = Date.now }) {
        if (!signer) throw new Error('MessageArchive requires a wallet signing handle.');
        this.signer = signer;
        this.now = now;
    }

    /** @returns {Promise<string>} */
    async _owner() {
        const identity = await this.signer.getNostrIdentity();
        const owner = `${identity?.nostrPublicKey || ''}`.trim().toLowerCase();
        if (!HEX32_RE.test(owner)) throw new Error('Unlock your wallet to keep or read message history.');
        return owner;
    }

    /** @param {string} peer */
    static _peer(peer) {
        const key = `${peer || ''}`.trim().toLowerCase();
        if (!HEX32_RE.test(key)) throw new Error('A conversation needs the peer’s Nostr public key.');
        return key;
    }

    /**
     * How long this conversation keeps its messages, in ms. 0 is off.
     * @param {string} peer
     */
    async getRetention(peer) {
        const tag = conversationTag(await this._owner(), MessageArchive._peer(peer));
        const db = await openDb();
        try {
            const row = /** @type {any} */ (await promisify(store(db, STORE_SETTINGS, 'readonly').get(tag)));
            return normalizeRetention(row?.retentionMs || 0);
        } finally {
            db.close();
        }
    }

    /**
     * Change how long a conversation keeps its messages.
     *
     * Off deletes what was kept — off means nothing of it stays. A shorter
     * window re-dates what is already kept, so it expires on the new terms
     * instead of the old ones; a longer one never extends a message past its
     * own timestamp plus the new window.
     *
     * @param {string} peer
     * @param {number} retentionMs
     * @returns {Promise<number>} the retention actually applied
     */
    async setRetention(peer, retentionMs) {
        const owner = await this._owner();
        const tag = conversationTag(owner, MessageArchive._peer(peer));
        const retention = normalizeRetention(retentionMs);
        const db = await openDb();
        try {
            if (retention === 0) {
                await promisify(store(db, STORE_SETTINGS, 'readwrite').delete(tag));
                await this._deleteConversation(db, tag, { keepUnread: true });
                return 0;
            }

            await promisify(
                store(db, STORE_SETTINGS, 'readwrite').put({ id: tag, retentionMs: retention, updatedAt: this.now() })
            );

            const now = this.now();
            const rows = /** @type {any[]} */ (
                (await promisify(store(db, STORE_MESSAGES, 'readonly').index(INDEX_CONVERSATION).getAll(tag))) || []
            );
            for (const row of rows) {
                // Unread is held until read, on its own clock; retention
                // applies once it has been shown.
                if (row.unread === true) continue;
                const expiresAt = Number(row.sentAt) + retention;
                if (expiresAt <= now) {
                    await promisify(store(db, STORE_MESSAGES, 'readwrite').delete(row.id));
                } else if (expiresAt !== row.expiresAt) {
                    await promisify(store(db, STORE_MESSAGES, 'readwrite').put({ ...row, expiresAt }));
                }
            }
            return retention;
        } finally {
            db.close();
        }
    }

    /**
     * Keep one message, if its conversation keeps messages.
     *
     * Keyed by the message's own id, so the same message arriving twice — over
     * WebRTC and again from a relay — is one row.
     *
     * @param {string} peer
     * @param {{ id?: string, from?: string, text?: string, timestamp?: string|number }} message
     * @param {{ own?: boolean, retentionMs?: number }} [options] pass a known retention to skip the lookup
     * @returns {Promise<boolean>} whether it was kept
     */
    async record(peer, message, { own = false, retentionMs } = {}) {
        const text = `${message?.text || ''}`;
        if (!text) return false;

        const owner = await this._owner();
        const peerKey = MessageArchive._peer(peer);
        const tag = conversationTag(owner, peerKey);
        const retention =
            retentionMs === undefined ? await this.getRetention(peerKey) : normalizeRetention(retentionMs);
        if (retention === 0) return false;

        const now = this.now();
        const claimed = new Date(message?.timestamp ?? now).getTime();
        // A peer's clock decides nothing past now.
        const sentAt = Number.isFinite(claimed) ? Math.min(claimed, now) : now;
        const expiresAt = sentAt + retention;
        if (expiresAt <= now) return false;

        const plaintext = JSON.stringify({
            id: `${message?.id || ''}`,
            from: `${message?.from || ''}`,
            text,
            timestamp: new Date(sentAt).toISOString(),
            own: own === true
        });
        if (new TextEncoder().encode(plaintext).length > MAX_SEALED_BYTES) return false;

        const id = hashHex(`web25-message:${tag}:${message?.id || `${sentAt}:${text}`}`);
        const ciphertext = await this.signer.nostrEncrypt(plaintext, owner);

        const db = await openDb();
        try {
            await promisify(
                store(db, STORE_MESSAGES, 'readwrite').put({ id, conversationTag: tag, sentAt, expiresAt, ciphertext })
            );
            return true;
        } finally {
            db.close();
        }
    }

    /**
     * Hold a message that arrived while its conversation was closed, until it
     * has been shown.
     *
     * Kept whatever the conversation's retention, sealed like everything else,
     * and gone seven days after it was sent even if it is never read. The
     * same message twice is one row, and a message this archive already holds
     * — read or not — is not brought back as unread.
     *
     * @param {string} peer
     * @param {{ id?: string, from?: string, text?: string, timestamp?: string|number }} message
     * @returns {Promise<string>} the row it is held in, or '' if it was not held
     */
    async hold(peer, message) {
        const text = `${message?.text || ''}`;
        if (!text) return '';

        const owner = await this._owner();
        const tag = conversationTag(owner, MessageArchive._peer(peer));
        const now = this.now();
        const claimed = new Date(message?.timestamp ?? now).getTime();
        const sentAt = Number.isFinite(claimed) ? Math.min(claimed, now) : now;
        const expiresAt = sentAt + MAX_RETENTION_MS;
        if (expiresAt <= now) return '';

        const plaintext = JSON.stringify({
            id: `${message?.id || ''}`,
            from: `${message?.from || ''}`,
            text,
            timestamp: new Date(sentAt).toISOString(),
            own: false
        });
        if (new TextEncoder().encode(plaintext).length > MAX_SEALED_BYTES) return '';

        const id = hashHex(`web25-message:${tag}:${message?.id || `${sentAt}:${text}`}`);
        // Sealed before the database is opened: nothing waits on the worker
        // while a transaction is live.
        const ciphertext = await this.signer.nostrEncrypt(plaintext, owner);

        const db = await openDb();
        try {
            if (await promisify(store(db, STORE_MESSAGES, 'readonly').get(id))) return '';
            await promisify(
                store(db, STORE_MESSAGES, 'readwrite').put({
                    id,
                    conversationTag: tag,
                    sentAt,
                    expiresAt,
                    unread: true,
                    ciphertext
                })
            );
            return id;
        } finally {
            db.close();
        }
    }

    /**
     * Release held messages once they have been shown: kept for the
     * conversation's retention if that still covers them, deleted otherwise.
     *
     * @param {string} peer
     * @param {{ retentionMs?: number, rowIds?: string[] }} [options] only these rows, when given
     * @returns {Promise<number>} how many were released
     */
    async markRead(peer, { retentionMs, rowIds } = {}) {
        const owner = await this._owner();
        const peerKey = MessageArchive._peer(peer);
        const tag = conversationTag(owner, peerKey);
        const retention =
            retentionMs === undefined ? await this.getRetention(peerKey) : normalizeRetention(retentionMs);
        const only = Array.isArray(rowIds) ? new Set(rowIds) : null;
        const now = this.now();

        const db = await openDb();
        try {
            const rows = /** @type {any[]} */ (
                (await promisify(store(db, STORE_MESSAGES, 'readonly').index(INDEX_CONVERSATION).getAll(tag))) || []
            );
            let released = 0;
            for (const row of rows) {
                if (row.unread !== true || (only && !only.has(row.id))) continue;
                const expiresAt = Number(row.sentAt) + retention;
                if (retention > 0 && expiresAt > now) {
                    const kept = { ...row, expiresAt };
                    delete kept.unread;
                    await promisify(store(db, STORE_MESSAGES, 'readwrite').put(kept));
                } else {
                    await promisify(store(db, STORE_MESSAGES, 'readwrite').delete(row.id));
                }
                released += 1;
            }
            return released;
        } finally {
            db.close();
        }
    }

    /**
     * How many held messages wait in each of these conversations. Reads only
     * the plain marks beside the sealed rows, so nothing is decrypted.
     *
     * @param {string[]} peers
     * @returns {Promise<Map<string, number>>} peer → unread count, only where there are some
     */
    async unreadCounts(peers) {
        const owner = await this._owner();
        const byTag = new Map();
        for (const peer of peers || []) {
            try {
                const key = MessageArchive._peer(peer);
                byTag.set(conversationTag(owner, key), key);
            } catch (_) {
                // Not a conversation key; nothing to count.
            }
        }
        const counts = new Map();
        if (byTag.size === 0) return counts;

        const now = this.now();
        const db = await openDb();
        try {
            const rows = /** @type {any[]} */ ((await promisify(store(db, STORE_MESSAGES, 'readonly').getAll())) || []);
            for (const row of rows) {
                if (row.unread !== true || !(Number(row.expiresAt) > now)) continue;
                const peer = byTag.get(row.conversationTag);
                if (peer) counts.set(peer, (counts.get(peer) || 0) + 1);
            }
            return counts;
        } finally {
            db.close();
        }
    }

    /**
     * What this conversation kept, and what is held for it unread, oldest
     * first. Expired rows are purged first, so nothing past its window is ever
     * shown.
     *
     * @param {string} peer
     * @returns {Promise<Array<{ id: string, from: string, text: string, timestamp: string, own: boolean,
     *                           unread: boolean, rowId: string }>>}
     */
    async history(peer) {
        const owner = await this._owner();
        const tag = conversationTag(owner, MessageArchive._peer(peer));
        await this.purgeExpired();
        const db = await openDb();
        let rows;
        try {
            rows = /** @type {any[]} */ (
                (await promisify(store(db, STORE_MESSAGES, 'readonly').index(INDEX_CONVERSATION).getAll(tag))) || []
            );
        } finally {
            db.close();
        }

        const messages = [];
        for (const row of rows.sort((a, b) => a.sentAt - b.sentAt)) {
            try {
                const message = JSON.parse(await this.signer.nostrDecrypt(row.ciphertext, owner));
                messages.push({
                    id: `${message.id || ''}`,
                    from: `${message.from || ''}`,
                    text: `${message.text || ''}`,
                    timestamp: `${message.timestamp || ''}`,
                    own: message.own === true,
                    unread: row.unread === true,
                    rowId: `${row.id}`
                });
            } catch (_) {
                // Not this wallet's, or damaged: skipped, never shown half-read.
            }
        }
        return messages;
    }

    /**
     * Delete everything past its expiry. Needs no wallet: it reads only the
     * plain expiry time beside each sealed row.
     *
     * @returns {Promise<number>} how many rows were deleted
     */
    async purgeExpired() {
        const now = this.now();
        const db = await openDb();
        try {
            const rows = /** @type {any[]} */ ((await promisify(store(db, STORE_MESSAGES, 'readonly').getAll())) || []);
            let removed = 0;
            for (const row of rows) {
                if (!(Number(row.expiresAt) > now)) {
                    await promisify(store(db, STORE_MESSAGES, 'readwrite').delete(row.id));
                    removed += 1;
                }
            }
            return removed;
        } finally {
            db.close();
        }
    }

    /**
     * Forget a conversation entirely: its messages and its setting.
     * @param {string} peer
     */
    async forget(peer) {
        const tag = conversationTag(await this._owner(), MessageArchive._peer(peer));
        const db = await openDb();
        try {
            await promisify(store(db, STORE_SETTINGS, 'readwrite').delete(tag));
            await this._deleteConversation(db, tag);
        } finally {
            db.close();
        }
    }

    /**
     * @param {IDBDatabase} db
     * @param {string} tag
     * @param {{ keepUnread?: boolean }} [options] spare messages still held unread
     */
    async _deleteConversation(db, tag, { keepUnread = false } = {}) {
        const rows = /** @type {any[]} */ (
            (await promisify(store(db, STORE_MESSAGES, 'readonly').index(INDEX_CONVERSATION).getAll(tag))) || []
        );
        for (const row of rows) {
            if (keepUnread && row.unread === true) continue;
            await promisify(store(db, STORE_MESSAGES, 'readwrite').delete(row.id));
        }
    }
}

export const MESSAGES_DB_NAME = DB_NAME;
export const MESSAGES_STORE_NAME = STORE_MESSAGES;
export const MESSAGES_SETTINGS_STORE_NAME = STORE_SETTINGS;
