/**
 * The three things a conversation can do about the person in it: save them,
 * block them, and keep what was said for a while.
 *
 * Saving used to fail whenever it was pressed before the peer's keys were
 * verified — the button is there from the moment a conversation opens — with
 * "ECIES public key is malformed", and to do nothing at all where the browser
 * suppressed `window.prompt`. These drive the shipped Lifecycle functions
 * against the real contacts store and message archive.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContactsStore } from '../src/channels/ContactsStore.js';
import { MessageArchive, MESSAGES_DB_NAME, MESSAGES_STORE_NAME } from '../src/channels/MessageArchive.js';
import { PendingInvitations } from '../src/channels/PendingInvitations.js';
import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

globalThis.window = globalThis.window || {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' }
};
globalThis.document = globalThis.document || {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
};

const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');

const DAY = 24 * 60 * 60 * 1000;

function peerFrom(privHex) {
    const eciesPublicKey = getPublicKeyFromPrivateKey(`0x${privHex}`).toLowerCase();
    const nostrPublicKey = nostrCore.getNostrPublicKey(privHex);
    return {
        nostrPublicKey,
        npub: npubEncode(nostrPublicKey),
        eciesPublicKey,
        evmAddress: evmAddressFromPublicKey(eciesPublicKey)
    };
}

const ALICE = peerFrom('22'.repeat(32));
const BOB = peerFrom('33'.repeat(32));

function makeWallet() {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        const response = await core.handle({ id: `s${++counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    return {
        unlock: () =>
            core.handle({
                id: 'unlock',
                type: WALLET_WORKER_OPS.UNLOCK,
                payload: { privateKey: `0x${'11'.repeat(32)}` }
            }),
        signer: {
            getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY).catch(() => null),
            nostrEncrypt: async (plaintext, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
            nostrDecrypt: async (payload, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
        }
    };
}

/** A conversation with `peer`, its keys not verified yet. */
async function conversationWith(peer) {
    const fake = installFakeIndexedDb();
    const wallet = makeWallet();
    await wallet.unlock();
    const toasts = [];
    const app = {
        dmSelectedPeer: peer.nostrPublicKey,
        dmPendingContactName: '',
        dmPendingContactSave: null,
        dmContacts: [],
        dmBlocked: new Set(),
        dmBlockedList: [],
        dmBlockedLoaded: false,
        dmConsentedPeers: new Set([peer.nostrPublicKey]),
        dmDeclinedRequests: new Map(),
        dmRetention: new Map(),
        dmSessionMessages: [],
        dmInvitations: new PendingInvitations(),
        contactsStore: new ContactsStore({ signer: wallet.signer }),
        messageArchive: new MessageArchive({ signer: wallet.signer }),
        channelsService: {
            peerPublicKey: '',
            peerAddress: '',
            left: 0,
            hasVerifiedPeerIdentity() {
                return Boolean(this.peerPublicKey && this.peerAddress);
            },
            async leaveChannel() {
                this.left += 1;
            }
        },
        nostrDmSession: { clearPeer() {} },
        presenceService: {
            cleared: [],
            clearIntent(p) {
                this.cleared.push(p);
            },
            watch() {},
            isOnline: () => false
        },
        log: () => {},
        toast: {
            info: (m) => toasts.push(['info', m]),
            success: (m) => toasts.push(['success', m]),
            warning: (m) => toasts.push(['warning', m]),
            error: (m) => toasts.push(['error', m])
        },
        toasts,
        fake,
        /** The handshake finishing: the peer's keys are now known and verified. */
        verify() {
            this.channelsService.peerPublicKey = peer.eciesPublicKey;
            this.channelsService.peerAddress = peer.evmAddress;
        }
    };
    for (const name of [
        'saveCurrentPeerAsContact',
        'storeVerifiedPeerAsContact',
        'completePendingContactSave',
        'renameContact',
        'refreshContactList',
        'watchPresenceTargets',
        'dmSaveContactState',
        'leaveDmConversation',
        'clearHandshakeStallTimer',
        'blockDmPeer',
        'unblockDmPeer',
        'isDmBlocked',
        'dmRetentionFor',
        'setDmRetention',
        'archiveDmMessage',
        'renderDmContactRows',
        'isDmConversationOpenWith',
        'isDmRoomOpenWith',
        'dmRoomFor',
        'dmGiftWrapSender'
    ]) {
        app[name] = lifecycle[name].bind(app);
    }
    return app;
}

