import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelsService from '../src/channels/ChannelsService.js';
import { eciesEncrypt, eciesDecrypt, signMessage, verifySignature, evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from '../src/channels/ecies.js';

// ─── Deterministic test keys ─────────────────────────────────────────────
const HOST_PRIV_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_PRIV_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const HOST_PUB_KEY = getPublicKeyFromPrivateKey(HOST_PRIV_KEY);
const GUEST_PUB_KEY = getPublicKeyFromPrivateKey(GUEST_PRIV_KEY);
const HOST_ADDRESS = evmAddressFromPublicKey(HOST_PUB_KEY);
const GUEST_ADDRESS = evmAddressFromPublicKey(GUEST_PUB_KEY);

class MockDataChannel {
    constructor() {
        this.readyState = 'connecting';
        this.sent = [];
        this.onopen = null;
        this.onclose = null;
        this.onmessage = null;
    }

    send(payload) {
        this.sent.push(payload);
    }

    close() {
        this.readyState = 'closed';
        this.onclose?.();
    }
}

class MockRTCPeerConnection {
    constructor(config) {
        this.config = config;
        this.localDescription = null;
        this.remoteDescription = null;
        this.iceGatheringState = 'complete';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.ondatachannel = null;
        this.onconnectionstatechange = null;
        this.oniceconnectionstatechange = null;
        this.listeners = new Map();
        this.channel = null;
    }

    createDataChannel() {
        this.channel = new MockDataChannel();
        return this.channel;
    }

    async createOffer() {
        return { type: 'offer', sdp: 'offer-sdp' };
    }

    async createAnswer() {
        return { type: 'answer', sdp: 'answer-sdp' };
    }

    async setLocalDescription(desc) {
        this.localDescription = desc;
    }

    async setRemoteDescription(desc) {
        this.remoteDescription = desc;
    }

    addEventListener(event, cb) {
        this.listeners.set(event, cb);
    }

    removeEventListener(event) {
        this.listeners.delete(event);
    }

    close() {
        this.connectionState = 'closed';
    }
}

const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;

test.beforeEach(() => {
    globalThis.RTCPeerConnection = MockRTCPeerConnection;
});

test.afterEach(() => {
    globalThis.RTCPeerConnection = OriginalRTCPeerConnection;
});

// ─── ecies.js unit tests ─────────────────────────────────────────────────

test('getPublicKeyFromPrivateKey returns a 130-char "04..." hex string', () => {
    assert.equal(HOST_PUB_KEY.length, 130);
    assert.equal(HOST_PUB_KEY.slice(0, 2), '04');
    assert.equal(GUEST_PUB_KEY.length, 130);
});

test('evmAddressFromPublicKey produces a valid 0x-prefixed EVM address', () => {
    assert.match(HOST_ADDRESS, /^0x[0-9a-f]{40}$/);
    assert.match(GUEST_ADDRESS, /^0x[0-9a-f]{40}$/);
    assert.notEqual(HOST_ADDRESS, GUEST_ADDRESS);
});

test('eciesEncrypt / eciesDecrypt round-trip restores original plaintext', async () => {
    const original = 'Hello, encrypted world! 🔐';
    const encrypted = await eciesEncrypt(original, GUEST_PUB_KEY);
    assert.ok(encrypted.length > 0);
    assert.notEqual(encrypted, original);
    const decrypted = await eciesDecrypt(encrypted, GUEST_PRIV_KEY);
    assert.equal(decrypted, original);
});

test('eciesDecrypt fails when a different private key is used', async () => {
    const encrypted = await eciesEncrypt('secret', GUEST_PUB_KEY);
    await assert.rejects(() => eciesDecrypt(encrypted, HOST_PRIV_KEY));
});

test('signMessage / verifySignature round-trip succeeds with correct key', async () => {
    const message = 'web25 signed message';
    const sig = await signMessage(message, HOST_PRIV_KEY);
    assert.equal(sig.length, 128); // 64 bytes compact = 128 hex chars
    const valid = await verifySignature(message, sig, HOST_PUB_KEY);
    assert.equal(valid, true);
});

test('verifySignature rejects tampered message', async () => {
    const message = 'original';
    const sig = await signMessage(message, HOST_PRIV_KEY);
    const valid = await verifySignature('tampered', sig, HOST_PUB_KEY);
    assert.equal(valid, false);
});

test('verifySignature rejects wrong public key', async () => {
    const message = 'test';
    const sig = await signMessage(message, HOST_PRIV_KEY);
    const valid = await verifySignature(message, sig, GUEST_PUB_KEY);
    assert.equal(valid, false);
});

// ─── ChannelsService — signaling protocol ────────────────────────────────

test('createHostOffer generates signal with {description, evmAddress, publicKey} and default STUN config', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    const offerCode = await service.createHostOffer('Builders', { address: HOST_ADDRESS });
    const envelope = JSON.parse(offerCode);

    assert.ok(envelope.description, 'description field present');
    const decoded = JSON.parse(Buffer.from(envelope.description, 'base64').toString('utf8'));
    assert.equal(decoded.type, 'offer');
    assert.equal(envelope.evmAddress, HOST_ADDRESS);
    assert.equal(envelope.publicKey, HOST_PUB_KEY);
    assert.equal(service.currentChannel, 'builders');
    assert.equal(service.role, 'host');
    assert.equal(service.peerConnection.config.iceServers[0].urls, 'stun:stun.l.google.com:19302');
    assert.equal(events.some((e) => e.type === 'local-offer'), true);
    assert.equal(events.some((e) => e.type === 'connecting'), true);
});

