/**
 * Persistent rooms, Nostr-first messaging, and WebRTC only while both sides
 * have the conversation open.
 *
 * Everything below runs the shipped wiring: `setupChannels` from Lifecycle.js
 * builds the real ChannelsService, NostrDirectMessageSession, presence service,
 * contacts store, message archive and inbox ledger — handed a wallet-worker
 * signer and an in-memory relay instead of the browser's — and the tests drive
 * it the way the UI does. Wallets, NIP-44/NIP-59 and ECIES are real; the relay
 * is a dumb pipe that stores what it is given and replays it to every new
 * subscription, the way public relays do on a reload.
 *
 * The acceptance criteria, in order:
 *   1. the same persistent room on both sides, stable across reloads;
 *   2. saved contacts message each other over Nostr with no WebRTC at all;
 *   3. messages are routed by room and verified sender while another
 *      conversation is open;
 *   4. the right contact row is marked unread, and cleared once shown;
 *   5. held messages and unread state survive a reload;
 *   6. WebRTC starts only when both have the same conversation open;
 *   7. closing or switching stops WebRTC without stopping Nostr;
 *   8. duplicates are neither rendered nor stored twice;
 *   9. unknown and blocked senders keep their restrictions.
 * (10, the New connection sheet, is in tests/chat-new-connection.test.mjs.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' }
};
const STUB_DOCUMENT = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
};
globalThis.document = globalThis.document || STUB_DOCUMENT;

const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import ChannelsService from '../src/channels/ChannelsService.js';
import { NostrDirectMessageSession } from '../src/channels/NostrDirectMessageSession.js';
import { conversationRoomId, isConversationRoom } from '../src/channels/ConversationRoom.js';
import { MessageArchive, MAX_RETENTION_MS } from '../src/channels/MessageArchive.js';
import { TRUST } from '../src/channels/ContactsStore.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import { _resetBootstrapReplayCache } from '../src/channels/DirectMessageBootstrapCore.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import { installFakeDom } from './helpers/fake-dom.mjs';

const KEYS = {
    alice: '0x1111111111111111111111111111111111111111111111111111111111111111',
    bob: '0x2222222222222222222222222222222222222222222222222222222222222222',
    carol: '0x3333333333333333333333333333333333333333333333333333333333333333',
    mallory: '0x4444444444444444444444444444444444444444444444444444444444444444'
};

function makeWallet(privateKey) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        counter += 1;
        const response = await core.handle({ id: `${privateKey.slice(2, 6)}-${counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    const eciesPublicKey = getPublicKeyFromPrivateKey(privateKey).toLowerCase();
    const nostrPublicKey = nostrCore.getNostrPublicKey(privateKey.slice(2));
    return {
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        signer: {
            getPublicKey: async () => (await call(WALLET_WORKER_OPS.GET_PUBLIC_KEY)).publicKey,
            signMessage: async (message) => (await call(WALLET_WORKER_OPS.ECIES_SIGN, { message })).signature,
            eciesDecrypt: async (ciphertext) => (await call(WALLET_WORKER_OPS.ECIES_DECRYPT, { ciphertext })).plaintext,
            getNostrIdentity: async () => {
                try {
                    return await call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY);
                } catch (_) {
                    return null;
                }
            },
            nostrSignEvent: async (template) => (await call(WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, template)).event,
            nostrEncrypt: async (plaintext, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
            nostrDecrypt: async (payload, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
        },
        eciesPublicKey,
        address: evmAddressFromPublicKey(eciesPublicKey),
        nostrPublicKey,
        npub: npubEncode(nostrPublicKey)
    };
}

/** The tuple a contact record holds for this wallet. */
function contactOf(wallet, name) {
    return {
        nostrPublicKey: wallet.nostrPublicKey,
        npub: wallet.npub,
        eciesPublicKey: wallet.eciesPublicKey,
        evmAddress: wallet.address.toLowerCase(),
        name,
        trust: TRUST.TRUSTED
    };
}

/**
 * A relay that keeps everything and replays it to each new subscription, and
 * fans each new event out to the live ones.
 */
class MemoryRelay {
    constructor() {
        this.stored = [];
        this.subscriptions = [];
    }

    async connect() {
        return { connected: 1, total: 1 };
    }

    _matches(filters, event) {
        return filters.some((filter) => {
            if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
            if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
            for (const [key, values] of Object.entries(filter)) {
                if (!key.startsWith('#')) continue;
                const tag = key.slice(1);
                if (!event.tags.some((entry) => entry[0] === tag && values.includes(entry[1]))) return false;
            }
            return true;
        });
    }

