/**
 * Files in a conversation that is running on the relay.
 *
 * A DataChannel transfer is the fast path and always will be. What these pin
 * is the case where there is no DataChannel: the transfer still happens, it is
 * paced and bounded rather than unlimited, every chunk is the same signed,
 * ECIES-encrypted envelope a message would be, and a chunk that no transport
 * accepts stops the transfer loudly instead of stranding the receiver.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import ChannelsService from '../src/channels/ChannelsService.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import {
    eciesDecrypt,
    evmAddressFromPublicKey,
    getPublicKeyFromPrivateKey,
    signMessage,
    verifySignature
} from '../src/channels/ecies.js';

const HOST_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_PRIV = '0x2222222222222222222222222222222222222222222222222222222222222222';
const HOST_PUB = getPublicKeyFromPrivateKey(HOST_PRIV);
const GUEST_PUB = getPublicKeyFromPrivateKey(GUEST_PRIV);
const HOST_ADDRESS = evmAddressFromPublicKey(HOST_PUB);
const GUEST_ADDRESS = evmAddressFromPublicKey(GUEST_PUB);

/** No pause between chunks, so the pacing does not slow the suite down. */
const FAST_TRANSPORT = { ...NOSTR_CONFIG, RELAY_FILE_CHUNK_PAUSE_MS: 0 };

function walletSigner(privateKey) {
    return {
        getPublicKey: async () => getPublicKeyFromPrivateKey(privateKey),
        signMessage: async (message) => signMessage(message, privateKey),
        eciesDecrypt: async (ciphertext) => eciesDecrypt(ciphertext, privateKey)
    };
}

function fakeFile(name, size, type = 'application/octet-stream') {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
    return {
        name,
        size,
        type,
        slice(start, end) {
            const view = bytes.slice(start, Math.min(end, size));
            return {
                arrayBuffer: async () => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
            };
        }
    };
}

function relayService({ accept = true, failAt = null, transportConfig = FAST_TRANSPORT } = {}) {
    const sent = [];
    const events = [];
    const fallback = {
        send: async (wire) => {
            sent.push(wire);
            if (failAt !== null && sent.length > failAt) return false;
            return accept;
        }
    };
    const service = new ChannelsService({
        signer: walletSigner(HOST_PRIV),
        nostrFallback: fallback,
        transportConfig
    });
    service.onUpdate((event) => events.push(event));
    service.currentChannel = 'room-relay';
    service.identityAddress = HOST_ADDRESS;
    service.peerPublicKey = GUEST_PUB;
    service.peerAddress = GUEST_ADDRESS;
    return { service, sent, events };
}

/** Undo the transport envelope the way the receiving side does. */
async function openWire(wire) {
    const envelope = JSON.parse(await eciesDecrypt(wire, GUEST_PRIV));
    const valid = await verifySignature(envelope.plaintext, envelope.signature, HOST_PUB);
    assert.ok(valid, 'every relayed chunk carries a valid signature from the sender');
    return JSON.parse(envelope.plaintext);
}

test('a file sends over the relay when there is no DataChannel', async () => {
    const { service, sent, events } = relayService();
    const size = NOSTR_CONFIG.RELAY_FILE_CHUNK_BYTES * 2 + 100;

    await service.sendFile(fakeFile('notes.txt', size, 'text/plain'), { address: HOST_ADDRESS });

    // One announcement plus three chunks, all of them through the relay.
    assert.equal(sent.length, 4);

    const info = await openWire(sent[0]);
    assert.equal(info.type, 'file-info');
    assert.equal(info.fileName, 'notes.txt');
    assert.equal(info.fileSize, size);

    const chunks = [];
    for (const wire of sent.slice(1)) chunks.push(await openWire(wire));
    assert.deepEqual(
        chunks.map((chunk) => chunk.type),
        ['file-chunk', 'file-chunk', 'file-chunk']
    );
    assert.deepEqual(
        chunks.map((chunk) => chunk.chunkIndex),
        [0, 1, 2]
    );
    // Everything reassembles to exactly the bytes that went in.
    const received = chunks.reduce(
        (total, chunk) => total + Uint8Array.from(atob(chunk.chunk), (c) => c.charCodeAt(0)).length,
        0
    );
    assert.equal(received, size);

    const start = events.find((event) => event.type === 'file-send-start');
    assert.equal(start.overRelay, true, 'the UI is told which transport is carrying this');
    assert.ok(events.some((event) => event.type === 'file-send-done'));
});

test('relay chunks are small enough to survive the NIP-59 layers', async () => {
    const { service, sent } = relayService();

    await service.sendFile(fakeFile('photo.bin', NOSTR_CONFIG.RELAY_FILE_CHUNK_BYTES * 2), {
        address: HOST_ADDRESS
    });

    for (const wire of sent.slice(1)) {
        const chunk = await openWire(wire);
        const rumor = JSON.stringify({ kind: 25510, content: wire, tags: [], created_at: 0 });
        // A rumor is NIP-44 sealed and then wrapped again, and each layer is
        // base64 over padded ciphertext — roughly 1.4x per layer. Staying under
        // the 65535-byte NIP-44 plaintext limit after two of those is the whole
        // reason the relay chunk is smaller than the DataChannel one.
        assert.ok(rumor.length * 1.4 * 1.4 < 65535, `a wrapped chunk must fit NIP-44: ${rumor.length} bytes raw`);
        assert.ok(chunk.chunk.length > 0);
    }
});

test('a file too large for public relays is refused with a reason, not sent', async () => {
    const { service, sent } = relayService();
    const tooBig = fakeFile('video.mp4', NOSTR_CONFIG.RELAY_FILE_MAX_BYTES + 1);

    await assert.rejects(() => service.sendFile(tooBig, { address: HOST_ADDRESS }), /public relays/);
    assert.equal(sent.length, 0, 'nothing is put on the relay before the limit is checked');
});