test('createAnswerFromOffer decodes offer, verifies host identity, stores peerPublicKey and emits verified message', async () => {
    const offerCode = JSON.stringify({
        description: Buffer.from(JSON.stringify({ type: 'offer', sdp: 'abc' }), 'utf8').toString('base64'),
        evmAddress: HOST_ADDRESS,
        publicKey: HOST_PUB_KEY
    });
    const service = new ChannelsService({ getPrivateKey: () => GUEST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    const answerCode = await service.createAnswerFromOffer('builders', offerCode, { address: GUEST_ADDRESS });
    const envelope = JSON.parse(answerCode);
    const decoded = JSON.parse(Buffer.from(envelope.description, 'base64').toString('utf8'));

    assert.equal(decoded.type, 'answer');
    assert.equal(service.currentChannel, 'builders');
    assert.equal(service.role, 'guest');
    assert.equal(service.peerPublicKey, HOST_PUB_KEY);
    assert.equal(service.peerAddress, HOST_ADDRESS);
    assert.equal(envelope.evmAddress, GUEST_ADDRESS);
    assert.equal(envelope.publicKey, GUEST_PUB_KEY);
    assert.equal(service.peerConnection.remoteDescription.type, 'offer');
    assert.equal(events.some((e) => e.type === 'message' && e.message.text.includes('🪪 Peer verified')), true);
});

test('createAnswerFromOffer rejects mismatched publicKey/evmAddress', async () => {
    const badOfferCode = JSON.stringify({
        description: Buffer.from(JSON.stringify({ type: 'offer', sdp: 'abc' }), 'utf8').toString('base64'),
        evmAddress: '0x0000000000000000000000000000000000000001',
        publicKey: HOST_PUB_KEY   // real key but wrong address
    });
    const service = new ChannelsService({ getPrivateKey: () => GUEST_PRIV_KEY });
    await assert.rejects(() => service.createAnswerFromOffer('builders', badOfferCode, { address: GUEST_ADDRESS }),
        /Peer identity verification failed/
    );
});

test('applyAnswer stores guest public key and emits verified message', async () => {
    const hostService = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    hostService.onUpdate((e) => events.push(e));

    await hostService.createHostOffer('builders', { address: HOST_ADDRESS });

    const answerCode = JSON.stringify({
        description: Buffer.from(JSON.stringify({ type: 'answer', sdp: 'xyz' }), 'utf8').toString('base64'),
        evmAddress: GUEST_ADDRESS,
        publicKey: GUEST_PUB_KEY
    });

    await hostService.applyAnswer(answerCode);
    assert.equal(hostService.peerConnection.remoteDescription.type, 'answer');
    assert.equal(hostService.peerPublicKey, GUEST_PUB_KEY);
    assert.equal(hostService.peerAddress, GUEST_ADDRESS);
    assert.equal(events.some((e) => e.type === 'message' && e.message.text.includes('🪪 Peer verified')), true);
});

test('applyAnswer rejects mismatched publicKey/evmAddress', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    await service.createHostOffer('builders', { address: HOST_ADDRESS });

    const badAnswerCode = JSON.stringify({
        description: Buffer.from(JSON.stringify({ type: 'answer', sdp: 'xyz' }), 'utf8').toString('base64'),
        evmAddress: '0x0000000000000000000000000000000000000002',
        publicKey: GUEST_PUB_KEY  // real key but wrong address
    });

    await assert.rejects(() => service.applyAnswer(badAnswerCode), /Peer identity verification failed/);
});

// ─── ChannelsService — messaging ─────────────────────────────────────────

test('sendChatMessage requires open data channel', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    assert.throws(() => service.sendChatMessage('hello', { address: HOST_ADDRESS }), /Connection is not ready yet/);
});