    async publish(event) {
        this.stored.push(event);
        for (const subscription of [...this.subscriptions]) {
            if (this._matches(subscription.filters, event)) await subscription.onEvent(event, 'wss://memory.relay');
        }
        return { accepted: ['wss://memory.relay'], rejected: {}, attempted: 1 };
    }

    subscribe(filters, onEvent) {
        const subscription = { filters, onEvent, closed: false };
        this.subscriptions.push(subscription);
        for (const event of [...this.stored]) {
            if (this._matches(filters, event)) void onEvent(event, 'wss://memory.relay');
        }
        return {
            id: `memory-${this.subscriptions.length}`,
            close: () => {
                subscription.closed = true;
                this.subscriptions = this.subscriptions.filter((entry) => entry !== subscription);
            }
        };
    }

    /** Deliver everything stored again, as a reconnecting relay would. */
    async replay() {
        for (const subscription of [...this.subscriptions]) {
            for (const event of [...this.stored]) {
                if (this._matches(subscription.filters, event)) await subscription.onEvent(event, 'wss://memory.relay');
            }
        }
    }

    giftWrapsTo(nostrPublicKey) {
        return this.stored.filter((event) => event.kind === 1059 && event.tags.some((t) => t[1] === nostrPublicKey));
    }
}

/**
 * Two fake peer connections that meet when the offerer applies the answer:
 * DataChannels open on both sides, and closing either end closes the other.
 */
const rtc = {
    created: [],
    bySdp: new Map(),
    sequence: 0,
    install() {
        this.created = [];
        this.bySdp = new Map();
        globalThis.RTCPeerConnection = FakePeerConnection;
    },
    uninstall() {
        delete globalThis.RTCPeerConnection;
    },
    open() {
        return this.created.filter((pc) => !pc.closed);
    }
};

class FakeDataChannel {
    constructor(label) {
        this.label = label;
        this.readyState = 'connecting';
        this.remote = null;
        this.sent = [];
    }

    _open() {
        if (this.readyState !== 'connecting') return;
        this.readyState = 'open';
        this.onopen?.();
    }

    send(data) {
        if (this.readyState !== 'open') throw new Error('DataChannel is not open.');
        this.sent.push(data);
        const remote = this.remote;
        setTimeout(() => {
            if (remote?.readyState === 'open') remote.onmessage?.({ data });
        }, 0);
    }

    close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.onclose?.();
        this.remote?.close();
    }
}

class FakePeerConnection {
    constructor() {
        this.iceGatheringState = 'complete';
        this.connectionState = 'new';
        this.channels = [];
        this.closed = false;
        this.partner = null;
        rtc.created.push(this);
    }

    createDataChannel(label) {
        const channel = new FakeDataChannel(label);
        this.channels.push(channel);
        return channel;
    }

    async createOffer() {
        rtc.sequence += 1;
        return { type: 'offer', sdp: `fake-offer-${rtc.sequence}` };
    }

    async createAnswer() {
        rtc.sequence += 1;
        return { type: 'answer', sdp: `fake-answer-${rtc.sequence}` };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
        rtc.bySdp.set(description.sdp, this);
    }

    async setRemoteDescription(description) {
        this.remoteDescription = description;
        const other = rtc.bySdp.get(description.sdp);
        if (!other) return;
        this.partner = other;
        other.partner = this;
        if (description.type === 'answer') setTimeout(() => this._connect(), 0);
    }

