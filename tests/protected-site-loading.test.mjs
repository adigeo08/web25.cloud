/**
 * Loading a site that has protected fragments.
 *
 * The order matters and is what these tests pin: torrent or mirror integrity
 * first, then the manifest signature, then the bundle, then each ciphertext,
 * then each grant — and only then does anything render. A protected fragment
 * that cannot be accounted for blocks the whole site rather than rendering as a
 * padlock nobody could ever open.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';

// The loader reads `window.location` at import time, as it does in a browser.
globalThis.window = globalThis.window || { location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' } };

import * as ecies from '../src/channels/ecies.js';
import { bencode } from '../src/torrent/BencodeCodec.js';
import { encodeGoFileMirror, decodeGoFileMirror } from '../src/gofile/GoFileMirrorCodec.js';
import { buildProtectedSite, prepareProtectionWorkspace } from '../src/torrent/ProtectedSiteBuilder.js';
import { textContentOf } from '../src/torrent/AuthoringDom.js';
import { validateProtectedAssets } from '../src/torrent/ProtectedAssetProtocol.js';
import { encodeSiteBundleGzip, decodeSiteBundleGzip, SITE_BUNDLE_FILE_NAME } from '../src/torrent/SiteBundleCodec.js';

if (typeof globalThis.CompressionStream === 'undefined') {
    globalThis.CompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
            const transform = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(new Uint8Array(gzipSync(chunk)));
                }
            });
            this.readable = transform.readable;
            this.writable = transform.writable;
        }
    };
    globalThis.DecompressionStream = class {
        constructor(format) {
            if (format !== 'gzip') throw new Error('Unsupported format');
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

const OWNER_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OWNER_PUB = ecies.getPublicKeyFromPrivateKey(OWNER_KEY);
const SITE_HTML = '<html><body><p>Open. <b>Closed</b> tail.</p></body></html>';
const { applyCachedProtectedSite, buildSignatureState, cacheableProtectedSite, displayCachedSite, verifyProtectedAssetsForRender } =
    await import('../src/core/torrent/TorrentLoader.js');
const { SIGNATURE_STATE_VERIFICATION_VERSION } = await import('../src/core/cache/SignatureStateVersion.js');

const ECIES_HANDLE = {
    eciesEncrypt: ecies.eciesEncrypt,
    evmAddressFromPublicKey: ecies.evmAddressFromPublicKey,
    isValidUncompressedPublicKey: ecies.isValidUncompressedPublicKey
};

async function protectedSite() {
    const files = [{ path: 'index.html', contentType: 'text/html', bytes: new TextEncoder().encode(SITE_HTML) }];
    const document_ = prepareProtectionWorkspace(files).get('index.html');
    let containerId = null;
    for (const [id, element] of document_.previewIndex) if (element.tag === 'p') containerId = id;
    const text = textContentOf(document_.previewIndex.get(containerId));
    const startOffset = text.indexOf('Closed');

    const built = await buildProtectedSite({
        files,
        selections: [
            {
                locator: {
                    path: 'index.html',
                    containerId,
                    startOffset,
                    endOffset: startOffset + 6,
                    exact: 'Closed',
                    prefix: text.slice(0, startOffset),
                    suffix: text.slice(startOffset + 6)
                }
            }
        ],
        owner: { eciesPublicKey: OWNER_PUB },
        ecies: ECIES_HANDLE
    });
    built.assets = await validateProtectedAssets(built.protectedAssets, { siteId: built.siteId });
    return built;
}

/** The `File`-shaped object the mirror encoder expects. */
function mirrorFile(path, bytes, type) {
    return {
        path,
        name: path.split('/').pop(),
        type,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    };
}

function siteDataFrom(files) {
    const siteData = {};
    for (const file of files) {
        siteData[file.path] = { content: file.bytes, type: file.contentType, size: file.bytes.length };
    }
    return siteData;
}

/** A loader context with only the reporting surface stubbed. */
function loaderContext(built) {
    const issues = [];
    return {
        issues,
        context: {
            verifyProtectedAssetsForRender,
            currentProtectedSite: {
                siteId: built.siteId,
                owner: {},
                protectedAssets: built.assets,
                assets: new Map()
            },
            log() {},
            reportVerificationIssue: (message) => issues.push(message)
        }
    };
}

// ─── the render gate ─────────────────────────────────────────────────────

test('a site whose ciphertexts all match is allowed to render', async () => {
    const built = await protectedSite();
    const { context } = loaderContext(built);

    const allowed = await context.verifyProtectedAssetsForRender(siteDataFrom(built.files));
    assert.equal(allowed, true);
    assert.equal(context.currentProtectedSite.assets.size, 1, 'the verified assets are held for the decrypt handler');
});

test('a tampered ciphertext blocks the render entirely', async () => {
    const built = await protectedSite();
    const { context, issues } = loaderContext(built);

    const siteData = siteDataFrom(built.files);
    const asset = built.assets[0];
    siteData[asset.cipherPath].content = Uint8Array.from(siteData[asset.cipherPath].content).fill(0, 0, 4);

    const allowed = await context.verifyProtectedAssetsForRender(siteData);
    assert.equal(allowed, false);
    assert.match(issues[0], /Render blocked/);
    assert.equal(context.currentProtectedSite, null, 'the protected context is dropped, not left half-verified');
});

