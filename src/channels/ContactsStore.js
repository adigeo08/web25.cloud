// @ts-check
/**
 * Local contacts for the Direct Messenger.
 *
 * Entirely local: a friendly name you choose, paired with the identities you
 * already know from an invitation or a search. Nothing here is ever published
 * to a relay — the name in particular is yours alone, and publishing it would
 * link a human label to a public key for everyone to see.
 *
 * Stored in its own IndexedDB database so it never shares a connection or an
 * upgrade path with the wallet vault in `web25-auth`.
 */

const DB_NAME = 'web25-contacts';
const DB_VERSION = 1;
const STORE_CONTACTS = 'contacts';
/** Secondary index so a contact can be found from an invitation's EVM address. */
const INDEX_EVM = 'byEvmAddress';

const HEX32_RE = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const MAX_NAME_LENGTH = 64;

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_CONTACTS)) {
                // Keyed by Nostr public key: that is the identity the Direct
                // Messenger addresses, and it is stable per wallet.
                const store = db.createObjectStore(STORE_CONTACTS, { keyPath: 'nostrPublicKey' });
                store.createIndex(INDEX_EVM, 'evmAddress', { unique: false });
            }
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

/**
 * Normalize and validate a contact before it is stored.
 *
 * @param {{ nostrPublicKey: string, npub?: string, evmAddress?: string|null, name?: string }} input
 */
export function normalizeContact(input) {
    const nostrPublicKey = `${input?.nostrPublicKey || ''}`.trim().toLowerCase();
    if (!HEX32_RE.test(nostrPublicKey)) throw new Error('A contact needs a 32-byte hex Nostr public key.');

    const evmAddressRaw = `${input?.evmAddress || ''}`.trim().toLowerCase();
    if (evmAddressRaw && !EVM_ADDRESS_RE.test(evmAddressRaw)) throw new Error('Contact EVM address is malformed.');

    const name = `${input?.name || ''}`
        // Control and bidi characters would let a name from an invitation
        // reorder what the contact list shows.
        .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .trim()
        .slice(0, MAX_NAME_LENGTH);

    return {
        nostrPublicKey,
        npub: `${input?.npub || ''}`.trim(),
        evmAddress: evmAddressRaw || null,
        name
    };
}

/**
 * Create or update a contact. Existing fields are preserved when the caller
 * does not supply them, so learning an EVM address later does not wipe a name.
 *
 * @param {{ nostrPublicKey: string, npub?: string, evmAddress?: string|null, name?: string }} input
 */
export async function saveContact(input) {
    const normalized = normalizeContact(input);
    const db = await openDb();
    try {
        const existing = /** @type {any} */ (await promisify(store(db, 'readonly').get(normalized.nostrPublicKey)));
        const now = Date.now();
        const record = {
            ...existing,
            ...normalized,
            npub: normalized.npub || existing?.npub || '',
            evmAddress: normalized.evmAddress ?? existing?.evmAddress ?? null,
            name: normalized.name || existing?.name || '',
            createdAt: existing?.createdAt || now,
            updatedAt: now
        };
        await promisify(store(db, 'readwrite').put(record));
        return record;
    } finally {
        db.close();
    }
}

/** @param {string} nostrPublicKey */
export async function getContact(nostrPublicKey) {
    const key = `${nostrPublicKey || ''}`.trim().toLowerCase();
    if (!HEX32_RE.test(key)) return null;
    const db = await openDb();
    try {
        return (await promisify(store(db, 'readonly').get(key))) || null;
    } finally {
        db.close();
    }
}

/** @returns {Promise<any[]>} newest-updated first */
export async function listContacts() {
    const db = await openDb();
    try {
        const all = /** @type {any[]} */ ((await promisify(store(db, 'readonly').getAll())) || []);
        return all.sort((a, b) => {
            const byName = `${a.name || ''}`.localeCompare(`${b.name || ''}`);
            return byName !== 0 ? byName : (b.updatedAt || 0) - (a.updatedAt || 0);
        });
    } finally {
        db.close();
    }
}

/** @param {string} nostrPublicKey */
export async function deleteContact(nostrPublicKey) {
    const key = `${nostrPublicKey || ''}`.trim().toLowerCase();
    if (!HEX32_RE.test(key)) return false;
    const db = await openDb();
    try {
        await promisify(store(db, 'readwrite').delete(key));
        return true;
    } finally {
        db.close();
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
export const CONTACTS_STORE_NAME = STORE_CONTACTS;
