/**
 * Presence, mutual intent, and the single connection state.
 *
 * The behaviour these pin is the whole point of the change: seeing somebody
 * online is not permission to call them. Presence and conversation are separate
 * states, and no WebRTC handshake may begin until both sides have asked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NostrPresenceService, INTENT } from '../src/channels/NostrPresenceService.js';
import ChannelsService, { DM_CONNECTION, DM_TRANSPORT } from '../src/channels/ChannelsService.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { nostrCore } from '../src/nostr/nostr.js';
import {
    eciesDecrypt,
    evmAddressFromPublicKey,
    getPublicKeyFromPrivateKey,
    signMessage
} from '../src/channels/ecies.js';

const ALICE_PRIV = '1111111111111111111111111111111111111111111111111111111111111111';
const BOB_PRIV = '2222222222222222222222222222222222222222222222222222222222222222';
const ALICE = nostrCore.getNostrPublicKey(ALICE_PRIV);
const BOB = nostrCore.getNostrPublicKey(BOB_PRIV);

/** A pool double recording publishes and driving subscriptions. */
class FakePool {
    constructor() {
        this.published = [];
        this.subscriptions = [];
    }
    async connect() {
        return { connected: 1, total: 1 };
    }
    async publish(event) {
        this.published.push(event);
        return { accepted: ['wss://fake'], rejected: {}, attempted: 1 };
    }
    subscribe(filters, onEvent) {
        const sub = { filters, onEvent, closed: false };
        this.subscriptions.push(sub);
        return { id: `s${this.subscriptions.length}`, close: () => { sub.closed = true; } };
    }
    deliver(event) {
        for (const sub of this.subscriptions) if (!sub.closed) sub.onEvent(event, 'wss://fake');
    }
}

function signerFor(privateKey) {
    return {
        nostrSignEvent: async (template) => nostrCore.signEvent(template, privateKey)
    };
}

function presenceBeacon(privateKey, atMs = Date.now()) {
    const seconds = Math.floor(atMs / 1000);
    return nostrCore.signEvent(
        {
            kind: NOSTR_CONFIG.PRESENCE_KIND,
            created_at: seconds,
            tags: [['d', NOSTR_CONFIG.PRESENCE_IDENTIFIER], ['expiration', `${seconds + 180}`]],
            content: ''
        },
        privateKey
    );
}

function makeService({ now = Date.now, local = ALICE } = {}) {
    const pool = new FakePool();
    const events = { presence: [], intent: [], mutual: [] };
    const service = new NostrPresenceService({
        pool,
        signer: signerFor(ALICE_PRIV),
        now,
        onPresenceChange: (peer, online) => events.presence.push({ peer, online }),
        onIntentChange: (peer, state) => events.intent.push({ peer, state }),
        onMutualIntent: (peer) => events.mutual.push(peer)
    });
    service.localNostrPublicKey = local;
    return { pool, service, events };
}

// ─── 1. Presence is public, coarse, and says nothing about intent ────────

test('the presence beacon carries no content beyond being reachable', async () => {
    const { pool, service } = makeService();
    await service.start({ localNostrPublicKey: ALICE });

    const beacon = pool.published[0];
    assert.equal(beacon.kind, NOSTR_CONFIG.PRESENCE_KIND);
    assert.equal(beacon.content, '', 'presence must not leak a status message');
    assert.deepEqual(
        beacon.tags.find((tag) => tag[0] === 'd'),
        ['d', 'web25-dm'],
        'namespaced away from a general NIP-38 status'
    );
    assert.ok(beacon.tags.some((tag) => tag[0] === 'expiration'), 'beacons expire');
    service.stop();
});

test('a fresh beacon makes a watched peer online, a stale one does not', () => {
    let clock = 1_000_000_000_000;
    const { pool, service } = makeService({ now: () => clock });
    service.watch([BOB]);

    pool.deliver(presenceBeacon(BOB_PRIV, clock));
    assert.equal(service.isOnline(BOB), true);

    // Presence is a freshness question, so nobody has to announce going offline.
    clock += NOSTR_CONFIG.PRESENCE_TTL_MS + 1000;
    assert.equal(service.isOnline(BOB), false);
    service.stop();
});

test('presence from an unwatched peer is ignored', () => {
    const { pool, service } = makeService();
    service.watch([ALICE]);
    pool.deliver(presenceBeacon(BOB_PRIV));
    assert.equal(service.isOnline(BOB), false);
    service.stop();
});

// ─── 2. Online is not permission to connect ─────────────────────────────

