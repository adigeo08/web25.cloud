/**
 * Hosting somebody else's site, and forgetting one entirely.
 *
 * The viewer's two right-hand actions are both claims about what this browser
 * does for the rest of the world, so both are pinned here with the real code.
 *
 * Reseed's claim is the strict one: the info hash *is* the site's address, so a
 * re-seed that hashes to anything else is a different site under a link
 * somebody else shared. `create-torrent` — the library WebTorrent builds
 * torrents with — hashes the original payload, and the files the real
 * `reseedSite` hands to `client.seed` are hashed by the same library. If the
 * payload, its order, the torrent name or the piece length were lost on the way
 * through storage, the second hash would differ and the reseed would be
 * refused rather than announced.
 *
 * Delete data's claim is the opposite one: afterwards there is nothing left
 * here — no session, no stored payload, no cached copy, no library row.
 *
 * In Node, `create-torrent` reads a `path` property as a filesystem path, so
 * the browser's `File` inputs are converted to the Buffer form it accepts.
 * What is under test is the info dictionary, which is identical either way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import createTorrent from 'create-torrent';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import { bdecode, bencode } from '../src/torrent/BencodeCodec.js';

globalThis.window = globalThis.window || {};
globalThis.window.location = { hostname: 'localhost', origin: 'https://web25.cloud', pathname: '/' };

const makeTorrent = promisify(createTorrent);

const SITE_NAME = 'someone-elses-site';
const PIECE_LENGTH = 16384;
const PUBLISHER = '0xfeed000000000000000000000000000000000001';
const VISITOR = '0xbeef000000000000000000000000000000000002';

/** The `.torrentchain` a deployment carries: who signed it, and when. */
const CHAIN = JSON.stringify({
    schema: 'web25-torrentchain-v1',
    payload: { publisher: PUBLISHER, createdAt: '2026-02-03T10:00:00.000Z', merkleRoot: 'abc' },
    signature: '0xsignature-of-the-real-author',
    signatureAlgorithm: 'EVM_SECP256K1'
});

/** A deployment on the wire: the signature manifest plus one bundle. */
function wireEntries() {
    return [
        { path: '.torrentchain', type: 'application/json', bytes: new TextEncoder().encode(CHAIN) },
        {
            path: 'site.bundle.json.gz',
            type: 'application/gzip',
            bytes: new TextEncoder().encode('pretend-gzip-bundle-'.repeat(3000))
        }
    ];
}

/** The Node shape `create-torrent` accepts, carrying the same paths and order. */
function torrentInputs(entries) {
    return entries.map((entry) => {
        const buffer = Buffer.from(entry.bytes);
        buffer.name = entry.path;
        return buffer;
    });
}

