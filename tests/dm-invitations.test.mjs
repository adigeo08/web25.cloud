/**
 * First contact in the Direct Messenger.
 *
 * The flow this file pins down used to be a dead end. A chat request — the only
 * thing a stranger can send, because an offer needs consent first — was
 * recorded as intent and announced in a toast that told the local user to go
 * and find the sender themselves. Nothing was clickable. Two people could only
 * meet by both independently searching for each other, and even then the side
 * that did not initiate parked the other's offer, because the offer came from
 * somebody who was not a stored contact yet. The handshake never completed.
 *
 * What is fixed here:
 *
 *   - a request from a stranger becomes a pending invitation with Accept and
 *     Decline, so one person asking is enough;
 *   - accepting is what sends consent back, and the peer's offer is then
 *     answered instead of parked;
 *   - a trusted contact does not have to ask twice;
 *   - declining stays silent, and stays silent on every retry.
 *
 * What must *not* change is the privacy property from `dm-consent.test.mjs`:
 * nothing is created, gathered or sent before a person says yes. Every test
 * that reaches Accept asserts what was revealed, and every test that does not
 * asserts that nothing was.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// `Lifecycle.js` is browser code; the same minimal stand-ins the consent tests
// use let the real module load, so these tests drive the shipped functions.
globalThis.window = globalThis.window || {
    location: { hostname: 'localhost', origin: 'http://localhost', pathname: '/' }
};
globalThis.document = globalThis.document || {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
};

const {
    handleChatRequest,
    holdChatRequest,
    consentToChatWith,
    handleNostrInvitation,
    holdDmInvitation,
    invitationMatchesContact,
    answerDmInvitation,
    acceptDmInvitation,
    declineDmInvitation
} = await import('../src/core/bootstrap/Lifecycle.js');
import { ContactsStore, TRUST } from '../src/channels/ContactsStore.js';
import { PendingInvitations } from '../src/channels/PendingInvitations.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
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
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
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

/** Counts everything that would reveal something about the local user. */
class LeakCountingChannels {
    constructor() {
        this.currentChannel = null;
        this.calls = { createAnswer: 0, iceGathering: 0 };
    }

    async createAnswerPayloadFromRemoteOffer(_room, offerPayload, _identity) {
        this.calls.createAnswer += 1;
        this.calls.iceGathering += 1;
        return { description: { type: 'answer', sdp: 'v=0\r\n' }, publicKey: offerPayload.publicKey, evmAddress: '0x' };
    }
}

class RecordingDmSession {
    constructor() {
        this.sent = [];
        this.giftWrapped = [];
        this.peerNostrPublicKey = '';
        this.started = false;
    }

    async start() {
        this.started = true;
    }

    setPeer(peer) {
        this.peerNostrPublicKey = peer;
    }

    async sendInvitation(params) {
        this.sent.push(params);
    }

    async sendGiftWrapped(peer, kind, content) {
        this.giftWrapped.push({ peer, kind, content });
    }
}

/**
 * A presence double that keeps the real intent semantics: a pair is mutual only
 * when both sides have asked, and mutual intent announces once.
 */
function makePresence(onMutual) {
    return {
        sent: new Set(),
        received: new Set(),
        cleared: [],
        announced: new Set(),
        _settle(peer) {
            if (!this.sent.has(peer) || !this.received.has(peer)) return this.state(peer);
            if (!this.announced.has(peer)) {
                this.announced.add(peer);
                onMutual?.(peer);
            }
            return 'mutual';
        },
        state(peer) {
            if (this.sent.has(peer) && this.received.has(peer)) return 'mutual';
            if (this.sent.has(peer)) return 'sent';
            if (this.received.has(peer)) return 'received';
            return 'none';
        },
        async sendChatRequest(peer, sendGiftWrapped) {
            // Mirrors the real signature, which awaits its second argument.
            if (typeof sendGiftWrapped !== 'function') throw new TypeError('sendGiftWrapped is not a function');
            await sendGiftWrapped(peer, NOSTR_CONFIG.WEB25_CHAT_REQUEST_KIND, '{}');
            this.sent.add(peer);
            return this._settle(peer);
        },
        receiveChatRequest(peer) {
            this.received.add(peer);
            return this._settle(peer);
        },
        clearIntent(peer) {
            this.cleared.push(peer);
            this.sent.delete(peer);
            this.received.delete(peer);
            this.announced.delete(peer);
        },
        isOnline: () => false,
        watch: () => {}
    };
}

