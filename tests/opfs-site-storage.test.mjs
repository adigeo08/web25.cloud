/**
 * Where site bytes live once OPFS is there.
 *
 * Nothing about deploying, loading or reseeding changes: the same records go
 * in and come out. What changes is that the bytes are files — a git repository
 * per page under `/web25/pages`, a plain tree per cached site and per kept
 * payload — and IndexedDB keeps only what describes them. These tests hold the
 * stores to both halves: round trips are byte-exact and in order, and the
 * bytes really are not in IndexedDB any more.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as isomorphicGit from 'isomorphic-git';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import { createFakeOpfs } from './helpers/fake-opfs.mjs';
import { OpfsFs } from '../src/storage/OpfsFs.js';
import { GitWorkspace } from '../src/storage/GitWorkspace.js';
import SeedingSessionStore from '../src/core/torrent/SeedingSessionStore.js';

global.window = global.window || { location: { hostname: 'localhost' } };

const encode = (value) => new TextEncoder().encode(value);
const decode = (bytes) => new TextDecoder().decode(bytes);

let idb;
let opfs;
let ws;
test.beforeEach(() => {
    idb = installFakeIndexedDb();
    opfs = createFakeOpfs();
    ws = new GitWorkspace({
        fs: new OpfsFs({ root: opfs.storage.getDirectory }),
        loadGit: async () => isomorphicGit,
        available: async () => true,
        report: () => {}
    });
});
test.afterEach(() => {
    idb.restore();
});

function deployment(hash = 'aa11', extra = {}) {
    return {
        hash,
        siteName: 'demo',
        torrentName: 'demo',
        pieceLength: 16384,
        createdAt: '2026-10-01T00:00:00.000Z',
        savedAt: 0,
        length: 7,
        fileCount: 2,
        torrentFile: encode('d4:infoe'),
        files: [
            { path: '.torrentchain', type: 'application/json', bytes: encode('{"sig":1}') },
            { path: 'site.bundle.json.gz', type: 'application/gzip', bytes: new Uint8Array([31, 139, 8, 0]) }
        ],
        deploy: { url: 'https://web25.cloud/#aa11', signedBy: '0xPublisher', signature: '0xsig', mirror: null },
        ...extra
    };
}

test('a deployment lands in a git repository, and IndexedDB keeps no bytes', async () => {
    const store = new SeedingSessionStore({ workspace: ws });
    await store.put(deployment());

    const [row] = idb.rawRows('web25-seeding', 'sessions');
    assert.equal(row.payloadStorage, 'opfs');
    await ws.settled('/web25/pages/aa11');
    assert.match(await store.repositoryHead('aa11'), /^[0-9a-f]{40}$/);
    assert.deepEqual(
        row.files.map((file) => [file.path, file.size, 'bytes' in file]),
        [
            ['.torrentchain', 9, false],
            ['site.bundle.json.gz', 4, false]
        ]
    );

    assert.deepEqual(await ws.listFiles('/web25/pages/aa11'), ['.torrentchain', 'site.bundle.json.gz']);
    const log = await ws.log('/web25/pages/aa11');
    assert.equal(log.length, 1);
    assert.equal(log[0].message, 'Deploy demo (aa11)');
    assert.equal(log[0].author, '0xPublisher');

    // Read back exactly as it went in: same order, same bytes.
    const back = await store.get('aa11');
    assert.deepEqual(
        back.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );
    assert.equal(decode(back.files[0].bytes), '{"sig":1}');
    assert.deepEqual([...back.files[1].bytes], [31, 139, 8, 0]);
});

test('a reseed is a commit too, and the listing does not read any bytes', async () => {
    const store = new SeedingSessionStore({ workspace: ws });
    await store.put(deployment('bb22', { reseeded: true }));
    await ws.settled('/web25/pages/bb22');
    const log = await ws.log('/web25/pages/bb22');
    assert.equal(log[0].message, 'Reseed demo (bb22)');

    const [listed] = await store.list({ payload: false });
    assert.equal(listed.files[0].bytes, undefined);
    const [full] = await store.list();
    assert.equal(decode(full.files[0].bytes), '{"sig":1}');
});

test('changing a field does not rewrite the site, and removing the session removes its repository', async () => {
    const store = new SeedingSessionStore({ workspace: ws });
    await store.put(deployment());
    await ws.settled('/web25/pages/aa11');
    const before = (await ws.log('/web25/pages/aa11')).length;

    const patched = await store.patch('aa11', { paused: true, deploy: { mirrorState: 'ready' } });
    assert.equal(patched.paused, true);
    assert.equal(patched.deploy.signedBy, '0xPublisher');
    assert.equal(decode(patched.files[0].bytes), '{"sig":1}');
    assert.equal((await ws.log('/web25/pages/aa11')).length, before);

    await store.remove('aa11');
    assert.equal(await store.get('aa11'), null);
    assert.deepEqual(opfs.list(), []);
});

test('a payload that cannot be a tree stays inline, as before', async () => {
    const store = new SeedingSessionStore({ workspace: ws });
    const record = deployment('cc33');
    record.files = [{ path: '.git/config', type: 'text/plain', bytes: encode('[core]') }];
    await store.put(record);
    const [row] = idb.rawRows('web25-seeding', 'sessions');
    assert.equal(row.payloadStorage, undefined);
    assert.equal(decode(row.files[0].bytes), '[core]');
    assert.deepEqual(opfs.list(), []);
});

test('without OPFS nothing changes', async () => {
    const store = new SeedingSessionStore({ workspace: null });
    await store.put(deployment());
    const [row] = idb.rawRows('web25-seeding', 'sessions');
    assert.equal(row.payloadStorage, undefined);
    assert.equal(decode(row.files[0].bytes), '{"sig":1}');
    assert.equal(await store.migrateToWorkspace(), 0);
});

test('sessions saved inline before move into their repositories, once', async () => {
    const legacy = new SeedingSessionStore({ workspace: null });
    await legacy.put(deployment());

    const store = new SeedingSessionStore({ workspace: ws });
    assert.equal(await store.migrateToWorkspace(), 1);
    assert.equal(await store.migrateToWorkspace(), 0);
    const [row] = idb.rawRows('web25-seeding', 'sessions');
    assert.equal(row.payloadStorage, 'opfs');
    assert.equal(decode((await store.get('aa11')).files[0].bytes), '{"sig":1}');
});

test('a cached site is a tree of files; the row describes it', async () => {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const cache = new PeerWebCache({ workspace: ws });
    const html = '<html><head><title>Hello</title></head><body>hi</body></html>';
    await cache.set('dd44', {
        'index.html': { content: encode(html), type: 'text/html', isText: true, size: html.length },
        'css/site.css': { content: 'body{}', type: 'text/css', isText: true, size: 6 }
    });
    // Cached as it always was — the render waits on that — then moved.
    assert.equal(idb.rawRows('PeerWebCache', 'sites')[0].dataStorage, undefined);
    await cache.whenSettled();

    const [row] = idb.rawRows('PeerWebCache', 'sites');
    assert.equal(row.dataStorage, 'opfs');
    assert.equal(row.data['index.html'].content, undefined);
    assert.deepEqual(await ws.listFiles('/web25/sites/dd44'), ['css/site.css', 'index.html']);
    // A plain tree: only reseeding makes a site a repository.
    assert.equal(await ws.hasRepository('/web25/sites/dd44'), false);

    const site = await cache.get('dd44');
    assert.equal(decode(site['index.html'].content), html);
    assert.equal(site['css/site.css'].content, 'body{}');
    assert.equal(site['index.html'].type, 'text/html');

    // Still findable by name: the library is built from the site, not the row.
    const [entry] = await cache.searchLibrary('hello');
    assert.equal(entry?.hash, 'dd44');

    await cache.delete('dd44');
    assert.equal(await cache.get('dd44'), null);
    assert.deepEqual(opfs.list(), []);
});

test('a site cached before OPFS moves there on its next read', async () => {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const legacy = new PeerWebCache({ workspace: null });
    await legacy.set('ee55', { 'index.html': { content: encode('<p>old</p>'), type: 'text/html' } });

    const cache = new PeerWebCache({ workspace: ws });
    const site = await cache.get('ee55');
    assert.equal(decode(site['index.html'].content), '<p>old</p>');
    await cache.whenSettled();
    const [row] = idb.rawRows('PeerWebCache', 'sites');
    assert.equal(row.dataStorage, 'opfs');
    assert.deepEqual(await ws.listFiles('/web25/sites/ee55'), ['index.html']);
    assert.equal(decode((await cache.get('ee55'))['index.html'].content), '<p>old</p>');
});

test('a newer copy, or a deletion, wins over a move that started before it', async () => {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const cache = new PeerWebCache({ workspace: ws });
    await cache.set('ab12', { 'index.html': { content: encode('<p>partial</p>'), type: 'text/html' } });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.set('ab12', { 'index.html': { content: encode('<p>complete</p>'), type: 'text/html' } });
    await cache.whenSettled();
    assert.equal(decode((await cache.get('ab12'))['index.html'].content), '<p>complete</p>');

    await cache.set('cd34', { 'index.html': { content: encode('<p>bye</p>'), type: 'text/html' } });
    await cache.delete('cd34');
    await cache.whenSettled();
    assert.equal(await cache.get('cd34'), null);
    assert.deepEqual(await ws.listFiles('/web25/sites/cd34'), []);
});

test('the payload kept for reseeding is a tree too, read back in order', async () => {
    const { default: PeerWebCache } = await import('../src/cache/PeerWebCache.js');
    const cache = new PeerWebCache({ workspace: ws });
    const ok = await cache.setPayload('ff66', {
        torrentFile: encode('d4:infoe'),
        files: [
            { path: 'site.bundle.json.gz', type: 'application/gzip', bytes: new Uint8Array([1, 2]) },
            { path: '.torrentchain', type: 'application/json', bytes: encode('{}') }
        ],
        gofileLocator: 'abc'
    });
    assert.equal(ok, true);
    const [row] = idb.rawRows('PeerWebCache', 'payloads');
    assert.equal(row.payloadStorage, 'opfs');
    assert.equal(row.files[0].bytes, undefined);

    const payload = await cache.getPayload('ff66');
    assert.deepEqual(
        payload.files.map((file) => file.path),
        ['site.bundle.json.gz', '.torrentchain']
    );
    assert.deepEqual([...payload.files[0].bytes], [1, 2]);
    assert.equal(payload.gofileLocator, 'abc');
    assert.equal(payload.payloadStorage, undefined);

    await cache.clear();
    assert.deepEqual(opfs.list(), []);
});
