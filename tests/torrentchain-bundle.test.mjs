import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';

global.window = {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' }
};

if (typeof global.CompressionStream === 'undefined') {
    global.CompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
            this.readable = null;
            this.writable = null;
            const transform = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(new Uint8Array(gzipSync(chunk)));
                }
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    };
}

if (typeof global.DecompressionStream === 'undefined') {
    global.DecompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
            this.readable = null;
            this.writable = null;
            const transform = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(new Uint8Array(gunzipSync(chunk)));
                }
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    };
}

const { encodeSiteBundleGzip, decodeSiteBundleGzip } = await import('../src/torrent/SiteBundleCodec.js');
const { evaluateRenderGate } = await import('../src/torrent/RenderGate.js');
const { applyCachedSignatureState, buildSignatureState, isTorrentComplete, verifyTorrentChainBeforeDownload, processTorrent } = await import(
    '../src/core/torrent/TorrentLoader.js'
);
const { PEERWEB_CONFIG } = await import('../src/config/peerweb.config.js');
const { SIGNATURE_STATE_VERIFICATION_VERSION } = await import('../src/core/cache/SignatureStateVersion.js');
const { isValidDirectMessageSessionId } = await import('../src/channels/DirectMessageSessionId.js');

function makeFile(path, contentType, text) {
    return { path, contentType, bytes: new TextEncoder().encode(text) };
}

test('Bundle codec encode -> gzip -> decode preserves files and metadata', async () => {
    const files = [
        makeFile('index.html', 'text/html', '<h1>Hello</h1>'),
        makeFile('assets/app.js', 'text/javascript', 'console.log("x")')
    ];
    const encoded = await encodeSiteBundleGzip(files, { entryPath: 'index.html' });
    const decoded = await decodeSiteBundleGzip(encoded.gzipBytes);

    assert.equal(decoded.entryPath, 'index.html');
    assert.equal(decoded.files.length, 2);
    assert.equal(new TextDecoder().decode(decoded.files[0].bytes).length > 0, true);
    assert.equal(decoded.sha256, encoded.sha256);
});

test('Bundle sha256 is deterministic for same file list regardless of input ordering', async () => {
    const a = [makeFile('b.js', 'text/javascript', 'b'), makeFile('a.html', 'text/html', 'a')];
    const b = [makeFile('a.html', 'text/html', 'a'), makeFile('b.js', 'text/javascript', 'b')];

    const encodedA = await encodeSiteBundleGzip(a);
    const encodedB = await encodeSiteBundleGzip(b);

    assert.equal(encodedA.sha256, encodedB.sha256);
});

test('Verify gating allows render for valid signature + valid bundle hash', () => {
    const gate = evaluateRenderGate({
        signatureVerified: true,
        strictMode: false,
        hasTorrentChain: true,
        bundleHashExpected: 'abc',
        bundleHashActual: 'abc'
    });
    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, 'ok');
});