/** The slice of the app the first-contact path touches. */
async function makeApp({ unlocked = true } = {}) {
    const fake = installFakeIndexedDb();
    const wallet = makeWallet();
    if (unlocked) await wallet.unlock();

    const toasts = [];
    const logs = [];
    const mutual = [];

    const app = {
        authController: { getActiveIdentity: () => ({ address: '0xlocal', chainId: 1 }) },
        contactsStore: new ContactsStore({ signer: wallet.signer }),
        dmInvitations: new PendingInvitations(),
        dmConsentedPeers: new Set(),
        dmDeclinedPeers: new Set(),
        channelsService: new LeakCountingChannels(),
        nostrDmSession: new RecordingDmSession(),
        presenceService: makePresence((peer) => mutual.push(peer)),
        nostrPool: null,
        dmSelectedPeer: '',
        dmPendingContactName: '',
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
        mutual,
        fake
    };

    app.handleChatRequest = handleChatRequest.bind(app);
    app.holdChatRequest = holdChatRequest.bind(app);
    app.consentToChatWith = consentToChatWith.bind(app);
    app.handleNostrInvitation = handleNostrInvitation.bind(app);
    app.holdDmInvitation = holdDmInvitation.bind(app);
    app.invitationMatchesContact = invitationMatchesContact.bind(app);
    app.answerDmInvitation = answerDmInvitation.bind(app);
    app.acceptDmInvitation = acceptDmInvitation.bind(app);
    app.declineDmInvitation = declineDmInvitation.bind(app);

    return app;
}

function assertNothingRevealed(app, label) {
    assert.equal(app.channelsService.calls.createAnswer, 0, `${label}: no answer may be created`);
    assert.equal(app.channelsService.calls.iceGathering, 0, `${label}: no ICE before consent`);
    assert.equal(app.nostrDmSession.sent.length, 0, `${label}: no invitation may be sent`);
    assert.equal(app.nostrDmSession.giftWrapped.length, 0, `${label}: nothing may be sent to the peer`);
}

// ─── 1. A request is an invitation, not a notification ───────────────────

test('a chat request from a stranger becomes an invitation the user can act on', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);

        const [pending] = app.dmInvitations.list();
        assert.ok(pending, 'the request is queued rather than only announced');
        assert.equal(pending.kind, 'request');
        assert.equal(pending.peerNostrPublicKey, MALLORY.nostrPublicKey);
        assert.equal(pending.npub, MALLORY.npub, 'the npub is the identity shown');

        // The whole point of the change, and the whole point of the gate: the
        // user is asked, and nothing has left the browser to ask them.
        assertNothingRevealed(app, 'a parked request');
    } finally {
        app.fake.restore();
    }
});

test('a request carries no keys, so the row has no identity to show yet', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        const [pending] = app.dmInvitations.list();
        assert.equal(pending.eciesPublicKey, '');
        assert.equal(pending.evmAddress, '');
        assert.ok(pending.expiresAt > Date.now(), 'intent goes stale, so the entry does too');
    } finally {
        app.fake.restore();
    }
});

test('the inbound request is still recorded as intent', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        assert.equal(app.presenceService.state(ALICE.nostrPublicKey), 'received');
        assert.equal(app.mutual.length, 0, 'one side asking is not a pair');
    } finally {
        app.fake.restore();
    }
});

test('a repeated request does not stack up in the panel', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        assert.equal(app.dmInvitations.size, 1);
    } finally {
        app.fake.restore();
    }
});

test('an offer already waiting is not blanked by a later bare request', async () => {
    const app = await makeApp();
    try {
        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });
        await app.handleChatRequest(MALLORY.nostrPublicKey);

        const [pending] = app.dmInvitations.list();
        assert.equal(pending.kind, 'offer', 'the answerable entry survives');
        assert.equal(pending.evmAddress, MALLORY.evmAddress);
    } finally {
        app.fake.restore();
    }
});

// ─── 2. Accepting is what sends consent ──────────────────────────────────

test('accepting a request sends our own request back, and nothing else', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        const accepted = await app.acceptDmInvitation(ALICE.nostrPublicKey);

        assert.equal(accepted, true);
        assert.equal(app.nostrDmSession.giftWrapped.length, 1, 'exactly one gift wrap: our consent');
        assert.equal(app.nostrDmSession.giftWrapped[0].kind, NOSTR_CONFIG.WEB25_CHAT_REQUEST_KIND);
        assert.equal(app.nostrDmSession.giftWrapped[0].peer, ALICE.nostrPublicKey);

        // A request has no SDP, so there is still nothing to answer here.
        assert.equal(app.channelsService.calls.createAnswer, 0);
        assert.equal(app.channelsService.calls.iceGathering, 0);
    } finally {
        app.fake.restore();
    }
});

test('accepting completes the pair, so the handshake may finally begin', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        await app.acceptDmInvitation(ALICE.nostrPublicKey);

        assert.equal(app.presenceService.state(ALICE.nostrPublicKey), 'mutual');
        assert.deepEqual(app.mutual, [ALICE.nostrPublicKey], 'mutual intent is announced exactly once');
    } finally {
        app.fake.restore();
    }
});

