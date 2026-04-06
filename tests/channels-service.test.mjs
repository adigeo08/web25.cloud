import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelsService from '../src/channels/ChannelsService.js';
import { encryptMessage, decryptMessage } from '../src/channels/crypto.js';

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

test('createHostOffer generates envelope {description,encryptionKey} with default Google STUN config', async () => {
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    const offerCode = await service.createHostOffer('Builders', { address: '0xabc' });
    const envelope = JSON.parse(offerCode);
    const decoded = JSON.parse(Buffer.from(envelope.description, 'base64').toString('utf8'));

    assert.equal(decoded.type, 'offer');
    assert.match(envelope.encryptionKey, /^[a-f0-9]{64}$/);
    assert.equal(service.currentChannel, 'builders');
    assert.equal(service.role, 'host');
    assert.match(service.sessionEncryptionKey, /^[a-f0-9]{64}$/);
    assert.equal(service.peerConnection.config.iceServers[0].urls, 'stun:stun.l.google.com:19302');
    assert.equal(events.some((event) => event.type === 'local-offer'), true);
    assert.equal(events.some((event) => event.type === 'connecting'), true);
});

test('createAnswerFromOffer decodes offer and returns answer code', async () => {
    const service = new ChannelsService();
    const offerCode = JSON.stringify({
        description: Buffer.from(JSON.stringify({ type: 'offer', sdp: 'abc' }), 'utf8').toString('base64'),
        encryptionKey: 'a'.repeat(64)
    });

    const answerCode = await service.createAnswerFromOffer('builders', offerCode, { address: '0xdef' });
    const envelope = JSON.parse(answerCode);
    const decoded = JSON.parse(Buffer.from(envelope.description, 'base64').toString('utf8'));

    assert.equal(decoded.type, 'answer');
    assert.equal(service.currentChannel, 'builders');
    assert.equal(service.role, 'guest');
    assert.equal(service.sessionEncryptionKey, 'a'.repeat(64));
    assert.equal(service.peerConnection.remoteDescription.type, 'offer');
});

test('applyAnswer validates host flow and sets remote description', async () => {
    const service = new ChannelsService();
    await service.createHostOffer('builders', { address: '0xabc' });
    const answerCode = JSON.stringify({
        description: Buffer.from(JSON.stringify({ type: 'answer', sdp: 'xyz' }), 'utf8').toString('base64'),
        encryptionKey: 'b'.repeat(64)
    });

    await service.applyAnswer(answerCode);
    assert.equal(service.peerConnection.remoteDescription.type, 'answer');
    assert.equal(service.sessionEncryptionKey, 'b'.repeat(64));
});

test('sendChatMessage requires open data channel', async () => {
    const service = new ChannelsService();
    await service.createHostOffer('builders', { address: '0xabc' });

    assert.throws(() => service.sendChatMessage('hello', { address: '0xabc' }), /Connection is not ready yet/);
});

test('open channel emits connected + local system message', async () => {
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.createHostOffer('builders', { address: '0xabc' });
    service.dataChannel.readyState = 'open';
    service.dataChannel.onopen?.();

    assert.equal(events.some((event) => event.type === 'connected'), true);
    assert.equal(events.some((event) => event.type === 'peer-count' && event.count === 1), true);
    assert.equal(
        events.some((event) => event.type === 'message' && event.message.text.includes('Connected to room')),
        true
    );
});

test('sendChatMessage emits local event and sends encrypted payload', async () => {
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.createHostOffer('builders', { address: '0xabc' });
    service.dataChannel.readyState = 'open';
    await service.sendChatMessage('salut', { address: '0xabc' });

    const lastSent = service.dataChannel.sent.at(-1);
    assert.match(lastSent, /^[a-f0-9]+:[a-f0-9]+$/, 'sent value should be ivHex:ctHex');
    const decrypted = JSON.parse(await decryptMessage(lastSent, service.sessionEncryptionKey));
    assert.equal(decrypted.type, 'chat');
    assert.equal(decrypted.text, 'salut');
    assert.equal(events.some((event) => event.type === 'message' && event.local === true), true);
});

test('handleInbound deduplicates repeated inbound messages', async () => {
    const service = new ChannelsService();
    await service.createHostOffer('builders', { address: '0xabc' });

    const events = [];
    service.onUpdate((event) => events.push(event));

    const payload = {
        type: 'chat',
        id: 'm1',
        text: 'hello',
        channel: 'builders',
        from: '0xremote',
        timestamp: new Date().toISOString()
    };
    service.handleInbound(payload, false);
    service.handleInbound(payload, false);

    assert.equal(events.filter((event) => event.type === 'message').length, 1);
});

