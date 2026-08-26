/**
 * The Direct Messenger consent model.
 *
 * The property under test throughout: **a cryptographically valid offer is not
 * consent.** Anyone who knows an npub can produce one, so answering an unknown
 * peer would hand them the local ECIES key, the EVM identity and — through ICE
 * gathering — this machine's network addresses, before a person ever saw the
 * request.
 *
 * These tests drive the real `handleNostrInvitation` from `Lifecycle.js`
 * against doubles, so the gate they check is the one that actually runs. The
 * `ChannelsService` double counts every call that would leak something, and a
 * test fails if any of them happens before consent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';


// `Lifecycle.js` is browser code: it reads `window` at module scope, through
// the shared config. A minimal stand-in lets the real module load unchanged, so
// these tests exercise the gate that actually ships rather than a copy of it.
globalThis.window = globalThis.window || { location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' } };
globalThis.document = globalThis.document || { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };

const {
    handleNostrInvitation,
    holdDmInvitation,
    invitationMatchesContact,
    answerDmInvitation,
    acceptDmInvitation,
    declineDmInvitation,
    removeContact
} = await import('../src/core/bootstrap/Lifecycle.js');
import { ContactsStore, TRUST, verifyIdentityTuple } from '../src/channels/ContactsStore.js';
import { PendingInvitations } from '../src/channels/PendingInvitations.js';
import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

const OWNER_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';

function peerFrom(privHex) {
    const eciesPublicKey = getPublicKeyFromPrivateKey(`0x${privHex}`).toLowerCase();
    const nostrPublicKey = nostrCore.getNostrPublicKey(privHex);
    return {
        nostrPublicKey,
        npub: npubEncode(nostrPublicKey),
        eciesPublicKey,
        evmAddress: evmAddressFromPublicKey(eciesPublicKey).toLowerCase()
    };
}

const ALICE = peerFrom('2222222222222222222222222222222222222222222222222222222222222222');
const MALLORY = peerFrom('3333333333333333333333333333333333333333333333333333333333333333');

/** A bootstrap exactly as the verified NIP-59 path produces one. */
function offerFrom(peer, { expiresInMs = 60_000, sessionId = 'session-1' } = {}) {
    return {
        role: 'offer',
        from: { evmAddress: peer.evmAddress, eciesPublicKey: peer.eciesPublicKey },
        webrtc: { description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' } },
        session: { sessionId, nonce: 'nonce-1', createdAt: Date.now(), expiresAt: Date.now() + expiresInMs }
    };
}

function makeWallet(privateKey = OWNER_PRIV) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        counter += 1;
        const response = await core.handle({ id: `w${counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };

    return {
        nostrPublicKey: nostrCore.getNostrPublicKey(privateKey.slice(2)),
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        lock: () => core.handle({ id: 'lock', type: WALLET_WORKER_OPS.LOCK }),
        signer: {
            getNostrIdentity: async () => {
                try {
                    return await call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY);
                } catch (_) {
                    return null;
                }
            },
            nostrEncrypt: async (plaintext, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
            nostrDecrypt: async (payload, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
        }
    };
}

/**
 * Counts every action that would reveal something to the peer. The names match
 * the real methods, so an accidental call shows up as a leak rather than as a
 * missing stub.
 */
class LeakCountingChannels {
    constructor() {
        this.currentChannel = null;
        this.peerAddress = '';
        this.peerPublicKey = '';
        this.calls = { createAnswer: 0, iceGathering: 0 };
    }

    async createAnswerPayloadFromRemoteOffer(_room, offerPayload, _identity) {
        this.calls.createAnswer += 1;
        // The real implementation creates an RTCPeerConnection and awaits ICE
        // gathering here; counting it separately makes the privacy claim
        // explicit rather than implied.
        this.calls.iceGathering += 1;
        this.peerPublicKey = offerPayload.publicKey;
        this.peerAddress = offerPayload.evmAddress;
        return { description: { type: 'answer', sdp: 'v=0\r\n' }, publicKey: '04ff', evmAddress: '0xlocal' };
    }
}

/** Counts what actually reaches a relay. */
class RecordingDmSession {
    constructor() {
        this.sent = [];
        this.peerNostrPublicKey = '';
    }

    setPeer(peer) {
        this.peerNostrPublicKey = peer;
    }

    async sendInvitation(params) {
        this.sent.push(params);
    }
}

/** The slice of the app the invitation path touches. */
async function makeApp({ unlocked = true } = {}) {
    const fake = installFakeIndexedDb();
    const wallet = makeWallet();
    if (unlocked) await wallet.unlock();

    const toasts = [];
    const logs = [];

    const app = {
        authController: { getActiveIdentity: () => ({ address: '0xlocal', chainId: 1 }) },
        contactsStore: new ContactsStore({ signer: wallet.signer }),
        dmInvitations: new PendingInvitations(),
        channelsService: new LeakCountingChannels(),
        nostrDmSession: new RecordingDmSession(),
        presenceService: { sendChatRequest: () => {}, clearIntent: () => {}, watch: () => {} },
        nostrPool: null,
        dmContacts: [],
        dmContactFilter: '',
        dmSelectedPeer: '',
        log: (message) => logs.push(message),
        toast: {
            info: (m, t) => toasts.push({ level: 'info', m, t }),
            success: (m, t) => toasts.push({ level: 'success', m, t }),
            warning: (m, t) => toasts.push({ level: 'warning', m, t }),
            error: (m, t) => toasts.push({ level: 'error', m, t })
        },
        refreshContactList: async () => {},
        toasts,
        logs,
        wallet,
        fake
    };

    // Bind the real Lifecycle methods under test.
    app.handleNostrInvitation = handleNostrInvitation.bind(app);
    app.holdDmInvitation = holdDmInvitation.bind(app);
    app.invitationMatchesContact = invitationMatchesContact.bind(app);
    app.answerDmInvitation = answerDmInvitation.bind(app);
    app.acceptDmInvitation = acceptDmInvitation.bind(app);
    app.declineDmInvitation = declineDmInvitation.bind(app);
    app.removeContact = removeContact.bind(app);

    return app;
}

/** Asserts that nothing at all went back to the peer. */
function assertNothingRevealed(app, label = '') {
    assert.equal(app.channelsService.calls.createAnswer, 0, `${label}: no answer payload may be created`);
    assert.equal(app.channelsService.calls.iceGathering, 0, `${label}: no ICE gathering before consent`);
    assert.equal(app.nostrDmSession.sent.length, 0, `${label}: nothing may be sent to the peer`);
    assert.equal(app.nostrDmSession.peerNostrPublicKey, '', `${label}: no peer is bound`);
    assert.equal(app.dmSelectedPeer, '', `${label}: no conversation is opened`);
}

// ─── 1. An unknown peer is never auto-answered ───────────────────────────

test('a valid offer from an unknown peer produces no answer and no ICE gathering', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });

        // This is the privacy property: an attacker who knows the victim's npub
        // learns nothing about their network position by offering.
        assertNothingRevealed(app, 'unknown peer');
    } finally {
        app.fake.restore();
    }
});

test('an unknown peer becomes a pending invitation the user can see', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });

        const pending = app.dmInvitations.list();
        assert.equal(pending.length, 1);
        assert.equal(pending[0].peerNostrPublicKey, MALLORY.nostrPublicKey);
        assert.equal(pending[0].npub, MALLORY.npub);
        assert.equal(pending[0].evmAddress, MALLORY.evmAddress);
        assert.equal(pending[0].trustState, 'unknown');
        assert.ok(pending[0].receivedAt > 0, 'a timestamp is shown');

        // The SDP is held for Accept but never handed to the UI.
        assert.equal(pending[0].bootstrap, undefined);
    } finally {
        app.fake.restore();
    }
});

test('repeated offers from one unknown peer cannot flood the notification area', async () => {
    const app = await makeApp();
    try {
        for (let i = 0; i < 10; i += 1) {
            await app.handleNostrInvitation(offerFrom(MALLORY, { sessionId: `s${i}` }), {
                senderNostrPublicKey: MALLORY.nostrPublicKey
            });
        }
        assert.equal(app.dmInvitations.list().length, 1, 'one entry per sender');
        assertNothingRevealed(app, 'repeat offers');
    } finally {
        app.fake.restore();
    }
});

// ─── 2. Decline ──────────────────────────────────────────────────────────

test('declining sends no answer, opens no connection and creates no friend', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });
        await app.declineDmInvitation(MALLORY.nostrPublicKey);

        assert.equal(app.dmInvitations.list().length, 0, 'the invitation is discarded');
        assertNothingRevealed(app, 'decline');
        assert.equal(await app.contactsStore.get(MALLORY.nostrPublicKey), null, 'no contact is created');
        assert.equal(await app.contactsStore.isTrusted(MALLORY.nostrPublicKey), false);
    } finally {
        app.fake.restore();
    }
});

test('a declined invitation cannot then be accepted', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });
        await app.declineDmInvitation(MALLORY.nostrPublicKey);
        await app.acceptDmInvitation(MALLORY.nostrPublicKey);

        assertNothingRevealed(app, 'accept after decline');
    } finally {
        app.fake.restore();
    }
});

// ─── 3. Accept ───────────────────────────────────────────────────────────

test('accepting produces an answer and sends it over Nostr', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });
        assertNothingRevealed(app, 'before accept');

        const accepted = await app.acceptDmInvitation(ALICE.nostrPublicKey);

        assert.equal(accepted, true);
        assert.equal(app.channelsService.calls.createAnswer, 1, 'ICE is gathered only now');
        assert.equal(app.nostrDmSession.sent.length, 1);

        const [sent] = app.nostrDmSession.sent;
        assert.equal(sent.role, 'answer');
        assert.equal(sent.recipient, ALICE.nostrPublicKey);
        // The Web25 ECIES envelope still rides on top of the NIP-44 gift wrap.
        assert.equal(sent.recipientEciesPublicKey, ALICE.eciesPublicKey);
        assert.equal(sent.replyToSessionId, 'session-1');
    } finally {
        app.fake.restore();
    }
});

test('an accepted peer is persisted as a trusted friend, with the exchanged identity', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });
        await app.acceptDmInvitation(ALICE.nostrPublicKey);

        const contact = await app.contactsStore.get(ALICE.nostrPublicKey);
        assert.ok(contact, 'the friend is stored only after the exchange');
        assert.equal(contact.trust, TRUST.TRUSTED);
        assert.equal(contact.eciesPublicKey, ALICE.eciesPublicKey);
        assert.equal(contact.evmAddress, ALICE.evmAddress);
        assert.deepEqual(verifyIdentityTuple(contact), { ok: true, reason: null });
    } finally {
        app.fake.restore();
    }
});

test('an expired invitation is refused at accept time', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(ALICE, { expiresInMs: 60_000 }), {
            senderNostrPublicKey: ALICE.nostrPublicKey
        });

        // Age it out while it sits in the queue, exactly as a slow decision does.
        app.dmInvitations.get(ALICE.nostrPublicKey).expiresAt = Date.now() - 1;

        const accepted = await app.acceptDmInvitation(ALICE.nostrPublicKey);
        assert.equal(accepted, false);
        assertNothingRevealed(app, 'expired accept');
        assert.equal(await app.contactsStore.get(ALICE.nostrPublicKey), null);
    } finally {
        app.fake.restore();
    }
});

test('an invitation whose identity tuple is broken is refused at accept time', async () => {
    const app = await makeApp();
    try {
        // A valid gift wrap from Mallory that claims Alice's EVM address.
        const forged = offerFrom(MALLORY);
        forged.from.evmAddress = ALICE.evmAddress;

        await app.handleNostrInvitation(forged, { senderNostrPublicKey: MALLORY.nostrPublicKey });
        const accepted = await app.acceptDmInvitation(MALLORY.nostrPublicKey);

        assert.equal(accepted, false);
        assertNothingRevealed(app, 'forged tuple');
        assert.equal(await app.contactsStore.get(MALLORY.nostrPublicKey), null);
    } finally {
        app.fake.restore();
    }
});

// ─── 4. Trusted friends reconnect ────────────────────────────────────────

test('a trusted friend reconnects without asking again', async () => {
    const app = await makeApp();
    try {
        await app.contactsStore.save({ ...ALICE, name: 'Alice', trust: TRUST.TRUSTED });

        await app.handleNostrInvitation(offerFrom(ALICE, { sessionId: 'later' }), {
            senderNostrPublicKey: ALICE.nostrPublicKey
        });

        assert.equal(app.dmInvitations.list().length, 0, 'no approval is requested');
        assert.equal(app.channelsService.calls.createAnswer, 1);
        assert.equal(app.nostrDmSession.sent.length, 1);
        assert.equal(app.dmSelectedPeer, ALICE.nostrPublicKey);
    } finally {
        app.fake.restore();
    }
});

test('a trusted contact whose identity tuple no longer matches is not auto-answered', async () => {
    const app = await makeApp();
    try {
        await app.contactsStore.save({ ...ALICE, name: 'Alice', trust: TRUST.TRUSTED });

        // Somebody controlling Alice's npub but offering a different ECIES key.
        // Both keys are internally consistent; they are not the same identity.
        const impostor = offerFrom(ALICE);
        impostor.from.eciesPublicKey = MALLORY.eciesPublicKey;
        impostor.from.evmAddress = MALLORY.evmAddress;

        await app.handleNostrInvitation(impostor, { senderNostrPublicKey: ALICE.nostrPublicKey });

        assertNothingRevealed(app, 'identity mismatch on a trusted contact');
        assert.equal(app.dmInvitations.list().length, 1, 'it is held for review instead');
    } finally {
        app.fake.restore();
    }
});

test('a removed friend needs approval again', async () => {
    const app = await makeApp();
    try {
        await app.contactsStore.save({ ...ALICE, name: 'Alice', trust: TRUST.TRUSTED });
        await app.contactsStore.remove(ALICE.nostrPublicKey);

        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });

        assertNothingRevealed(app, 'removed friend');
        assert.equal(app.dmInvitations.list().length, 1);
    } finally {
        app.fake.restore();
    }
});

// ─── 5. Failing closed ───────────────────────────────────────────────────

test('a locked wallet makes everyone unknown rather than everyone trusted', async () => {
    const app = await makeApp();
    try {
        await app.contactsStore.save({ ...ALICE, name: 'Alice', trust: TRUST.TRUSTED });
        await app.wallet.lock();

        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });

        // The contacts store cannot answer "is this a friend?", and the only
        // safe reading of that is "no".
        assertNothingRevealed(app, 'locked wallet');
        assert.equal(app.dmInvitations.list().length, 1);
    } finally {
        app.fake.restore();
    }
});

test('an invitation arriving without an authenticated identity is ignored entirely', async () => {
    const app = await makeApp();
    try {
        app.authController.getActiveIdentity = () => ({ address: '' });
        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });

        assertNothingRevealed(app, 'no local identity');
        assert.equal(app.dmInvitations.list().length, 0);
    } finally {
        app.fake.restore();
    }
});

// ─── 6. The queue itself ─────────────────────────────────────────────────

test('expired invitations drop out of the queue on their own', () => {
    let clock = 1_000_000;
    const queue = new PendingInvitations({ now: () => clock });

    queue.add({
        bootstrap: { from: ALICE, session: { sessionId: 's', expiresAt: clock + 1000 } },
        senderNostrPublicKey: ALICE.nostrPublicKey
    });
    assert.equal(queue.size, 1);

    clock += 2000;
    assert.equal(queue.size, 0, 'a stale offer is not an actionable request');
    assert.deepEqual(queue.list(), []);
});

test('taking an invitation consumes it exactly once', () => {
    const queue = new PendingInvitations();
    queue.add({
        bootstrap: { from: ALICE, session: { sessionId: 's', expiresAt: Date.now() + 60_000 } },
        senderNostrPublicKey: ALICE.nostrPublicKey
    });

    assert.ok(queue.take(ALICE.nostrPublicKey), 'first take succeeds');
    assert.equal(queue.take(ALICE.nostrPublicKey), null, 'a double click cannot answer twice');
});

test('a profile name never replaces the npub in a pending record', () => {
    const queue = new PendingInvitations();
    const record = queue.add({
        bootstrap: { from: ALICE, session: { sessionId: 's', expiresAt: Date.now() + 60_000 } },
        senderNostrPublicKey: ALICE.nostrPublicKey,
        npub: ALICE.npub,
        profileName: 'Alice‮ evil'
    });

    assert.equal(record.npub, ALICE.npub, 'identity is the npub, not the label');
    assert.ok(!/[‪-‮]/.test(record.profileName), 'relay-supplied names are sanitized');
});

test('clearing the queue leaves nothing behind, as a wallet lock requires', () => {
    const queue = new PendingInvitations();
    queue.add({
        bootstrap: { from: ALICE, session: { sessionId: 's', expiresAt: Date.now() + 60_000 } },
        senderNostrPublicKey: ALICE.nostrPublicKey
    });
    queue.clear();
    assert.equal(queue.size, 0);
    assert.deepEqual(queue.list(), []);
});

// ─── 7. The architecture is unchanged around it ──────────────────────────

/** Lifecycle source with comments stripped, so prose cannot satisfy a rule. */
async function lifecycleCode() {
    const source = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../src/core/bootstrap/Lifecycle.js', import.meta.url), 'utf8')
    );
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('consent is a gate in front of the existing transport, not a replacement', async () => {
    const code = await lifecycleCode();

    // The answer still goes through the same one method, and the Web25 ECIES
    // envelope on top of the NIP-44 gift wrap is still there.
    assert.equal(
        (code.match(/createAnswerPayloadFromRemoteOffer\(/g) || []).length,
        1,
        'exactly one place creates an answer, so the gate cannot be bypassed'
    );
    assert.ok(code.includes('recipientEciesPublicKey'));
    assert.ok(code.includes('setNostrFallback'), 'the Nostr fallback transport is still wired');
    assert.ok(code.includes('applyRemoteAnswerPayload'), 'the answer path is untouched');
});

test('the gate sits before answer creation, never after', async () => {
    const code = await lifecycleCode();
    const handler = code.slice(code.indexOf('export async function handleNostrInvitation'));
    const offerBranch = handler.slice(0, handler.indexOf("if (bootstrap.role === 'answer')"));

    const trustCheck = offerBranch.indexOf('isTrusted(');
    const hold = offerBranch.indexOf('holdDmInvitation(');
    const answer = offerBranch.indexOf('answerDmInvitation(');

    assert.ok(trustCheck > -1 && hold > -1 && answer > -1, 'all three steps are present');
    assert.ok(trustCheck < answer, 'trust is checked before an answer is created');
    assert.ok(hold < answer, 'the unknown-peer path returns before an answer is created');
});