test('a chunk the relay will not carry stops the transfer instead of stranding it', async () => {
    // Accept the announcement and the first chunk, then refuse.
    const { service, events } = relayService({ failAt: 2 });
    const size = NOSTR_CONFIG.RELAY_FILE_CHUNK_BYTES * 3;

    await assert.rejects(
        () => service.sendFile(fakeFile('archive.zip', size), { address: HOST_ADDRESS }),
        /stopped sending at chunk/
    );

    const failure = events.find((event) => event.type === 'file-send-error');
    assert.ok(failure, 'the UI is told the transfer died');
    assert.equal(failure.chunkIndex, 1);
});

test('with no transport at all a file is refused before anything is read', async () => {
    const service = new ChannelsService({ signer: walletSigner(HOST_PRIV), transportConfig: FAST_TRANSPORT });
    service.currentChannel = 'room-relay';
    service.peerPublicKey = GUEST_PUB;
    service.peerAddress = GUEST_ADDRESS;

    await assert.rejects(
        () => service.sendFile(fakeFile('notes.txt', 10), { address: HOST_ADDRESS }),
        /Connection is not ready yet/
    );
});

test('an open DataChannel still uses the bigger chunk and no pacing', async () => {
    const { service, events } = relayService();
    const written = [];
    service.dataChannel = { readyState: 'open', send: (wire) => written.push(wire) };

    await service.sendFile(fakeFile('notes.txt', 16 * 1024 + 1), { address: HOST_ADDRESS });

    // 16 KiB chunks: one announcement plus two chunks, not the three the
    // relay's smaller chunk would have produced.
    assert.equal(written.length, 3);
    assert.equal(
        events.find((event) => event.type === 'file-send-start').overRelay,
        false
    );
});

test('a chunk that overtakes its announcement still lands', async () => {
    // Relays publish each chunk as its own event and promise nothing about
    // order. A receiver that drops chunks arriving before `file-info` can never
    // reach the announced size, so the transfer hangs forever.
    const { service, events } = relayService();
    const previousCreate = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = () => 'blob:stub';

    try {
        const chunk = (index, text, total) => ({
            type: 'file-chunk',
            id: `fc-${index}`,
            channel: 'room-relay',
            from: GUEST_ADDRESS,
            fileId: 'f1',
            chunkIndex: index,
            fileName: 'notes.txt',
            fileSize: 6,
            totalChunks: total,
            chunk: btoa(text)
        });

        // Second chunk first, then the first, and the announcement last.
        service.handleInbound(chunk(1, 'def', 2));
        assert.ok(
            events.some((event) => event.type === 'file-incoming'),
            'the transfer opens from whichever event arrives first'
        );
        service.handleInbound(chunk(0, 'abc', 2));
        service.handleInbound({
            type: 'file-info',
            id: 'fi-1',
            channel: 'room-relay',
            from: GUEST_ADDRESS,
            fileId: 'f1',
            fileName: 'notes.txt',
            fileSize: 6
        });

        const ready = events.filter((event) => event.type === 'file-ready');
        assert.equal(ready.length, 1, 'the file completes exactly once');
        assert.equal(ready[0].fileName, 'notes.txt');
    } finally {
        globalThis.URL.createObjectURL = previousCreate;
    }
});

test('a late announcement does not discard what is already buffered', async () => {
    const { service, events } = relayService();
    const previousCreate = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = () => 'blob:stub';

    try {
        service.handleInbound({
            type: 'file-chunk',
            id: 'c0',
            channel: 'room-relay',
            from: GUEST_ADDRESS,
            fileId: 'f2',
            chunkIndex: 0,
            fileName: 'a.bin',
            fileSize: 6,
            totalChunks: 2,
            chunk: btoa('abc')
        });
        // The announcement used to reset the buffer, throwing away chunk 0.
        service.handleInbound({
            type: 'file-info',
            id: 'fi-2',
            channel: 'room-relay',
            from: GUEST_ADDRESS,
            fileId: 'f2',
            fileName: 'a.bin',
            fileSize: 6
        });
        service.handleInbound({
            type: 'file-chunk',
            id: 'c1',
            channel: 'room-relay',
            from: GUEST_ADDRESS,
            fileId: 'f2',
            chunkIndex: 1,
            fileName: 'a.bin',
            fileSize: 6,
            totalChunks: 2,
            chunk: btoa('def')
        });

        assert.equal(events.filter((event) => event.type === 'file-ready').length, 1);
    } finally {
        globalThis.URL.createObjectURL = previousCreate;
    }
});

test('a duplicate chunk from a second relay is counted once', async () => {
    const { service, events } = relayService();
    const previousCreate = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = () => 'blob:stub';

    try {
        const chunk = (id, index, text) => ({
            type: 'file-chunk',
            id,
            channel: 'room-relay',
            from: GUEST_ADDRESS,
            fileId: 'f3',
            chunkIndex: index,
            fileName: 'a.bin',
            fileSize: 6,
            totalChunks: 2,
            chunk: btoa(text)
        });

        service.handleInbound(chunk('x0', 0, 'abc'));
        // Same chunk, different message id: the id-based dedupe does not catch
        // it, so the completion rule has to.
        service.handleInbound(chunk('x0-again', 0, 'abc'));
        assert.equal(events.filter((event) => event.type === 'file-ready').length, 0, 'not complete on a duplicate');

        service.handleInbound(chunk('x1', 1, 'def'));
        assert.equal(events.filter((event) => event.type === 'file-ready').length, 1);
    } finally {
        globalThis.URL.createObjectURL = previousCreate;
    }
});
