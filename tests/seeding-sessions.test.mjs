/**
 * Hosting that survives the page.
 *
 * A deployment used to exist only for as long as the tab that made it: the
 * payload was seeded from memory, so a refresh ended the only copy of the site
 * that existed, and signing out took it down too. These tests pin the new
 * contract — the payload is stored, it is re-seeded on start with the wallet
 * locked, a resumed torrent must hash to the same deployment, and the only
 * thing that ends a session is the publisher stopping it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER_HASH = 'fedcba9876543210fedcba9876543210fedcba98';

/** Minimal File stand-in: what create-torrent and the store actually read. */
class FakeFile {
    constructor(parts, name, options = {}) {
        const bytes = parts[0] instanceof Uint8Array ? parts[0] : new TextEncoder().encode(`${parts[0]}`);
        this.bytes = bytes;
        this.name = name;
        this.type = options.type || '';
        this.size = bytes.length;
    }

    async arrayBuffer() {
        return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
    }
}

function payloadFile(path, text) {
    const file = new FakeFile([new TextEncoder().encode(text)], path.split('/').pop(), { type: 'text/plain' });
    file.path = path;
    file.webkitRelativePath = path;
    return file;
}

/**
 * A PeerWeb-shaped context carrying the real seeding mixin.
 *
 * @param {{ seedInfoHash?: string, onSeed?: Function }} [options]
 */
async function harness({ seedInfoHash = HASH, onSeed = null } = {}) {
    const sessions = await import('../src/core/torrent/SeedingSessions.js');
    const { default: SeedingSessionStore } = await import('../src/core/torrent/SeedingSessionStore.js');

    const logs = [];
    const seeded = [];
    const context = {
        ...sessions,
        clientReady: true,
        trackers: ['wss://tracker.example/'],
        log: (message) => logs.push(message),
        toast: { info() {}, warning() {}, error() {}, success() {} },
        _seedingStore: new SeedingSessionStore(),
        _seedingTorrents: new Map(),
        _seedingErrors: new Map(),
        getNormalizedDeployPath: (file) => file.path || file.webkitRelativePath || file.name,
        refreshPagesPanel: async () => {},
        refreshPagesLiveStats: async () => {},
        startSeedingStatsTimer: () => {},
        client: {
            get: () => null,
            seed(files, options, callback) {
                const torrent = {
                    infoHash: seedInfoHash,
                    name: options.name,
                    pieceLength: options.pieceLength || 16384,
                    length: files.reduce((total, file) => total + file.size, 0),
                    numPeers: 0,
                    uploaded: 0,
                    destroyed: false,
                    destroy() {
                        this.destroyed = true;
                    }
                };
                seeded.push({ files, options, torrent });
                onSeed?.(torrent);
                callback(torrent);
            }
        }
    };

    return { context, logs, seeded };
}

function liveTorrent(hash = HASH) {
    return {
        infoHash: hash,
        name: 'my-site',
        pieceLength: 32768,
        length: 42,
        numPeers: 3,
        uploaded: 1024,
        destroyed: false,
        destroy() {
            this.destroyed = true;
        }
    };
}

const DEPLOY = {
    url: 'https://web25.cloud/?orc=' + HASH,
    signedBy: '0xabc0000000000000000000000000000000000001',
    signature: '0xsignature',
    signatureAlgorithm: 'EVM_SECP256K1',
    signedAt: '2026-01-01T00:00:00.000Z',
    signatureStatus: 'VERIFIED',
    mirror: null,
    mirrorState: 'disabled'
};

let idb;
test.beforeEach(() => {
    idb = installFakeIndexedDb();
    globalThis.File = FakeFile;
});
test.afterEach(() => {
    idb.restore();
});

test('a live deployment stores its payload, not just its .torrent', async () => {
    const { context } = await harness();

    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: new Uint8Array([1, 2, 3]),
        payloadFiles: [payloadFile('.torrentchain', '{}'), payloadFile('site.bundle.json.gz', 'bundle-bytes')],
        siteName: 'my-site',
        createdAt: '2026-01-01T00:00:00.000Z',
        deploy: DEPLOY
    });

    const record = await context._seedingStore.get(HASH);
    assert.equal(record.hash, HASH);
    assert.equal(record.fileCount, 2);
    assert.equal(record.pieceLength, 32768, 'the piece length is part of the info hash, so it is stored');
    assert.deepEqual(
        record.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );
    assert.equal(new TextDecoder().decode(record.files[1].bytes), 'bundle-bytes');
    assert.equal(record.deploy.url, DEPLOY.url);
});

