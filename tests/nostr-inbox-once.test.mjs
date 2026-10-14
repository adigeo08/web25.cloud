/**
 * Every invitation is acted on once, in one session.
 *
 * Relays hand back stored events again and again: on every reconnect, on
 * every new subscription, on every page load (the inbox asks for days of
 * history). Before the inbox ledger, an old chat request from a trusted
 * contact, delivered again inside its thirty-minute window, made this browser
 * send a new request back and then a new offer; an old offer was answered all
 * over again. These pin the opposite: the relay below behaves like a real one
 * — it stores what is published and replays its history to every new
 * subscription and on demand — and each request or invitation reaches the app
 * exactly once, across reconnects and across reloads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { NostrDirectMessageSession } from '../src/channels/NostrDirectMessageSession.js';
import { InboxLedger, INBOX_DB_NAME, INBOX_STORE_NAME, LEDGER_RETENTION_MS } from '../src/channels/InboxLedger.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { _resetBootstrapReplayCache } from '../src/channels/DirectMessageBootstrapCore.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

const ALICE_PRIV = `0x${'11'.repeat(32)}`;
const BOB_PRIV = `0x${'22'.repeat(32)}`;
const OFFER_DESC = { type: 'offer', sdp: 'v=0\r\noffer-sdp' };

function makeWallet(privateKey) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        const response = await core.handle({ id: `${privateKey.slice(2, 6)}-${++counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    const publicKey = getPublicKeyFromPrivateKey(privateKey);
    return {
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
        nostrPublicKey: nostrCore.getNostrPublicKey(privateKey)
    };
}

/**
 * A relay that remembers: what is published is stored, a new subscription is
 * sent the stored history first, and `replay()` sends it all again — what a
 * reconnect does once the pool's own per-subscription memory has let go.
 */
class RememberingRelay {
    constructor() {
        this.stored = [];
        this.subscriptions = [];
    }

    async connect() {
        return { connected: 1, total: 1 };
    }

    _matches(subscription, event) {
        const recipient = event.tags.find((tag) => tag[0] === 'p')?.[1];
        return subscription.filters.some((filter) => filter['#p']?.includes(recipient));
    }

    async publish(event) {
        this.stored.push(event);
        for (const subscription of [...this.subscriptions]) {
            if (this._matches(subscription, event)) await subscription.onEvent(event, 'wss://remembering.relay');
        }
        return { accepted: ['wss://remembering.relay'], rejected: {}, attempted: 1 };
    }

    subscribe(filters, onEvent) {
        const subscription = { filters, onEvent };
        this.subscriptions.push(subscription);
        for (const event of this.stored)
            if (this._matches(subscription, event)) void onEvent(event, 'wss://remembering.relay');
        return {
            id: `remembering-${this.subscriptions.length}`,
            close: () => {
                this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription);
            }
        };
    }

    async replay() {
        for (const subscription of [...this.subscriptions]) {
            for (const event of this.stored) {
                if (this._matches(subscription, event)) await subscription.onEvent(event, 'wss://remembering.relay');
            }
        }
    }
}

async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Bob's inbox as a fresh page would open it: a new session and a new ledger. */
function bobPage(relay, bob, { now = Date.now } = {}) {
    const seen = { invitations: [], requests: [], errors: [] };
    const session = new NostrDirectMessageSession({
        pool: relay,
        signer: bob.signer,
        ledger: new InboxLedger({ now }),
        now,
        onInvitation: (bootstrap) => seen.invitations.push(bootstrap),
        onChatRequest: (sender, context) => seen.requests.push({ sender, context }),
        onError: (error) => seen.errors.push(error.message)
    });
    return { session, seen };
}

async function setup() {
    _resetBootstrapReplayCache();
    const fake = installFakeIndexedDb();
    const alice = makeWallet(ALICE_PRIV);
    const bob = makeWallet(BOB_PRIV);
    await Promise.all([alice.unlock(), bob.unlock()]);
    const relay = new RememberingRelay();
    const aliceSession = new NostrDirectMessageSession({
        pool: relay,
        signer: alice.signer,
        ledger: new InboxLedger()
    });
    await aliceSession.start({ localAddress: alice.address });
    return { fake, alice, bob, relay, aliceSession };
}

const requestTo = (session, bob) =>
    session.sendGiftWrapped(
        bob.nostrPublicKey,
        NOSTR_CONFIG.WEB25_CHAT_REQUEST_KIND,
        JSON.stringify({ type: 'web25-chat-request', at: Date.now() })
    );

const offerTo = (session, alice, bob) =>
    session.sendInvitation({
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.nostrPublicKey
    });

test('a request and an offer reach the app once, however often the relay repeats them', async () => {
    const { fake, alice, bob, relay, aliceSession } = await setup();
    try {
        const { session, seen } = bobPage(relay, bob);
        await session.start({ localAddress: bob.address });

        await requestTo(aliceSession, bob);
        await offerTo(aliceSession, alice, bob);
        await settle();
        assert.equal(seen.requests.length, 1);
        assert.equal(seen.invitations.length, 1);

        // Reconnects: the relay sends its history again, twice.
        await relay.replay();
        await relay.replay();
        await settle();

        assert.equal(seen.requests.length, 1, 'the request is not handled again');
        assert.equal(seen.invitations.length, 1, 'the offer is not handled again');
        assert.deepEqual(seen.errors, [], 'a repeat is not an error, just nothing to do');
    } finally {
        fake.restore();
    }
});

