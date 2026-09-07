import test from 'node:test';
import assert from 'node:assert/strict';
import { bencode } from '../src/torrent/BencodeCodec.js';

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