function answering(prompt, confirm = true) {
    const previous = { prompt: globalThis.window.prompt, confirm: globalThis.window.confirm };
    globalThis.window.prompt = () => prompt;
    globalThis.window.confirm = () => confirm;
    return () => Object.assign(globalThis.window, previous);
}

test('saving before the keys are verified waits for them instead of failing', async () => {
    const app = await conversationWith(ALICE);
    const restore = answering('Alice');
    try {
        assert.equal(await app.saveCurrentPeerAsContact(), true);

        assert.deepEqual(app.dmPendingContactSave, { peer: ALICE.nostrPublicKey, name: 'Alice' });
        assert.equal(app.dmSaveContactState(), 'pending');
        assert.ok(!app.toasts.some(([level]) => level === 'error'), 'no "ECIES public key is malformed"');
        assert.deepEqual(await app.contactsStore.list(), [], 'nothing unverified is stored');

        app.verify();
        assert.equal(await app.completePendingContactSave(), true);

        const [saved] = await app.contactsStore.list();
        assert.equal(saved.name, 'Alice');
        assert.equal(saved.nostrPublicKey, ALICE.nostrPublicKey);
        assert.equal(app.dmPendingContactSave, null);
        assert.equal(app.dmSaveContactState(), 'saved');
    } finally {
        restore();
        app.fake.restore();
    }
});

test('a verified peer is saved at once', async () => {
    const app = await conversationWith(ALICE);
    const restore = answering('Alice P.');
    try {
        app.verify();
        assert.equal(await app.saveCurrentPeerAsContact(), true);
        assert.equal((await app.contactsStore.list())[0].name, 'Alice P.');
        assert.ok(app.toasts.some(([level]) => level === 'success'));
    } finally {
        restore();
        app.fake.restore();
    }
});

test('cancelling the name saves nothing and holds nothing', async () => {
    const app = await conversationWith(ALICE);
    const restore = answering(null);
    try {
        assert.equal(await app.saveCurrentPeerAsContact(), false);
        assert.equal(app.dmPendingContactSave, null);
        assert.deepEqual(await app.contactsStore.list(), []);
    } finally {
        restore();
        app.fake.restore();
    }
});

test('a saved contact is renamed by the same button, without needing a live handshake', async () => {
    const app = await conversationWith(ALICE);
    const restore = answering('Ally');
    try {
        await app.contactsStore.save({ ...ALICE, name: 'Alice' });
        await app.refreshContactList();
        assert.equal(app.dmSaveContactState(), 'saved');

        assert.equal(await app.saveCurrentPeerAsContact(), true);
        assert.equal((await app.contactsStore.list())[0].name, 'Ally');
    } finally {
        restore();
        app.fake.restore();
    }
});

test('a pending save is for that peer only, and leaving drops it with a word', async () => {
    const app = await conversationWith(ALICE);
    const restore = answering('Alice');
    try {
        await app.saveCurrentPeerAsContact();

        // The conversation moved to somebody else before Alice verified.
        app.dmSelectedPeer = BOB.nostrPublicKey;
        app.channelsService.peerPublicKey = BOB.eciesPublicKey;
        app.channelsService.peerAddress = BOB.evmAddress;
        assert.equal(await app.completePendingContactSave(), false, 'Bob is not saved under Alice’s name');
        assert.deepEqual(await app.contactsStore.list(), []);

        app.dmSelectedPeer = ALICE.nostrPublicKey;
        await app.leaveDmConversation();
        assert.equal(app.dmPendingContactSave, null);
        assert.ok(app.toasts.some(([, m]) => /not saved/.test(m)));
    } finally {
        restore();
        app.fake.restore();
    }
});

