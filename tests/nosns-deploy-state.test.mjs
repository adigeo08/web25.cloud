/**
 * The deploy-state regression that made NosNS publication silently do nothing.
 *
 * `showUploadResult()` used to overwrite `lastPublishCandidate` with just
 * `{ hash, siteName }`, destroying the seeded `torrent`, `torrentFile`,
 * `signedTorrentFile` and `createdAt` the deploy flow had put there. The
 * publication step runs immediately afterwards and requires
 * `candidate.torrent`, so it returned without a word: the site deployed, and no
 * directory entry was ever created.
 *
 * These tests run the real `showUploadResult` against a minimal DOM stub, so
 * they fail against the pre-fix implementation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { showUploadResult } from '../src/core/torrent/TorrentUploader.js';
import { ensureNosnsTorrentName } from '../src/nosns/NosNSProtocol.js';

const HASH = 'e5a1c0d4b7f28369ac015be47d3902fa6c8b1d47';

/** The smallest DOM the function actually touches. */
function installDom() {
    const nodes = new Map();
    const make = (id) => ({
        id,
        textContent: '',
        href: '',
        download: '',
        style: {},
        classList: {
            _set: new Set(['hidden']),
            add(name) {
                this._set.add(name);
            },
            remove(name) {
                this._set.delete(name);
            },
            contains(name) {
                return this._set.has(name);
            }
        }
    });

    for (const id of ['result-hash', 'result-url', 'upload-result', 'download-torrent-file']) {
        nodes.set(id, make(id));
    }

    globalThis.window = { location: { origin: 'https://web25.cloud', pathname: '/' } };
    globalThis.document = { getElementById: (id) => nodes.get(id) || null };
    globalThis.Blob = class Blob {
        constructor(parts) {
            this.parts = parts;
        }
    };
    // Keep the real URL constructor; only the object-URL helpers are stubbed.
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.URL.createObjectURL = () => 'blob:fake';

    return nodes;
}

/** The deploy state as `signStagedPayload()` / `deploySignedArtifact()` leave it. */
function deployApp() {
    const torrent = { infoHash: HASH, name: 'my-site.nosns.torrent', files: [], announce: [] };
    return {
        lastPublishCandidate: {
            hash: HASH,
            siteName: 'my-site',
            createdAt: '2026-02-01T10:00:00.000Z',
            torrent,
            torrentFile: new Uint8Array([1, 2, 3]),
            signedTorrentFile: new Uint8Array([4, 5, 6])
        },
        lastSignature: { signature: `0x${'9'.repeat(130)}`, payload: {} },
        sanitizeHash: (value) => `${value}`.toLowerCase(),
        createTrackedObjectURL: () => 'blob:fake',
        updateSeedingStats() {},
        showUploadResult,
        torrent
    };
}

test('showUploadResult does not destroy lastPublishCandidate.torrent', () => {
    installDom();
    const app = deployApp();
    const before = app.lastPublishCandidate;

    app.showUploadResult(HASH, app.lastPublishCandidate.signedTorrentFile, app.torrent);

    assert.equal(app.lastPublishCandidate, before, 'deploy state is owned by the deploy flow');
    assert.equal(app.lastPublishCandidate.torrent, app.torrent);
    assert.ok(app.lastPublishCandidate.torrentFile);
    assert.ok(app.lastPublishCandidate.signedTorrentFile);
    assert.equal(app.lastPublishCandidate.createdAt, '2026-02-01T10:00:00.000Z');
});

test('NosNS publication still has what it needs after the result is rendered', () => {
    installDom();
    const app = deployApp();
    app.showUploadResult(HASH, app.lastPublishCandidate.signedTorrentFile, app.torrent);

    // This is the exact guard at the top of `publishNosnsEntry()`. Before the
    // fix it was false here, and publication returned silently.
    const candidate = app.lastPublishCandidate;
    const signature = app.lastSignature;
    assert.ok(candidate?.torrent && signature?.signature, 'the publish guard must pass');
});

test('rendering writes display state to its own field', () => {
    installDom();
    const app = deployApp();
    app.showUploadResult(HASH, null, app.torrent);

    assert.deepEqual(app.lastResultDisplay, {
        hash: HASH,
        siteName: 'my-site.nosns.torrent',
        url: `https://web25.cloud/?orc=${HASH}`
    });
});

test('the DOM is still updated — the fix did not silence rendering', () => {
    const nodes = installDom();
    const app = deployApp();
    app.showUploadResult(HASH, app.lastPublishCandidate.signedTorrentFile, app.torrent);

    assert.equal(nodes.get('result-hash').textContent, HASH);
    assert.equal(nodes.get('result-url').textContent, `https://web25.cloud/?orc=${HASH}`);
    assert.equal(nodes.get('upload-result').classList.contains('hidden'), false);
});

test('the downloadable .torrent filename carries the NosNS suffix', () => {
    const nodes = installDom();
    const app = deployApp();
    app.showUploadResult(HASH, app.lastPublishCandidate.signedTorrentFile, app.torrent);

    const link = nodes.get('download-torrent-file');
    assert.equal(link.download, 'my-site.nosns.torrent');
    assert.equal(link.download, ensureNosnsTorrentName(app.torrent.name), 'idempotent — no doubled suffix');
    assert.ok(link.download.endsWith('.nosns.torrent'));
});

test('a torrent with no name still yields a suffixed download name', () => {
    const nodes = installDom();
    const app = deployApp();
    app.showUploadResult(HASH, app.lastPublishCandidate.signedTorrentFile, { infoHash: HASH });

    assert.ok(nodes.get('download-torrent-file').download.endsWith('.nosns.torrent'));
});

test('the seeded torrent name is what the real seed call is given', async () => {
    // The suffix has to be in the BitTorrent info.name, not bolted onto the
    // download afterwards, so it survives re-sharing the .torrent file.
    const source = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../src/core/torrent/TorrentUploader.js', import.meta.url), 'utf8')
    );

    const seedCall = source.slice(source.indexOf('this.client.seed('));
    const nameLine = seedCall.split('\n').find((line) => line.trim().startsWith('name:'));

    assert.ok(nameLine, 'the deploy seed call sets an explicit name');
    assert.match(nameLine, /ensureNosnsTorrentName\(/, 'info.name must be the NosNS name');
});
