/**
 * The claim the whole seeding store rests on.
 *
 * A resumed session is only the same deployment if it hashes to the same info
 * hash — that hash is the site's identity, and `resumeSeedingSession` refuses
 * anything else. Everything the record keeps beyond the bytes exists to make
 * that true: the torrent name, the piece length, and the exact paths and order
 * of the payload files.
 *
 * So this runs the real thing. `create-torrent` — the library WebTorrent uses
 * to build a torrent — hashes the original payload, the record is written by
 * the real `recordSeedingSession`, and the files the real
 * `restoreSeedingSessions` hands to `client.seed` are hashed by the same
 * library. If any of those fields were lost or reordered in storage, the second
 * hash would differ and the resume would be rejected.
 *
 * In Node, `create-torrent` reads a `path` property as a filesystem path, so
 * the browser's `File` inputs are converted to the Buffer form it accepts
 * there. What is under test is the info dictionary — name, piece length, file
 * paths, sizes and order — which is identical either way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import createTorrent from 'create-torrent';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import { bdecode, bencode } from '../src/torrent/BencodeCodec.js';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const makeTorrent = promisify(createTorrent);

const SITE_NAME = 'marasdarkroom';
const PIECE_LENGTH = 16384;

/** The same way `GoFileMirrorCodec` checks a mirror: SHA-1 over the info dict. */
async function infoHashOf(torrentFile) {
    const metainfo = bdecode(new Uint8Array(torrentFile));
    const digest = await crypto.subtle.digest('SHA-1', bencode(metainfo.info));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A deploy payload: several files, nested paths, more than one piece of data. */
function payloadSpec() {
    return [
        ['.torrentchain', JSON.stringify({ publisher: '0xabc', files: 3 })],
        ['index.html', '<!doctype html><html><head><title>Darkroom</title></head><body>hi</body></html>'],
        ['assets/app.js', 'console.log("x");'.repeat(2000)],
        ['assets/styles.css', 'body{color:#fff}'.repeat(1500)]
    ];
}

/** The browser shape: what the deploy flow passes to `recordSeedingSession`. */
function browserFiles() {
    return payloadSpec().map(([path, text]) => {
        const file = new File([new TextEncoder().encode(text)], path.split('/').pop(), { type: 'text/plain' });
        Object.defineProperty(file, 'path', { value: path });
        Object.defineProperty(file, 'webkitRelativePath', { value: path });
        return file;
    });
}

/** The Node shape `create-torrent` accepts, carrying the same paths and order. */
async function torrentInputs(files) {
    const inputs = [];
    for (const file of files) {
        const buffer = Buffer.from(new Uint8Array(await file.arrayBuffer()));
        buffer.name = file.path || file.webkitRelativePath || file.name;
        inputs.push(buffer);
    }
    return inputs;
}

const seedOptionsOf = (options) => ({
    name: options.name,
    pieceLength: options.pieceLength,
    private: options.private === true,
    comment: options.comment,
    createdBy: options.createdBy
});

let idb;
test.beforeEach(() => {
    idb = installFakeIndexedDb();
});
test.afterEach(() => {
    idb.restore();
});

test('a stored payload reproduces the original info hash exactly', async () => {
    const sessions = await import('../src/core/torrent/SeedingSessions.js');
    const { default: SeedingSessionStore } = await import('../src/core/torrent/SeedingSessionStore.js');

    // 1. The deployment as it was first seeded.
    const payloadFiles = browserFiles();
    const originalFile = await makeTorrent(await torrentInputs(payloadFiles), {
        name: SITE_NAME,
        pieceLength: PIECE_LENGTH,
        private: false,
        comment: 'Web25 Deploy Artifact (in-memory bundle)',
        createdBy: 'WEB25.cloud Deploy'
    });
    const originalHash = await infoHashOf(originalFile);
    assert.match(originalHash, /^[0-9a-f]{40}$/);

    const store = new SeedingSessionStore();
    const base = {
        ...sessions,
        clientReady: true,
        trackers: ['wss://tracker.example/'],
        log() {},
        toast: { info() {}, warning() {} },
        getNormalizedDeployPath: (file) => file.path || file.webkitRelativePath || file.name,
        refreshPagesPanel: async () => {},
        startSeedingStatsTimer() {},
        initSeedingChannel: () => null,
        broadcastSeedingStopped() {}
    };

    // 2. Store it, exactly as a live deployment does.
    const publisher = {
        ...base,
        _seedingStore: store,
        _seedingTorrents: new Map(),
        _seedingErrors: new Map(),
        client: { get: () => null }
    };
    await publisher.recordSeedingSession.call(publisher, {
        hash: originalHash,
        torrent: { infoHash: originalHash, name: SITE_NAME, pieceLength: PIECE_LENGTH, length: 0 },
        torrentFile: new Uint8Array(originalFile),
        payloadFiles,
        siteName: SITE_NAME,
        deploy: { url: `https://web25.cloud/?orc=${originalHash}`, signedBy: '0xabc', mirrorState: 'disabled' }
    });

    // 3. A fresh page restores it, and whatever it hands to `client.seed` is
    //    hashed for real rather than assumed.
    let seededHash = null;
    let seededOptions = null;
    const visitor = {
        ...base,
        _seedingStore: store,
        _seedingTorrents: new Map(),
        _seedingErrors: new Map(),
        client: {
            get: () => null,
            seed(files, options, callback) {
                seededOptions = options;
                void (async () => {
                    const rebuilt = await makeTorrent(await torrentInputs(files), seedOptionsOf(options));
                    seededHash = await infoHashOf(rebuilt);
                    callback({ infoHash: seededHash, name: options.name, pieceLength: options.pieceLength });
                })();
            }
        }
    };

    await visitor.restoreSeedingSessions.call(visitor);

    // 4. Same bytes, same name, same piece length — therefore the same site.
    assert.equal(seededHash, originalHash, 'the resumed torrent is the same deployment');
    assert.equal(visitor._seedingTorrents.size, 1, 'and it was accepted rather than rejected');
    assert.equal(visitor._seedingErrors.size, 0);
    assert.equal(seededOptions.name, SITE_NAME);
    assert.equal(seededOptions.pieceLength, PIECE_LENGTH);
});

test('losing the stored piece length would change the info hash', async () => {
    // Why the record keeps it. `create-torrent` picks a piece length from the
    // payload size when none is given, and a different piece length is a
    // different info dictionary — a different site, as far as the swarm and
    // `resumeSeedingSession` are concerned.
    const files = await torrentInputs(browserFiles());

    const pinned = await infoHashOf(
        await makeTorrent(files, { name: SITE_NAME, pieceLength: PIECE_LENGTH, private: false })
    );
    const doubled = await infoHashOf(
        await makeTorrent(files, { name: SITE_NAME, pieceLength: PIECE_LENGTH * 2, private: false })
    );

    assert.notEqual(pinned, doubled);
});

test('losing the stored name would change the info hash', async () => {
    const files = await torrentInputs(browserFiles());

    const named = await infoHashOf(
        await makeTorrent(files, { name: SITE_NAME, pieceLength: PIECE_LENGTH, private: false })
    );
    const renamed = await infoHashOf(
        await makeTorrent(files, { name: 'something-else', pieceLength: PIECE_LENGTH, private: false })
    );

    assert.notEqual(named, renamed);
});