test('an accepted request is consumed, so the panel does not keep asking', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        await app.acceptDmInvitation(ALICE.nostrPublicKey);
        assert.equal(app.dmInvitations.size, 0);
    } finally {
        app.fake.restore();
    }
});

test('an expired request is refused at accept time', async () => {
    const app = await makeApp();
    try {
        app.dmInvitations.add({
            kind: 'request',
            senderNostrPublicKey: ALICE.nostrPublicKey,
            npub: ALICE.npub,
            expiresAt: Date.now() - 1
        });
        const accepted = await app.acceptDmInvitation(ALICE.nostrPublicKey);

        assert.equal(accepted, false);
        assertNothingRevealed(app, 'an expired request');
    } finally {
        app.fake.restore();
    }
});

// ─── 3. The deadlock: an offer after consent must be answered ────────────

test('the offer that follows an accepted request is answered, not parked again', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        await app.acceptDmInvitation(ALICE.nostrPublicKey);

        // Alice is the one who offers. Before this fix her offer was parked —
        // she is not a stored contact — and both sides waited forever.
        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });

        assert.equal(app.channelsService.calls.createAnswer, 1, 'the offer is answered');
        assert.equal(app.dmInvitations.size, 0, 'and not queued as a fresh decision');
        const answer = app.nostrDmSession.sent.find((message) => message.role === 'answer');
        assert.ok(answer, 'the answer goes back over Nostr');
        assert.equal(answer.recipient, ALICE.nostrPublicKey);
    } finally {
        app.fake.restore();
    }
});

test('consent is per peer: accepting one does not open the door to another', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        await app.acceptDmInvitation(ALICE.nostrPublicKey);

        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });

        assert.equal(app.channelsService.calls.createAnswer, 0, "Mallory's offer is still parked");
        assert.equal(app.dmInvitations.list()[0].peerNostrPublicKey, MALLORY.nostrPublicKey);
    } finally {
        app.fake.restore();
    }
});

test('consent does not waive the identity check on the offer that follows', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        await app.acceptDmInvitation(ALICE.nostrPublicKey);

        // Alice's npub, somebody else's keys: the tuple does not hold.
        const forged = offerFrom(ALICE);
        forged.from.eciesPublicKey = MALLORY.eciesPublicKey;
        await app.handleNostrInvitation(forged, { senderNostrPublicKey: ALICE.nostrPublicKey });

        assert.equal(app.channelsService.calls.createAnswer, 0, 'a broken tuple is never answered');
        assert.ok(
            app.dmInvitations.has(ALICE.nostrPublicKey),
            'it goes back to the panel as a decision, rather than through'
        );
    } finally {
        app.fake.restore();
    }
});

// ─── 4. A trusted contact does not have to ask twice ─────────────────────

test('a trusted contact', async (t) => {
    await t.test('is consented to automatically when they ask', async () => {
        const app = await makeApp();
        try {
            await app.contactsStore.save({
                nostrPublicKey: ALICE.nostrPublicKey,
                npub: ALICE.npub,
                eciesPublicKey: ALICE.eciesPublicKey,
                evmAddress: ALICE.evmAddress,
                name: 'Alice',
                trust: TRUST.TRUSTED
            });

            await app.handleChatRequest(ALICE.nostrPublicKey);

            assert.equal(app.dmInvitations.size, 0, 'a friend is not queued as a stranger');
            assert.equal(app.presenceService.state(ALICE.nostrPublicKey), 'mutual');
            assert.equal(app.nostrDmSession.giftWrapped.length, 1, 'our request goes back on its own');
        } finally {
            app.fake.restore();
        }
    });

    await t.test('is still only a contact: a stranger is not', async () => {
        const app = await makeApp();
        try {
            await app.handleChatRequest(MALLORY.nostrPublicKey);
            assert.equal(app.dmInvitations.size, 1, 'a stranger still waits for a decision');
            assertNothingRevealed(app, 'a stranger asking');
        } finally {
            app.fake.restore();
        }
    });

    await t.test('is nobody when the wallet is locked, so the request waits', async () => {
        const app = await makeApp({ unlocked: false });
        try {
            await app.handleChatRequest(ALICE.nostrPublicKey);
            assert.equal(app.dmInvitations.size, 1, 'failing closed means asking, not auto-connecting');
            assertNothingRevealed(app, 'a locked wallet');
        } finally {
            app.fake.restore();
        }
    });
});

// ─── 5. Declining stays silent, and stays silent on repeats ──────────────

test('declining tells the sender nothing at all', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.declineDmInvitation(MALLORY.nostrPublicKey);

        assert.equal(app.dmInvitations.size, 0);
        assertNothingRevealed(app, 'a declined request');
    } finally {
        app.fake.restore();
    }
});