test('a stored session is re-seeded on start with no wallet involved', async () => {
    const { context, seeded } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: new Uint8Array([1]),
        payloadFiles: [payloadFile('index.html', '<h1>hi</h1>')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    // A fresh page: nothing live, nothing unlocked.
    const fresh = (await harness()).context;
    fresh._seedingStore = context._seedingStore;

    const restored = await fresh.restoreSeedingSessions.call(fresh);

    assert.equal(restored.length, 1);
    assert.equal(fresh._seedingTorrents.size, 1, 'the site is announcing again');
    assert.equal(seeded.length, 0, 'the re-seed came from the fresh page, not the original');
    assert.equal(fresh._seedingTorrents.get(HASH).infoHash, HASH);
});

test('a resumed torrent that hashes differently is dropped, not announced', async () => {
    const { context } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', '<h1>hi</h1>')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    // The same bytes coming back out as a different info hash is not this
    // deployment, whatever the record says.
    const wrong = await harness({ seedInfoHash: OTHER_HASH });
    wrong.context._seedingStore = context._seedingStore;

    await wrong.context.restoreSeedingSessions.call(wrong.context);

    assert.equal(wrong.context._seedingTorrents.size, 0, 'nothing is announced under the wrong hash');
    assert.match(wrong.context._seedingErrors.get(HASH), /hashes to/);
    assert.equal(wrong.seeded[0].torrent.destroyed, true, 'the mismatched torrent is torn down');
});

test('the resumed seed reuses the stored name and piece length', async () => {
    const { context } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    const fresh = await harness();
    fresh.context._seedingStore = context._seedingStore;
    await fresh.context.restoreSeedingSessions.call(fresh.context);

    const [{ options, files }] = fresh.seeded;
    assert.equal(options.name, 'my-site');
    assert.equal(options.pieceLength, 32768);
    assert.equal(options.private, false);
    assert.deepEqual(options.announce, ['wss://tracker.example/']);
    assert.equal(files[0].path, 'index.html', 'paths are rebuilt exactly, or the info hash changes');
});

test('a session is owned by the registry, so page teardown cannot destroy it', async () => {
    const { context } = await harness();
    const torrent = liveTorrent();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent,
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    assert.equal(context.isSeedingTorrent.call(context, torrent), true);
    assert.equal(context.isSeedingTorrent.call(context, liveTorrent(OTHER_HASH)), false);
    assert.equal(context.isSeedingTorrent.call(context, null), false);
});

test('stopping is the only thing that deletes a session', async () => {
    const { context } = await harness();
    const torrent = liveTorrent();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent,
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    await context.stopSeedingSession.call(context, HASH);

    assert.equal(torrent.destroyed, true);
    assert.equal(await context._seedingStore.get(HASH), null, 'it does not come back on the next load');
    assert.equal(context._seedingTorrents.size, 0);
});

test('a mirror that arrives later patches the record without touching the payload', async () => {
    const { context } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: { ...DEPLOY, mirrorState: 'pending' }
    });

    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: null,
        torrentFile: null,
        payloadFiles: null,
        deploy: { ...DEPLOY, mirror: { locator: 'abc123', filename: 'm.json' }, mirrorState: 'available' }
    });

    const record = await context._seedingStore.get(HASH);
    assert.equal(record.deploy.mirror.locator, 'abc123');
    assert.equal(record.fileCount, 1, 'the payload survived the patch');
    assert.equal(new TextDecoder().decode(record.files[0].bytes), 'x');
});

test('the Pages view merges the stored record with what is live', async () => {
    const { context } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: new Uint8Array([1, 2]),
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    const [view] = await context.listSeedingSessionViews.call(context);

    assert.equal(view.state, 'seeding');
    assert.equal(view.peers, 3);
    assert.equal(view.uploaded, 1024);
    assert.equal(view.url, DEPLOY.url);
    assert.equal(view.signedBy, DEPLOY.signedBy);
    assert.equal(view.hasTorrentFile, true);
});

test('a session that failed to resume is shown as failed, not as seeding', async () => {
    const { context } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    const wrong = await harness({ seedInfoHash: OTHER_HASH });
    wrong.context._seedingStore = context._seedingStore;
    await wrong.context.restoreSeedingSessions.call(wrong.context);

    const [view] = await wrong.context.listSeedingSessionViews.call(wrong.context);
    assert.equal(view.state, 'error');
    assert.match(view.error, /hashes to/);
});