test('leaveChannel resets room state and emits left', async () => {
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.createHostOffer('builders', { address: '0xabc' });
    await service.leaveChannel();

    assert.equal(service.peerConnection, null);
    assert.equal(service.dataChannel, null);
    assert.equal(service.currentChannel, '');
    assert.equal(service.currentPeerCount, 0);
    assert.equal(events.some((event) => event.type === 'left'), true);
});

test('encryptMessage / decryptMessage round-trip returns original string', async () => {
    const hexKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const original = 'Hello, encrypted world! 🔐';
    const encrypted = await encryptMessage(original, hexKey);
    assert.match(encrypted, /^[a-f0-9]+:[a-f0-9]+$/, 'encrypted format should be ivHex:ctHex');
    assert.notEqual(encrypted, original);
    const decrypted = await decryptMessage(encrypted, hexKey);
    assert.equal(decrypted, original);
});

test('transmit sends encrypted wire format, not plain JSON', async () => {
    const service = new ChannelsService();
    await service.createHostOffer('builders', { address: '0xabc' });
    service.dataChannel.readyState = 'open';

    const payload = { type: 'chat', id: 'test-1', text: 'secret', channel: 'builders', from: '0xabc', timestamp: new Date().toISOString() };
    await service.transmit(payload);

    const lastSent = service.dataChannel.sent.at(-1);
    assert.match(lastSent, /^[a-f0-9]+:[a-f0-9]+$/, 'sent value should be ivHex:ctHex');
    assert.throws(() => JSON.parse(lastSent), 'raw sent string should not be plain JSON');
    const decrypted = await decryptMessage(lastSent, service.sessionEncryptionKey);
    assert.deepEqual(JSON.parse(decrypted), payload);
});

test('onmessage decrypts incoming encrypted message and calls handleInbound', async () => {
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.createHostOffer('builders', { address: '0xabc' });
    service.dataChannel.readyState = 'open';

    const inboundPayload = {
        type: 'chat',
        id: 'inbound-1',
        text: 'hi from peer',
        channel: 'builders',
        from: '0xpeer',
        timestamp: new Date().toISOString()
    };
    const encrypted = await encryptMessage(JSON.stringify(inboundPayload), service.sessionEncryptionKey);

    await service.dataChannel.onmessage?.({ data: encrypted });

    // Allow microtasks to settle
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(events.some((e) => e.type === 'message' && e.message.text === 'hi from peer'), true);
});

test('sendFile emits file-send-start and transmits file-info + file-chunk messages', async () => {
    const service = new ChannelsService();
    await service.createHostOffer('builders', { address: '0xabc' });
    service.dataChannel.readyState = 'open';

    const events = [];
    service.onUpdate((event) => events.push(event));

    // Create a small mock File (32 bytes)
    const content = new Uint8Array(32).fill(0xab);
    const file = new File([content], 'test.bin', { type: 'application/octet-stream' });

    await service.sendFile(file, { address: '0xabc' });

    const sentPayloads = await Promise.all(
        service.dataChannel.sent.map(async (s) => {
            const plain = await decryptMessage(s, service.sessionEncryptionKey);
            return JSON.parse(plain);
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
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.createHostOffer('builders', { address: '0xabc' });

    // Mock URL.createObjectURL
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

        service.handleInbound({
            type: 'file-info',
            id: 'fi-1',
            channel: 'builders',
            from: '0xpeer',
            timestamp: new Date().toISOString(),
            fileId,
            fileName: 'hello.txt',
            fileSize: 4
        }, false);

        service.handleInbound({
            type: 'file-chunk',
            id: 'fc-1',
            channel: 'builders',
            from: '0xpeer',
            timestamp: new Date().toISOString(),
            fileId,
            chunkIndex: 0,
            chunk: b64
        }, false);

        assert.equal(events.some((e) => e.type === 'file-incoming' && e.fileId === fileId), true);
        assert.equal(events.some((e) => e.type === 'file-progress' && e.fileId === fileId), true);
        assert.equal(events.some((e) => e.type === 'file-ready' && e.fileId === fileId && e.fileName === 'hello.txt'), true);
    } finally {
        if (typeof URL !== 'undefined') {
            if (originalCreateObjectURL) {
                URL.createObjectURL = originalCreateObjectURL;
            } else {
                delete URL.createObjectURL;
            }
        }
    }
});
