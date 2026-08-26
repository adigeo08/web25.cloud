/**
 * A minimal in-memory IndexedDB, enough for the contacts store.
 *
 * Only what `ContactsStore` actually uses: `open` with `onupgradeneeded`,
 * object stores with a `keyPath`, one non-unique index, and
 * `get` / `put` / `delete` / `getAll`. Everything resolves on a microtask so
 * the request/callback shape matches the real API closely enough for the
 * store's `promisify()` wrapper.
 */

class FakeRequest {
    constructor() {
        this.result = undefined;
        this.error = null;
        this.onsuccess = null;
        this.onerror = null;
        this.onupgradeneeded = null;
    }

    _succeed(result) {
        this.result = result;
        queueMicrotask(() => this.onsuccess?.());
    }

    _fail(error) {
        this.error = error;
        queueMicrotask(() => this.onerror?.());
    }
}

class FakeIndex {
    /** @param {FakeStore} store @param {string} keyPath */
    constructor(store, keyPath) {
        this.store = store;
        this.keyPath = keyPath;
    }

    getAll(value) {
        const request = new FakeRequest();
        const rows = [...this.store.rows.values()].filter((row) => row[this.keyPath] === value);
        request._succeed(rows.map((row) => structuredClone(row)));
        return request;
    }
}

class FakeStore {
    constructor(name, keyPath) {
        this.name = name;
        this.keyPath = keyPath;
        /** @type {Map<any, any>} */
        this.rows = new Map();
        /** @type {Map<string, string>} index name to key path */
        this.indexes = new Map();
    }

    createIndex(name, keyPath) {
        this.indexes.set(name, keyPath);
        return new FakeIndex(this, keyPath);
    }

    index(name) {
        const keyPath = this.indexes.get(name);
        if (!keyPath) throw new Error(`No such index: ${name}`);
        return new FakeIndex(this, keyPath);
    }

    get(key) {
        const request = new FakeRequest();
        const row = this.rows.get(key);
        request._succeed(row ? structuredClone(row) : undefined);
        return request;
    }

    getAll() {
        const request = new FakeRequest();
        request._succeed([...this.rows.values()].map((row) => structuredClone(row)));
        return request;
    }

    put(value) {
        const request = new FakeRequest();
        this.rows.set(value[this.keyPath], structuredClone(value));
        request._succeed(value[this.keyPath]);
        return request;
    }

    delete(key) {
        const request = new FakeRequest();
        this.rows.delete(key);
        request._succeed(undefined);
        return request;
    }
}

class FakeDatabase {
    constructor(name) {
        this.name = name;
        this.version = 0;
        /** @type {Map<string, FakeStore>} */
        this.stores = new Map();
        this.closed = false;
    }

    get objectStoreNames() {
        const names = [...this.stores.keys()];
        return { contains: (name) => names.includes(name) };
    }

    createObjectStore(name, { keyPath }) {
        const store = new FakeStore(name, keyPath);
        this.stores.set(name, store);
        return store;
    }

    deleteObjectStore(name) {
        this.stores.delete(name);
    }

    transaction(name) {
        return { objectStore: () => this.stores.get(name) };
    }

    close() {
        this.closed = true;
    }
}

/**
 * Install a fake `globalThis.indexedDB`.
 * @returns {{ databases: Map<string, FakeDatabase>, restore: () => void, rawRows: (db?: string, store?: string) => any[] }}
 */
export function installFakeIndexedDb() {
    /** @type {Map<string, FakeDatabase>} */
    const databases = new Map();
    const previous = globalThis.indexedDB;

    globalThis.indexedDB = {
        open(name, version) {
            const request = new FakeRequest();
            let db = databases.get(name);
            if (!db) {
                db = new FakeDatabase(name);
                databases.set(name, db);
            }

            const needsUpgrade = version > db.version;
            if (needsUpgrade) db.version = version;

            queueMicrotask(() => {
                db.closed = false;
                if (needsUpgrade) {
                    request.result = db;
                    request.onupgradeneeded?.();
                }
                request._succeed(db);
            });
            return request;
        }
    };

    return {
        databases,
        rawRows(dbName = 'web25-contacts', storeName = 'secure_contacts') {
            const store = databases.get(dbName)?.stores.get(storeName);
            return store ? [...store.rows.values()] : [];
        },
        /**
         * Pre-seed a v1 plaintext database, so an upgrade to v2 is exercised
         * exactly as it would be for a user who already had contacts.
         *
         * @param {any[]} contacts v1 records: { nostrPublicKey, npub, evmAddress, name }
         */
        seedLegacy(contacts, dbName = 'web25-contacts') {
            const db = new FakeDatabase(dbName);
            db.version = 1;
            const legacy = db.createObjectStore('contacts', { keyPath: 'nostrPublicKey' });
            legacy.createIndex('byEvmAddress', 'evmAddress');
            for (const contact of contacts) {
                legacy.rows.set(contact.nostrPublicKey, structuredClone({ createdAt: Date.now(), ...contact }));
            }
            databases.set(dbName, db);
            return db;
        },
        legacyRows(dbName = 'web25-contacts') {
            const store = databases.get(dbName)?.stores.get('contacts');
            return store ? [...store.rows.values()] : [];
        },
        hasStore(name, dbName = 'web25-contacts') {
            return Boolean(databases.get(dbName)?.stores.has(name));
        },
        restore() {
            if (previous === undefined) delete globalThis.indexedDB;
            else globalThis.indexedDB = previous;
        }
    };
}