    _connect() {
        const guest = this.partner;
        if (this.closed || !guest || guest.closed) return;
        for (const channel of this.channels) {
            const remote = new FakeDataChannel(channel.label);
            channel.remote = remote;
            remote.remote = channel;
            guest.channels.push(remote);
            guest.ondatachannel?.({ channel: remote });
        }
        for (const pc of [this, guest]) {
            pc.connectionState = 'connected';
            pc.onconnectionstatechange?.();
        }
        for (const channel of this.channels) {
            channel._open();
            channel.remote._open();
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.connectionState = 'closed';
        for (const channel of this.channels) channel.close();
    }

    addEventListener() {}
    removeEventListener() {}
}

/** Wait for the asynchronous unwrap → verify → store chains to finish. */
async function until(check, label = 'condition', timeoutMs = 4000) {
    const started = Date.now();
    for (;;) {
        if (await check()) return;
        if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

async function settle(rounds = 40) {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * One browser: the real Lifecycle wiring, on a test wallet and the memory relay.
 *
 * @param {ReturnType<typeof makeWallet>} wallet
 * @param {MemoryRelay} relay
 */
function makeApp(wallet, relay) {
    const toasts = [];
    const logs = [];
    const app = {
        authController: { getActiveIdentity: () => ({ address: wallet.address, chainId: 1 }) },
        toast: {
            info: (m) => toasts.push(['info', m]),
            success: (m) => toasts.push(['success', m]),
            warning: (m) => toasts.push(['warning', m]),
            error: (m) => toasts.push(['error', m])
        },
        log: (m) => logs.push(m),
        toasts,
        logs,
        wallet
    };
    for (const [name, value] of Object.entries(lifecycle)) {
        if (typeof value === 'function') app[name] = value.bind(app);
    }
    app.setupChannels({ signer: wallet.signer, pool: relay });
    // Profile lookups wait out their timeout on a relay with no profiles.
    app.nostrPool = {
        subscribe() {
            throw new Error('No profiles on the memory relay.');
        }
    };

    // What the thread was handed live, and what this side published.
    app.thread = [];
    app.channelsService.onUpdate((event) => {
        if (event.type === 'message' && event.message?.from !== 'system') {
            app.thread.push({ text: event.message.text, local: event.local === true, source: event.source || '' });
        }
    });
    app.invitationsSent = [];
    const sendInvitation = app.nostrDmSession.sendInvitation.bind(app.nostrDmSession);
    app.nostrDmSession.sendInvitation = async (params) => {
        app.invitationsSent.push(params.role);
        return sendInvitation(params);
    };
    app.chatRequestsSent = [];
    const sendChatRequest = app.presenceService.sendChatRequest.bind(app.presenceService);
    app.presenceService.sendChatRequest = async (peer, send) => {
        app.chatRequestsSent.push(peer);
        return sendChatRequest(peer, send);
    };
    return app;
}

/** Unlock-time start-up, as setupAuthAwareUi does it. */
async function start(app) {
    await app.nostrDmSession.start({ localAddress: app.wallet.address });
    await app.presenceService.start({ localNostrPublicKey: app.wallet.nostrPublicKey });
    await app.refreshContactList();
    return app;
}

function stop(app) {
    app.nostrDmSession.stop();
    app.presenceService.stop();
    clearInterval(app._dmPurgeTimer);
}

async function befriend(app, ...wallets) {
    for (const [wallet, name] of wallets) await app.contactsStore.save(contactOf(wallet, name));
    await app.refreshContactList();
}

async function send(app, text) {
    await app.channelsService.sendChatMessage(text, app.authController.getActiveIdentity());
}

/**
 * A bare sender — ChannelsService and a Nostr session, no Lifecycle — for
 * messages crafted outside the app: someone else's room, a re-wrapped copy.
 */
async function rawSender(wallet, relay, recipient, { room } = {}) {
    const session = new NostrDirectMessageSession({ pool: relay, signer: wallet.signer });
    await session.start({ localAddress: wallet.address });
    session.setPeer(recipient.nostrPublicKey);
    const channels = new ChannelsService({ signer: wallet.signer, nostrFallback: session.createFallback() });
    await channels.openContactRoom(
        room || conversationRoomId(wallet.nostrPublicKey, recipient.nostrPublicKey),
        { eciesPublicKey: recipient.eciesPublicKey, evmAddress: recipient.address },
        { address: wallet.address }
    );
    return {
        session,
        channels,
        send: (text) => channels.sendChatMessage(text, { address: wallet.address }),
        stop: () => session.stop()
    };
}

/**
 * The Web25 wire inside a gift wrap, opened by its recipient on the side — so
 * a test can send the very same message again under a new wrap.
 */
function wireInside(recipient, giftWrap) {
    return new Promise((resolve) => {
        const probe = new NostrDirectMessageSession({
            pool: { connect: async () => ({}), subscribe: () => ({ close() {} }) },
            signer: recipient.signer,
            ledger: { load: async () => {}, claim: () => true, has: () => false },
            onChatEnvelope: (content) => resolve(content)
        });
        void probe.start({ localAddress: recipient.address }).then(() => probe._handleGiftWrap(giftWrap));
    });
}

let fakeDb;
let wallets;
test.beforeEach(async () => {
    _resetBootstrapReplayCache();
    fakeDb = installFakeIndexedDb();
    wallets = Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, makeWallet(key)]));
    await Promise.all(Object.values(wallets).map((wallet) => wallet.unlock()));
    rtc.uninstall();
});
test.afterEach(() => {
    fakeDb.restore();
    rtc.uninstall();
    globalThis.document = STUB_DOCUMENT;
});

// ─── 1. One room per pair, the same on both sides, for good ──────────────

test('1. both sides derive the same persistent room, whatever the order, and it survives a reload', async () => {
    const { alice, bob, carol } = wallets;
    const ab = conversationRoomId(alice.nostrPublicKey, bob.nostrPublicKey);
    assert.equal(ab, conversationRoomId(bob.nostrPublicKey, alice.nostrPublicKey), 'order does not matter');
    assert.equal(ab, conversationRoomId(alice.nostrPublicKey.toUpperCase(), bob.nostrPublicKey), 'case does not');
    assert.match(ab, /^room-[0-9a-f]{32}$/);
    assert.notEqual(ab, conversationRoomId(alice.nostrPublicKey, carol.nostrPublicKey), 'another pair, another room');
    assert.ok(isConversationRoom(ab, bob.nostrPublicKey, alice.nostrPublicKey));
    assert.throws(() => conversationRoomId('npub-not-hex', bob.nostrPublicKey));

    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    const bobApp = await start(makeApp(bob, relay));
    await befriend(aliceApp, [bob, 'Bob']);
    await befriend(bobApp, [alice, 'Alice']);

    assert.equal(aliceApp.dmRoomFor(bob.nostrPublicKey), ab);
    assert.equal(bobApp.dmRoomFor(alice.nostrPublicKey), ab);

    assert.equal(await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey }), true);
    assert.equal(aliceApp.channelsService.currentChannel, ab, 'the open conversation is that room');