test('a second call for the same deployment patches instead of re-copying the payload', async () => {
    const { context } = await harness();
    const payload = [payloadFile('index.html', 'x')];

    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: payload,
        siteName: 'my-site',
        deploy: { ...DEPLOY, mirrorState: 'pending' }
    });

    // The deployment is its content, so a record that already holds bytes for
    // this hash holds the right ones: the mirror result must not re-copy them.
    let reads = 0;
    const original = payload[0].arrayBuffer.bind(payload[0]);
    payload[0].arrayBuffer = async () => {
        reads += 1;
        return original();
    };

    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: payload,
        siteName: 'my-site',
        deploy: { ...DEPLOY, mirror: { locator: 'abc123', filename: 'm.json' }, mirrorState: 'available' }
    });

    assert.equal(reads, 0, 'the payload is not read back out of the page a second time');
    const record = await context._seedingStore.get(HASH);
    assert.equal(record.deploy.mirrorState, 'available');
    assert.equal(record.fileCount, 1);
});

test('a torrent is adopted only once its payload is durably stored', async () => {
    const { context } = await harness();
    const torrent = liveTorrent();
    // A full disk, a denied quota, a private window: the store refuses.
    context._seedingStore = {
        get: async () => null,
        put: async () => {
            throw new Error('QuotaExceededError');
        }
    };

    const record = await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent,
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    assert.equal(record, null);
    // Adopting a torrent the store never accepted would make it immortal: no
    // card in Pages to stop it, and every teardown path refusing to touch it.
    assert.equal(context._seedingTorrents.size, 0);
    assert.equal(context.isSeedingTorrent.call(context, torrent), false);
});

test('a stop that cannot be persisted keeps the session and says so', async () => {
    const { context } = await harness();
    const torrent = liveTorrent();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent,
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    const store = context._seedingStore;
    context._seedingStore = {
        get: (hash) => store.get(hash),
        list: () => store.list(),
        remove: async () => {
            throw new Error('database is closing');
        }
    };

    // Reporting "stopped" while the record survives would promise something the
    // next reload immediately undoes.
    await assert.rejects(() => context.stopSeedingSession.call(context, HASH), /still seeding/);
    assert.equal(torrent.destroyed, false, 'the site keeps being served');
    assert.equal(context._seedingTorrents.size, 1);
});

/** A torrent that can be told it died, the way WebTorrent's does. */
function emitterTorrent(hash = HASH) {
    const listeners = new Map();
    return {
        infoHash: hash,
        name: 'my-site',
        pieceLength: 32768,
        length: 42,
        numPeers: 1,
        uploaded: 0,
        destroyed: false,
        once(event, handler) {
            listeners.set(event, handler);
        },
        emit(event, payload) {
            listeners.get(event)?.(payload);
        },
        destroy() {
            this.destroyed = true;
            this.emit('close');
        }
    };
}

test('two records for the same hash do not overwrite each other', async () => {
    const { context } = await harness();
    const payload = [payloadFile('index.html', 'x')];

    // A mirrored deploy records itself twice in quick succession. Run
    // concurrently against a store that reads before it writes, both calls used
    // to read the same old state and the later write lost.
    const [, second] = await Promise.all([
        context.recordSeedingSession.call(context, {
            hash: HASH,
            torrent: liveTorrent(),
            torrentFile: null,
            payloadFiles: payload,
            siteName: 'my-site',
            deploy: { ...DEPLOY, mirrorState: 'pending' }
        }),
        context.recordSeedingSession.call(context, {
            hash: HASH,
            torrent: liveTorrent(),
            torrentFile: null,
            payloadFiles: payload,
            siteName: 'my-site',
            deploy: { ...DEPLOY, mirror: { locator: 'abc123', filename: 'm.json' }, mirrorState: 'available' }
        })
    ]);

    const record = await context._seedingStore.get(HASH);
    assert.equal(record.deploy.mirrorState, 'available', 'the newest metadata wins');
    assert.equal(record.deploy.mirror.locator, 'abc123');
    assert.equal(second.deploy.mirrorState, 'available');
    assert.equal(record.fileCount, 1, 'and the payload was copied once, not twice');
});