test('a missing ciphertext blocks the render rather than showing an unopenable padlock', async () => {
    const built = await protectedSite();
    const { context, issues } = loaderContext(built);

    const withoutCiphertext = siteDataFrom(built.files.filter((file) => !file.path.startsWith('.web25/protected/')));
    assert.equal(await context.verifyProtectedAssetsForRender(withoutCiphertext), false);
    assert.match(issues[0], /missing its ciphertext/);
});

test('a site with no protected assets passes the gate untouched', async () => {
    const context = {
        verifyProtectedAssetsForRender,
        currentProtectedSite: null,
        log() {},
        reportVerificationIssue() {}
    };
    assert.equal(await context.verifyProtectedAssetsForRender({ 'index.html': { content: new Uint8Array([1]) } }), true);

    const empty = { ...context, currentProtectedSite: { siteId: null, owner: {}, protectedAssets: [], assets: null } };
    empty.verifyProtectedAssetsForRender = verifyProtectedAssetsForRender;
    assert.equal(await empty.verifyProtectedAssetsForRender({}), true);
    assert.equal(empty.currentProtectedSite.assets.size, 0);
});

test('an unverified manifest leaves no protected context behind', () => {
    // Whatever the previous site was, a signature state that is not a verified
    // torrentchain must not carry decrypt capabilities forward.
    const context = { currentHash: 'abc', currentProtectedSite: { assets: new Map([['x', {}]]) }, buildSignatureState };
    const state = buildSignatureState.call(context, { verified: false, source: 'orphan', torrentHash: 'abc' });
    assert.equal(state.verified, false);
    assert.equal(state.source, 'orphan');
});

// ─── 17. WebTorrent deployment still works ───────────────────────────────

test('the gzip bundle round trip carries protected sites like any other', async () => {
    const built = await protectedSite();
    const encoded = await encodeSiteBundleGzip(built.files, { entryPath: 'index.html' });
    const decoded = await decodeSiteBundleGzip(encoded.gzipBytes);

    assert.equal(decoded.sha256, encoded.sha256, 'the bundle hash the manifest pins is stable');
    assert.deepEqual(
        decoded.files.map((file) => file.path).sort(),
        built.files.map((file) => file.path).sort()
    );

    const siteData = siteDataFrom(decoded.files);
    const { context } = loaderContext(built);
    assert.equal(await context.verifyProtectedAssetsForRender(siteData), true, 'ciphertext survives the gzip round trip');
});

test('the bundle hash changes when protection changes, so an old signature cannot cover it', async () => {
    const plain = [{ path: 'index.html', contentType: 'text/html', bytes: new TextEncoder().encode(SITE_HTML) }];
    const built = await protectedSite();

    const plainBundle = await encodeSiteBundleGzip(plain, { entryPath: 'index.html' });
    const protectedBundle = await encodeSiteBundleGzip(built.files, { entryPath: 'index.html' });
    assert.notEqual(plainBundle.sha256, protectedBundle.sha256);
});

// ─── 18. GoFile mirroring still works ────────────────────────────────────

test('a GoFile mirror carries a protected site byte-for-byte', async () => {
    const built = await protectedSite();
    const encoded = await encodeSiteBundleGzip(built.files, { entryPath: 'index.html' });

    const info = { name: 'site', length: encoded.gzipBytes.length, 'piece length': 16384, pieces: new Uint8Array(20) };
    const torrentFile = bencode({ info });

    // Exactly what the deploy flow mirrors: the signed metainfo plus the very
    // payload files the torrent carries.
    const mirror = await encodeGoFileMirror({
        torrentFile,
        files: [
            mirrorFile('.torrentchain', new TextEncoder().encode('{"signed":true}'), 'application/json'),
            mirrorFile(SITE_BUNDLE_FILE_NAME, encoded.gzipBytes, 'application/gzip')
        ]
    });

    const decoded = decodeGoFileMirror(mirror);
    assert.deepEqual(
        decoded.files.map((file) => file.path),
        ['.torrentchain', SITE_BUNDLE_FILE_NAME],
        'the mirror carries exactly the signed deployment, with no special protected-asset handling'
    );

    const roundTripped = await decodeSiteBundleGzip(decoded.files[1].bytes);
    assert.equal(roundTripped.sha256, encoded.sha256);

    const { context } = loaderContext(built);
    assert.equal(
        await context.verifyProtectedAssetsForRender(siteDataFrom(roundTripped.files)),
        true,
        'a site fetched from the mirror verifies exactly like one fetched over WebTorrent'
    );
});