    // Close it, reload the page, open it again: the same room.
    await aliceApp.leaveDmConversation();
    stop(aliceApp);
    const reloaded = await start(makeApp(alice, relay));
    assert.equal(await reloaded.openContactConversation({ nostrPublicKey: bob.nostrPublicKey }), true);
    assert.equal(reloaded.channelsService.currentChannel, ab);

    stop(reloaded);
    stop(bobApp);
});

// ─── 2. Nostr is the messenger; WebRTC is optional ───────────────────────

test('2. saved contacts exchange messages over Nostr with no WebRTC at all', async () => {
    // No RTCPeerConnection in this "browser": everything has to work without it.
    const { alice, bob } = wallets;
    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    const bobApp = await start(makeApp(bob, relay));
    await befriend(aliceApp, [bob, 'Bob']);
    await befriend(bobApp, [alice, 'Alice']);

    assert.equal(await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey }), true);
    // Usable at once: no request, no invitation, no handshake.
    assert.equal(aliceApp.channelsService.connectionState, 'connected-nostr');
    assert.equal(aliceApp.channelsService.canSend(), true);
    assert.deepEqual(aliceApp.invitationsSent, []);
    assert.deepEqual(aliceApp.chatRequestsSent, []);

    await send(aliceApp, 'Hi Bob — over Nostr');
    await until(() => bobApp.dmUnread.get(alice.nostrPublicKey) === 1, 'Bob holding the message');

    assert.equal(await bobApp.openContactConversation({ nostrPublicKey: alice.nostrPublicKey }), true);
    await until(() => bobApp.dmUnread.get(alice.nostrPublicKey) === undefined, 'Bob reading it');
    assert.ok(bobApp.dmSessionMessages.some(({ message }) => message.text === 'Hi Bob — over Nostr'));

    // Both open now. With no WebRTC available the attempt simply does not
    // happen, and the conversation keeps working over Nostr in both directions.
    await send(bobApp, 'Hi Alice');
    await until(() => aliceApp.thread.some((m) => m.text === 'Hi Alice' && !m.local), 'Alice seeing the reply live');
    assert.equal(aliceApp.thread.find((m) => m.text === 'Hi Alice').source, 'nostr');
    assert.equal(aliceApp.channelsService.connectionState, 'connected-nostr', 'Nostr-only is connected, not an error');
    assert.equal(bobApp.channelsService.connectionState, 'connected-nostr');
    assert.deepEqual(bobApp.chatRequestsSent, [], 'opening a saved contact never sends an invitation');

    stop(aliceApp);
    stop(bobApp);
});

// ─── 3. Routing by room and verified sender ──────────────────────────────

