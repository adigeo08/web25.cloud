/**
 * Transport selection: WebRTC preferred, Nostr as fallback.
 *
 * The Web25 message layer is unchanged in both directions — serialize, sign,
 * ECIES-encrypt — and only the pipe carrying the ciphertext differs. These
 * tests pin that: which transport is chosen and when, that the fallback stays
 * encrypted and authenticated, and that a message delivered over both paths is
 * rendered once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import ChannelsService, { DM_TRANSPORT } from '../src/channels/ChannelsService.js';
import {
    eciesDecrypt,
    eciesEncrypt,
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

/** Fast timings so the fallback logic can be exercised without real waits. */
const FAST_TRANSPORT = { WEBRTC_CONNECT_TIMEOUT_MS: 40, WEBRTC_DISCONNECT_GRACE_MS: 40 };

function walletSigner(privateKey) {
    return {
        getPublicKey: async () => getPublicKeyFromPrivateKey(privateKey),
        signMessage: async (message) => signMessage(message, privateKey),
        eciesDecrypt: async (ciphertext) => eciesDecrypt(ciphertext, privateKey)
    };
}

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

    open() {
        this.readyState = 'open';
        this.onopen?.();
    }

    close() {
        this.readyState = 'closed';
        this.onclose?.();
    }
}