test('Verify gating blocks render for bundle hash mismatch', () => {
    const gate = evaluateRenderGate({
        signatureVerified: true,
        strictMode: false,
        hasTorrentChain: true,
        bundleHashExpected: 'abc',
        bundleHashActual: 'def'
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, 'bundle-hash-mismatch');
});

test('Cache signature persistence applies verified state on cache hit without pending regression', () => {
    const ctx = {
        currentHash: null,
        currentSiteSignatureStatus: { label: 'Publisher signature pending (.torrentchain)', verified: false },
        buildSignatureState
    };

    const persisted = buildSignatureState.call(ctx, {
        verified: true,
        label: 'Verified publisher: 0xabc...',
        source: 'torrentchain',
        publisher: '0xabc',
        torrentHash: '1234'
    });

    applyCachedSignatureState.call(ctx, persisted, '1234');
    assert.equal(ctx.currentSiteSignatureStatus.verified, true);
    assert.equal(ctx.currentSiteSignatureStatus.label.startsWith('Verified publisher'), true);
    assert.equal(ctx.currentSiteSignatureStatus.verificationVersion, SIGNATURE_STATE_VERIFICATION_VERSION);
});

test('isTorrentComplete detects already-finished WebTorrent instances', () => {
    assert.equal(isTorrentComplete({ done: true, progress: 0, downloaded: 0, length: 10 }), true);
    assert.equal(isTorrentComplete({ progress: 1, downloaded: 0, length: 10 }), true);
    assert.equal(isTorrentComplete({ progress: 0.99, downloaded: 10, length: 10 }), true);
    assert.equal(isTorrentComplete({ progress: 0.99, downloaded: 9, length: 10 }), false);
});

test('Legacy/orphan permissive mode allows load but strict mode blocks', async () => {
    const original = PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN;
    const ctx = {
        currentSiteSignatureStatus: null,
        buildSignatureState,
        log() {},
        hideLoadingOverlay() {},
        reportVerificationIssue() {}
    };

    global.alert = () => {};

    PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN = false;
    const permissive = await verifyTorrentChainBeforeDownload.call(ctx, { files: [] }, 'a'.repeat(40));
    assert.equal(permissive.ok, true);
    assert.equal(permissive.signatureState.source, 'orphan');

    PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN = true;
    const strict = await verifyTorrentChainBeforeDownload.call(ctx, { files: [], destroy() {} }, 'b'.repeat(40));
    assert.equal(strict.ok, false);

    PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN = original;
});

test('isValidDirectMessageSessionId accepts valid 16-64 hex session ids and rejects invalid ones', () => {
    // Valid: exactly 16 hex chars (lowercase and uppercase)
    assert.equal(isValidDirectMessageSessionId('a'.repeat(16)), true);
    assert.equal(isValidDirectMessageSessionId('A'.repeat(16)), true);
    assert.equal(isValidDirectMessageSessionId('0123456789abcdef'), true);
    // Valid: 24 hex chars (typical output of createDirectMessageSessionId)
    assert.equal(isValidDirectMessageSessionId('a'.repeat(24)), true);
    // Valid: 64 hex chars (upper bound)
    assert.equal(isValidDirectMessageSessionId('f'.repeat(64)), true);

    // Invalid: too short
    assert.equal(isValidDirectMessageSessionId('abc'), false);
    assert.equal(isValidDirectMessageSessionId('a'.repeat(15)), false);
    // Invalid: too long
    assert.equal(isValidDirectMessageSessionId('a'.repeat(65)), false);
    // Invalid: non-hex characters
    assert.equal(isValidDirectMessageSessionId('z'.repeat(24)), false);
    assert.equal(isValidDirectMessageSessionId('room-abc123'), false);
    // Invalid: empty / null / undefined
    assert.equal(isValidDirectMessageSessionId(''), false);
    assert.equal(isValidDirectMessageSessionId(null), false);
    assert.equal(isValidDirectMessageSessionId(undefined), false);
});

test('processTorrent resets processingInProgress to false when cache.set throws', async () => {
    const original = PEERWEB_CONFIG.SITE_BUNDLE_MODE;
    PEERWEB_CONFIG.SITE_BUNDLE_MODE = 'legacy';

    const overlayHidden = { called: false };
    const ctx = {
        processingInProgress: true,
        log() {},
        hideLoadingOverlay() { overlayHidden.called = true; },
        getFileBuffer: async () => new Uint8Array([]),
        getContentType: () => 'text/html',
        isTextFile: () => true,
        attachSignatureManifest() {},
        validateReceivedManifest() {},
        reportVerificationIssue() {},
        cache: {
            set: async () => { throw new Error('storage quota exceeded'); }
        },
        displaySite() {}
    };

    await processTorrent.call(ctx, { files: [{ name: 'index.html' }] }, 'a'.repeat(40));

    assert.equal(ctx.processingInProgress, false, 'processingInProgress must be reset on cache error');
    assert.equal(overlayHidden.called, true, 'hideLoadingOverlay must be called on cache error');

    PEERWEB_CONFIG.SITE_BUNDLE_MODE = original;
});