test('3. a message for a closed conversation is routed to its contact while another is open', async () => {
    const { alice, bob, carol } = wallets;
    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    const bobApp = await start(makeApp(bob, relay));
    const carolApp = await start(makeApp(carol, relay));
    await befriend(aliceApp, [bob, 'Bob'], [carol, 'Carol']);
    await befriend(bobApp, [alice, 'Alice']);
    await befriend(carolApp, [alice, 'Alice']);

    // Alice is talking to Carol.
    await aliceApp.openContactConversation({ nostrPublicKey: carol.nostrPublicKey });
    await carolApp.openContactConversation({ nostrPublicKey: alice.nostrPublicKey });

    // Bob writes to Alice meanwhile.
    await bobApp.openContactConversation({ nostrPublicKey: alice.nostrPublicKey });
    await send(bobApp, 'Bob here, while you were busy');
    await until(() => aliceApp.dmUnread.get(bob.nostrPublicKey) === 1, 'the message held under Bob');

    assert.equal(aliceApp.thread.some((m) => m.text.startsWith('Bob here')), false, "not in Carol's thread");
    assert.equal(aliceApp.dmUnread.has(carol.nostrPublicKey), false, "Carol's row is not touched");
    assert.equal(aliceApp.channelsService.currentChannel, aliceApp.dmRoomFor(carol.nostrPublicKey), 'Carol stays open');

    // Carol's own message still goes straight into the open thread.
    await send(carolApp, 'Carol, live');
    await until(() => aliceApp.thread.some((m) => m.text === 'Carol, live'), "Carol's message in her thread");

    // Bob signing a message for Carol's room: Bob is a contact and his
    // signature is good, but the room is not his — dropped.
    const crossRoom = await rawSender(bob, relay, alice, {
        room: conversationRoomId(alice.nostrPublicKey, carol.nostrPublicKey)
    });
    await crossRoom.send('pretending to be in your chat with Carol');
    await settle();
    assert.equal(aliceApp.thread.some((m) => m.text.startsWith('pretending')), false);
    assert.equal(aliceApp.dmUnread.get(bob.nostrPublicKey), 1, 'not counted under anybody');
    assert.ok(aliceApp.logs.some((line) => /not for your conversation with them/.test(line)));
    crossRoom.stop();

    // Switching to Bob shows what he sent, and loses nothing of Carol's.
    await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
    await until(() => !aliceApp.dmUnread.has(bob.nostrPublicKey), 'Bob read');
    assert.ok(aliceApp.dmSessionMessages.some(({ message }) => message.text === 'Bob here, while you were busy'));
    await send(carolApp, 'Carol again, now that you switched');
    await until(() => aliceApp.dmUnread.get(carol.nostrPublicKey) === 1, "Carol's next one held for her");

    stop(aliceApp);
    stop(bobApp);
    stop(carolApp);
});

// ─── 4. The right row, marked and cleared ────────────────────────────────

test('4. the sender’s row gets the unread badge, and it clears once the messages are shown', async () => {
    const dom = installFakeDom({
        list: { tag: 'div', id: 'dm-contacts-list' },
        count: { tag: 'span', id: 'dm-contacts-count' },
        thread: { tag: 'div', id: 'channels-messages' }
    });
    try {
        const { alice, bob, carol } = wallets;
        const relay = new MemoryRelay();
        const aliceApp = await start(makeApp(alice, relay));
        await befriend(aliceApp, [bob, 'Bob'], [carol, 'Carol']);

        const bobSender = await rawSender(bob, relay, alice);
        await bobSender.send('One');
        await bobSender.send('Two');
        await until(() => aliceApp.dmUnread.get(bob.nostrPublicKey) === 2, 'two held');

        const row = (wallet) => dom.nodes.list.querySelector(`[data-contact-key="${wallet.nostrPublicKey}"]`);
        const badge = (wallet) => row(wallet)?.querySelector('.dm-contact-unread') || null;
        assert.equal(badge(bob)?.textContent, '2');
        assert.equal(row(bob).classList.contains('has-unread'), true);
        assert.equal(badge(bob).getAttribute('aria-label'), '2 unread messages');
        assert.equal(badge(carol), null, 'Carol has nothing unread');

        await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
        await until(() => dom.nodes.thread.textContent.includes('Two'), 'shown in the thread');
        assert.ok(dom.nodes.thread.textContent.includes('One'));
        assert.ok(dom.nodes.thread.querySelector('.channels-unread-divider'), 'a divider where unread begins');
        assert.match(dom.nodes.thread.textContent, /2 unread messages/);
        assert.match(dom.nodes.thread.textContent, /held encrypted on this device until now/);

        await until(() => badge(bob) === null, 'badge cleared');
        assert.equal(row(bob).classList.contains('has-unread'), false);
        assert.equal((await aliceApp.messageArchive.unreadCounts([bob.nostrPublicKey])).size, 0);

        bobSender.stop();
        stop(aliceApp);
    } finally {
        dom.restore();
    }
});

// ─── 5. Survives a reload, and retention still decides afterwards ─────────

