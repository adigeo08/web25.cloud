/**
 * End-to-end Direct Messenger over a simulated relay pool.
 *
 * Two `NostrDirectMessageSession` instances, two wallets and one in-memory
 * relay: A addresses B by `npub`, the gift-wrapped offer is published and
 * routed, B answers, and a chat message travels the relay fallback and comes
 * out the other side as a rendered Web25 message. Nothing here trusts the
 * relay — it is a dumb pipe that also gets to try misbehaving.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { eciesEncrypt, evmAddressFromPublicKey, getPublicKeyFromPrivateKey, signMessage } from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { NostrDirectMessageSession } from '../src/channels/NostrDirectMessageSession.js';
import { createNostrChatEvent } from '../src/channels/NostrDirectMessageBootstrap.js';
import { NostrRelayPool } from '../src/nostr/NostrRelayPool.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { _resetBootstrapReplayCache } from '../src/channels/DirectMessageBootstrapCore.js';

const ALICE_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BOB_PRIV = '0x2222222222222222222222222222222222222222222222222222222222222222';

const OFFER_DESC = { type: 'offer', sdp: 'v=0\r\noffer-sdp' };
const ANSWER_DESC = { type: 'answer', sdp: 'v=0\r\nanswer-sdp' };

function makeWallet(privateKey) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        counter += 1;
        const response = await core.handle({ id: `${privateKey.slice(2, 6)}-${counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };

    const publicKey = getPublicKeyFromPrivateKey(privateKey);
    return {
        core,
        signer: {
            getPublicKey: async () => (await call(WALLET_WORKER_OPS.GET_PUBLIC_KEY)).publicKey,
            signMessage: async (message) => (await call(WALLET_WORKER_OPS.ECIES_SIGN, { message })).signature,
            eciesDecrypt: async (ciphertext) => (await call(WALLET_WORKER_OPS.ECIES_DECRYPT, { ciphertext })).plaintext,
            getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY),
            nostrSignEvent: async (template) => (await call(WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, template)).event,
            nostrEncrypt: async (plaintext, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
            nostrDecrypt: async (payload, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
        },
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        publicKey,
        address: evmAddressFromPublicKey(publicKey),
        nostrPublicKey: nostrCore.getNostrPublicKey(privateKey),
        npub: npubEncode(nostrCore.getNostrPublicKey(privateKey))
    };
}

/**
 * A relay pool double: it stores published events and fans them out to every
 * subscription whose filter matches, exactly as several real relays would.
 */
class FakePool {
    constructor() {
        this.published = [];
        this.subscriptions = [];
        /** How many copies of each event to deliver, i.e. how many relays. */
        this.relayCount = 1;
    }

    async connect() {
        return { connected: 1, total: 1 };
    }

    async publish(event) {
        this.published.push(event);
        for (const subscription of this.subscriptions) {
            const recipient = event.tags.find((tag) => tag[0] === 'p')?.[1];
            if (subscription.filters.some((filter) => filter['#p']?.includes(recipient))) {
                for (let i = 0; i < this.relayCount; i++) {
                    if (subscription.seen.has(event.id)) continue;
                    subscription.seen.add(event.id);
                    await subscription.onEvent(event, 'wss://fake.relay');
                }
            }
        }
        return { accepted: ['wss://fake.relay'], rejected: {}, attempted: 1 };
    }

    subscribe(filters, onEvent) {
        const subscription = { filters, onEvent, seen: new Set(), closed: false };
        this.subscriptions.push(subscription);
        return {
            id: `fake-${this.subscriptions.length}`,
            close: () => {
                subscription.closed = true;
                this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription);
            }
        };
    }
}

/**
 * The inbox handler is deliberately fire-and-forget (a relay must never be
 * able to stall the pool), so tests wait for the unwrap chain to settle.
 */