class MockRTCPeerConnection {
    constructor() {
        this.localDescription = null;
        this.remoteDescription = null;
        this.iceGatheringState = 'complete';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.ondatachannel = null;
        this.onconnectionstatechange = null;
        this.oniceconnectionstatechange = null;
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

    addEventListener() {}
    removeEventListener() {}

    close() {
        this.connectionState = 'closed';
    }

    /** Drive the ICE/connection state machine the way a browser would. */
    setState(state) {
        this.connectionState = state;
        this.iceConnectionState = state;
        this.onconnectionstatechange?.();
    }
}

const OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
test.beforeEach(() => {
    globalThis.RTCPeerConnection = MockRTCPeerConnection;
});
test.afterEach(() => {
    globalThis.RTCPeerConnection = OriginalRTCPeerConnection;
});

/** Records everything the relay path was asked to carry. */
function recordingFallback({ accept = true } = {}) {
    const sent = [];
    return {
        sent,
        send: async (wire) => {
            sent.push(wire);
            return accept;
        }
    };
}

async function hostService({ fallback = null } = {}) {
    const events = [];
    const service = new ChannelsService({
        signer: walletSigner(HOST_PRIV),
        nostrFallback: fallback,
        transportConfig: FAST_TRANSPORT
    });
    service.onUpdate((event) => events.push(event));
    await service.createHostOfferPayload('builders', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB;
    service.peerAddress = GUEST_ADDRESS;
    return { service, events };
}

const transportEvents = (events) => events.filter((event) => event.type === 'transport').map((event) => event.transport);

// ─── 1. WebRTC success keeps the conversation peer to peer ───────────────

test('an open DataChannel puts the conversation on the WebRTC transport', async () => {
    const fallback = recordingFallback();
    const { service, events } = await hostService({ fallback });

    assert.equal(service.transport, DM_TRANSPORT.CONNECTING);
    service.dataChannel.open();

    assert.equal(service.transport, DM_TRANSPORT.WEBRTC);
    assert.deepEqual(transportEvents(events), [DM_TRANSPORT.CONNECTING, DM_TRANSPORT.WEBRTC]);

    await service.sendChatMessage('over webrtc', { address: HOST_ADDRESS });
    assert.equal(service.dataChannel.sent.length, 1);
    assert.equal(fallback.sent.length, 0, 'the relay must not be used while WebRTC is up');
    await service.leaveChannel();
});

test('a transient disconnected state does not immediately fall back', async () => {
    const fallback = recordingFallback();
    const { service } = await hostService({ fallback });
    service.dataChannel.open();

    service.peerConnection.setState('disconnected');
    assert.equal(service.transport, DM_TRANSPORT.WEBRTC, 'a blip must not switch transports');

    // ...and a recovery inside the grace window keeps it on WebRTC.
    service.peerConnection.setState('connected');
    await new Promise((resolve) => setTimeout(resolve, FAST_TRANSPORT.WEBRTC_DISCONNECT_GRACE_MS + 20));
    assert.equal(service.transport, DM_TRANSPORT.WEBRTC);
    await service.leaveChannel();
});

// ─── 2. WebRTC failure hands over to the relay ───────────────────────────

test('a failed peer connection falls back to the Nostr transport', async () => {
    const fallback = recordingFallback();
    const { service, events } = await hostService({ fallback });

    service.peerConnection.setState('failed');
    assert.equal(service.transport, DM_TRANSPORT.NOSTR);
    assert.deepEqual(transportEvents(events), [DM_TRANSPORT.CONNECTING, DM_TRANSPORT.NOSTR]);

    await service.sendChatMessage('over nostr', { address: HOST_ADDRESS });
    assert.equal(fallback.sent.length, 1);
    await service.leaveChannel();
});

test('a WebRTC attempt that never connects falls back once its deadline passes', async () => {
    const fallback = recordingFallback();
    const { service } = await hostService({ fallback });

    assert.equal(service.transport, DM_TRANSPORT.CONNECTING);
    await new Promise((resolve) => setTimeout(resolve, FAST_TRANSPORT.WEBRTC_CONNECT_TIMEOUT_MS + 30));
    assert.equal(service.transport, DM_TRANSPORT.NOSTR);
    await service.leaveChannel();
});

test('a disconnected state that does not recover falls back after the grace period', async () => {
    const fallback = recordingFallback();
    const { service } = await hostService({ fallback });
    service.dataChannel.open();

    // The browser marks the channel `closing` as the connection degrades; the
    // grace period runs, nothing recovers, and only then does the relay take over.
    service.dataChannel.readyState = 'closing';
    service.peerConnection.setState('disconnected');
    assert.equal(service.transport, DM_TRANSPORT.WEBRTC, 'the grace period must not be skipped');

    await new Promise((resolve) => setTimeout(resolve, FAST_TRANSPORT.WEBRTC_DISCONNECT_GRACE_MS + 30));
    assert.equal(service.transport, DM_TRANSPORT.NOSTR);
    await service.leaveChannel();
});

test('without a relay fallback a failed connection simply reports disconnected', async () => {
    const { service } = await hostService();
    service.peerConnection.setState('failed');
    assert.equal(service.transport, DM_TRANSPORT.DISCONNECTED);
    assert.throws(() => service.sendChatMessage('nope', { address: HOST_ADDRESS }), /Connection is not ready yet/);
    await service.leaveChannel();
});

// ─── 3. WebRTC is preferred again as soon as it is available ─────────────

test('the conversation returns to WebRTC when the DataChannel comes back', async () => {
    const fallback = recordingFallback();
    const { service, events } = await hostService({ fallback });

    service.peerConnection.setState('failed');
    assert.equal(service.transport, DM_TRANSPORT.NOSTR);

    service.dataChannel.open();
    assert.equal(service.transport, DM_TRANSPORT.WEBRTC);
    assert.deepEqual(transportEvents(events), [DM_TRANSPORT.CONNECTING, DM_TRANSPORT.NOSTR, DM_TRANSPORT.WEBRTC]);

    await service.sendChatMessage('back on p2p', { address: HOST_ADDRESS });
    assert.equal(service.dataChannel.sent.length, 1);
    assert.equal(fallback.sent.length, 0);
    await service.leaveChannel();
});

// ─── 4. The fallback carries the unchanged Web25 envelope ────────────────

test('a fallback message is still signed and ECIES-encrypted for the peer', async () => {
    const fallback = recordingFallback();
    const { service } = await hostService({ fallback });
    service.peerConnection.setState('failed');

    await service.sendChatMessage('top secret', { address: HOST_ADDRESS });
    const [wire] = fallback.sent;

    assert.ok(!wire.includes('top secret'), 'the relay must never see plaintext');
    assert.match(wire, /^04[0-9a-f]+$/, 'the relay carries the same ECIES wire format as the DataChannel');

    // Only the intended recipient can open it, and the inner signature is the
    // sender's — the relay hop adds nothing and removes nothing.
    const envelope = JSON.parse(await eciesDecrypt(wire, GUEST_PRIV));
    assert.equal(await verifySignature(envelope.plaintext, envelope.signature, HOST_PUB), true);
    assert.equal(JSON.parse(envelope.plaintext).text, 'top secret');

    await assert.rejects(() => eciesDecrypt(wire, HOST_PRIV));
    await service.leaveChannel();
});

test('an inbound relay message goes through the same verification as WebRTC', async () => {
    const { service, events } = await hostService({ fallback: recordingFallback() });
    service.peerConnection.setState('failed');

    const payload = {
        type: 'chat',
        id: 'relay-1',
        text: 'hello from the relay',
        channel: 'builders',
        from: GUEST_ADDRESS,
        timestamp: new Date().toISOString()
    };
    const plaintext = JSON.stringify(payload);
    const wire = await eciesEncrypt(
        JSON.stringify({ plaintext, signature: await signMessage(plaintext, GUEST_PRIV) }),
        HOST_PUB
    );

    assert.equal(await service.receiveNostrEnvelope(wire), true);
    const message = events.find((event) => event.type === 'message');
    assert.equal(message.message.text, 'hello from the relay');
    assert.equal(message.source, DM_TRANSPORT.NOSTR);
    await service.leaveChannel();
});

test('a relay message signed by the wrong key is rejected', async () => {
    const { service, events } = await hostService({ fallback: recordingFallback() });
    service.peerConnection.setState('failed');

    const plaintext = JSON.stringify({
        type: 'chat',
        id: 'forged-1',
        text: 'not really from your peer',
        channel: 'builders',
        from: GUEST_ADDRESS,
        timestamp: new Date().toISOString()
    });
    const wire = await eciesEncrypt(
        JSON.stringify({ plaintext, signature: await signMessage(plaintext, HOST_PRIV) }),
        HOST_PUB
    );

    assert.equal(await service.receiveNostrEnvelope(wire), false);
    assert.equal(events.some((event) => event.type === 'message'), false);
    assert.equal(
        events.some((event) => event.type === 'error' && /signature verification failed/i.test(event.error.message)),
        true
    );
    await service.leaveChannel();
});

test('a relay message is refused while the wallet is locked', async () => {
    const events = [];
    const service = new ChannelsService({
        signer: {
            getPublicKey: async () => null,
            signMessage: async () => {
                throw new Error('Wallet is locked.');
            },
            eciesDecrypt: async () => {
                throw new Error('Wallet is locked.');
            }
        },
        nostrFallback: recordingFallback(),
        transportConfig: FAST_TRANSPORT
    });
    service.onUpdate((event) => events.push(event));
    service.currentChannel = 'builders';
    service.peerPublicKey = GUEST_PUB;
    service.peerAddress = GUEST_ADDRESS;

    assert.equal(await service.receiveNostrEnvelope('04'.padEnd(200, 'a')), false);
    assert.equal(
        events.some((event) => event.type === 'error' && /Wallet is locked/.test(event.error.message)),
        true
    );
});

// ─── 5. Duplicates across transports are rendered once ───────────────────

test('the same message arriving over WebRTC and over Nostr is rendered once', async () => {
    const { service, events } = await hostService({ fallback: recordingFallback() });
    service.dataChannel.open();

    const payload = {
        type: 'chat',
        id: 'stable-message-id',
        text: 'delivered twice',
        channel: 'builders',
        from: GUEST_ADDRESS,
        timestamp: new Date().toISOString()
    };
    const plaintext = JSON.stringify(payload);
    const envelope = JSON.stringify({ plaintext, signature: await signMessage(plaintext, GUEST_PRIV) });

    // Two independently encrypted copies: same logical message, different bytes.
    const viaWebrtc = await eciesEncrypt(envelope, HOST_PUB);
    const viaNostr = await eciesEncrypt(envelope, HOST_PUB);
    assert.notEqual(viaWebrtc, viaNostr);

    await service.handleEncryptedWire(viaWebrtc, DM_TRANSPORT.WEBRTC);
    await service.receiveNostrEnvelope(viaNostr);

    const rendered = events.filter((event) => event.type === 'message' && event.message.id === 'stable-message-id');
    assert.equal(rendered.length, 1, 'a duplicate delivery must not be rendered twice');
    assert.equal(rendered[0].source, DM_TRANSPORT.WEBRTC);
    await service.leaveChannel();
});

test('the same relayed message arriving from several relays is rendered once', async () => {
    const { service, events } = await hostService({ fallback: recordingFallback() });
    service.peerConnection.setState('failed');

    const payload = {
        type: 'chat',
        id: 'multi-relay-id',
        text: 'fanned out',
        channel: 'builders',
        from: GUEST_ADDRESS,
        timestamp: new Date().toISOString()
    };
    const plaintext = JSON.stringify(payload);
    const envelope = JSON.stringify({ plaintext, signature: await signMessage(plaintext, GUEST_PRIV) });
    const wire = await eciesEncrypt(envelope, HOST_PUB);

    await service.receiveNostrEnvelope(wire);
    await service.receiveNostrEnvelope(wire);
    await service.receiveNostrEnvelope(await eciesEncrypt(envelope, HOST_PUB));

    assert.equal(events.filter((event) => event.type === 'message').length, 1);
    await service.leaveChannel();
});

// ─── 6. Fallback failures are surfaced, never silently downgraded ────────

test('a fallback that no relay accepts reports an error rather than succeeding', async () => {
    const fallback = recordingFallback({ accept: false });
    const { service, events } = await hostService({ fallback });
    service.peerConnection.setState('failed');

    const sent = await service.sendChatMessage('will not land', { address: HOST_ADDRESS });
    assert.equal(sent, false);
    assert.equal(
        events.some((event) => event.type === 'error' && /No Nostr relay accepted/i.test(event.error.message)),
        true
    );
    await service.leaveChannel();
});

test('leaving the channel returns the transport to disconnected', async () => {
    const { service, events } = await hostService({ fallback: recordingFallback() });
    service.dataChannel.open();
    await service.leaveChannel();

    assert.equal(service.transport, DM_TRANSPORT.DISCONNECTED);
    assert.equal(transportEvents(events).at(-1), DM_TRANSPORT.DISCONNECTED);
});