test('5. held messages and unread state survive reloads; once read, retention decides', async () => {
    const { alice, bob } = wallets;
    const relay = new MemoryRelay();

    // Alice is not even here: Bob writes, the relay keeps it.
    const bobSender = await rawSender(bob, relay, alice);
    await bobSender.send('Sent while you were offline');

    const firstPage = makeApp(alice, relay);
    await befriend(firstPage, [bob, 'Bob']);
    await start(firstPage);
    await until(() => firstPage.dmUnread.get(bob.nostrPublicKey) === 1, 'held on first load');
    stop(firstPage);

    // Reload: the relay replays the same gift wrap; the ledger knows it, and
    // the unread state comes back from IndexedDB, not from the relay.
    const secondPage = await start(makeApp(alice, relay));
    await settle();
    assert.equal(secondPage.dmUnread.get(bob.nostrPublicKey), 1, 'still unread after a reload, counted once');

    await secondPage.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
    await until(() => !secondPage.dmUnread.has(bob.nostrPublicKey), 'read');
    assert.ok(secondPage.dmSessionMessages.some(({ message }) => message.text === 'Sent while you were offline'));
    stop(secondPage);

    // Retention is off for this chat, so once read nothing of it stays.
    const thirdPage = await start(makeApp(alice, relay));
    await settle();
    assert.equal(thirdPage.dmUnread.has(bob.nostrPublicKey), false, 'read stays read');
    assert.deepEqual(await thirdPage.messageArchive.history(bob.nostrPublicKey), [], 'retention off keeps nothing once read');
    stop(thirdPage);
    bobSender.stop();
});

test('5b. the hold is bounded and honest about retention', async () => {
    const { alice, bob, carol } = wallets;
    let now = Date.parse('2026-10-01T12:00:00Z');
    const archive = new MessageArchive({ signer: alice.signer, now: () => now });

    // Off: held until read, then deleted.
    const offRow = await archive.hold(bob.nostrPublicKey, { id: 'm-1', from: bob.address, text: 'off', timestamp: now });
    assert.ok(offRow);
    assert.deepEqual([...(await archive.unreadCounts([bob.nostrPublicKey]))], [[bob.nostrPublicKey, 1]]);
    // Turning retention off does not take an unread message with it.
    await archive.setRetention(bob.nostrPublicKey, 0);
    assert.equal((await archive.history(bob.nostrPublicKey)).length, 1);
    assert.equal(await archive.markRead(bob.nostrPublicKey, { retentionMs: 0 }), 1);
    assert.deepEqual(await archive.history(bob.nostrPublicKey), []);

    // On (24 h): read, it is kept for the conversation's retention, by its own timestamp.
    await archive.setRetention(carol.nostrPublicKey, 24 * 60 * 60 * 1000);
    await archive.hold(carol.nostrPublicKey, { id: 'm-2', from: carol.address, text: 'kept', timestamp: now });
    await archive.markRead(carol.nostrPublicKey);
    const kept = await archive.history(carol.nostrPublicKey);
    assert.deepEqual(
        kept.map((m) => [m.text, m.unread]),
        [['kept', false]]
    );
    now += 25 * 60 * 60 * 1000;
    await archive.purgeExpired();
    assert.deepEqual(await archive.history(carol.nostrPublicKey), [], 'gone after its retention');

    // Unread, never opened: still gone at the seven-day ceiling.
    await archive.hold(bob.nostrPublicKey, { id: 'm-3', from: bob.address, text: 'never read', timestamp: now });
    now += MAX_RETENTION_MS + 1;
    assert.deepEqual(await archive.history(bob.nostrPublicKey), []);
    assert.equal((await archive.unreadCounts([bob.nostrPublicKey])).size, 0);
});

// ─── 6 & 7. A direct link only while both have it open ───────────────────

