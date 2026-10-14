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
                await this._deleteConversation(db, tag);
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
     * What this conversation kept, oldest first. Expired rows are purged first,
     * so nothing past its window is ever shown.
     *
     * @param {string} peer
     * @returns {Promise<Array<{ id: string, from: string, text: string, timestamp: string, own: boolean }>>}
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
                    own: message.own === true
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
     */
    async _deleteConversation(db, tag) {
        const rows = /** @type {any[]} */ (
            (await promisify(store(db, STORE_MESSAGES, 'readonly').index(INDEX_CONVERSATION).getAll(tag))) || []
        );
        for (const row of rows) await promisify(store(db, STORE_MESSAGES, 'readwrite').delete(row.id));
    }
}

export const MESSAGES_DB_NAME = DB_NAME;
export const MESSAGES_STORE_NAME = STORE_MESSAGES;
export const MESSAGES_SETTINGS_STORE_NAME = STORE_SETTINGS;