test('a seed callback that arrives after the timeout is destroyed, not left running', async () => {
    const { context } = await harness();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    const fresh = await harness();
    fresh.context._seedingStore = context._seedingStore;
    fresh.context._resumeTimeoutMs = 20;

    let late = null;
    fresh.context.client = {
        get: () => null,
        seed(files, options, callback) {
            // WebTorrent keeps hashing after we stop waiting, and calls back.
            late = liveTorrent();
            setTimeout(() => callback(late), 60);
        }
    };

    await fresh.context.restoreSeedingSessions.call(fresh.context);
    assert.match(fresh.context._seedingErrors.get(HASH), /Timed out/);

    await new Promise((resolve) => setTimeout(resolve, 120));
    // Nothing tracks that torrent: it would seed forever with no card in Pages
    // and no way to stop it.
    assert.equal(late.destroyed, true, 'the late torrent is torn down');
    assert.equal(fresh.context._seedingTorrents.size, 0);
});

test('one stuck session does not hold up the others', async () => {
    const { context } = await harness();
    for (const hash of [HASH, OTHER_HASH, 'a'.repeat(40)]) {
        await context.recordSeedingSession.call(context, {
            hash,
            torrent: { ...liveTorrent(hash) },
            torrentFile: null,
            payloadFiles: [payloadFile('index.html', hash)],
            siteName: `site-${hash.slice(0, 4)}`,
            deploy: DEPLOY
        });
    }

    const fresh = await harness();
    fresh.context._seedingStore = context._seedingStore;
    fresh.context._resumeTimeoutMs = 60;
    fresh.context.client = {
        get: () => null,
        seed(files, options, callback) {
            const hash = new TextDecoder().decode(files[0].bytes ?? new Uint8Array());
            // One session never calls back at all.
            if (hash === OTHER_HASH) return;
            callback({ ...liveTorrent(hash), name: options.name });
        }
    };

    const started = Date.now();
    await fresh.context.restoreSeedingSessions.call(fresh.context);
    const elapsed = Date.now() - started;

    assert.equal(fresh.context._seedingTorrents.size, 2, 'the healthy sessions came up');
    assert.match(fresh.context._seedingErrors.get(OTHER_HASH), /Timed out/);
    // Sequentially this would be three timeouts long; concurrently it is one.
    assert.ok(elapsed < 200, `restoring ran concurrently (${elapsed}ms)`);
});

test('a torrent that dies stops being reported as seeding', async () => {
    const { context } = await harness();
    const torrent = emitterTorrent();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent,
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });
    assert.equal((await context.listSeedingSessionViews.call(context))[0].state, 'seeding');

    torrent.emit('error', new Error('tracker exploded'));

    const [view] = await context.listSeedingSessionViews.call(context);
    // The map still held an object; an object is not a running torrent.
    assert.equal(view.state, 'error');
    assert.match(view.error, /tracker exploded/);
    assert.equal(context._seedingTorrents.size, 0);
});

test('another tab stopping a session takes it down here too', async () => {
    const { context } = await harness();
    const torrent = emitterTorrent();
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent,
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    // IndexedDB is shared between tabs; the live torrents are not. The tab that
    // pressed Stop deleted the record — this one has to let go of its torrent.
    const stopped = context.applyRemoteSeedingStop.call(context, HASH);

    assert.equal(stopped, true);
    assert.equal(torrent.destroyed, true);
    assert.equal(context._seedingTorrents.size, 0);
});

test('stopping broadcasts to the other tabs', async () => {
    const { context } = await harness();
    const posted = [];
    context._seedingChannel = { postMessage: (message) => posted.push(message) };
    await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    await context.stopSeedingSession.call(context, HASH);

    assert.deepEqual(posted, [{ type: 'stopped', hash: HASH }]);
});

test('a write is only durable once the transaction commits', async () => {
    const { context } = await harness();
    // The request succeeds and the transaction aborts afterwards — a quota the
    // browser only discovers while flushing. Reporting that as saved would
    // promise a deployment that is not there on the next load.
    await context._seedingStore.openDb();
    idb.databases.get('web25-seeding').abortNextTransaction = true;

    const record = await context.recordSeedingSession.call(context, {
        hash: HASH,
        torrent: liveTorrent(),
        torrentFile: null,
        payloadFiles: [payloadFile('index.html', 'x')],
        siteName: 'my-site',
        deploy: DEPLOY
    });

    assert.equal(record, null, 'the write is reported as failed');
    assert.equal(context._seedingTorrents.size, 0, 'and nothing was adopted on the strength of it');
});
