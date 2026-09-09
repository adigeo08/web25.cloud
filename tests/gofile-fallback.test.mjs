import test from 'node:test';
import assert from 'node:assert/strict';
import { bencode } from '../src/torrent/BencodeCodec.js';
import { GoFileService } from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };
const loader = () => import('../src/core/torrent/TorrentLoader.js');

const HASH = '0123456789abcdef0123456789abcdef01234567';
const LOCATOR = '9632c967-30e5-4123-856a-8b2c425d1c74';

/** The Worker needs a credential, and a visitor mints a throwaway one. */
const guestAccount = async () => {
    const account = { tier: 'guest' };
    Object.defineProperty(account, 'token', { value: 'minted-for-this-read', enumerable: false });
    return account;
};

test('legacy terminal torrent failure never contacts GoFile', async () => {
    const { handleTerminalP2PFailure } = await loader();
    let contacted = false;
    const context = {
        gofileService: { createGuestAccount: guestAccount, downloadPublicMirror: async () => (contacted = true) },
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
            createGuestAccount: guestAccount,
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
        await handleTerminalP2PFailure.call(context, HASH, LOCATOR, new Error('retry exhausted'));
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
        gofileService: { createGuestAccount: guestAccount, downloadPublicMirror: async () => mirrorWire },
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
    await handleTerminalP2PFailure.call(context, hash, LOCATOR, new Error('retry exhausted'));
    assert.equal(chainChecks, 1);
    assert.equal(processed, 1);
});

test("the resolver asks for this deployment's own locator and mirror filename", async () => {
    const { handleTerminalP2PFailure } = await loader();
    const asked = [];
    const context = {
        gofileService: {
            createGuestAccount: guestAccount,
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
        await handleTerminalP2PFailure.call(context, HASH, LOCATOR, new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }
    assert.deepEqual(asked, [{ locator: LOCATOR, expectedFilename: gofileMirrorFilename(HASH) }]);
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
            downloadTimeoutMs: 25
        }),
        // A credential already in hand, so the stall under test is the mirror
        // download rather than the account mint that would precede it.
        gofileCredentialStore: { read: async () => ({ token: 'visitor-token' }) },
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
        await handleTerminalP2PFailure.call(context, HASH, LOCATOR, new Error('retry exhausted'));
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
        gofileService: { createGuestAccount: guestAccount, downloadPublicMirror: async () => mirrorWire },
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
        await handleTerminalP2PFailure.call(context, HASH, LOCATOR, new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }

    assert.equal(rendered, 0, 'verification runs before anything reaches the renderer');
    assert.equal(chainChecks, 0, 'the hash mismatch is caught before TorrentChain verification');
    assert.match(alerted, /info hash mismatch/i);
});

test('a visitor mints a throwaway credential for the read', async () => {
    const { handleTerminalP2PFailure } = await loader();
    const asked = [];
    const context = {
        gofileCredentialStore: { read: async () => ({ token: 'visitor-token' }) },
        gofileService: {
            createGuestAccount: guestAccount,
            downloadPublicMirror: async (locator, options) => {
                asked.push({ locator, token: options?.token ?? null, filename: options?.expectedFilename });
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
        await handleTerminalP2PFailure.call(context, HASH, LOCATOR, new Error('retry exhausted'));
    } finally {
        globalThis.alert = previousAlert;
    }
    // A stored credential is preferred when the wallet is open; this context
    // has one, so nothing is minted.
    assert.deepEqual(asked, [{ locator: LOCATOR, token: 'visitor-token', filename: gofileMirrorFilename(HASH) }]);
});

test('a locked wallet or empty store still resolves, by minting one', async () => {
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
                createGuestAccount: guestAccount,
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
            await handleTerminalP2PFailure.call(context, HASH, LOCATOR, new Error('retry exhausted'));
        } finally {
            globalThis.alert = previousAlert;
        }
        assert.deepEqual(
            asked,
            ['minted-for-this-read'],
            'a locked wallet is not an error: a throwaway credential is minted instead'
        );
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
            createGuestAccount: guestAccount,
            downloadPublicMirror: async () => {
                contacted.push('gofile');
                throw new Error('mirror offline');
            }
        },
        gofileCredentialStore: { read: async () => null }
    };
}

/** Drive one load attempt, reporting what it tried and what it scheduled. */
async function oneLoadAttempt(loadSite, handleTerminalP2PFailure, address, attempt) {
    const previousTimeout = globalThis.setTimeout;
    const contacted = [];
    const magnets = [];
    let scheduled = 0;
    globalThis.setTimeout = () => {
        scheduled += 1;
        return previousTimeout(() => {}, 0);
    };
    try {
        const context = loaderContext({
            contacted,
            handleTerminalP2PFailure,
            onAdd: (magnetURI) => {
                magnets.push(magnetURI);
                throw new Error('WebTorrent could not add the torrent');
            }
        });
        await loadSite.call(context, address, attempt);
    } finally {
        globalThis.setTimeout = previousTimeout;
    }
    return { contacted, magnets, scheduled };
}

test('WebTorrent is always tried first, tracker and all', async () => {
    const { loadSite, handleTerminalP2PFailure } = await loader();
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
        for (const address of [`${HASH}&${LOCATOR}`, HASH]) {
            const { magnets } = await oneLoadAttempt(loadSite, handleTerminalP2PFailure, address, 0);
            assert.equal(magnets.length, 1, 'the torrent transport is attempted before anything else');
            assert.match(magnets[0], /^magnet:\?xt=urn:btih:/);
            assert.match(magnets[0], /tr=wss%3A%2F%2Ftracker/, 'the WebRTC tracker is in the magnet');
        }
    } finally {
        globalThis.alert = previousAlert;
    }
});

test('a mirrored address falls back after one attempt, not after the full budget', async () => {
    // Each WebTorrent attempt costs 20-30s waiting for a tracker to report no
    // peers, and a mirrored address has something better to do with that time.
    const { loadSite, handleTerminalP2PFailure } = await loader();
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    try {
        const first = await oneLoadAttempt(loadSite, handleTerminalP2PFailure, `${HASH}&${LOCATOR}`, 0);
        assert.equal(first.contacted.length, 1, 'the mirror is reached on the very first failure');
        assert.equal(first.scheduled, 0, 'no further torrent attempt is scheduled');
    } finally {
        globalThis.alert = previousAlert;
    }
});

test('an address with no mirror keeps the whole retry budget', async () => {
    // Retries exist because there is nothing else to try. Cutting them here
    // would only make a hopeless load fail faster.
    const { loadSite, handleTerminalP2PFailure } = await loader();
    const previousAlert = globalThis.alert;
    globalThis.alert = () => {};
    let firstTerminalAttempt = null;
    try {
        for (let attempt = 0; attempt < 10 && firstTerminalAttempt === null; attempt += 1) {
            const { scheduled } = await oneLoadAttempt(loadSite, handleTerminalP2PFailure, HASH, attempt);
            if (scheduled === 0) firstTerminalAttempt = attempt;
        }
    } finally {
        globalThis.alert = previousAlert;
    }
    assert.ok(
        firstTerminalAttempt >= 5,
        `an unmirrored load kept retrying to attempt ${firstTerminalAttempt}, not one`
    );
});
