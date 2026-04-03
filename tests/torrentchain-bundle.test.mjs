import test from 'node:test';
import assert from 'node:assert/strict';

global.window = {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' }
};

const { encodeSiteBundleGzip, decodeSiteBundleGzip } = await import('../src/torrent/SiteBundleCodec.js');
const { evaluateRenderGate } = await import('../src/torrent/RenderGate.js');
const { applyCachedSignatureState, buildSignatureState, verifyTorrentChainBeforeDownload } = await import(
    '../src/core/torrent/TorrentLoader.js'
);
const { PEERWEB_CONFIG } = await import('../src/config/peerweb.config.js');
const { SIGNATURE_STATE_VERIFICATION_VERSION } = await import('../src/core/cache/SignatureStateVersion.js');

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

test('Legacy/orphan permissive mode allows load but strict mode blocks', async () => {
    const original = PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN;
    const ctx = {
        currentSiteSignatureStatus: null,
        buildSignatureState,
        log() {},
        hideLoadingOverlay() {}
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
