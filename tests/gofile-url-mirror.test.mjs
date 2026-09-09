import test from 'node:test';
import assert from 'node:assert/strict';

import { bencode } from '../src/torrent/BencodeCodec.js';
import {
    createMirrorTorrentAdapter,
    decodeGoFileMirror,
    encodeGoFileMirror,
    verifyGoFileMirror
} from '../src/gofile/GoFileMirrorCodec.js';
import { formatWeb25Url, parseWeb25Address } from '../src/gofile/Web25Url.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('WEB25 address parser handles legacy, mirrored, debug, and full URL forms', () => {
    assert.deepEqual(parseWeb25Address(HASH), { torrentHash: HASH, gofileLocator: null });
    assert.deepEqual(parseWeb25Address(`${HASH}&AbCd1234`), { torrentHash: HASH, gofileLocator: 'AbCd1234' });
    assert.deepEqual(parseWeb25Address(`?orc=${HASH}&AbCd1234&debug=true`), {
        torrentHash: HASH,
        gofileLocator: 'AbCd1234'
    });
    assert.deepEqual(parseWeb25Address(`https://web25.cloud/?orc=${HASH}&AbCd1234`), {
        torrentHash: HASH,
        gofileLocator: 'AbCd1234'
    });
    assert.deepEqual(parseWeb25Address(`?orc=${HASH}&debug=true`), { torrentHash: HASH, gofileLocator: null });
});

test('WEB25 address parser reads orc= by name, not by position', () => {
    // A ?debug=true&orc=<hash> bookmark is a supported form: checkURL reads both
    // parameters, so the address must resolve whatever order they arrive in.
    assert.deepEqual(parseWeb25Address(`https://web25.cloud/?debug=true&orc=${HASH}`), {
        torrentHash: HASH,
        gofileLocator: null
    });
    assert.deepEqual(parseWeb25Address(`?debug=true&orc=${HASH}&AbCd1234`), {
        torrentHash: HASH,
        gofileLocator: 'AbCd1234'
    });
    assert.deepEqual(parseWeb25Address(`?utm_source=x&AbCd1234&orc=${HASH}`), {
        torrentHash: HASH,
        gofileLocator: 'AbCd1234'
    });
});

test('WEB25 address parser rejects malformed hashes and locators', () => {
    assert.throws(() => parseWeb25Address('deadbeef'), /40 hexadecimal/i);
    assert.throws(() => parseWeb25Address(`${HASH}&bad%2Flocator`), /locator/i);
    assert.throws(() => parseWeb25Address(`${HASH}&one&two`), /only one/i);
});

test('a WEB25 link carries a storage locator through unchanged', () => {
    // `<server>~<uuid>` is the shape the resolver needs; "~" is unreserved, so
    // it survives both directions without percent-encoding.
    const locator = 'store6~9632c967-30e5-4123-856a-8b2c425d1c74';
    assert.deepEqual(parseWeb25Address(`${HASH}&${locator}`), { torrentHash: HASH, gofileLocator: locator });
    assert.equal(
        formatWeb25Url({ torrentHash: HASH, gofileLocator: locator, origin: 'https://web25.cloud', pathname: '/' }),
        `https://web25.cloud/?orc=${HASH}&${locator}`
    );
    assert.deepEqual(parseWeb25Address(`https://web25.cloud/?orc=${HASH}&${locator}`), {
        torrentHash: HASH,
        gofileLocator: locator
    });
});

test('WEB25 URL formatter emits canonical legacy and mirrored links', () => {
    assert.equal(
        formatWeb25Url({ torrentHash: HASH, origin: 'https://web25.cloud', pathname: '/' }),
        `https://web25.cloud/?orc=${HASH}`
    );
    assert.equal(
        formatWeb25Url({ torrentHash: HASH, gofileLocator: 'AbCd1234', origin: 'https://web25.cloud', pathname: '/' }),
        `https://web25.cloud/?orc=${HASH}&AbCd1234`
    );
});

async function fixture() {
    const files = [
        { path: '.torrentchain', bytes: new TextEncoder().encode('{"signed":true}') },
        { path: 'site.bundle.json.gz', bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) }
    ];
    const payload = new Uint8Array(files.reduce((sum, file) => sum + file.bytes.length, 0));
    let offset = 0;
    for (const file of files) {
        payload.set(file.bytes, offset);
        offset += file.bytes.length;
    }
    const pieceLength = 8;
    const digests = [];
    for (let start = 0; start < payload.length; start += pieceLength) {
        digests.push(new Uint8Array(await crypto.subtle.digest('SHA-1', payload.slice(start, start + pieceLength))));
    }
    const pieces = new Uint8Array(digests.length * 20);
    digests.forEach((digest, index) => pieces.set(digest, index * 20));
    const info = {
        name: 'fixture',
        'piece length': pieceLength,
        pieces,
        files: files.map((file) => ({ length: file.bytes.length, path: [file.path] }))
    };
    const torrentFile = bencode({ announce: 'wss://tracker.example', info });
    const infoHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', bencode(info))), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('');
    const virtualFiles = files.map((file) => ({
        name: file.path,
        path: file.path,
        type: 'application/octet-stream',
        arrayBuffer: async () =>
            file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.length)
    }));
    return { files, virtualFiles, torrentFile, infoHash };
}

test('mirror codec preserves exact metainfo and payload and verifies torrent binding', async () => {
    const source = await fixture();
    const wire = await encodeGoFileMirror({ torrentFile: source.torrentFile, files: source.virtualFiles });
    const decoded = decodeGoFileMirror(wire);
    assert.deepEqual(decoded.torrentFile, source.torrentFile);
    assert.deepEqual(
        decoded.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );
    assert.deepEqual(decoded.files[0].bytes, source.files[0].bytes);
    const verified = await verifyGoFileMirror(decoded, source.infoHash);
    const adapter = createMirrorTorrentAdapter(verified);
    assert.deepEqual(
        adapter.files.map((file) => file.path),
        ['.torrentchain', 'site.bundle.json.gz']
    );
});

test('mirror rejects the wrong requested torrent and modified payload pieces', async () => {
    const source = await fixture();
    const decoded = decodeGoFileMirror(
        await encodeGoFileMirror({ torrentFile: source.torrentFile, files: source.virtualFiles })
    );
    await assert.rejects(() => verifyGoFileMirror(decoded, HASH), /info hash mismatch/i);
    decoded.files[1].bytes[0] ^= 0xff;
    await assert.rejects(() => verifyGoFileMirror(decoded, source.infoHash), /piece .*SHA-1/i);
});