async function settle() {
    for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function scenario() {
    _resetBootstrapReplayCache();
    const alice = makeWallet(ALICE_PRIV);
    const bob = makeWallet(BOB_PRIV);
    await Promise.all([alice.unlock(), bob.unlock()]);

    const pool = new FakePool();
    const inbox = { alice: [], bob: [] };
    const chat = { alice: [], bob: [] };
    const errors = { alice: [], bob: [] };

    const aliceSession = new NostrDirectMessageSession({
        pool,
        signer: alice.signer,
        onInvitation: (bootstrap, context) => inbox.alice.push({ bootstrap, context }),
        onChatEnvelope: (wire) => chat.alice.push(wire),
        onError: (error) => errors.alice.push(error)
    });
    const bobSession = new NostrDirectMessageSession({
        pool,
        signer: bob.signer,
        onInvitation: (bootstrap, context) => inbox.bob.push({ bootstrap, context }),
        onChatEnvelope: (wire) => chat.bob.push(wire),
        onError: (error) => errors.bob.push(error)
    });

    await aliceSession.start({ localAddress: alice.address });
    await bobSession.start({ localAddress: bob.address });

    return { alice, bob, pool, aliceSession, bobSession, inbox, chat, errors };
}

test('start() reports the local npub and subscribes to the gift-wrapped inbox', async () => {
    const { alice, aliceSession, pool } = await scenario();
    assert.equal(aliceSession.localNpub, alice.npub);
    assert.equal(pool.subscriptions.length, 2);
    assert.deepEqual(pool.subscriptions[0].filters[0]['#p'], [alice.nostrPublicKey]);
    aliceSession.stop();
});

test('an offer published by A is routed to B, validated, and answered', async () => {
    const { alice, bob, aliceSession, bobSession, inbox } = await scenario();

    await aliceSession.sendInvitation({
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });
    await settle();

    assert.equal(inbox.bob.length, 1);
    const offer = inbox.bob[0];
    assert.equal(offer.bootstrap.role, 'offer');
    assert.equal(offer.bootstrap.webrtc.description.sdp, OFFER_DESC.sdp);
    assert.equal(offer.context.senderNostrPublicKey, alice.nostrPublicKey);

    bobSession.setPeer(offer.context.senderNostrPublicKey);
    await bobSession.sendInvitation({
        identity: { address: bob.address },
        eciesPublicKey: bob.publicKey,
        role: 'answer',
        webrtcDescription: ANSWER_DESC,
        recipient: offer.context.senderNostrPublicKey,
        recipientEciesPublicKey: offer.bootstrap.from.eciesPublicKey,
        replyToSessionId: offer.bootstrap.session.sessionId
    });
    await settle();

    assert.equal(inbox.alice.length, 1);
    assert.equal(inbox.alice[0].bootstrap.role, 'answer');
    assert.equal(inbox.alice[0].bootstrap.session.replyToSessionId, offer.bootstrap.session.sessionId);

    aliceSession.stop();
    bobSession.stop();
});

test('an answer that replies to the wrong offer session is rejected', async () => {
    const { alice, bob, aliceSession, bobSession, inbox, errors } = await scenario();

    await aliceSession.sendInvitation({
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });
    await settle();
    const offer = inbox.bob[0];

    await bobSession.sendInvitation({
        identity: { address: bob.address },
        eciesPublicKey: bob.publicKey,
        role: 'answer',
        webrtcDescription: ANSWER_DESC,
        recipient: alice.nostrPublicKey,
        recipientEciesPublicKey: offer.bootstrap.from.eciesPublicKey,
        replyToSessionId: 'ffffffffffffffffffffffff'
    });
    await settle();

    assert.equal(inbox.alice.length, 0);
    assert.equal(errors.alice.length, 1);
    assert.match(errors.alice[0].message, /does not reference the expected offer session/i);

    aliceSession.stop();
    bobSession.stop();
});

test('the relay fallback carries an unmodified Web25 envelope to the peer', async () => {
    const { alice, bob, aliceSession, bobSession, chat } = await scenario();

    aliceSession.setPeer(bob.npub);
    bobSession.setPeer(alice.npub);

    const plaintext = JSON.stringify({ type: 'chat', id: 'x1', text: 'hi', channel: 'room-1', from: alice.address });
    const wire = await eciesEncrypt(
        JSON.stringify({ plaintext, signature: await signMessage(plaintext, ALICE_PRIV) }),
        bob.publicKey
    );

    const fallback = aliceSession.createFallback();
    assert.equal(await fallback.send(wire), true);
    await settle();

    assert.deepEqual(chat.bob, [wire], 'the peer receives exactly the ciphertext that was sent');
    assert.equal(chat.alice.length, 0);

    aliceSession.stop();
    bobSession.stop();
});

test('a chat envelope from anyone other than the bound peer is ignored', async () => {
    const { alice, bob, aliceSession, bobSession, chat } = await scenario();

    aliceSession.setPeer(bob.npub);
    // Bob has not bound Alice as his peer, so her relayed chat is dropped.
    const fallback = aliceSession.createFallback();
    await fallback.send(await eciesEncrypt(JSON.stringify({ plaintext: '{}', signature: '' }), bob.publicKey));
    await settle();

    assert.equal(chat.bob.length, 0);

    aliceSession.stop();
    bobSession.stop();
});

test('the same relayed envelope fanned out by three real relays is handed over once', async () => {
    _resetBootstrapReplayCache();
    const alice = makeWallet(ALICE_PRIV);
    const bob = makeWallet(BOB_PRIV);
    await Promise.all([alice.unlock(), bob.unlock()]);

    // A real relay pool this time, with three sockets that will each push the
    // very same gift wrap at us.
    const sockets = [];
    class MockSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
            queueMicrotask(() => {
                this.readyState = 1;
                this.onopen?.();
            });
        }
        send(frame) {
            this.sent.push(JSON.parse(frame));
        }
        close() {
            this.readyState = 3;
            this.onclose?.();
        }
        deliver(frame) {
            this.onmessage?.({ data: JSON.stringify(frame) });
        }
    }

    const pool = new NostrRelayPool({
        relays: ['wss://one.example', 'wss://two.example', 'wss://three.example'],
        verifyEvent: (event) => nostrCore.verifyEvent(event),
        WebSocketImpl: MockSocket,
        config: { ...NOSTR_CONFIG, RELAY_CONNECT_TIMEOUT_MS: 50, RELAY_PUBLISH_TIMEOUT_MS: 50 }
    });

    const chat = [];
    const bobSession = new NostrDirectMessageSession({
        pool,
        signer: bob.signer,
        onChatEnvelope: (wire) => chat.push(wire)
    });
    await bobSession.start({ localAddress: bob.address });
    bobSession.setPeer(alice.npub);

    const wire = await eciesEncrypt(JSON.stringify({ plaintext: '{}', signature: '' }), bob.publicKey);
    const { event } = await createNostrChatEvent({ signer: alice.signer, recipient: bob.npub, wire });

    const subscriptionId = sockets[0].sent.find((frame) => frame[0] === 'REQ')[1];
    for (const socket of sockets) socket.deliver(['EVENT', subscriptionId, event]);
    await settle();

    assert.equal(chat.length, 1, 'three relays delivering one event must surface it once');
    assert.deepEqual(chat, [wire]);

    bobSession.stop();
    pool.close();
});

