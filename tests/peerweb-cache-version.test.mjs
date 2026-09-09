/**
 * Opening the site cache.
 *
 * The cache used to ask for version 1 explicitly. A browser whose database had
 * reached a higher version answered every single read with
 * `VersionError: The requested version (1) is less than the existing version
 * (2)`, and the cache silently stopped working for that visitor — with no way
 * back, since the version only ever goes up. Asking for whatever exists cannot
 * collide; a version is named only to add the object store when it is missing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

global.window = global.window || { location: { hostname: 'localhost' } };
const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');

/**
 * An IndexedDB double holding one database.
 *
 * @param {{ version: number, stores: string[] }} state
 */
function fakeIndexedDB(state) {
    const opens = [];

    const makeDb = () => ({
        version: state.version,
        objectStoreNames: { contains: (name) => state.stores.includes(name) },
        close() {
            this.closed = true;
        },
        transaction: () => ({
            objectStore: () => ({
                get: () => ({ onsuccess: null, onerror: null, result: undefined }),
                put: () => ({}),
                delete: () => ({})
            })
        }),
        createObjectStore(name) {
            state.stores.push(name);
            return { createIndex() {} };
        }
    });

    return {
        opens,
        open(name, version) {
            opens.push(version);
            const request = { onerror: null, onsuccess: null, onblocked: null, onupgradeneeded: null, result: null };
            queueMicrotask(() => {
                if (version !== undefined && version < state.version) {
                    request.error = new Error(
                        `The requested version (${version}) is less than the existing version (${state.version}).`
                    );
                    request.error.name = 'VersionError';
                    request.onerror?.();
                    return;
                }
                const upgrading = version !== undefined && version > state.version;
                if (upgrading) state.version = version;
                request.result = makeDb();
                if (upgrading) request.onupgradeneeded?.({ target: request });
                request.onsuccess?.();
            });
            return request;
        }
    };
}

test('a database that is already past version 1 opens without a VersionError', async () => {
    const idb = fakeIndexedDB({ version: 2, stores: ['sites'] });
    global.indexedDB = idb;

    const cache = new PeerWebCache();
    const db = await cache.openDB();

    assert.deepEqual(idb.opens, [undefined], 'the version is not pinned');
    assert.equal(db.version, 2, 'the cache works at whatever version the browser is on');
});

test('the open handle is reused instead of reopened per operation', async () => {
    const idb = fakeIndexedDB({ version: 5, stores: ['sites'] });
    global.indexedDB = idb;

    const cache = new PeerWebCache();
    await cache.openDB();
    await cache.openDB();
    await cache.openDB();

    assert.equal(idb.opens.length, 1);
});

test('a missing object store is added in one upgrade, at the version that exists', async () => {
    const state = { version: 3, stores: [] };
    const idb = fakeIndexedDB(state);
    global.indexedDB = idb;

    const cache = new PeerWebCache();
    await cache.openDB();

    assert.deepEqual(idb.opens, [undefined, 4], 'one probe, then one upgrade above the existing version');
    assert.deepEqual(state.stores, ['sites']);
});

test('a fresh browser creates the database and its store', async () => {
    const state = { version: 0, stores: [] };
    const idb = fakeIndexedDB(state);
    global.indexedDB = idb;

    const cache = new PeerWebCache();
    await cache.openDB();

    assert.deepEqual(idb.opens, [undefined, 1]);
    assert.deepEqual(state.stores, ['sites']);
});

test('a read that cannot open the database reports null instead of throwing', async () => {
    global.indexedDB = {
        open() {
            const request = { onerror: null, onsuccess: null, onblocked: null, onupgradeneeded: null };
            queueMicrotask(() => {
                request.error = new Error('nope');
                request.onerror?.();
            });
            return request;
        }
    };

    const cache = new PeerWebCache();
    assert.equal(await cache.getEntry('0123'), null);
    assert.equal(await cache.get('0123'), null);
});
