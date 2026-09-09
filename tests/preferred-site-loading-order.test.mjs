import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const HASH = '0123456789abcdef0123456789abcdef01234567';
const LOCATOR = 'mirror-locator';

function baseContext(events) {
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

test('cache hit stops before GoFile and P2P', async () => {
    const { loadSite } = await import('../src/core/torrent/PreferredSiteLoader.js');
    const events = [];
    const context = baseContext(events);
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

test('cache miss tries GoFile before P2P', async () => {
    const { loadSite } = await import('../src/core/torrent/PreferredSiteLoader.js');
    const events = [];
    const context = baseContext(events);
    context.gofileCredentialStore = { read: async () => ({ token: 'reader-token' }) };
    context.gofileService = {
        async downloadPublicMirror() {
            events.push('gofile');
            throw new Error('mirror unavailable');
        }
    };

    await loadSite.call(context, `${HASH}&${LOCATOR}`);

    assert.equal(events[0], 'cache');
    assert.equal(events[1], 'gofile');
    assert.ok(events.includes('p2p'));
    assert.ok(events.indexOf('gofile') < events.indexOf('p2p'));
});

test('without a GoFile locator a cache miss goes directly to P2P', async () => {
    const { loadSite } = await import('../src/core/torrent/PreferredSiteLoader.js');
    const events = [];
    const context = baseContext(events);

    await loadSite.call(context, HASH);

    assert.equal(events[0], 'cache');
    assert.ok(!events.includes('gofile'));
    assert.ok(events.includes('p2p'));
});