test('seeing a peer online produces no intent and no handshake', () => {
    const { pool, service, events } = makeService();
    service.watch([BOB]);
    pool.deliver(presenceBeacon(BOB_PRIV));

    assert.equal(service.isOnline(BOB), true);
    assert.equal(service.intentState(BOB), INTENT.NONE, 'presence alone is not intent');
    assert.deepEqual(events.mutual, [], 'nothing may be initiated from presence');
    assert.equal(pool.published.length, 0, 'no invitation is published');
    service.stop();
});

test('one-sided intent waits: a request alone never becomes mutual', async () => {
    const { service, events } = makeService();
    const sent = [];

    const state = await service.sendChatRequest(BOB, async (peer, kind, content) => sent.push({ peer, kind, content }));

    assert.equal(state, INTENT.SENT);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, NOSTR_CONFIG.WEB25_CHAT_REQUEST_KIND);
    assert.deepEqual(events.mutual, [], 'a handshake needs both sides');

    // And the request carries no SDP or ICE data of any kind.
    assert.ok(!/sdp|candidate/i.test(sent[0].content));
    service.stop();
});

test('an inbound request alone does not start anything either', () => {
    const { service, events } = makeService();
    const state = service.receiveChatRequest(BOB);

    assert.equal(state, INTENT.RECEIVED);
    assert.deepEqual(events.mutual, [], 'the local user still has to select them');
    service.stop();
});

test('intent becomes mutual only when both sides have asked, and announces once', async () => {
    const { service, events } = makeService();

    await service.sendChatRequest(BOB, async () => {});
    assert.deepEqual(events.mutual, []);

    service.receiveChatRequest(BOB);
    assert.equal(service.intentState(BOB), INTENT.MUTUAL);
    assert.deepEqual(events.mutual, [BOB]);

    // Repeat signals must not start a second handshake.
    service.receiveChatRequest(BOB);
    assert.deepEqual(events.mutual, [BOB], 'mutual intent is announced exactly once');
    service.stop();
});

test('mutual intent works in either order', async () => {
    const { service, events } = makeService();
    service.receiveChatRequest(BOB);
    await service.sendChatRequest(BOB, async () => {});
    assert.deepEqual(events.mutual, [BOB]);
    service.stop();
});

test('a stale request no longer counts towards mutual intent', async () => {
    let clock = 1_000_000_000_000;
    const { service, events } = makeService({ now: () => clock });

    service.receiveChatRequest(BOB);
    clock += NOSTR_CONFIG.CHAT_REQUEST_TTL_MS + 1000;
    await service.sendChatRequest(BOB, async () => {});

    assert.equal(service.intentState(BOB), INTENT.SENT, 'their request expired');
    assert.deepEqual(events.mutual, []);
    service.stop();
});

test('leaving a conversation clears intent, so a later ping cannot reconnect it', async () => {
    const { service } = makeService();
    await service.sendChatRequest(BOB, async () => {});
    service.receiveChatRequest(BOB);
    assert.equal(service.intentState(BOB), INTENT.MUTUAL);

    service.clearIntent(BOB);
    assert.equal(service.intentState(BOB), INTENT.NONE);
    service.stop();
});

// ─── 3. Exactly one side offers ─────────────────────────────────────────

test('the initiator is chosen deterministically and the sides never agree', () => {
    const alice = makeService({ local: ALICE }).service;
    const bob = makeService({ local: BOB }).service;

    assert.notEqual(alice.shouldInitiate(BOB), bob.shouldInitiate(ALICE), 'exactly one side offers');
    assert.equal(alice.shouldInitiate(BOB), ALICE < BOB);
    alice.stop();
    bob.stop();
});

// ─── 4. One connection state, never two ─────────────────────────────────

