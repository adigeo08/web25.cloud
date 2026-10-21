/**
 * "Our conversation is open on my screen" — the one signal that decides
 * whether a saved contact's conversation tries a direct WebRTC link — and the
 * room mode of ChannelsService that keeps such a conversation on Nostr until
 * then, with the peer's identity pinned to the contact record.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NostrPresenceService, CONVERSATION } from '../src/channels/NostrPresenceService.js';
import ChannelsService, { DM_CONNECTION } from '../src/channels/ChannelsService.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const ROOM = 'room-0123456789abcdef0123456789abcdef';

function presence({ now = () => 1_000_000 } = {}) {
    const events = { mutual: [], closed: [] };
    const service = new NostrPresenceService({
        pool: { publish: async () => ({ accepted: ['x'] }), subscribe: () => ({ close() {} }) },
        signer: {},
        now,
        onConversationMutual: (peer, room) => events.mutual.push([peer, room]),
        onPeerConversationClosed: (peer, room) => events.closed.push([peer, room])
    });
    service.localNostrPublicKey = ALICE;
    const sent = [];
    const send = async (peer, kind, content) => {
        sent.push({ peer, kind, ...JSON.parse(content) });
    };
    return { service, events, sent, send };
}

test('opening alone sends one notice and starts nothing', async () => {
    const { service, events, sent, send } = presence();
    const mutual = await service.openConversation(BOB, ROOM, send);
    assert.equal(mutual, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, NOSTR_CONFIG.WEB25_CONVERSATION_KIND);
    assert.deepEqual([sent[0].type, sent[0].state, sent[0].room, sent[0].ack], ['web25-conversation', 'open', ROOM, false]);
    assert.deepEqual(events.mutual, []);
});

test('their opening while ours is open is answered once, and makes it mutual once', async () => {
    const { service, events, sent, send } = presence();
    await service.openConversation(BOB, ROOM, send);

    service.receiveConversation(BOB, { state: 'open', room: ROOM, ack: false, at: 1_000_000 }, send);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.mutual, [[BOB, ROOM]]);
    assert.equal(sent.filter((entry) => entry.ack === true).length, 1, 'whoever opened first hears back');

    // Their answer to ours is not answered again: no echo.
    service.receiveConversation(BOB, { state: 'open', room: ROOM, ack: true, at: 1_000_001 }, send);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.filter((entry) => entry.ack === true).length, 1);
    assert.equal(events.mutual.length, 1, 'one direct-link attempt per opening');
});

test('they opened first: our opening finds it mutual straight away', async () => {
    const { service, events, send } = presence();
    service.receiveConversation(BOB, { state: 'open', room: ROOM, ack: false, at: 1_000_000 }, send);
    assert.deepEqual(events.mutual, [], 'nothing is open here yet');
    assert.equal(await service.openConversation(BOB, ROOM, send), true);
    assert.deepEqual(events.mutual, [[BOB, ROOM]]);
});

test('an old opening from the inbox history is not somebody waiting now', async () => {
    let now = 10_000_000;
    const { service, events, send } = presence({ now: () => now });
    service.receiveConversation(
        BOB,
        { state: 'open', room: ROOM, ack: false, at: now - NOSTR_CONFIG.CONVERSATION_INTENT_MAX_AGE_MS - 1 },
        send
    );
    assert.equal(await service.openConversation(BOB, ROOM, send), false);
    assert.deepEqual(events.mutual, []);
    now += 1;
    assert.equal(service.peerHasConversationOpen(BOB, ROOM), false);
});

test('another room, or a closed one, is not open', async () => {
    const { service, events, send } = presence();
    await service.openConversation(BOB, ROOM, send);
    service.receiveConversation(BOB, { state: 'open', room: 'room-somewhere-else', at: 1_000_000 }, send);
    assert.deepEqual(events.mutual, []);

    service.receiveConversation(BOB, { state: 'open', room: ROOM, at: 1_000_000 }, send);
    assert.equal(events.mutual.length, 1);
    service.receiveConversation(BOB, { state: 'closed', room: ROOM, at: 1_000_000 }, send);
    assert.deepEqual(events.closed, [[BOB, ROOM]]);
    assert.equal(service.isConversationMutual(BOB), false);

    // Something older than what we know is ignored: relays do not keep order.
    service.receiveConversation(BOB, { state: 'open', room: ROOM, at: 999_999 }, send);
    assert.equal(service.isConversationMutual(BOB), false);

    // A later opening is a new chance.
    service.receiveConversation(BOB, { state: 'open', room: ROOM, at: 1_000_000 }, send);
    assert.equal(events.mutual.length, 2);
});

test('closing withdraws: the peer is told, and nothing is open here any more', async () => {
    const { service, sent, send } = presence();
    await service.openConversation(BOB, ROOM, send);
    assert.equal(await service.closeConversation(send), true);
    assert.equal(sent.at(-1).state, CONVERSATION.CLOSED);
    assert.equal(service.activeConversation, null);
    assert.equal(await service.closeConversation(send), false, 'closing twice says nothing twice');
});

test('a failed send on close is reported, not thrown', async () => {
    const errors = [];
    const service = new NostrPresenceService({ pool: {}, signer: {}, onError: (error) => errors.push(error.message) });
    await service.openConversation(BOB, ROOM, async () => {});
    await service.closeConversation(async () => {
        throw new Error('relay down');
    });
    assert.deepEqual(errors, ['relay down']);
});

// ─── ChannelsService room mode ───────────────────────────────────────────

const PEER_PRIV = `0x${'22'.repeat(32)}`;
const OTHER_PRIV = `0x${'33'.repeat(32)}`;
const LOCAL_PRIV = `0x${'11'.repeat(32)}`;
const peerKey = getPublicKeyFromPrivateKey(PEER_PRIV);
const otherKey = getPublicKeyFromPrivateKey(OTHER_PRIV);
const localKey = getPublicKeyFromPrivateKey(LOCAL_PRIV);
const PEER = { eciesPublicKey: peerKey, evmAddress: evmAddressFromPublicKey(peerKey) };
const OTHER = { publicKey: otherKey, evmAddress: evmAddressFromPublicKey(otherKey) };
const LOCAL = { address: evmAddressFromPublicKey(localKey) };

function roomService() {
    const created = [];
    globalThis.RTCPeerConnection = class {
        constructor() {
            created.push(this);
            this.iceGatheringState = 'complete';
        }
        createDataChannel() {
            return { readyState: 'connecting', close() {} };
        }
        async createOffer() {
            return { type: 'offer', sdp: 'o' };
        }
        async createAnswer() {
            return { type: 'answer', sdp: 'a' };
        }
        async setLocalDescription(description) {
            this.localDescription = description;
        }
        async setRemoteDescription() {}
        close() {
            this.closed = true;
        }
    };
    const service = new ChannelsService({
        signer: { getPublicKey: async () => localKey, signMessage: async () => 'sig', eciesDecrypt: async () => '{}' },
        nostrFallback: { send: async () => true }
    });
    return { service, created };
}

test.afterEach(() => {
    delete globalThis.RTCPeerConnection;
});

test('a contact room is usable over Nostr the moment it opens', async () => {
    const { service, created } = roomService();
    const states = [];
    service.onUpdate((event) => event.type === 'connection-state' && states.push(event.state));
    await service.openContactRoom(ROOM, PEER, LOCAL);
    assert.equal(service.persistentRoom, true);
    assert.equal(service.currentChannel, ROOM);
    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_NOSTR);
    assert.deepEqual(states, [DM_CONNECTION.CONNECTED_NOSTR]);
    assert.equal(service.canSend(), true);
    assert.equal(created.length, 0, 'no peer connection for a Nostr conversation');

    // Opening the same room again sets nothing up again.
    const again = await service.openContactRoom(ROOM, PEER, LOCAL);
    assert.equal(again.reopened, false);
    assert.deepEqual(states, [DM_CONNECTION.CONNECTED_NOSTR]);
});

test('a direct-link offer from any other key is refused before a peer connection exists', async () => {
    const { service, created } = roomService();
    await service.openContactRoom(ROOM, PEER, LOCAL);
    await assert.rejects(
        () => service.answerWebrtcOffer({ description: { type: 'offer', sdp: 'x' }, ...OTHER }, LOCAL),
        /does not match this conversation/
    );
    assert.equal(created.length, 0, 'no ICE gathered for it');
    assert.equal(service.peerPublicKey, PEER.eciesPublicKey, 'the room keeps its keys');
});

test('a direct-link answer cannot swap the room’s identity either', async () => {
    const { service } = roomService();
    await service.openContactRoom(ROOM, PEER, LOCAL);
    await service.startWebrtcOffer(LOCAL);
    await assert.rejects(
        () => service.applyRemoteAnswerPayload({ description: { type: 'answer', sdp: 'y' }, ...OTHER }),
        /does not match this conversation/
    );
    assert.equal(service.peerPublicKey, PEER.eciesPublicKey);
});

test('trying, failing or closing the direct link never takes the room off Nostr', async () => {
    const { service, created } = roomService();
    await service.openContactRoom(ROOM, PEER, LOCAL);
    const offer = await service.startWebrtcOffer(LOCAL);
    assert.equal(offer.description.type, 'offer');
    assert.equal(created.length, 1);
    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_NOSTR, 'still working while it tries');

    assert.equal(service.closeWebrtc('peer-closed'), true);
    assert.equal(created[0].closed, true);
    assert.equal(service.peerConnection, null);
    assert.equal(service.currentChannel, ROOM, 'the room stays open');
    assert.equal(service.connectionState, DM_CONNECTION.CONNECTED_NOSTR);

    await service.leaveChannel();
    assert.equal(service.persistentRoom, false);
    assert.equal(service.connectionState, DM_CONNECTION.IDLE);
});

test('a room needs a contact whose keys are one identity', async () => {
    const { service } = roomService();
    await assert.rejects(
        () => service.openContactRoom(ROOM, { eciesPublicKey: peerKey, evmAddress: OTHER.evmAddress }, LOCAL),
        /does not match claimed address/
    );
    assert.equal(service.currentChannel, '');
});