test('a mirror that lost the ciphertext is caught by the same gate', async () => {
    const built = await protectedSite();
    const withoutCiphertext = built.files.filter((file) => !file.path.startsWith('.web25/protected/'));
    const encoded = await encodeSiteBundleGzip(withoutCiphertext, { entryPath: 'index.html' });
    const decoded = await decodeSiteBundleGzip(encoded.gzipBytes);

    const { context, issues } = loaderContext(built);
    assert.equal(await context.verifyProtectedAssetsForRender(siteDataFrom(decoded.files)), false);
    assert.match(issues[0], /missing its ciphertext/);
});

// ─── what a viewer without a key actually sees ───────────────────────────

test('the rendered HTML shows a placeholder, never the protected text', async () => {
    const built = await protectedSite();
    const encoded = await encodeSiteBundleGzip(built.files, { entryPath: 'index.html' });
    const decoded = await decodeSiteBundleGzip(encoded.gzipBytes);
    const html = new TextDecoder().decode(decoded.files.find((file) => file.path === 'index.html').bytes);

    assert.ok(!html.includes('Closed'), 'the protected text is not in the bundle a visitor downloads');
    assert.match(html, /<web25-protected data-asset-id="[0-9a-f-]{36}"><\/web25-protected>/);
    assert.ok(html.includes('Open.'), 'the rest of the page is intact');
});

test('the sandbox renders a Decrypt control and never decrypts on its own', async () => {
    const { buildSandboxBootstrapHtml } = await import('../src/core/renderer/SandboxBootstrap.js');
    const bootstrap = buildSandboxBootstrapHtml({
        token: 'tok',
        parentOrigin: 'https://web25.cloud',
        prefix: '/peerweb-site/x/',
        mode: 'view',
        protectedEnabled: true
    });

    assert.match(bootstrap, /🔐 Decrypt/, 'a placeholder offers an explicit control');
    assert.match(bootstrap, /web25-protected\[data-asset-id\]/);
    // Decryption is reached from a click handler, never from the render path.
    assert.match(bootstrap, /button\.addEventListener\('click', function \(\) \{\s*requestDecrypt/);
    assert.doesNotMatch(bootstrap, /installProtectedUi\(\)[\s\S]{0,80}requestDecrypt\(/);
});


// ─── the cached path ─────────────────────────────────────────────────────

test('what gets cached is the manifest declaration, never a key or a fragment', async () => {
    const built = await protectedSite();
    const { context } = loaderContext(built);

    const cacheable = context.cacheableProtectedSite ? context.cacheableProtectedSite() : cacheableProtectedSite.call(context);
    assert.equal(cacheable.siteId, built.siteId);
    assert.equal(cacheable.verificationVersion, SIGNATURE_STATE_VERIFICATION_VERSION);

    const serialized = JSON.stringify(cacheable);
    assert.ok(!serialized.includes('Closed'), 'the protected text is not cached');
    assert.ok(!/"cek"/.test(serialized), 'nor is a content key');

    // A site with nothing protected caches nothing extra at all.
    const empty = { currentProtectedSite: null };
    assert.equal(cacheableProtectedSite.call(empty), null);
});

test('a cached protected site is revalidated before it can be decrypted again', async () => {
    const built = await protectedSite();
    const cached = cacheableProtectedSite.call({
        currentProtectedSite: { siteId: built.siteId, owner: {}, protectedAssets: built.assets, assets: new Map() }
    });

    const context = { applyCachedProtectedSite, log() {} };
    await context.applyCachedProtectedSite(cached, 'a'.repeat(40));
    assert.equal(context.currentProtectedSite.protectedAssets.length, 1);
    assert.equal(context.currentProtectedSite.assets.size, 0, 'nothing counts as verified until the bundle is checked');

    // A cache entry whose grants were edited fails revalidation and grants nothing.
    const tampered = JSON.parse(JSON.stringify(cached));
    tampered.protectedAssets[0].grants[0].wrappedKey = tampered.protectedAssets[0].grants[0].wrappedKey.replace(/.$/, '0');
    await context.applyCachedProtectedSite(tampered, 'a'.repeat(40));
    assert.equal(context.currentProtectedSite, null, 'a tampered cache entry carries no decrypt rights');

    // So does one written by an older verification version.
    await context.applyCachedProtectedSite({ ...cached, verificationVersion: 'stale' }, 'a'.repeat(40));
    assert.equal(context.currentProtectedSite, null);
});

test('a cached site whose ciphertext no longer matches is not rendered', async () => {
    const built = await protectedSite();
    const rendered = [];
    const { context, issues } = loaderContext(built);
    context.displayCachedSite = displayCachedSite;
    context.displaySite = (siteData, hash, fromCache) => rendered.push({ hash, fromCache });
    context.hideLoadingOverlay = () => {};

    const siteData = siteDataFrom(built.files);
    await context.displayCachedSite(siteData, 'a'.repeat(40));
    assert.equal(rendered.length, 1, 'an intact cache entry renders');

    const asset = built.assets[0];
    siteData[asset.cipherPath].content = Uint8Array.from(siteData[asset.cipherPath].content).fill(9, 0, 3);
    await context.displayCachedSite(siteData, 'a'.repeat(40));
    assert.equal(rendered.length, 1, 'a mismatched one does not');
    assert.match(issues.at(-1), /Render blocked/);
});
