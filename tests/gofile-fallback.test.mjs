import test from 'node:test';
import assert from 'node:assert/strict';
import { bencode } from '../src/torrent/BencodeCodec.js';
import { GoFileService } from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };
const loader = () => import('../src/core/torrent/TorrentLoader.js');

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('legacy terminal torrent failure never contacts GoFile', async () => {
    const { handleTerminalP2PFailure } = await loader();
    let contacted = false;
    const context = {
        gofileService: { downloadPublicMirror: async () => (contacted = true) },
        hideLoadingOverlay() {},
        log() {}
    };
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
        await handleTerminalP2PFailure.call(context, HASH, null, new Error('no peers'));
        assert.equal(contacted, false);
    } finally {
        globalThis.alert = previousAlert;
    }
});

test('terminal torrent failure with locator enters GoFile path but never renders failed verification', async () => {
    const { handleTerminalP2PFailure } = await loader();
    let contacted = 0;
    let rendered = false;
    const context = {
        gofileService: {
            downloadPublicMirror: async () => {
                contacted += 1;
                throw new Error('mirror offline');
            }
        },
        hideLoadingOverlay() {},
        log() {},
        processTorrent: async () => {
            rendered = true;
        }
    };
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
        await handleTerminalP2PFailure.call(context, HASH, 'Mirror123', new Error('retry exhausted'));
        assert.equal(contacted, 1);
        assert.equal(rendered, false);
    } finally {
        globalThis.alert = previousAlert;
    }
});

test('a valid bound mirror converges on the existing verification and processing path', async () => {
    const { handleTerminalP2PFailure } = await loader();
    const bytes = new TextEncoder().encode('{"torrentchain":"fixture"}');
    const piece = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const info = { name: '.torrentchain', length: bytes.length, 'piece length': 16384, pieces: piece };
    const torrentFile = bencode({ info });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', bencode(info))), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
    const mirrorWire = new TextEncoder().encode(
        JSON.stringify({
            schema: 'web25-gofile-mirror-v1',
            torrentBase64: Buffer.from(torrentFile).toString('base64'),
            files: [
                {
                    path: '.torrentchain',
                    contentType: 'application/json',
                    bytesBase64: Buffer.from(bytes).toString('base64')
                }
            ]
        })
    );
    let chainChecks = 0;
    let processed = 0;
    const context = {
        gofileService: { downloadPublicMirror: async () => mirrorWire },
        verifyTorrentChainBeforeDownload: async (torrent, requested) => {
            chainChecks += 1;
            assert.equal(requested, hash);
            assert.equal(torrent.files[0].path, '.torrentchain');
            return { ok: true };
        },
        processTorrent: async (torrent, requested) => {
            processed += 1;
            assert.equal(requested, hash);
            assert.equal(torrent.done, true);
            return true;
        },
        hideLoadingOverlay() {},
        log() {},
        toast: { info() {} }
    };
    await handleTerminalP2PFailure.call(context, hash, 'Mirror123', new Error('retry exhausted'));
    assert.equal(chainChecks, 1);
    assert.equal(processed, 1);
});

test("the resolver asks for this deployment's own locator and mirror filename", async () => {
    const { handleTerminalP2PFailure } = await loader();
    const asked = [];
    const context = {
        gofileService: {
            downloadPublicMirror: async (locator, options) => {
                asked.push({ locator, expectedFilename: options?.expectedFilename });
                throw new Error('mirror offline');
            }
        },
        hideLoadingOverlay() {},
        log() {},
        toast: { info() {} }
    };
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
        await handleTerminalP2PFailure.call(context, HASH, 'Mirror123', new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }
    assert.deepEqual(asked, [{ locator: 'Mirror123', expectedFilename: gofileMirrorFilename(HASH) }]);
});