test('open channel emits connected + local system message', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.dataChannel.readyState = 'open';
    service.dataChannel.onopen?.();

    assert.equal(events.some((e) => e.type === 'connected'), true);
    assert.equal(events.some((e) => e.type === 'peer-count' && e.count === 1), true);
    assert.equal(events.some((e) => e.type === 'message' && e.message.text.includes('Connected to room')), true);
});

test('sendChatMessage emits local event and sends ECIES-encrypted payload', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB_KEY; // set AFTER createHostOffer to avoid leaveChannel reset
    service.dataChannel.readyState = 'open';
    await service.sendChatMessage('salut', { address: HOST_ADDRESS });

    const lastSent = service.dataChannel.sent.at(-1);
    assert.ok(lastSent, 'something was sent');
    // Should not be plain JSON (it's hex-encoded ECIES ciphertext)
    assert.throws(() => JSON.parse(lastSent), 'sent wire should not be plain JSON');
    // Should be decryptable by the intended recipient
    const envelope = await eciesDecrypt(lastSent, GUEST_PRIV_KEY);
    const { plaintext, signature } = JSON.parse(envelope);
    const payload = JSON.parse(plaintext);
    assert.equal(payload.type, 'chat');
    assert.equal(payload.text, 'salut');
    // Signature should verify against host's public key
    const valid = await verifySignature(plaintext, signature, HOST_PUB_KEY);
    assert.equal(valid, true);
    assert.equal(events.some((e) => e.type === 'message' && e.local === true), true);
});

test('transmit sends ECIES-encrypted + signed payload when peerPublicKey is set', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB_KEY; // set AFTER createHostOffer to avoid leaveChannel reset
    service.dataChannel.readyState = 'open';

    const payload = { type: 'chat', id: 'test-1', text: 'secret', channel: 'builders', from: HOST_ADDRESS, timestamp: new Date().toISOString() };
    await service.transmit(payload);

    const lastSent = service.dataChannel.sent.at(-1);
    const envelope = await eciesDecrypt(lastSent, GUEST_PRIV_KEY);
    const { plaintext, signature } = JSON.parse(envelope);
    assert.deepEqual(JSON.parse(plaintext), payload);
    assert.ok(signature, 'signature present');
    assert.equal(await verifySignature(plaintext, signature, HOST_PUB_KEY), true);
});

test('onmessage decrypts ECIES payload, verifies signature, and calls handleInbound', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB_KEY; // set AFTER createHostOffer to avoid leaveChannel reset
    service.dataChannel.readyState = 'open';

    const inboundPayload = {
        type: 'chat',
        id: 'inbound-1',
        text: 'hi from guest',
        channel: 'builders',
        from: GUEST_ADDRESS,
        timestamp: new Date().toISOString()
    };
    const plaintext = JSON.stringify(inboundPayload);
    const signature = await signMessage(plaintext, GUEST_PRIV_KEY);
    const envelope = JSON.stringify({ plaintext, signature });
    const encrypted = await eciesEncrypt(envelope, HOST_PUB_KEY);

    await service.dataChannel.onmessage?.({ data: encrypted });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(events.some((e) => e.type === 'message' && e.message.text === 'hi from guest'), true);
    assert.equal(events.some((e) => e.type === 'message' && e.local === false), true);
});

test('onmessage emits error event when signature verification fails', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB_KEY; // set AFTER createHostOffer to avoid leaveChannel reset
    service.dataChannel.readyState = 'open';

    const inboundPayload = { type: 'chat', id: 'tampered-1', text: 'bad', channel: 'builders', from: GUEST_ADDRESS, timestamp: new Date().toISOString() };
    const plaintext = JSON.stringify(inboundPayload);
    // Sign with WRONG key (host key instead of guest key)
    const signature = await signMessage(plaintext, HOST_PRIV_KEY);
    const envelope = JSON.stringify({ plaintext, signature });
    const encrypted = await eciesEncrypt(envelope, HOST_PUB_KEY);

    await service.dataChannel.onmessage?.({ data: encrypted });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(events.some((e) => e.type === 'error' && e.error?.message?.includes('signature')), true);
    assert.equal(events.some((e) => e.type === 'message'), false);
});

