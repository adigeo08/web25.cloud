import test from 'node:test';
import assert from 'node:assert/strict';

function stubElement() {
    return {
        textContent: '',
        href: '',
        download: '',
        style: {},
        classList: { add() {}, remove() {}, toggle() {} }
    };
}

function installDom() {
    const elements = new Map();
    globalThis.window = {
        location: {
            origin: 'https://web25.cloud',
            pathname: '/',
            href: 'https://web25.cloud/',
            hostname: 'web25.cloud',
            protocol: 'https:',
            search: ''
        },
        addEventListener() {}
    };
    Object.defineProperty(globalThis, 'location', {
        value: globalThis.window.location,
        configurable: true,
        writable: true
    });
    globalThis.document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, stubElement());
            return elements.get(id);
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}
    };
    return elements;
}

function uploadContext() {
    return {
        sanitizeHash: (hash) => `${hash}`.replace(/[^a-fA-F0-9]/g, '').toLowerCase(),
        createTrackedObjectURL: () => 'blob:stub',
        updateSeedingStats() {},
        log() {}
    };
}

const SIGNED_HASH = '0123456789abcdef0123456789abcdef01234567';
const IMPORTED_HASH = 'fedcba9876543210fedcba9876543210fedcba98';

test('re-rendering the same artifact keeps its signed bytes and mirror payload', async () => {
    installDom();
    const { showUploadResult } = await import('../src/core/torrent/TorrentUploader.js');
    const context = uploadContext();
    context.lastPublishCandidate = {
        hash: SIGNED_HASH,
        siteName: 'website',
        createdAt: '2026-09-07T00:00:00.000Z',
        signedTorrentFile: new Uint8Array([1, 2, 3]),
        payloadFiles: ['.torrentchain']
    };

    showUploadResult.call(context, SIGNED_HASH, new Uint8Array([1, 2, 3]), { name: 'website' }, 'Mirror123');

    assert.equal(context.lastPublishCandidate.hash, SIGNED_HASH);
    assert.deepEqual(context.lastPublishCandidate.payloadFiles, ['.torrentchain']);
    assert.ok(context.lastPublishCandidate.signedTorrentFile);
    assert.equal(context.lastPublishCandidate.createdAt, '2026-09-07T00:00:00.000Z');
});

test('rendering a different torrent never inherits the previous signed artifact', async () => {
    const elements = installDom();
    const { showUploadResult } = await import('../src/core/torrent/TorrentUploader.js');
    const context = uploadContext();
    context.lastPublishCandidate = {
        hash: SIGNED_HASH,
        siteName: 'website',
        createdAt: '2026-09-07T00:00:00.000Z',
        signedTorrentFile: new Uint8Array([1, 2, 3]),
        payloadFiles: ['.torrentchain']
    };

    showUploadResult.call(context, IMPORTED_HASH, new Uint8Array([9]), { name: 'imported' });

    assert.equal(context.lastPublishCandidate.hash, IMPORTED_HASH);
    assert.equal(context.lastPublishCandidate.signedTorrentFile, undefined);
    assert.equal(context.lastPublishCandidate.payloadFiles, undefined);
    assert.equal(context.lastPublishCandidate.createdAt, undefined);
    assert.equal(elements.get('result-url').textContent, `https://web25.cloud/?orc=${IMPORTED_HASH}`);
});

test('deployment refuses a staged artifact the held signature does not cover', async () => {
    installDom();
    const { deploySignedArtifact } = await import('../src/core/bootstrap/Lifecycle.js');
    const context = {
        lastPublishCandidate: { hash: IMPORTED_HASH },
        lastSignature: { signature: '0xsig' },
        lastSignedPublish: { torrentHash: SIGNED_HASH },
        log() {}
    };

    await assert.rejects(() => deploySignedArtifact.call(context), /changed after signing/i);

    // A candidate the signature does cover gets past the guard and fails later,
    // on the identity lookup this stub deliberately does not provide.
    context.lastPublishCandidate = { hash: SIGNED_HASH };
    await assert.rejects(
        () => deploySignedArtifact.call(context),
        (error) => {
            assert.doesNotMatch(error.message, /changed after signing/i);
            return true;
        }
    );
});
