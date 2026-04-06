import test from 'node:test';
import assert from 'node:assert/strict';
import ChannelsService from '../src/channels/ChannelsService.js';

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

test('sendChatMessage emits local event and serializes outbound payload', async () => {
    const service = new ChannelsService();
    const events = [];
    service.onUpdate((event) => events.push(event));

    await service.createHostOffer('builders', { address: '0xabc' });
    service.dataChannel.readyState = 'open';
    service.sendChatMessage('salut', { address: '0xabc' });

    const lastSent = JSON.parse(service.dataChannel.sent.at(-1));
    assert.equal(lastSent.type, 'chat');
    assert.equal(lastSent.text, 'salut');
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
