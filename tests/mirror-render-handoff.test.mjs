/**
 * What happens to the abandoned torrent once the GoFile mirror takes a load
 * over.
 *
 * The mirror path renders the very same bundle the torrent would have: same
 * `.torrentchain` gate, same gzip decode, same `displaySite`. What made a
 * mirrored site come up wrong was everything the torrent kept doing afterwards
 * — its `error` handler telling the service worker the site had stopped
 * loading, which emptied the file list the rendered page is served from, and
 * its tracker sockets still reconnecting behind the page.
 *
 * So: once the fallback owns a hash, the torrent phase is over and silent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };
const { loadSite, registerLoadTorrent, releaseLoadTorrent } = await import('../src/core/torrent/TorrentLoader.js');

const HASH = '0123456789abcdef0123456789abcdef01234567';

/** A torrent double that hands its event handlers back to the test. */
function fakeTorrent() {
    const handlers = new Map();
    return {
        name: 'site',
        length: 1024,
        files: [{ name: '.torrentchain', path: '.torrentchain', select() {} }],
        destroyed: false,
        handlers,
        on(name, handler) {
            handlers.set(name, handler);
        },
        once() {},
        emit(name, ...args) {
            return handlers.get(name)?.(...args);
        },
        destroy(callback) {
            this.destroyed = true;
            callback?.();
        }
    };
}

/** A loader context that gets as far as a running torrent and stops there. */
function loaderContext({ torrent, messages }) {
    return {
        registerLoadTorrent,
        releaseLoadTorrent,
        sanitizeHash: (value) => `${value}`.replace(/[^a-fA-F0-9]/g, '').toLowerCase(),
        isValidTorrentHash: () => true,
        buildSignatureState: (state) => state,
        signedTorrentMetadata: new Map(),
        cache: { getEntry: async () => null },
        showLoadingOverlay() {},
        hideLoadingOverlay() {},
        isBrowserSupportedTracker: () => true,
        trackers: ['wss://tracker.openwebtorrent.com/'],
        sendToServiceWorker(type, data) {
            messages.push({ type, ...data });
        },
        serviceWorkerReady: true,
        clientReady: true,
        client: {
            add: (magnetURI, callback) => {
                void callback(torrent);
                return torrent;
            }
        },
        verifyTorrentChainBeforeDownload: async () => ({ ok: true, manifest: null }),
        updatePeerStats() {},
        updateProgress() {},
        isTorrentComplete: () => false,
        shouldProcessSiteEarly: () => false,
        calculateProcessingTimeout: () => 1000,
        formatBytes: (value) => `${value}`,
        processTorrent: async () => {
            throw new Error('the torrent phase must not process anything after the fallback took over');
        },
        handleTerminalP2PFailure: async () => {},
        // The retry the torrent phase schedules for itself; the tests only care
        // that it belongs to the torrent phase and not to the mirrored render.
        retries: [],
        loadSite(hash, attempt) {
            this.retries.push(attempt);
        },
        log() {},
        toast: { info() {} }
    };
}

/** Run one load with timers stubbed out, then hand the context back. */
async function startedLoad(torrent, messages) {
    const context = loaderContext({ torrent, messages });
    const previousTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;
    try {
        await loadSite.call(context, HASH);
    } finally {
        globalThis.setTimeout = previousTimeout;
    }
    return context;
}

test('a torrent that errors after the mirror took over says nothing to the service worker', async () => {
    const torrent = fakeTorrent();
    const messages = [];
    const context = await startedLoad(torrent, messages);

    assert.deepEqual(
        messages.map((message) => message.state),
        ['start'],
        'the load starts as usual'
    );

    // This is what `handleTerminalP2PFailure` marks when it takes the hash over.
    context._gofileFallbackStarted = HASH;
    torrent.emit('error', new Error('torrent gave up'));

    assert.equal(messages.length, 1, 'no stop message follows the mirrored render');
});

test('a torrent that finds peers after the mirror rendered does not render again', async () => {
    const torrent = fakeTorrent();
    const messages = [];
    const context = await startedLoad(torrent, messages);
    context._gofileFallbackStarted = HASH;
    context.isTorrentComplete = () => true;

    // `processTorrent` throws if it is reached, and `noPeers` would schedule
    // another attempt at a transport nobody is waiting for any more.
    torrent.emit('download');
    await torrent.emit('done');
    torrent.emit('noPeers');

    assert.equal(messages.length, 1);
});

test('the torrent phase is live until the fallback takes over', async () => {
    const torrent = fakeTorrent();
    const messages = [];
    await startedLoad(torrent, messages);

    torrent.emit('error', new Error('torrent gave up'));

    assert.deepEqual(
        messages.map((message) => message.state),
        ['start', 'stop'],
        'an error during the torrent phase still ends the download phase'
    );
});

test('a torrent error after the fallback took over schedules no further attempt', async () => {
    const torrent = fakeTorrent();
    const context = await startedLoad(torrent, []);
    context._gofileFallbackStarted = HASH;

    torrent.emit('error', new Error('torrent gave up'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(context.retries, []);
});

test('starting a load destroys the torrent the previous one was running', async () => {
    const first = fakeTorrent();
    const messages = [];
    const context = await startedLoad(first, messages);
    assert.equal(first.destroyed, false);

    const second = fakeTorrent();
    context.client.add = (magnetURI, callback) => {
        void callback(second);
        return second;
    };
    const previousTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => 0;
    try {
        await loadSite.call(context, HASH);
    } finally {
        globalThis.setTimeout = previousTimeout;
    }

    assert.equal(first.destroyed, true, 'one load owns the transport at a time');
    assert.equal(second.destroyed, false);
});

test('releasing twice is harmless and forgets the torrent', () => {
    const torrent = fakeTorrent();
    const context = { log() {}, releaseLoadTorrent };
    registerLoadTorrent.call(context, torrent);
    releaseLoadTorrent.call(context);
    releaseLoadTorrent.call(context);

    assert.equal(torrent.destroyed, true);
    assert.equal(context._activeLoadTorrent, null);
});