test('stop() unsubscribes and clears the bound peer', async () => {
    const { alice, bob, pool, aliceSession, bobSession, inbox } = await scenario();
    aliceSession.setPeer(bob.npub);
    aliceSession.stop();

    assert.equal(aliceSession.peerNostrPublicKey, '');
    assert.equal(pool.subscriptions.length, 1);

    await bobSession.sendInvitation({
        identity: { address: bob.address },
        eciesPublicKey: bob.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: alice.npub
    });
    await settle();
    assert.equal(inbox.alice.length, 0, 'a stopped session receives nothing further');
    bobSession.stop();
});

test('a locked wallet cannot start a Nostr session', async () => {
    const alice = makeWallet(ALICE_PRIV);
    const session = new NostrDirectMessageSession({ pool: new FakePool(), signer: alice.signer });
    await assert.rejects(() => session.start({ localAddress: alice.address }), /unlock your wallet|locked/i);
});

test('concurrent start() calls share one connect and one subscription', async () => {
    _resetBootstrapReplayCache();
    const alice = makeWallet(ALICE_PRIV);
    await alice.unlock();

    const pool = new FakePool();
    let connects = 0;
    pool.connect = async () => {
        connects += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { connected: 1, total: 1 };
    };

    const session = new NostrDirectMessageSession({ pool, signer: alice.signer });
    await Promise.all([
        session.start({ localAddress: alice.address }),
        session.start({ localAddress: alice.address }),
        session.start({ localAddress: alice.address })
    ]);

    assert.equal(connects, 1);
    assert.equal(pool.subscriptions.length, 1);
    session.stop();
});

test('clearPeer() forgets the conversation but keeps the inbox subscribed', async () => {
    const { alice, bob, pool, aliceSession, bobSession, inbox } = await scenario();
    aliceSession.setPeer(bob.npub);
    aliceSession.clearPeer();

    assert.equal(aliceSession.peerNostrPublicKey, '');
    assert.equal(aliceSession.started, true);
    assert.equal(pool.subscriptions.length, 2);

    await bobSession.sendInvitation({
        identity: { address: bob.address },
        eciesPublicKey: bob.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: alice.npub
    });
    await settle();
    assert.equal(inbox.alice.length, 1, 'the user is still reachable at their npub');

    aliceSession.stop();
    bobSession.stop();
});