test('6. WebRTC starts only when both sides have the same conversation open', async () => {
    rtc.install();
    const { alice, bob, carol } = wallets;
    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    const bobApp = await start(makeApp(bob, relay));
    await befriend(aliceApp, [bob, 'Bob']);
    await befriend(bobApp, [alice, 'Alice'], [carol, 'Carol']);

    // Bob is online — his presence beacon is out — with no conversation open.
    await settle();
    assert.equal(aliceApp.presenceService.isOnline(bob.nostrPublicKey), true, 'Bob is online');

    // Only Alice has it open: Nostr only.
    await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
    await settle();
    assert.equal(rtc.created.length, 0, 'online is not open');

    // A message arriving is not a reason either.
    await send(aliceApp, 'ping');
    await until(() => bobApp.dmUnread.get(alice.nostrPublicKey) === 1, 'Bob holding it');
    assert.equal(rtc.created.length, 0, 'a message never starts WebRTC');

    // Bob opening a different conversation does not count.
    await bobApp.openContactConversation({ nostrPublicKey: carol.nostrPublicKey });
    await settle();
    assert.equal(rtc.created.length, 0, 'open, but not with Alice');

    // Bob opens Alice's: both have the same conversation open now.
    await bobApp.openContactConversation({ nostrPublicKey: alice.nostrPublicKey });
    await until(
        () =>
            aliceApp.channelsService.connectionState === 'connected-webrtc' &&
            bobApp.channelsService.connectionState === 'connected-webrtc',
        'the direct link'
    );
    assert.equal(rtc.created.length, 2, 'one peer connection each');
    assert.deepEqual(aliceApp.invitationsSent.concat(bobApp.invitationsSent).sort(), ['answer', 'offer']);
    // The signalling session is its own one-time id, never the room.
    const offerer = aliceApp.dmOfferSessionId ? aliceApp : bobApp;
    assert.ok(offerer.dmOfferSessionId);
    assert.notEqual(offerer.dmOfferSessionId, offerer.channelsService.currentChannel);
    assert.equal(aliceApp.channelsService.currentChannel, bobApp.channelsService.currentChannel);

    // Connected, WebRTC carries the messages: nothing new goes to the relay.
    const wrapsBefore = relay.giftWrapsTo(bob.nostrPublicKey).length;
    await send(aliceApp, 'direct');
    await until(() => bobApp.thread.some((m) => m.text === 'direct'), 'delivered directly');
    assert.equal(bobApp.thread.find((m) => m.text === 'direct').source, 'webrtc');
    assert.equal(relay.giftWrapsTo(bob.nostrPublicKey).length, wrapsBefore, 'no relay copy');

    stop(aliceApp);
    stop(bobApp);
});

test('7. closing or switching stops WebRTC and Nostr carries on', async () => {
    rtc.install();
    const { alice, bob, carol } = wallets;
    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    const bobApp = await start(makeApp(bob, relay));
    await befriend(aliceApp, [bob, 'Bob'], [carol, 'Carol']);
    await befriend(bobApp, [alice, 'Alice']);

    const linked = () =>
        until(
            () =>
                aliceApp.channelsService.connectionState === 'connected-webrtc' &&
                bobApp.channelsService.connectionState === 'connected-webrtc',
            'the direct link'
        );

    await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
    await bobApp.openContactConversation({ nostrPublicKey: alice.nostrPublicKey });
    await linked();

    // Bob closes the chat.
    await bobApp.leaveDmConversation();
    await until(() => aliceApp.channelsService.connectionState === 'connected-nostr', 'Alice back on Nostr');
    assert.equal(rtc.open().length, 0, 'every peer connection is closed');
    assert.equal(aliceApp.channelsService.currentChannel, aliceApp.dmRoomFor(bob.nostrPublicKey), 'still open for Alice');
    assert.equal(aliceApp.nostrDmSession.started, true, 'the inbox stays subscribed');
    assert.equal(bobApp.nostrDmSession.started, true);
    assert.equal(relay.subscriptions.filter((s) => s.filters[0]['#p']).length, 2, 'both inboxes still listening');

    // And it still works: Alice's next message reaches Bob over Nostr.
    await send(aliceApp, 'still here, over Nostr');
    await until(() => bobApp.dmUnread.get(alice.nostrPublicKey) === 1, 'held for Bob');

    // Bob comes back: a new direct link. Then Alice switches to Carol.
    await bobApp.openContactConversation({ nostrPublicKey: alice.nostrPublicKey });
    await linked();
    await aliceApp.openContactConversation({ nostrPublicKey: carol.nostrPublicKey });
    await until(() => bobApp.channelsService.connectionState === 'connected-nostr', 'Bob back on Nostr');
    assert.equal(rtc.open().length, 0, 'switching closes the link too');
    assert.equal(aliceApp.channelsService.currentChannel, aliceApp.dmRoomFor(carol.nostrPublicKey));

    await send(bobApp, 'you switched away');
    await until(() => aliceApp.dmUnread.get(bob.nostrPublicKey) === 1, 'held for Alice under Bob');
    assert.equal(aliceApp.dmUnread.has(carol.nostrPublicKey), false);

    stop(aliceApp);
    stop(bobApp);
});

// ─── 8. Once, however often it arrives ───────────────────────────────────