test('a declined peer cannot nag: their retries never re-open the panel', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.declineDmInvitation(MALLORY.nostrPublicKey);

        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.handleChatRequest(MALLORY.nostrPublicKey);

        assert.equal(app.dmInvitations.size, 0, 'repeats are dropped in silence');
        assertNothingRevealed(app, 'a declined peer retrying');
    } finally {
        app.fake.restore();
    }
});

test('declining drops their intent, so a later pair cannot form behind the decision', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.declineDmInvitation(MALLORY.nostrPublicKey);

        assert.deepEqual(app.presenceService.cleared, [MALLORY.nostrPublicKey]);
        assert.equal(app.presenceService.state(MALLORY.nostrPublicKey), 'none');
    } finally {
        app.fake.restore();
    }
});

test("a declined peer's offer is still parked rather than answered", async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(MALLORY.nostrPublicKey);
        await app.declineDmInvitation(MALLORY.nostrPublicKey);

        await app.handleNostrInvitation(offerFrom(MALLORY), { senderNostrPublicKey: MALLORY.nostrPublicKey });
        assert.equal(app.channelsService.calls.createAnswer, 0);
    } finally {
        app.fake.restore();
    }
});

test('changing your mind works: a declined peer can be accepted after asking again', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        await app.declineDmInvitation(ALICE.nostrPublicKey);

        // Consent given by another route — searching for them and asking —
        // clears the refusal, because it is the same person deciding again.
        await app.consentToChatWith(ALICE.nostrPublicKey);

        assert.equal(app.dmDeclinedPeers.has(ALICE.nostrPublicKey), false);
        assert.equal(app.dmConsentedPeers.has(ALICE.nostrPublicKey), true);
    } finally {
        app.fake.restore();
    }
});

// ─── 6. Asking somebody is consent to their reply ────────────────────────

test('the side that asks first answers the offer it invited', async () => {
    const app = await makeApp();
    try {
        // We searched for Alice and asked her; she accepted and offered.
        await app.consentToChatWith(ALICE.nostrPublicKey);
        await app.handleNostrInvitation(offerFrom(ALICE), { senderNostrPublicKey: ALICE.nostrPublicKey });

        assert.equal(app.channelsService.calls.createAnswer, 1, 'the invited reply is answered');
        assert.equal(app.dmInvitations.size, 0);
    } finally {
        app.fake.restore();
    }
});

test('consenting clears a pending entry from the same peer', async () => {
    const app = await makeApp();
    try {
        await app.handleChatRequest(ALICE.nostrPublicKey);
        assert.equal(app.dmInvitations.size, 1);

        // The user went to the search box instead of pressing Accept.
        await app.consentToChatWith(ALICE.nostrPublicKey);
        assert.equal(app.dmInvitations.size, 0, 'the panel stops asking an answered question');
    } finally {
        app.fake.restore();
    }
});

test('consent needs an unlocked wallet, and says so', async () => {
    const app = await makeApp();
    app.authController.getActiveIdentity = () => ({ address: '' });
    try {
        await assert.rejects(() => app.consentToChatWith(ALICE.nostrPublicKey), /Unlock your wallet/);
        assertNothingRevealed(app, 'a locked wallet consenting');
    } finally {
        app.fake.restore();
    }
});

// ─── 7. The gate is still where it was ───────────────────────────────────

/** Lifecycle source with comments stripped, so prose cannot satisfy a rule. */
async function lifecycleCode() {
    const source = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../src/core/bootstrap/Lifecycle.js', import.meta.url), 'utf8')
    );
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('a request is parked before anything is sent, never after', async () => {
    const code = await lifecycleCode();
    const handler = code.slice(code.indexOf('export async function handleChatRequest'));
    const body = handler.slice(0, handler.indexOf('export async function holdChatRequest'));

    const declined = body.indexOf('dmDeclinedPeers');
    const trust = body.indexOf('isTrusted(');
    const consent = body.indexOf('consentToChatWith(');
    const hold = body.indexOf('holdChatRequest(');

    assert.ok(declined > -1 && trust > -1 && consent > -1 && hold > -1, 'all four steps are present');
    assert.ok(declined < trust, 'a refusal is honoured before anything else is considered');
    assert.ok(trust < consent, 'only a trusted contact reaches automatic consent');
    assert.ok(consent < hold, 'everybody else falls through to the panel');
});

test('there is still exactly one place that creates an answer', async () => {
    const code = await lifecycleCode();
    assert.equal(
        (code.match(/createAnswerPayloadFromRemoteOffer\(/g) || []).length,
        1,
        'consent cannot be bypassed by a second answer path'
    );
});
