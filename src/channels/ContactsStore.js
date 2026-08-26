// @ts-check
/**
 * Trusted contacts (friends) for the Direct Messenger.
 *
 * This is an **authorization** layer on top of the existing authentication.
 * Nothing here replaces a cryptographic check: a contact record only answers
 * "has the local user consented to talk to this identity?". Whether the peer
 * really is that identity is still decided by the NIP-59 / NIP-44 / Web25
 * bootstrap verification, every time, for trusted and untrusted peers alike.
 *
 * Protection model
 * ----------------
 * Contact records are encrypted at rest with the wallet's own Nostr identity
 * (NIP-44 v2 to self, through the existing narrowly scoped wallet-worker
 * operations). The consequences are the ones the design wants:
 *
 *   - a locked wallet cannot read or write a contact, because the worker
 *     refuses the operation. There is no second password and no separate
 *     unlock path;
 *   - IndexedDB holds opaque ids and ciphertext, never a peer key, an EVM
 *     address or a display name;
 *   - **no private key, PRF output or derived secret is persisted here.** The
 *     only things written are ciphertext and timestamps.
 *
 * Nothing in this file is ever published to a relay. The display name in
 * particular is yours alone: publishing it would bind a human label to a public
 * key for everybody to see.
 *
 * Stored in its own IndexedDB database so it never shares a connection or an
 * upgrade path with the wallet vault in `web25-auth`.
 */

import { sha256 } from '@noble/hashes/sha256';
import { evmAddressFromPublicKey } from './ecies.js';

const DB_NAME = 'web25-contacts';
/**
 * v2 replaces the v1 plaintext store. The old store is dropped on upgrade
 * rather than migrated: plaintext contacts written before this layer existed
 * cannot be re-encrypted without the wallet, and keeping them would leave
 * exactly the readable-while-locked copy this store exists to remove.
 */
const DB_VERSION = 2;
const STORE_CONTACTS = 'contacts';
/** Secondary index so one owner's records can be listed without decrypting. */
const INDEX_OWNER = 'byOwner';

const HEX32_RE = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const ECIES_PUBKEY_RE = /^(0x)?04[0-9a-f]{128}$/;
const MAX_NAME_LENGTH = 64;

/**
 * Control and bidi characters, which would let a name taken from an invitation
 * or a relay profile reorder what the contact list shows.
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Trust states a contact record can hold. */
export const TRUST = /** @type {const} */ ({
    /** Explicitly approved: may auto-connect after the usual crypto checks. */
    TRUSTED: 'trusted',
    /** Awaiting the local user's decision. Never auto-answered. */
    PENDING: 'pending',
    /** Explicitly refused. Treated as unknown, but remembered. */
    BLOCKED: 'blocked'
});

/** @param {Uint8Array} bytes */
function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {string} text */
function hashHex(text) {
    return toHex(sha256(new TextEncoder().encode(text)));
}

/**
 * Opaque per-owner record id.
 *
 * Both inputs are public keys, so this leaks nothing the npub does not already
 * leak. What it buys is that the *contact list itself* stays unreadable while
 * locked: a stored row names neither party.
 *
 * @param {string} ownerNostrPublicKey
 * @param {string} peerNostrPublicKey
 */
export function contactRecordId(ownerNostrPublicKey, peerNostrPublicKey) {
    return hashHex(`web25-contact:${ownerNostrPublicKey}:${peerNostrPublicKey}`);
}