class MockDataChannel {
    constructor() {
        this.readyState = 'connecting';
        this.sent = [];
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
        this.iceGatheringState = 'complete';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.localDescription = null;
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
    async setLocalDescription(d) {
        this.localDescription = d;
    }
    async setRemoteDescription() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
    setState(state) {
        this.connectionState = state;
        this.iceConnectionState = state;
        this.onconnectionstatechange?.();
    }
}

const HOST_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const GUEST_PUB = getPublicKeyFromPrivateKey('0x2222222222222222222222222222222222222222222222222222222222222222');
const HOST_PUB = getPublicKeyFromPrivateKey(HOST_PRIV);
const HOST_ADDRESS = evmAddressFromPublicKey(HOST_PUB);
const GUEST_ADDRESS = evmAddressFromPublicKey(GUEST_PUB);

const original = globalThis.RTCPeerConnection;
test.beforeEach(() => {
    globalThis.RTCPeerConnection = MockRTCPeerConnection;
});
test.afterEach(() => {
    globalThis.RTCPeerConnection = original;
});

async function chat({ fallback = null } = {}) {
    const states = [];
    const service = new ChannelsService({
        signer: {
            getPublicKey: async () => HOST_PUB,
            signMessage: async (m) => signMessage(m, HOST_PRIV),
            eciesDecrypt: async (c) => eciesDecrypt(c, HOST_PRIV)
        },
        nostrFallback: fallback,
        transportConfig: { WEBRTC_CONNECT_TIMEOUT_MS: 40, WEBRTC_DISCONNECT_GRACE_MS: 40 }
    });
    service.onUpdate((event) => {
        if (event.type === 'connection-state') states.push(event.state);
    });
    await service.createHostOfferPayload('room', { address: HOST_ADDRESS });
    service.peerPublicKey = GUEST_PUB;
    service.peerAddress = GUEST_ADDRESS;
    return { service, states };
}

test('the connection state walks handshake to connected, and lands green on WebRTC', async () => {
    const { service, states } = await chat({ fallback: { send: async () => true } });

    assert.equal(service.connectionState, DM_CONNECTION.CONNECTING_WEBRTC);
    service.dataChannel.open();

    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_WEBRTC);
    assert.deepEqual(states, [DM_CONNECTION.CONNECTING_WEBRTC, DM_CONNECTION.CONNECTED_WEBRTC]);
    await service.leaveChannel();
});

test('a WebRTC failure lands green on Nostr, not on a warning state', async () => {
    const { service, states } = await chat({ fallback: { send: async () => true } });
    service.peerConnection.setState('failed');

    // The conversation works; the transport is a detail of that success.
    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_NOSTR);
    assert.equal(states.at(-1), DM_CONNECTION.CONNECTED_NOSTR);
    await service.leaveChannel();
});

test('without a fallback a WebRTC failure is honestly disconnected', async () => {
    const { service } = await chat();
    service.peerConnection.setState('failed');
    assert.equal(service.connectionState, DM_CONNECTION.DISCONNECTED);
    await service.leaveChannel();
});

test('recovering to WebRTC returns to the WebRTC connected state', async () => {
    const { service } = await chat({ fallback: { send: async () => true } });
    service.peerConnection.setState('failed');
    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_NOSTR);

    service.dataChannel.open();
    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_WEBRTC);
    await service.leaveChannel();
});

test('pre-connection states are driven by the intent layer', async () => {
    const { service, states } = await chat({ fallback: { send: async () => true } });

    service.setPreConnectionState(DM_CONNECTION.AWAITING_PEER);
    assert.equal(service.connectionState, DM_CONNECTION.AWAITING_PEER);

    service.setPreConnectionState(DM_CONNECTION.HANDSHAKE);
    assert.equal(service.connectionState, DM_CONNECTION.HANDSHAKE);

    assert.ok(states.includes(DM_CONNECTION.AWAITING_PEER));
    assert.ok(states.includes(DM_CONNECTION.HANDSHAKE));
    await service.leaveChannel();
});

test('leaving returns to idle', async () => {
    const { service } = await chat({ fallback: { send: async () => true } });
    service.dataChannel.open();
    await service.leaveChannel();
    assert.equal(service.connectionState, DM_CONNECTION.IDLE);
});

test('every connection state maps to exactly one label, and both connected states are green', async () => {
    const { DM_CONNECTION_LABELS } = await import('../src/ui/channels/ChannelsPanel.js');

    for (const state of Object.values(DM_CONNECTION)) {
        assert.ok(DM_CONNECTION_LABELS[state], `no label for ${state}`);
    }
    assert.match(DM_CONNECTION_LABELS[DM_CONNECTION.CONNECTED_WEBRTC].className, /status-success/);
    assert.match(DM_CONNECTION_LABELS[DM_CONNECTION.CONNECTED_NOSTR].className, /status-success/);
    assert.equal(DM_CONNECTION_LABELS[DM_CONNECTION.CONNECTED_WEBRTC].text, 'Connected · WebRTC');
    assert.equal(DM_CONNECTION_LABELS[DM_CONNECTION.CONNECTED_NOSTR].text, 'Connected · Nostr');
});

test('the old competing transport indicator is gone', async () => {
    const panel = await import('../src/ui/channels/ChannelsPanel.js');
    assert.equal(panel.renderDmTransport, undefined, 'no second connection flag may remain');
    assert.equal(panel.renderChannelsStatus, undefined);
    assert.equal(typeof panel.renderDmConnectionState, 'function');
});