test('a stalled mirror ends the load instead of hanging the overlay', async () => {
    const { handleTerminalP2PFailure } = await loader();
    let overlayHidden = 0;
    let alerted = '';
    const context = {
        gofileService: new GoFileService({
            fetchImpl: (_url, init) =>
                new Promise((_resolve, reject) => {
                    const socket = setTimeout(() => {}, 10000);
                    init.signal.addEventListener('abort', () => {
                        clearTimeout(socket);
                        reject(init.signal.reason);
                    });
                }),
            metadataTimeoutMs: 25
        }),
        hideLoadingOverlay() {
            overlayHidden += 1;
        },
        log() {},
        toast: { info() {} },
        processTorrent: async () => {
            throw new Error('nothing may be rendered from a mirror that never arrived');
        }
    };
    const previousAlert = globalThis.alert;
    globalThis.alert = (message) => {
        alerted = message;
    };
    const started = Date.now();
    try {
        await handleTerminalP2PFailure.call(context, HASH, 'Mirror123', new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }

    assert.ok(Date.now() - started < 5000, 'the resolver did not wait on GoFile indefinitely');
    assert.equal(overlayHidden, 1, 'the loading overlay always terminates');
    assert.equal(context.processingInProgress, false);
    assert.match(alerted, /timed out/i);
    assert.match(alerted, /No unverified content was rendered/);
});

test('a mirror bound to a different torrent is refused before any render', async () => {
    const { handleTerminalP2PFailure } = await loader();
    const bytes = new TextEncoder().encode('{"torrentchain":"other deployment"}');
    const piece = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const info = { name: '.torrentchain', length: bytes.length, 'piece length': 16384, pieces: piece };
    const mirrorWire = new TextEncoder().encode(
        JSON.stringify({
            schema: 'web25-gofile-mirror-v1',
            torrentBase64: Buffer.from(bencode({ info })).toString('base64'),
            files: [
                {
                    path: '.torrentchain',
                    contentType: 'application/json',
                    bytesBase64: Buffer.from(bytes).toString('base64')
                }
            ]
        })
    );
    let rendered = 0;
    let chainChecks = 0;
    let alerted = '';
    const context = {
        gofileService: { downloadPublicMirror: async () => mirrorWire },
        verifyTorrentChainBeforeDownload: async () => {
            chainChecks += 1;
            return { ok: true };
        },
        processTorrent: async () => {
            rendered += 1;
            return true;
        },
        hideLoadingOverlay() {},
        log() {},
        toast: { info() {} }
    };
    const previousAlert = globalThis.alert;
    globalThis.alert = (message) => {
        alerted = message;
    };
    try {
        // The mirror is internally consistent, but it is not the deployment the
        // WEB25 address asked for.
        await handleTerminalP2PFailure.call(context, HASH, 'Mirror123', new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }

    assert.equal(rendered, 0, 'verification runs before anything reaches the renderer');
    assert.equal(chainChecks, 0, 'the hash mismatch is caught before TorrentChain verification');
    assert.match(alerted, /info hash mismatch/i);
});

test('a visitor with a stored credential resolves the mirror with it', async () => {
    const { handleTerminalP2PFailure } = await loader();
    const asked = [];
    const context = {
        gofileCredentialStore: { read: async () => ({ token: 'visitor-token' }) },
        gofileService: {
            downloadPublicMirror: async (locator, options) => {
                asked.push({ locator, token: options?.token ?? null });
                throw new Error('mirror offline');
            }
        },
        hideLoadingOverlay() {},
        log() {},
        toast: { info() {} }
    };
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
        await handleTerminalP2PFailure.call(context, HASH, 'Mirror123', new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }
    assert.deepEqual(asked, [{ locator: 'Mirror123', token: 'visitor-token' }]);
});

test('a locked wallet or missing credential still attempts the mirror', async () => {
    const { handleTerminalP2PFailure } = await loader();
    // The common case: someone opening a WEB25 link who has never deployed.
    for (const store of [
        undefined,
        { read: async () => null },
        {
            read: async () => {
                throw new Error('Unlock your wallet to use the GoFile guest credential.');
            }
        }
    ]) {
        const asked = [];
        const context = {
            gofileCredentialStore: store,
            gofileService: {
                downloadPublicMirror: async (locator, options) => {
                    asked.push(options?.token ?? null);
                    throw new Error('mirror offline');
                }
            },
            hideLoadingOverlay() {},
            log() {},
            toast: { info() {} }
        };
        const previousAlert = globalThis.alert;
        globalThis.alert = () => {};
        try {
            await handleTerminalP2PFailure.call(context, HASH, 'Mirror123', new Error('retry exhausted'));
        } finally {
            globalThis.alert = previousAlert;
        }
        assert.deepEqual(asked, [null], 'the mirror is attempted, unauthenticated, without a wallet error');
    }
});

/** A loader context whose only failing part is the torrent transport. */
function loaderContext({ onAdd, contacted, handleTerminalP2PFailure }) {
    return {
        handleTerminalP2PFailure,
        sanitizeHash: (value) => `${value}`.replace(/[^a-fA-F0-9]/g, '').toLowerCase(),
        isValidTorrentHash: () => true,
        buildSignatureState: (state) => state,
        signedTorrentMetadata: new Map(),
        cache: { getEntry: async () => null },
        showLoadingOverlay() {},
        hideLoadingOverlay() {},
        isBrowserSupportedTracker: () => true,
        trackers: ['wss://tracker.openwebtorrent.com/'],
        sendToServiceWorker() {},
        serviceWorkerReady: true,
        clientReady: true,
        client: { add: onAdd },
        log() {},
        toast: { info() {} },
        gofileService: {
            downloadPublicMirror: async () => {
                contacted.push('gofile');
                throw new Error('mirror offline');
            }
        },
        gofileCredentialStore: { read: async () => null }
    };
}

test('the mirror is only reached after the WebRTC tracker budget is spent', async () => {
    const { loadSite, handleTerminalP2PFailure } = await loader();
    const previousAlert = globalThis.alert;
    const previousTimeout = globalThis.setTimeout;
    globalThis.alert = () => {};

    let firstFallbackAttempt = null;
    const scheduledRetries = [];
    try {
        for (let attempt = 0; attempt < 10 && firstFallbackAttempt === null; attempt += 1) {
            const contacted = [];
            const magnets = [];
            let scheduled = 0;
            globalThis.setTimeout = (fn, delay) => {
                scheduled += 1;
                return previousTimeout(() => {}, 0);
            };
            const context = loaderContext({
                contacted,
                handleTerminalP2PFailure,
                onAdd: (magnetURI) => {
                    magnets.push(magnetURI);
                    throw new Error('WebTorrent could not add the torrent');
                }
            });

            await loadSite.call(context, `${HASH}&Mirror123`, attempt);

            assert.equal(magnets.length, 1, 'every attempt really tries the torrent transport first');
            assert.match(magnets[0], /^magnet:\?xt=urn:btih:/);
            assert.match(magnets[0], /tr=wss%3A%2F%2Ftracker/, 'the WebRTC tracker is in the magnet');
            if (contacted.length > 0) firstFallbackAttempt = attempt;
            else scheduledRetries.push(scheduled);
        }
    } finally {
        globalThis.alert = previousAlert;
        globalThis.setTimeout = previousTimeout;
    }

    assert.notEqual(firstFallbackAttempt, null, 'the mirror is eventually reached');
    assert.ok(firstFallbackAttempt >= 5, `the mirror waited for the retry budget, not attempt ${firstFallbackAttempt}`);
    assert.ok(
        scheduledRetries.every((count) => count >= 1),
        'each earlier attempt schedules another torrent attempt instead of falling back'
    );
});