test('handleInbound deduplicates repeated inbound messages', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    await service.createHostOffer('builders', { address: HOST_ADDRESS });

    const events = [];
    service.onUpdate((e) => events.push(e));

    const payload = { type: 'chat', id: 'm1', text: 'hello', channel: 'builders', from: GUEST_ADDRESS, timestamp: new Date().toISOString() };
    service.handleInbound(payload, false);
    service.handleInbound(payload, false);

    assert.equal(events.filter((e) => e.type === 'message').length, 1);
});

test('leaveChannel resets room state including peerPublicKey and emits left', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB_KEY;
    service.peerAddress = GUEST_ADDRESS;
    await service.leaveChannel();

    assert.equal(service.peerConnection, null);
    assert.equal(service.dataChannel, null);
    assert.equal(service.currentChannel, '');
    assert.equal(service.currentPeerCount, 0);
    assert.equal(service.peerPublicKey, '');
    assert.equal(service.peerAddress, '');
    assert.equal(events.some((e) => e.type === 'left'), true);
});

test('sendFile emits file-send-start and transmits ECIES-encrypted file-info + file-chunk messages', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    await service.createHostOffer('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB_KEY; // set AFTER createHostOffer to avoid leaveChannel reset
    service.dataChannel.readyState = 'open';

    const events = [];
    service.onUpdate((e) => events.push(e));

    const content = new Uint8Array(32).fill(0xab);
    const file = new File([content], 'test.bin', { type: 'application/octet-stream' });

    await service.sendFile(file, { address: HOST_ADDRESS });

    const sentPayloads = await Promise.all(
        service.dataChannel.sent.map(async (s) => {
            const envelope = await eciesDecrypt(s, GUEST_PRIV_KEY);
            const { plaintext } = JSON.parse(envelope);
            return JSON.parse(plaintext);
        })
    );

    const infoMsg = sentPayloads.find((p) => p.type === 'file-info');
    const chunkMsgs = sentPayloads.filter((p) => p.type === 'file-chunk');

    assert.ok(infoMsg, 'file-info message should be transmitted');
    assert.equal(infoMsg.fileName, 'test.bin');
    assert.equal(infoMsg.fileSize, 32);
    assert.ok(chunkMsgs.length > 0, 'at least one file-chunk should be transmitted');
    assert.ok(chunkMsgs[0].chunk, 'chunk should have base64 data');

    assert.equal(events.some((e) => e.type === 'file-send-start'), true);
    assert.equal(events.some((e) => e.type === 'file-send-done'), true);
});

test('handleInbound reassembles file-info + file-chunk into file-ready event', async () => {
    const service = new ChannelsService({ getPrivateKey: () => HOST_PRIV_KEY });
    const events = [];
    service.onUpdate((e) => events.push(e));

    await service.createHostOffer('builders', { address: HOST_ADDRESS });

    const originalCreateObjectURL = globalThis.URL?.createObjectURL;
    if (typeof URL !== 'undefined') {
        URL.createObjectURL = () => 'blob:mock-url';
    } else {
        globalThis.URL = { createObjectURL: () => 'blob:mock-url' };
    }

    try {
        const content = new Uint8Array([1, 2, 3, 4]);
        const b64 = btoa(String.fromCharCode(...content));
        const fileId = 'test-file-id';

        service.handleInbound({ type: 'file-info', id: 'fi-1', channel: 'builders', from: GUEST_ADDRESS, timestamp: new Date().toISOString(), fileId, fileName: 'hello.txt', fileSize: 4 }, false);
        service.handleInbound({ type: 'file-chunk', id: 'fc-1', channel: 'builders', from: GUEST_ADDRESS, timestamp: new Date().toISOString(), fileId, chunkIndex: 0, chunk: b64 }, false);

        assert.equal(events.some((e) => e.type === 'file-incoming' && e.fileId === fileId), true);
        assert.equal(events.some((e) => e.type === 'file-progress' && e.fileId === fileId), true);
        assert.equal(events.some((e) => e.type === 'file-ready' && e.fileId === fileId && e.fileName === 'hello.txt'), true);
    } finally {
        if (typeof URL !== 'undefined') {
            if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
            else delete URL.createObjectURL;
        }
    }
});