test('a lock and unlock — a new subscription with the whole history — handles nothing twice', async () => {
    const { fake, alice, bob, relay, aliceSession } = await setup();
    try {
        const { session, seen } = bobPage(relay, bob);
        await session.start({ localAddress: bob.address });
        await requestTo(aliceSession, bob);
        await offerTo(aliceSession, alice, bob);
        await settle();

        session.stop();
        await session.start({ localAddress: bob.address });
        await settle();

        assert.equal(seen.requests.length, 1);
        assert.equal(seen.invitations.length, 1);
    } finally {
        fake.restore();
    }
});

test('after a reload, what an earlier page handled is not handled again', async () => {
    const { fake, alice, bob, relay, aliceSession } = await setup();
    try {
        const first = bobPage(relay, bob);
        await first.session.start({ localAddress: bob.address });
        await requestTo(aliceSession, bob);
        await offerTo(aliceSession, alice, bob);
        await settle();
        assert.equal(first.seen.requests.length, 1);
        first.session.stop();

        // A reload: a new session, a new ledger, the in-memory replay cache
        // gone — only what the ledger stored survives.
        _resetBootstrapReplayCache();
        const second = bobPage(relay, bob);
        await second.session.start({ localAddress: bob.address });
        await settle();

        assert.deepEqual(second.seen.requests, [], 'the old request does not come back');
        assert.deepEqual(second.seen.invitations, [], 'the old offer is not answered again');

        // Something new still gets through.
        await requestTo(aliceSession, bob);
        await settle();
        assert.equal(second.seen.requests.length, 1);
    } finally {
        fake.restore();
    }
});

test('an offer made for an earlier session is neither answered nor shown', async () => {
    const { fake, alice, bob, relay, aliceSession } = await setup();
    try {
        // Alice offers; Bob's page opens its inbox ten minutes later — still
        // inside the offer's fifteen-minute life, but not the session it was for.
        await offerTo(aliceSession, alice, bob);
        const later = () => Date.now() + 10 * 60 * 1000;
        const { session, seen } = bobPage(relay, bob, { now: later });
        await session.start({ localAddress: bob.address });
        await settle();

        assert.deepEqual(seen.invitations, []);
        assert.ok(seen.errors.some((message) => /earlier session/.test(message)));
    } finally {
        fake.restore();
    }
});

test('an offer from just before the inbox opened — a reload mid-handshake — still counts', async () => {
    const { fake, alice, bob, relay, aliceSession } = await setup();
    try {
        await offerTo(aliceSession, alice, bob);
        const soon = () => Date.now() + 60 * 1000;
        const { session, seen } = bobPage(relay, bob, { now: soon });
        await session.start({ localAddress: bob.address });
        await settle();
        assert.equal(seen.invitations.length, 1);
    } finally {
        fake.restore();
    }
});

test('a request sent while this browser was away still arrives, once', async () => {
    const { fake, bob, relay, aliceSession } = await setup();
    try {
        // Requests are how a stranger reaches somebody who is offline, so the
        // session rule for offers does not apply to them.
        await requestTo(aliceSession, bob);
        const later = () => Date.now() + 10 * 60 * 1000;
        const { session, seen } = bobPage(relay, bob, { now: later });
        await session.start({ localAddress: bob.address });
        await settle();
        await relay.replay();
        await settle();
        assert.equal(seen.requests.length, 1);
    } finally {
        fake.restore();
    }
});

test('the ledger stores opaque hashes and forgets them once no relay can replay them', async () => {
    const fake = installFakeIndexedDb();
    try {
        const clock = { now: Date.now() };
        const ledger = new InboxLedger({ now: () => clock.now });
        await ledger.load('ab'.repeat(32));
        assert.equal(ledger.claim('wrap:event-id-123'), true);
        assert.equal(ledger.claim('wrap:event-id-123'), false);
        await settle();

        const rows = fake.rawRows(INBOX_DB_NAME, INBOX_STORE_NAME);
        assert.equal(rows.length, 1);
        assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'id']);
        assert.ok(!JSON.stringify(rows).includes('event-id-123'));
        assert.ok(!JSON.stringify(rows).includes('ab'.repeat(32)));

        // Another identity in the same browser has its own ledger.
        const other = new InboxLedger({ now: () => clock.now });
        await other.load('cd'.repeat(32));
        assert.equal(other.claim('wrap:event-id-123'), true);

        // Past the furthest replay, rows are deleted and the memory with them.
        clock.now += LEDGER_RETENTION_MS + 1000;
        const later = new InboxLedger({ now: () => clock.now });
        await later.load('ab'.repeat(32));
        assert.equal(later.has('wrap:event-id-123'), false);
        assert.equal(fake.rawRows(INBOX_DB_NAME, INBOX_STORE_NAME).length, 0);
    } finally {
        fake.restore();
    }
});

test('without IndexedDB the ledger still holds for the life of the page', async () => {
    const ledger = new InboxLedger({ persistent: false });
    await ledger.load('ab'.repeat(32));
    assert.equal(ledger.claim('rumor:x'), true);
    assert.equal(ledger.claim('rumor:x'), false);
});
