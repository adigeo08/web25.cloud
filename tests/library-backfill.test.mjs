/**
 * The library has to include what was already there.
 *
 * Creating the index store does not fill it. Without a backfill, every visitor
 * who had ever loaded a site would open the new library and find it empty until
 * they happened to visit each of those sites again — which is the one thing the
 * library exists to save them from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

global.window = global.window || { location: { hostname: 'localhost' } };

const encode = (text) => new TextEncoder().encode(text);

/** Recent enough that the cache's own freshness window keeps them. */
const RECENT = Date.now() - 60 * 1000;

function site(title) {
    const html = `<html><head><title>${title}</title></head><body>x</body></html>`;
    return {
        'index.html': { content: encode(html), type: 'text/html', size: html.length }
    };
}

let idb;
test.beforeEach(() => {
    idb = installFakeIndexedDb();
});
test.afterEach(() => {
    idb.restore();
});

/** A cache whose `sites` store predates the library, as every real one does. */
async function cacheWithLegacySites(entries) {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const cache = new PeerWebCache();
    const db = await cache.openDB();

    for (const [hash, record] of entries) {
        await new Promise((resolve, reject) => {
            const request = db
                .transaction([cache.storeName], 'readwrite')
                .objectStore(cache.storeName)
                .put({
                    hash,
                    data: record.data,
                    signatureState: record.signatureState || null,
                    timestamp: record.timestamp
                });
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
        });
    }
    return cache;
}

test('sites cached before the index are indexed on first use', async () => {
    const cache = await cacheWithLegacySites([
        ['1'.repeat(40), { data: site('Bakery hours'), timestamp: RECENT }],
        [
            '2'.repeat(40),
            {
                data: site('Club night'),
                timestamp: RECENT - 1000,
                signatureState: { publisher: '0xabc0000000000000000000000000000000000001', verified: true }
            }
        ]
    ]);

    const entries = await cache.listLibrary();

    assert.deepEqual(
        entries.map((entry) => entry.title),
        ['Bakery hours', 'Club night']
    );
    assert.equal(entries[1].publisher, '0xabc0000000000000000000000000000000000001');
    assert.equal(entries[1].verified, true);
    assert.equal(entries[0].savedAt, RECENT, 'the row keeps the time the site was actually cached');
});

test('the backfill runs once, not on every keystroke', async () => {
    const cache = await cacheWithLegacySites([['3'.repeat(40), { data: site('Gallery'), timestamp: RECENT }]]);

    assert.equal(await cache.backfillLibrary(), 1);
    assert.equal(await cache.backfillLibrary(), 0, 'a second call does no work');
    assert.equal((await cache.listLibrary()).length, 1);
});

test('a backfilled site is searchable straight away', async () => {
    const cache = await cacheWithLegacySites([['4'.repeat(40), { data: site('Darkroom prints'), timestamp: RECENT }]]);

    const results = await cache.searchLibrary('darkroom');

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, '4'.repeat(40));
});

test('a newly cached site is indexed without waiting for a backfill', async () => {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const cache = new PeerWebCache();

    await cache.set('5'.repeat(40), site('Fresh site'), { signatureState: { verified: true, publisher: '0xfeed' } });

    const entries = await cache.listLibrary();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'Fresh site');
});

test('deleting a site takes its index row with it', async () => {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const cache = new PeerWebCache();
    await cache.set('6'.repeat(40), site('Going away'), {});

    await cache.delete('6'.repeat(40));

    // A row pointing at bytes that are gone would offer the user a result that
    // opens onto a cache miss.
    assert.deepEqual(await cache.listLibrary(), []);
});