test('blocking the person you are talking to ends the chat, the friendship and the kept history', async () => {
    const app = await conversationWith(ALICE);
    const restore = answering(null, true);
    try {
        app.verify();
        await app.contactsStore.save({ ...ALICE, name: 'Alice' });
        await app.messageArchive.setRetention(ALICE.nostrPublicKey, DAY);
        await app.messageArchive.record(ALICE.nostrPublicKey, {
            id: 'm1',
            from: '0x',
            text: 'hi',
            timestamp: Date.now()
        });
        app.dmInvitations.add({ kind: 'request', senderNostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub });

        assert.equal(await app.blockDmPeer(ALICE.nostrPublicKey, { name: 'Alice' }), true);

        assert.equal(app.channelsService.left, 1, 'the conversation is left');
        assert.equal(app.dmSelectedPeer, '');
        assert.equal(app.dmInvitations.size, 0, 'their invitation goes');
        assert.equal(app.dmConsentedPeers.has(ALICE.nostrPublicKey), false);
        assert.deepEqual(app.presenceService.cleared, [ALICE.nostrPublicKey, ALICE.nostrPublicKey]);
        assert.equal(await app.contactsStore.isTrusted(ALICE.nostrPublicKey), false);
        assert.equal(await app.isDmBlocked(ALICE.nostrPublicKey), true);
        assert.deepEqual(app.fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), [], 'kept messages are deleted');
        assert.deepEqual(
            app.dmBlockedList.map((entry) => entry.name),
            ['Alice']
        );
    } finally {
        restore();
        app.fake.restore();
    }
});

test('a block asks first, and unblocking makes them a stranger again', async () => {
    const app = await conversationWith(ALICE);
    let restore = answering(null, false);
    try {
        assert.equal(await app.blockDmPeer(BOB.nostrPublicKey), false, 'declining the question blocks nobody');
        assert.equal(await app.isDmBlocked(BOB.nostrPublicKey), false);
        restore();

        restore = answering(null, true);
        await app.blockDmPeer(BOB.nostrPublicKey);
        assert.equal(await app.isDmBlocked(BOB.nostrPublicKey), true);
        await app.unblockDmPeer(BOB.nostrPublicKey);
        assert.equal(await app.isDmBlocked(BOB.nostrPublicKey), false);
        assert.equal(await app.contactsStore.isTrusted(BOB.nostrPublicKey), false);
    } finally {
        restore();
        app.fake.restore();
    }
});

test('messages are kept only once the conversation keeps them, and turning it on keeps this session', async () => {
    const app = await conversationWith(ALICE);
    try {
        const said = { id: 'm1', from: '0xalice', text: 'before turning it on', timestamp: new Date().toISOString() };
        app.dmSessionMessages.push({ message: said, own: false });
        await app.archiveDmMessage(said, false);
        assert.deepEqual(app.fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), [], 'off by default');

        await app.setDmRetention(7 * DAY);
        await app.archiveDmMessage(
            { id: 'm2', from: '0xme', text: 'after', timestamp: new Date().toISOString() },
            true
        );
        await app.archiveDmMessage(
            { id: 's1', from: 'system', text: '🪪 Peer verified', timestamp: new Date().toISOString() },
            true
        );

        const history = await app.messageArchive.history(ALICE.nostrPublicKey);
        assert.deepEqual(
            history.map((m) => [m.text, m.own]),
            [
                ['before turning it on', false],
                ['after', true]
            ],
            'this session is kept, service notices are not'
        );

        await app.setDmRetention(0);
        assert.deepEqual(app.fake.rawRows(MESSAGES_DB_NAME, MESSAGES_STORE_NAME), []);
    } finally {
        app.fake.restore();
    }
});