async function infoHashOf(torrentFile) {
    const metainfo = bdecode(new Uint8Array(torrentFile));
    const digest = await crypto.subtle.digest('SHA-1', bencode(metainfo.info));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The published site, as it exists before anybody reseeds it. */
async function publishedSite() {
    const entries = wireEntries();
    const torrentFile = new Uint8Array(
        await makeTorrent(torrentInputs(entries), {
            name: SITE_NAME,
            pieceLength: PIECE_LENGTH,
            private: false,
            comment: 'Web25 Deploy Artifact (in-memory bundle)',
            createdBy: 'WEB25.cloud Deploy'
        })
    );
    return { entries, torrentFile, hash: await infoHashOf(torrentFile) };
}

/**
 * A cache double: the calls the reseed and delete paths make.
 *
 * `payloads` is its own store in the real cache, for the same reason it is
 * separate here: a payload can exist without a rendered copy — a site deployed
 * from this browser is reseedable before anybody has opened it — and a rendered
 * copy can exist without one.
 */
function fakeCache(entries = new Map(), payloads = new Map()) {
    return {
        entries,
        payloads,
        deleted: [],
        async getEntry(hash) {
            return entries.get(hash) || null;
        },
        async getPayload(hash) {
            return payloads.get(hash) || null;
        },
        async setPayload(hash, payload) {
            payloads.set(hash, payload);
            return true;
        },
        async delete(hash) {
            this.deleted.push(hash);
            entries.delete(hash);
            payloads.delete(hash);
        }
    };
}

/**
 * A PeerWeb-shaped context carrying the real seeding and navigation mixins.
 *
 * `client.seed` hashes what it is given for real, so a payload that would
 * announce under the wrong info hash fails here exactly as it would in a
 * browser.
 */
async function harness({ cache = fakeCache(), signatureVerified = true } = {}) {
    const sessions = await import('../src/core/torrent/SeedingSessions.js');
    const navigation = await import('../src/core/navigation/Navigation.js');
    const { default: SeedingSessionStore } = await import('../src/core/torrent/SeedingSessionStore.js');

    const logs = [];
    const broadcasts = [];
    const toasts = [];
    const seeded = [];

    const context = {
        ...sessions,
        ...navigation,
        clientReady: true,
        trackers: ['wss://tracker.example/'],
        cache,
        log: (message) => logs.push(message),
        toast: {
            info: (body, title) => toasts.push(['info', title]),
            success: (body, title) => toasts.push(['success', title]),
            warning: (body, title) => toasts.push(['warning', title]),
            error: (body, title) => toasts.push(['error', title])
        },
        _seedingStore: new SeedingSessionStore(),
        _seedingTorrents: new Map(),
        _seedingErrors: new Map(),
        signedTorrentMetadata: new Map(),
        getNormalizedDeployPath: (file) => file.path || file.webkitRelativePath || file.name,
        _siteVerified: signatureVerified,
        _siteVerdictLabel: signatureVerified ? 'Verified publisher' : 'Publisher: unverified',
        currentSiteSignatureStatus: {
            verified: signatureVerified,
            label: 'Verified publisher',
            publisher: PUBLISHER,
            torrentHash: ''
        },
        currentGofileLocator: null,
        refreshPagesPanel: async () => {},
        refreshPagesLiveStats: async () => {},
        refreshLibrary: async () => {
            context.libraryRefreshed = (context.libraryRefreshed || 0) + 1;
        },
        startSeedingStatsTimer: () => {},
        initSeedingChannel: () => null,
        broadcastSeedingChange: (kind, hash) => broadcasts.push({ kind, hash }),
        client: {
            get: () => null,
            seed(files, options, callback) {
                void (async () => {
                    const rebuilt = await makeTorrent(
                        files.map((file) => {
                            const buffer = Buffer.from(file.bytes);
                            buffer.name = file.path || file.name;
                            return buffer;
                        }),
                        {
                            name: options.name,
                            pieceLength: options.pieceLength,
                            private: options.private === true,
                            comment: options.comment,
                            createdBy: options.createdBy
                        }
                    );
                    const infoHash = await infoHashOf(rebuilt);
                    const torrent = {
                        infoHash,
                        name: options.name,
                        pieceLength: options.pieceLength,
                        numPeers: 0,
                        uploaded: 0,
                        destroyed: false,
                        destroy() {
                            this.destroyed = true;
                        },
                        once() {}
                    };
                    seeded.push({ files, options, torrent });
                    callback(torrent);
                })();
            }
        }
    };

    return { context, logs, broadcasts, toasts, seeded };
}

/** `toSeedFile` builds real `File`s; in Node they need readable bytes. */
class FileStub {
    constructor(parts, name, options = {}) {
        this.bytes = parts[0] instanceof Uint8Array ? parts[0] : new TextEncoder().encode(`${parts[0]}`);
        this.name = name;
        this.type = options.type || '';
        this.size = this.bytes.length;
    }

    async arrayBuffer() {
        return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
    }
}

let idb;
let previousFile;
test.beforeEach(() => {
    idb = installFakeIndexedDb();
    previousFile = globalThis.File;
    globalThis.File = FileStub;
});
test.afterEach(() => {
    idb.restore();
    globalThis.File = previousFile;
});

test('a reseeded site announces under the very same info hash', async () => {
    const site = await publishedSite();
    const { context, seeded, broadcasts } = await harness();

    // What a load leaves behind: the payload exactly as it came off the wire.
    context.rememberReseedPayload.call(context, site.hash, {
        torrentFile: site.torrentFile,
        name: SITE_NAME,
        pieceLength: PIECE_LENGTH,
        length: site.entries.reduce((total, entry) => total + entry.bytes.length, 0),
        files: site.entries
    });

    const result = await context.reseedSite.call(context, site.hash);

    assert.equal(result.state, 'seeding');
    assert.equal(seeded.length, 1, 'the payload was handed to WebTorrent');
    assert.equal(seeded[0].torrent.infoHash, site.hash, 'and it is the same site, not a lookalike');
    assert.equal(context._seedingTorrents.get(site.hash), seeded[0].torrent);
    assert.deepEqual(broadcasts, [{ kind: 'resumed', hash: site.hash }]);
});

test('the card it writes credits the original author, not whoever reseeded it', async () => {
    const site = await publishedSite();
    const { context } = await harness();
    context.currentGofileLocator = 'someLocator123';

    context.rememberReseedPayload.call(context, site.hash, {
        torrentFile: site.torrentFile,
        name: SITE_NAME,
        pieceLength: PIECE_LENGTH,
        length: 0,
        files: site.entries
    });
    await context.reseedSite.call(context, site.hash);

    const stored = await context._seedingStore.get(site.hash);
    assert.equal(stored.reseeded, true, 'the record knows this browser is a host, not the publisher');
    // Read out of the payload's own `.torrentchain`, so it cannot come from
    // whoever happens to be signed in here.
    assert.equal(stored.deploy.signedBy, PUBLISHER);
    assert.notEqual(stored.deploy.signedBy, VISITOR);
    assert.equal(stored.deploy.signature, '0xsignature-of-the-real-author');
    assert.equal(stored.deploy.signedAt, '2026-02-03T10:00:00.000Z');
    assert.equal(stored.createdAt, '2026-02-03T10:00:00.000Z');
    assert.equal(stored.siteName, SITE_NAME);
    assert.equal(stored.pieceLength, PIECE_LENGTH);

    // The link keeps the mirror the visitor arrived by, so what they share
    // resolves the same way their own link did.
    assert.equal(stored.deploy.url, `https://web25.cloud/?orc=${site.hash}&someLocator123`);
    // The mirror's filename is derived from the hash, so a reseed can name the
    // same file the publisher uploaded without anything being stored for it.
    assert.deepEqual(stored.deploy.mirror, {
        locator: 'someLocator123',
        filename: `web25-gofile-mirror-${site.hash}.json`
    });

    // And it reaches the Pages tab as a card marked as somebody else's.
    const [view] = await context.listSeedingSessionViews.call(context);
    assert.equal(view.reseeded, true);
    assert.equal(view.signedBy, PUBLISHER);
    assert.equal(view.state, 'seeding');
});

test('a cached visit can still reseed: the payload is read back out of the cache', async () => {
    const site = await publishedSite();
    const cache = fakeCache(
        new Map([[site.hash, { data: {} }]]),
        new Map([[site.hash, { torrentFile: site.torrentFile, files: site.entries }]])
    );
    const { context, seeded } = await harness({ cache });

    // Nothing in the page: this is the second visit, served from the cache.
    context.currentHash = site.hash;
    assert.equal(await context.resolveReseedState.call(context, site.hash), 'available');
    await context.reseedSite.call(context, site.hash);

    assert.equal(seeded[0].torrent.infoHash, site.hash);
});

/** One byte short of the real thing — which is a different site entirely. */
function tamperedEntries(site) {
    return site.entries.map((entry) =>
        entry.path === 'site.bundle.json.gz' ? { ...entry, bytes: entry.bytes.slice(0, -1) } : entry
    );
}

test('a stored payload that does not match its .torrent never reaches the swarm', async () => {
    const site = await publishedSite();
    const cache = fakeCache(
        new Map([[site.hash, { data: {} }]]),
        new Map([[site.hash, { torrentFile: site.torrentFile, files: tamperedEntries(site) }]])
    );
    const { context, logs, seeded } = await harness({ cache });

    // The metainfo says how long every entry is, so this is caught on the way
    // out of storage — the button is not even offered.
    context.currentHash = site.hash;
    assert.equal(await context.resolveReseedState.call(context, site.hash), 'unavailable');
    await assert.rejects(() => context.reseedSite.call(context, site.hash), /does not hold the original payload/);
    assert.equal(seeded.length, 0, 'nothing was announced');
    assert.ok(
        logs.some((line) => /does not match its \.torrent/.test(line)),
        'and the reason was recorded'
    );
});

test('a payload that hashes to a different site is refused, and leaves nothing behind', async () => {
    const site = await publishedSite();
    const { context, seeded } = await harness();

    // The last line of defence: a payload the metainfo cannot rule out, which
    // WebTorrent then hashes to something else. `create-torrent` does the
    // hashing here, so this is the real check rather than a stubbed one.
    context.rememberReseedPayload.call(context, site.hash, {
        torrentFile: site.torrentFile,
        name: 'a-different-name-entirely',
        pieceLength: PIECE_LENGTH,
        length: 0,
        files: site.entries
    });

    await assert.rejects(() => context.reseedSite.call(context, site.hash), /could not be reseeded from here/);
    assert.equal(seeded.length, 1, 'it was hashed before being believed');
    assert.notEqual(seeded[0].torrent.infoHash, site.hash);
    assert.equal(context._seedingTorrents.size, 0, 'nothing is being announced');
    assert.equal(await context._seedingStore.get(site.hash), null, 'and no card was left claiming otherwise');
});

test('a reseed of a site already stored here puts it back on the air instead of copying it again', async () => {
    const site = await publishedSite();
    const { context, seeded } = await harness();

    context.rememberReseedPayload.call(context, site.hash, {
        torrentFile: site.torrentFile,
        name: SITE_NAME,
        pieceLength: PIECE_LENGTH,
        length: 0,
        files: site.entries
    });
    await context.reseedSite.call(context, site.hash);
    await context.pauseSeedingSession.call(context, site.hash);
    assert.equal(context._seedingTorrents.size, 0);

    const again = await context.reseedSite.call(context, site.hash);

    assert.equal(again.state, 'resumed');
    assert.equal(seeded.length, 2, 'it was re-seeded from the copy already stored');
    const stored = await context._seedingStore.get(site.hash);
    assert.equal(stored.paused, false, 'and it is no longer marked paused');
});

test('deleting a site data leaves nothing of it in this browser', async () => {
    const site = await publishedSite();
    const cache = fakeCache(new Map([[site.hash, { data: {} }]]));
    const { context, broadcasts } = await harness({ cache });

    context.rememberReseedPayload.call(context, site.hash, {
        torrentFile: site.torrentFile,
        name: SITE_NAME,
        pieceLength: PIECE_LENGTH,
        length: 0,
        files: site.entries
    });
    await context.reseedSite.call(context, site.hash);
    const torrent = context._seedingTorrents.get(site.hash);
    context.signedTorrentMetadata.set(site.hash, { publisher: PUBLISHER });
    context.currentHash = site.hash;
    context.currentSiteData = { 'index.html': { content: new Uint8Array([1]) } };
    broadcasts.length = 0;

    assert.equal(await context.forgetSiteData.call(context, site.hash), true);

    // Off the air, and not coming back on the next load.
    assert.equal(torrent.destroyed, true);
    assert.equal(context._seedingTorrents.size, 0);
    assert.equal(await context._seedingStore.get(site.hash), null);
    // Out of the cache, which is what takes it out of the search box: the
    // library row is deleted with the site by `PeerWebCache.delete`.
    assert.deepEqual(cache.deleted, [site.hash]);
    assert.equal(context.libraryRefreshed, 1, 'the open search was asked again');
    // And out of this page.
    assert.equal(context.currentSiteData, null);
    assert.equal(context._reseedPayload, null);
    assert.equal(context.signedTorrentMetadata.has(site.hash), false);
    assert.deepEqual(broadcasts, [{ kind: 'deleted', hash: site.hash }]);
});

test('deleting works the same for a site deployed from here', async () => {
    const site = await publishedSite();
    const cache = fakeCache(new Map([[site.hash, { data: {} }]]));
    const { context } = await harness({ cache });

    // A deployment, not a reseed: recorded the way the deploy pipeline does.
    await context.recordSeedingSession.call(context, {
        hash: site.hash,
        torrent: { infoHash: site.hash, name: SITE_NAME, pieceLength: PIECE_LENGTH, length: 10 },
        torrentFile: site.torrentFile,
        payloadFiles: site.entries.map((entry) => {
            const file = new FileStub([entry.bytes], entry.path, { type: entry.type });
            file.path = entry.path;
            file.webkitRelativePath = entry.path;
            return file;
        }),
        siteName: SITE_NAME,
        deploy: { url: '', signedBy: VISITOR, mirrorState: 'disabled' }
    });
    context.lastDeployResult = { hash: site.hash };
    let deploySessionCleared = 0;
    context.clearDeploySession = () => {
        deploySessionCleared += 1;
    };

    await context.forgetSiteData.call(context, site.hash);

    assert.equal(await context._seedingStore.get(site.hash), null);
    assert.deepEqual(cache.deleted, [site.hash]);
    assert.equal(context.lastDeployResult, null, 'the deploy receipt cannot outlive the site it points at');
    assert.equal(deploySessionCleared, 1);
});

test('a delete that only half works says so rather than reporting success', async () => {
    const site = await publishedSite();
    const cache = fakeCache();
    cache.delete = async () => {
        throw new Error('the cache is open in another tab');
    };
    const { context } = await harness({ cache });

    // Reporting "deleted" while a copy of the site is still cached — and still
    // findable by name — would be a promise the browser did not keep.
    await assert.rejects(() => context.forgetSiteData.call(context, site.hash), /still here[\s\S]*cached copy/);
});

test('the metainfo decides the paths, whatever the transport called them', async () => {
    const { buildReseedPayload, readPublisherFromPayload } = await import('../src/core/torrent/ReseedPayload.js');
    const site = await publishedSite();

    // WebTorrent reports `sitename/index.html` where the metainfo says
    // `index.html`; the GoFile mirror reports the bare path. Both have to line
    // up against the same entries, and the metainfo's spelling is what gets
    // stored — it is the one that reproduces the info hash.
    const asWebTorrentWouldSay = site.entries.map((entry) => ({ ...entry, path: `${SITE_NAME}/${entry.path}` }));

    const payload = buildReseedPayload({ torrentFile: site.torrentFile, files: asWebTorrentWouldSay });

    assert.deepEqual(
        payload.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );
    assert.equal(payload.name, SITE_NAME);
    assert.equal(payload.pieceLength, PIECE_LENGTH);
    assert.equal(
        payload.length,
        site.entries.reduce((total, entry) => total + entry.bytes.length, 0)
    );
    assert.equal(readPublisherFromPayload(payload.files).publisher, PUBLISHER);
});

test('an incomplete payload is refused rather than seeded with a gap', async () => {
    const { buildReseedPayload } = await import('../src/core/torrent/ReseedPayload.js');
    const site = await publishedSite();

    assert.throws(
        () => buildReseedPayload({ torrentFile: site.torrentFile, files: [site.entries[0]] }),
        /site\.bundle\.json\.gz is missing/
    );
    assert.throws(() => buildReseedPayload({ torrentFile: null, files: site.entries }), /without its \.torrent/);
});

test('a site with no signature manifest can still be reseeded, just not attributed', async () => {
    const { readPublisherFromPayload } = await import('../src/core/torrent/ReseedPayload.js');

    // An unreadable or absent `.torrentchain` costs the attribution, never the
    // bytes: the same payload still hashes to the same site.
    assert.equal(readPublisherFromPayload([{ path: 'index.html', bytes: new Uint8Array([1]) }]).publisher, '');
    assert.equal(
        readPublisherFromPayload([{ path: '.torrentchain', bytes: new TextEncoder().encode('not json') }]).publisher,
        ''
    );
});

test('a guest who reseeds can still find the card that stops it', async () => {
    const { installFakePagesDom } = await import('./helpers/fake-pages-dom.mjs');
    const dom = installFakePagesDom();
    try {
        const site = await publishedSite();
        const { context } = await harness();
        // The real panel refresh, rather than the harness's no-op: what is
        // under test is which cards it decides to render.
        const sessions = await import('../src/core/torrent/SeedingSessions.js');
        context.refreshPagesPanel = sessions.refreshPagesPanel;
        // No identity unlocked: a visitor, not a publisher.
        context._pagesTabAllowed = false;

        // One of each: a deployment made here, and a site hosted for somebody
        // else.
        await context.recordSeedingSession.call(context, {
            hash: 'aaaa567890abcdef0123456789abcdef01234567',
            torrent: { infoHash: 'aaaa567890abcdef0123456789abcdef01234567', name: 'my-own-site', length: 1 },
            torrentFile: null,
            payloadFiles: null,
            siteName: 'my-own-site',
            deploy: { url: '', signedBy: VISITOR, mirrorState: 'disabled' }
        });
        context.rememberReseedPayload.call(context, site.hash, {
            torrentFile: site.torrentFile,
            name: SITE_NAME,
            pieceLength: PIECE_LENGTH,
            length: 0,
            files: site.entries
        });
        await context.reseedSite.call(context, site.hash);

        // Hosting somebody else's site needs no identity, so stopping must not
        // either: the tab exists, and shows exactly the card that can stop it.
        assert.equal(dom.nodes.tabBtn.style.display, 'inline-flex');
        const cards = dom.nodes.list.querySelectorAll('article.page-card');
        assert.equal(cards.length, 1);
        assert.equal(cards[0].getAttribute('data-page-hash'), site.hash);
        assert.match(cards[0].textContent, /Reseeded/);
        // The publisher's own deployment stays behind the wallet.
        assert.ok(!cards[0].textContent.includes('my-own-site'));
    } finally {
        dom.restore();
    }
});

test('the capture reads the payload off whichever transport fetched it', async () => {
    const loader = await import('../src/core/torrent/TorrentLoader.js');
    const site = await publishedSite();
    const logs = [];
    const peerweb = {
        ...loader,
        log: (message) => logs.push(message),
        formatBytes: (value) => `${value} B`,
        getContentType: () => 'application/octet-stream'
    };

    // WebTorrent's shape: `path` carries the torrent's own folder in front of
    // the entry the metainfo names.
    const asTorrent = {
        torrentFile: site.torrentFile,
        length: site.entries.reduce((total, entry) => total + entry.bytes.length, 0),
        files: site.entries.map((entry) => ({
            name: entry.path.split('/').pop(),
            path: `${SITE_NAME}/${entry.path}`,
            length: entry.bytes.length,
            getBuffer: (callback) => callback(null, entry.bytes)
        }))
    };

    const captured = await peerweb.captureReseedPayload.call(peerweb, asTorrent, site.hash);
    assert.equal(captured.name, SITE_NAME);
    assert.deepEqual(
        captured.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );

    // The GoFile mirror's shape, built by the codec that verified it.
    const { createMirrorTorrentAdapter } = await import('../src/gofile/GoFileMirrorCodec.js');
    const adapter = createMirrorTorrentAdapter({
        torrentFile: site.torrentFile,
        files: site.entries.map((entry) => ({ path: entry.path, bytes: entry.bytes }))
    });
    const fromMirror = await peerweb.captureReseedPayload.call(peerweb, adapter, site.hash);
    assert.deepEqual(
        fromMirror.files.map((file) => file.path),
        captured.files.map((file) => file.path)
    );
});

test('a site with no metainfo, or too big to copy, is loaded but not captured', async () => {
    const loader = await import('../src/core/torrent/TorrentLoader.js');
    const site = await publishedSite();
    const logs = [];
    const peerweb = {
        ...loader,
        log: (message) => logs.push(message),
        formatBytes: (value) => `${value} B`,
        getContentType: () => 'application/octet-stream'
    };

    // A load with no `.torrent` behind it cannot be reseeded — and must still
    // render, so this reports rather than throws.
    assert.equal(await peerweb.captureReseedPayload.call(peerweb, { files: [] }, site.hash), null);
    assert.ok(logs.some((line) => /No \.torrent metadata/.test(line)));

    // Capturing is a second copy of the site in memory, so past a point the
    // render matters more than the button.
    const huge = { torrentFile: site.torrentFile, length: 512 * 1024 * 1024, files: [] };
    assert.equal(await peerweb.captureReseedPayload.call(peerweb, huge, site.hash), null);
    assert.ok(logs.some((line) => /too large to hold a reseedable copy/.test(line)));
});

test('a site deployed from here is reseedable after its card is deleted', async () => {
    // The case that made this a bug report. Deleting a deployment from Pages
    // means this browser stops hosting it — not that it threw the site away.
    // While a copy is still here, Reseed has to be able to put it back, and
    // how the bytes first arrived (deployed here, WebRTC, GoFile mirror) must
    // make no difference at all.
    const site = await publishedSite();
    const { context, seeded } = await harness();

    await context.recordSeedingSession.call(context, {
        hash: site.hash,
        torrent: { infoHash: site.hash, name: SITE_NAME, pieceLength: PIECE_LENGTH, length: 10 },
        torrentFile: site.torrentFile,
        payloadFiles: site.entries.map((entry) => {
            const file = new FileStub([entry.bytes], entry.path, { type: entry.type });
            file.path = entry.path;
            file.webkitRelativePath = entry.path;
            return file;
        }),
        siteName: SITE_NAME,
        deploy: { url: '', signedBy: VISITOR, mirrorState: 'disabled' }
    });

    await context.deleteSeedingSession.call(context, site.hash);
    assert.equal(await context._seedingStore.get(site.hash), null, 'the deployment is gone from Pages');

    // Nothing in the page and no session left — only what the deployment kept.
    context.rememberReseedPayload.call(context, '', null);
    context.currentHash = site.hash;
    assert.equal(await context.resolveReseedState.call(context, site.hash), 'available');

    await context.reseedSite.call(context, site.hash);
    assert.equal(seeded[0].torrent.infoHash, site.hash, 'and it goes back up as the same site');
});

test('a stored session is itself a payload: a paused site needs nothing else', async () => {
    const site = await publishedSite();
    // No payload store at all — the seeding record already holds the metainfo
    // and the ordered entries, which is what a payload is.
    const { context, seeded } = await harness({
        cache: {
            async getEntry() {
                return null;
            }
        }
    });

    await context._seedingStore.put({
        hash: site.hash,
        siteName: SITE_NAME,
        torrentName: SITE_NAME,
        pieceLength: PIECE_LENGTH,
        createdAt: '',
        savedAt: Date.now(),
        length: 0,
        fileCount: site.entries.length,
        torrentFile: site.torrentFile,
        files: site.entries,
        paused: true,
        deploy: { url: '', signedBy: PUBLISHER, mirrorState: 'disabled' }
    });

    context.currentHash = site.hash;
    assert.equal(await context.resolveReseedState.call(context, site.hash), 'resume');

    const result = await context.reseedSite.call(context, site.hash);
    assert.equal(result.state, 'resumed');
    assert.equal(seeded[0].torrent.infoHash, site.hash);
});
