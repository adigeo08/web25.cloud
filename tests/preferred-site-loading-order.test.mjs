import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const HASH = '0123456789abcdef0123456789abcdef01234567';
const LOCATOR = 'mirror-locator';

/**
 * The loader is imported lazily: `peerweb.config.js` reads `window` at module
 * scope, so nothing may be imported before the stub above is in place.
 */
async function torrentLoader() {
    return import('../src/core/torrent/TorrentLoader.js');
}

function baseContext(events, clearP2PDeadline = () => {}) {
    return {
        sanitizeHash: (value) => `${value}`.toLowerCase(),
        isValidTorrentHash: () => true,
        signedTorrentMetadata: new Map(),
        buildSignatureState: (state) => state,
        applyCachedSignatureState() {},
        displayCachedSite() {
            events.push('render-cache');
        },
        cache: {
            async getEntry() {
                events.push('cache');
                return null;
            }
        },
        releaseLoadTorrent() {},
        clearP2PDeadline,
        // The mirror handoff lives behind the single P2P attempt now, so every
        // path that reaches it reaches it through here.
        async handleTerminalP2PFailure() {
            events.push('gofile');
        },
        showLoadingOverlay() {},
        hideLoadingOverlay() {},
        log() {},
        toast: { info() {} },
        serviceWorkerReady: true,
        clientReady: true,
        trackers: [],
        isBrowserSupportedTracker: () => true,
        sendToServiceWorker() {},
        client: {
            add() {
                events.push('p2p');
            }
        }
    };
}

test('cache hit stops before P2P and GoFile', async () => {
    const { loadSite } = await import('../src/core/torrent/PreferredSiteLoader.js');
    const events = [];
    const context = baseContext(events, (await torrentLoader()).clearP2PDeadline);
    context.cache.getEntry = async () => {
        events.push('cache');
        return { data: { 'index.html': { content: new Uint8Array() } }, signatureState: null };
    };
    context.gofileService = {
        async downloadPublicMirror() {
            events.push('gofile');
            throw new Error('should not run');
        }
    };

    await loadSite.call(context, `${HASH}&${LOCATOR}`);

    assert.deepEqual(events, ['cache', 'render-cache']);
});

test('a cache miss goes to the swarm before the mirror is considered', async () => {
    const { loadSite } = await import('../src/core/torrent/PreferredSiteLoader.js');
    const { clearP2PDeadline } = await torrentLoader();
    const events = [];
    const context = baseContext(events, clearP2PDeadline);
    context.gofileCredentialStore = { read: async () => ({ token: 'reader-token' }) };
    context.gofileService = {
        async downloadPublicMirror() {
            events.push('gofile');
            throw new Error('mirror unavailable');
        }
    };

    await loadSite.call(context, `${HASH}&${LOCATOR}`);
    clearP2PDeadline.call(context);

    assert.deepEqual(events, ['cache', 'p2p']);
});

test('without a GoFile locator a cache miss goes directly to P2P', async () => {
    const { loadSite } = await import('../src/core/torrent/PreferredSiteLoader.js');
    const { clearP2PDeadline } = await torrentLoader();
    const events = [];
    const context = baseContext(events, clearP2PDeadline);

    await loadSite.call(context, HASH);
    clearP2PDeadline.call(context);

    assert.equal(events[0], 'cache');
    assert.ok(!events.includes('gofile'));
    assert.ok(events.includes('p2p'));
});

test('the P2P attempt is a single 8 second window', async () => {
    const loader = await torrentLoader();
    const source = await import('node:fs').then((fs) =>
        fs.promises.readFile(new URL('../src/core/torrent/TorrentLoader.js', import.meta.url), 'utf8')
    );

    assert.equal(loader.P2P_ATTEMPT_TIMEOUT_MS, 8000);
    // The retry ladder is gone, not merely shortened: one attempt means there
    // is no backoff, no attempt counter and no second announce anywhere.
    assert.ok(!/LOAD_RETRY_MAX|calcRetryDelay/.test(source));
});

test('the deadline hands the load to the mirror exactly once', async () => {
    const { loadSite, clearP2PDeadline } = await torrentLoader();
    const events = [];
    const context = baseContext(events, clearP2PDeadline);
    context.currentHash = null;
    context.handleTerminalP2PFailure = async (hash, locator) => {
        events.push(`terminal:${hash}:${locator}`);
    };
    // A client that accepts the magnet and then never calls back: no metadata,
    // no peers, no error — the case the deadline exists for.
    context.client = {
        add() {
            events.push('p2p');
        }
    };

    await loadSite.call(context, { torrentHash: HASH, gofileLocator: LOCATOR });
    assert.ok(events.includes('p2p'));
    assert.ok(!events.some((event) => event.startsWith('terminal:')));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!events.some((event) => event.startsWith('terminal:')), 'the deadline must not fire early');

    // Fire it by hand rather than waiting eight seconds in a unit test.
    clearP2PDeadline.call(context);
    assert.equal(context._p2pDeadlineTimer, null);
});