test('8. duplicates are neither rendered nor stored twice', async () => {
    const { alice, bob } = wallets;
    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    await befriend(aliceApp, [bob, 'Bob']);
    const bobSender = await rawSender(bob, relay, alice);

    // The same gift wrap, delivered again by a reconnecting relay.
    await bobSender.send('once');
    await until(() => aliceApp.dmUnread.get(bob.nostrPublicKey) === 1, 'held');
    await relay.replay();
    await settle();
    assert.equal(aliceApp.dmUnread.get(bob.nostrPublicKey), 1);

    // The same message wrapped again — a new gift wrap, the same message id.
    const wire = await wireInside(alice, relay.giftWrapsTo(alice.nostrPublicKey).at(-1));
    await bobSender.session.createFallback().send(wire);
    await settle();
    assert.equal(aliceApp.dmUnread.get(bob.nostrPublicKey), 1, 're-wrapped is still the same message');
    assert.equal((await aliceApp.messageArchive.history(bob.nostrPublicKey)).length, 1, 'one row');

    // Read it; then the same message turning up yet again is not unread again.
    await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
    await until(() => !aliceApp.dmUnread.has(bob.nostrPublicKey), 'read');
    await aliceApp.leaveDmConversation();
    await bobSender.session.createFallback().send(wire);
    await settle();
    assert.equal(aliceApp.dmUnread.has(bob.nostrPublicKey), false, 'shown once is shown');

    // Live, in the open conversation: one bubble however often it arrives.
    await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey });
    await bobSender.send('live once');
    await until(() => aliceApp.thread.some((m) => m.text === 'live once'), 'live');
    const liveWire = await wireInside(alice, relay.giftWrapsTo(alice.nostrPublicKey).at(-1));
    await bobSender.session.createFallback().send(liveWire);
    await settle();
    assert.equal(aliceApp.thread.filter((m) => m.text === 'live once').length, 1);

    // Shown live, then closed and delivered again: not held as new either.
    await aliceApp.leaveDmConversation();
    await bobSender.session.createFallback().send(liveWire);
    await settle();
    assert.equal(aliceApp.dmUnread.has(bob.nostrPublicKey), false);

    bobSender.stop();
    stop(aliceApp);
});

// ─── 9. Strangers and the blocked ────────────────────────────────────────

test('9. unknown senders and blocked contacts keep their restrictions', async () => {
    const { alice, bob, mallory } = wallets;
    const relay = new MemoryRelay();
    const aliceApp = await start(makeApp(alice, relay));
    await befriend(aliceApp, [bob, 'Bob']);

    // A stranger's message is dropped unread: not shown, not held, not queued.
    const stranger = await rawSender(mallory, relay, alice);
    await stranger.send('hello from nobody you know');
    await settle();
    assert.equal(aliceApp.dmUnread.size, 0);
    assert.equal(aliceApp.thread.length, 0);
    assert.equal((await aliceApp.messageArchive.history(mallory.nostrPublicKey)).length, 0);
    assert.ok(aliceApp.logs.some((line) => /not a saved contact/.test(line)));

    // Claiming Bob's room does not make Mallory Bob: the seal names her.
    const impostor = await rawSender(mallory, relay, alice, {
        room: conversationRoomId(alice.nostrPublicKey, bob.nostrPublicKey)
    });
    await impostor.send('it is me, Bob');
    await settle();
    assert.equal(aliceApp.dmUnread.size, 0, 'a room id is not a credential');

    // A stranger opening a conversation is asking to talk: an invitation,
    // and nothing goes back to her.
    const before = relay.giftWrapsTo(mallory.nostrPublicKey).length;
    await stranger.session.sendGiftWrapped(
        alice.nostrPublicKey,
        NOSTR_CONFIG.WEB25_CONVERSATION_KIND,
        JSON.stringify({
            type: 'web25-conversation',
            state: 'open',
            room: conversationRoomId(alice.nostrPublicKey, mallory.nostrPublicKey),
            ack: false
        })
    );
    await until(() => aliceApp.dmInvitations.size === 1, 'held as an invitation');
    await settle();
    assert.equal(relay.giftWrapsTo(mallory.nostrPublicKey).length, before, 'nothing sent back');

    // Blocked: Bob's messages and openings are dropped like a stranger's.
    globalThis.window.confirm = () => true;
    await aliceApp.blockDmPeer(bob.nostrPublicKey, { name: 'Bob' });
    assert.equal(await aliceApp.isDmBlocked(bob.nostrPublicKey), true);
    const blocked = await rawSender(bob, relay, alice);
    await blocked.send('let me in');
    await settle();
    assert.equal(aliceApp.dmUnread.size, 0);
    assert.ok(aliceApp.logs.some((line) => /blocked/.test(line)));
    assert.equal(await aliceApp.handleConversationIntent(bob.nostrPublicKey, { state: 'open', room: '', ack: false }), false);
    assert.equal(await aliceApp.openContactConversation({ nostrPublicKey: bob.nostrPublicKey }), false);

    stranger.stop();
    impostor.stop();
    blocked.stop();
    stop(aliceApp);
});