/** @param {string} ownerNostrPublicKey */
export function contactOwnerTag(ownerNostrPublicKey) {
    return hashHex(`web25-contact-owner:${ownerNostrPublicKey}`);
}

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (db.objectStoreNames.contains(STORE_CONTACTS)) db.deleteObjectStore(STORE_CONTACTS);
            const created = db.createObjectStore(STORE_CONTACTS, { keyPath: 'id' });
            created.createIndex(INDEX_OWNER, 'ownerTag', { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/**
 * @param {IDBDatabase} db
 * @param {IDBTransactionMode} mode
 */
function store(db, mode) {
    return db.transaction(STORE_CONTACTS, mode).objectStore(STORE_CONTACTS);
}

/** @param {IDBRequest} request */
function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** @param {string} value */
function safeName(value) {
    return `${value || ''}`.replace(UNSAFE_NAME_CHARS, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * Check that a peer's three identities are really one key.
 *
 * The tuple is the whole point of the record: a Nostr pubkey, an ECIES public
 * key and an EVM address are only meaningful together. Independently stored
 * strings are never trusted. If the relationship no longer validates, the
 * record is rejected however well it matches an existing contact.
 *
 * @param {{ nostrPublicKey?: string, eciesPublicKey?: string, evmAddress?: string|null }} identity
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function verifyIdentityTuple(identity) {
    const nostrPublicKey = `${identity?.nostrPublicKey || ''}`.trim().toLowerCase();
    const eciesPublicKey = `${identity?.eciesPublicKey || ''}`.trim().toLowerCase();
    const evmAddress = `${identity?.evmAddress || ''}`.trim().toLowerCase();

    if (!HEX32_RE.test(nostrPublicKey)) return { ok: false, reason: 'Nostr public key is malformed.' };
    if (!ECIES_PUBKEY_RE.test(eciesPublicKey)) return { ok: false, reason: 'ECIES public key is malformed.' };
    if (!EVM_ADDRESS_RE.test(evmAddress)) return { ok: false, reason: 'EVM address is malformed.' };

    const uncompressed = eciesPublicKey.replace(/^0x/, '');

    // The Nostr identity is the x coordinate of the very same secp256k1 point.
    if (uncompressed.slice(2, 66) !== nostrPublicKey) {
        return { ok: false, reason: 'Nostr public key is not the x coordinate of the ECIES key.' };
    }

    let derived;
    try {
        derived = evmAddressFromPublicKey(uncompressed).toLowerCase();
    } catch (_) {
        return { ok: false, reason: 'ECIES public key does not describe a valid secp256k1 point.' };
    }
    if (derived !== evmAddress) {
        return { ok: false, reason: 'EVM address is not derived from the ECIES key.' };
    }

    return { ok: true, reason: null };
}

/**
 * Wallet-protected contacts.
 *
 * Every method needs an unlocked wallet, because every method has to reach the
 * worker to encrypt or decrypt. That is the protection: there is no cached
 * plaintext to fall back on, so locking is immediate and complete.
 */
export class ContactsStore {
    /**
     * @param {{ signer: { getNostrIdentity: () => Promise<any>,
     *                    nostrEncrypt: (plaintext: string, peerPublicKey: string) => Promise<string>,
     *                    nostrDecrypt: (payload: string, peerPublicKey: string) => Promise<string> },
     *           now?: () => number }} options
     */
    constructor({ signer, now = Date.now }) {
        if (!signer) throw new Error('ContactsStore requires a wallet signing handle.');
        this.signer = signer;
        this.now = now;
    }

    /**
     * The local wallet's Nostr public key: both the owner of every record here
     * and the key the records are encrypted to.
     * @returns {Promise<string>}
     */
    async _owner() {
        const identity = await this.signer.getNostrIdentity();
        const owner = `${identity?.nostrPublicKey || ''}`.trim().toLowerCase();
        if (!HEX32_RE.test(owner)) {
            throw new Error('Unlock your wallet to use trusted contacts.');
        }
        return owner;
    }

    /**
     * @param {string} owner
     * @param {any} contact
     */
    async _seal(owner, contact) {
        // NIP-44 v2 to self: the conversation key is ECDH of the wallet key
        // with its own public key, so only this wallet can open the record and
        // no new key material is created or stored.
        return this.signer.nostrEncrypt(JSON.stringify(contact), owner);
    }

    /**
     * @param {string} owner
     * @param {string} ciphertext
     */
    async _open(owner, ciphertext) {
        return JSON.parse(await this.signer.nostrDecrypt(ciphertext, owner));
    }

    /**
     * Create or update a trusted contact.
     *
     * The identity tuple is re-verified on every write, so a record can never
     * be stored, or silently updated, with a Nostr key, ECIES key and EVM
     * address that no longer belong to one another.
     *
     * @param {{ nostrPublicKey: string, npub?: string, eciesPublicKey: string,
     *           evmAddress: string, name?: string, trust?: string }} input
     */
    async save(input) {
        const verification = verifyIdentityTuple(input);
        if (!verification.ok) throw new Error(`Refusing to store a contact: ${verification.reason}`);

        const owner = await this._owner();
        const nostrPublicKey = `${input.nostrPublicKey}`.trim().toLowerCase();
        const id = contactRecordId(owner, nostrPublicKey);
        const trust = Object.values(TRUST).includes(/** @type {any} */ (input.trust)) ? input.trust : TRUST.TRUSTED;

        const db = await openDb();
        try {
            const existingRow = /** @type {any} */ (await promisify(store(db, 'readonly').get(id)));
            let existing = null;
            if (existingRow?.ciphertext) {
                try {
                    existing = await this._open(owner, existingRow.ciphertext);
                } catch (_) {
                    // An unreadable record is replaced rather than merged: a
                    // half-decrypted contact is worse than a fresh one.
                    existing = null;
                }
            }

            const now = this.now();
            const contact = {
                nostrPublicKey,
                npub: `${input.npub || ''}`.trim() || existing?.npub || '',
                eciesPublicKey: `${input.eciesPublicKey}`.trim().toLowerCase(),
                evmAddress: `${input.evmAddress}`.trim().toLowerCase(),
                name: safeName(input.name) || existing?.name || '',
                trust,
                createdAt: existing?.createdAt || now,
                updatedAt: now
            };

            await promisify(
                store(db, 'readwrite').put({
                    id,
                    ownerTag: contactOwnerTag(owner),
                    ciphertext: await this._seal(owner, contact),
                    createdAt: contact.createdAt,
                    updatedAt: contact.updatedAt
                })
            );
            return contact;
        } finally {
            db.close();
        }
    }

    /**
     * @param {string} nostrPublicKey
     * @returns {Promise<any|null>}
     */
    async get(nostrPublicKey) {
        const key = `${nostrPublicKey || ''}`.trim().toLowerCase();
        if (!HEX32_RE.test(key)) return null;

        const owner = await this._owner();
        const db = await openDb();
        try {
            const row = /** @type {any} */ (await promisify(store(db, 'readonly').get(contactRecordId(owner, key))));
            if (!row?.ciphertext) return null;

            let contact;
            try {
                contact = await this._open(owner, row.ciphertext);
            } catch (_) {
                return null;
            }

            // Re-verified on read as well: a record that was tampered with in
            // IndexedDB must not become trust just because it decrypts.
            if (!verifyIdentityTuple(contact).ok) return null;
            if (contact.nostrPublicKey !== key) return null;
            return contact;
        } finally {
            db.close();
        }
    }

    /**
     * Is this peer an approved friend?
     *
     * The one question the connection path asks. A pending or blocked record is
     * not trust, and neither is a record whose identity tuple no longer holds.
     *
     * @param {string} nostrPublicKey
     */
    async isTrusted(nostrPublicKey) {
        const contact = await this.get(nostrPublicKey);
        return contact?.trust === TRUST.TRUSTED;
    }

    /** @returns {Promise<any[]>} sorted by display name, then most recent */
    async list() {
        const owner = await this._owner();
        const ownerTag = contactOwnerTag(owner);
        const db = await openDb();
        try {
            const rows = /** @type {any[]} */ (
                (await promisify(store(db, 'readonly').index(INDEX_OWNER).getAll(ownerTag))) || []
            );

            const contacts = [];
            for (const row of rows) {
                try {
                    const contact = await this._open(owner, row.ciphertext);
                    if (verifyIdentityTuple(contact).ok) contacts.push(contact);
                } catch (_) {
                    // Skip anything this wallet cannot open or validate.
                }
            }

            return contacts.sort((a, b) => {
                const byName = `${a.name || ''}`.localeCompare(`${b.name || ''}`);
                return byName !== 0 ? byName : (b.updatedAt || 0) - (a.updatedAt || 0);
            });
        } finally {
            db.close();
        }
    }

    /**
     * Rename a contact. Identity is untouched: only the local label changes.
     * @param {string} nostrPublicKey
     * @param {string} name
     */
    async rename(nostrPublicKey, name) {
        const contact = await this.get(nostrPublicKey);
        if (!contact) return null;
        return this.save({ ...contact, name });
    }

    /**
     * Forget a contact.
     *
     * Removing a friend is purely a local authorization change: a future
     * invitation from them is treated as new and unknown, and needs approval
     * again. **No wallet or Nostr key is deleted or rotated** - the local
     * identity is unaffected, and so is the peer's.
     *
     * @param {string} nostrPublicKey
     */
    async remove(nostrPublicKey) {
        const key = `${nostrPublicKey || ''}`.trim().toLowerCase();
        if (!HEX32_RE.test(key)) return false;
        const owner = await this._owner();
        const db = await openDb();
        try {
            await promisify(store(db, 'readwrite').delete(contactRecordId(owner, key)));
            return true;
        } finally {
            db.close();
        }
    }
}

/**
 * Filter contacts locally by friendly name or either identity.
 * @param {any[]} contacts
 * @param {string} query
 */
export function filterContacts(contacts, query) {
    const needle = `${query || ''}`.trim().toLowerCase();
    if (!needle) return contacts || [];
    return (contacts || []).filter((contact) =>
        [contact.name, contact.npub, contact.nostrPublicKey, contact.evmAddress]
            .map((value) => `${value || ''}`.toLowerCase())
            .some((value) => value.includes(needle))
    );
}

export const CONTACTS_DB_NAME = DB_NAME;
export const CONTACTS_DB_VERSION = DB_VERSION;
export const CONTACTS_STORE_NAME = STORE_CONTACTS;
