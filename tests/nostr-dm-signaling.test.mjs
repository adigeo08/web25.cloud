/**
 * Encrypted WebRTC signalling over Nostr.
 *
 * These tests drive the real modules end to end with two in-memory wallets and
 * a scripted relay pool: A addresses B by `npub`, the gift-wrapped offer is
 * published, B decrypts and validates it, answers back, and A accepts the
 * answer. They also pin the things that must *not* happen: nothing sensitive
 * on the wire in the clear, no replays, no expired invitations, and no
 * acceptance of an invitation whose Nostr sender does not match the ECIES
 * identity inside it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from '../src/channels/ecies.js';
import { nostrCore, nip59 } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { NOSTR_CONFIG } from '../src/config/nostr.config.js';
import {
    createNostrChatEvent,
    createNostrDMInvitation,
    openNostrGiftWrap,
    verifyNostrDMInvitation
} from '../src/channels/NostrDirectMessageBootstrap.js';
import { _resetBootstrapReplayCache } from '../src/channels/DirectMessageBootstrapCore.js';

const ALICE_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BOB_PRIV = '0x2222222222222222222222222222222222222222222222222222222222222222';
const EVE_PRIV = '0x3333333333333333333333333333333333333333333333333333333333333333';

const OFFER_DESC = { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 udp 2130706431 203.0.113.7 54321 typ host' };
const ANSWER_DESC = { type: 'answer', sdp: 'v=0\r\na=candidate:2 1 udp 2130706431 198.51.100.9 41234 typ host' };

/**
 * A wallet: the worker core plus the narrow capability handle the application
 * is given. Exactly the shape `createLocalWalletSigner()` produces in the app.
 */
function makeWallet(privateKey) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        counter += 1;
        const response = await core.handle({ id: `${privateKey.slice(2, 6)}-${counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };

    const signer = {
        getPublicKey: async () => (await call(WALLET_WORKER_OPS.GET_PUBLIC_KEY)).publicKey,
        signMessage: async (message) => (await call(WALLET_WORKER_OPS.ECIES_SIGN, { message })).signature,
        eciesDecrypt: async (ciphertext) => (await call(WALLET_WORKER_OPS.ECIES_DECRYPT, { ciphertext })).plaintext,
        getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY),
        nostrSignEvent: async (template) => (await call(WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, template)).event,
        nostrEncrypt: async (plaintext, peerPublicKey) =>
            (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
        nostrDecrypt: async (payload, peerPublicKey) =>
            (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
    };

    const publicKey = getPublicKeyFromPrivateKey(privateKey);
    return {
        core,
        signer,
        lock: () => core.handle({ id: 'lock', type: WALLET_WORKER_OPS.LOCK }),
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        publicKey,
        address: evmAddressFromPublicKey(publicKey),
        nostrPublicKey: nostrCore.getNostrPublicKey(privateKey),
        npub: npubEncode(nostrCore.getNostrPublicKey(privateKey))
    };
}

async function wallets() {
    _resetBootstrapReplayCache();
    const alice = makeWallet(ALICE_PRIV);
    const bob = makeWallet(BOB_PRIV);
    const eve = makeWallet(EVE_PRIV);
    await Promise.all([alice.unlock(), bob.unlock(), eve.unlock()]);
    return { alice, bob, eve };
}

/** Open a gift wrap as `wallet` and validate whatever invitation is inside. */
function receiveInvitation(wallet, event, extra = {}) {
    return openNostrGiftWrap({ signer: wallet.signer, giftWrap: event, localNostrPublicKey: wallet.nostrPublicKey }).then(
        ({ rumor, senderNostrPublicKey }) =>
            verifyNostrDMInvitation({
                signer: wallet.signer,
                rumor,
                senderNostrPublicKey,
                localNostrPublicKey: wallet.nostrPublicKey,
                localAddress: wallet.address,
                ...extra
            })
    );
}

// ─── 1. Full offer/answer exchange ───────────────────────────────────────

test('an npub-addressed offer and its answer complete the handshake', async () => {
    const { alice, bob } = await wallets();

    const offer = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    const received = await receiveInvitation(bob, offer.event);
    assert.equal(received.role, 'offer');
    assert.equal(received.from.evmAddress, alice.address);
    assert.equal(received.from.eciesPublicKey, alice.publicKey);
    assert.equal(received.webrtc.description.sdp, OFFER_DESC.sdp);

    // Bob now knows Alice's full ECIES key, so the answer additionally goes
    // through the existing Web25 ECIES envelope.
    const answer = await createNostrDMInvitation({
        signer: bob.signer,
        identity: { address: bob.address },
        eciesPublicKey: bob.publicKey,
        role: 'answer',
        webrtcDescription: ANSWER_DESC,
        recipient: alice.npub,
        recipientEciesPublicKey: alice.publicKey,
        replyToSessionId: received.session.sessionId
    });
    assert.equal(answer.envelope.type, 'direct-message-bootstrap-v2');
    assert.ok(answer.envelope.encrypted.ciphertext);

    const acceptedAnswer = await receiveInvitation(alice, answer.event, {
        expectedReplyToSessionId: received.session.sessionId
    });
    assert.equal(acceptedAnswer.role, 'answer');
    assert.equal(acceptedAnswer.webrtc.description.sdp, ANSWER_DESC.sdp);
    assert.equal(acceptedAnswer.from.evmAddress, bob.address);
});

test('a raw hex Nostr public key is accepted in place of an npub', async () => {
    const { alice, bob } = await wallets();
    const offer = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.nostrPublicKey
    });
    const received = await receiveInvitation(bob, offer.event);
    assert.equal(received.role, 'offer');
});

// ─── 2. Nothing sensitive is publicly readable ───────────────────────────

test('the published event exposes nothing but a recipient tag', async () => {
    const { alice, bob } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    const wire = JSON.stringify(event);
    for (const secret of [OFFER_DESC.sdp, '203.0.113.7', alice.address, alice.publicKey, alice.nostrPublicKey]) {
        assert.ok(!wire.includes(secret), `"${secret.slice(0, 24)}…" must not be publicly readable`);
    }

    // The wrap is signed by a throwaway key, not by the sender's identity.
    assert.equal(event.kind, nip59.NOSTR_KIND_GIFT_WRAP);
    assert.notEqual(event.pubkey, alice.nostrPublicKey);
    assert.deepEqual(event.tags, [['p', bob.nostrPublicKey]]);
    assert.equal(nostrCore.verifyEvent(event), true);
});

test('a third party cannot open a gift wrap addressed to somebody else', async () => {
    const { alice, bob, eve } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    await assert.rejects(
        () => openNostrGiftWrap({ signer: eve.signer, giftWrap: event, localNostrPublicKey: eve.nostrPublicKey }),
        /not addressed to this identity/i
    );
});

// ─── 3. Replay and expiry ────────────────────────────────────────────────

test('the same invitation cannot be accepted twice', async () => {
    const { alice, bob } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    await receiveInvitation(bob, event);
    await assert.rejects(() => receiveInvitation(bob, event), /replay detected/i);
});

test('an expired invitation is rejected', async () => {
    const { alice, bob } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub,
        ttlMs: 1
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(() => receiveInvitation(bob, event), /expired/i);
});

test('an answer that does not reference the outstanding offer is rejected', async () => {
    const { alice, bob } = await wallets();
    const answer = await createNostrDMInvitation({
        signer: bob.signer,
        identity: { address: bob.address },
        eciesPublicKey: bob.publicKey,
        role: 'answer',
        webrtcDescription: ANSWER_DESC,
        recipient: alice.npub,
        recipientEciesPublicKey: alice.publicKey,
        replyToSessionId: 'aaaaaaaaaaaaaaaaaaaaaaaa'
    });

    await assert.rejects(
        () => receiveInvitation(alice, answer.event, { expectedReplyToSessionId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }),
        /does not reference the expected offer session/i
    );
});

// ─── 4. Identity binding ─────────────────────────────────────────────────

test('an invitation whose Nostr sender does not match its ECIES identity is rejected', async () => {
    const { alice, bob, eve } = await wallets();

    // Eve wraps a payload that claims to be from Alice.
    const forged = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    const { rumor } = await openNostrGiftWrap({
        signer: bob.signer,
        giftWrap: forged.event,
        localNostrPublicKey: bob.nostrPublicKey
    });

    await assert.rejects(
        () =>
            verifyNostrDMInvitation({
                signer: bob.signer,
                rumor,
                // The relay claims Eve signed the seal, while the payload says Alice.
                senderNostrPublicKey: eve.nostrPublicKey,
                localNostrPublicKey: bob.nostrPublicKey,
                localAddress: bob.address
            }),
        /Nostr sender key does not match the ECIES identity/i
    );
});

test('a tampered sealed payload fails its Web25 signature', async () => {
    const { alice, bob } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    const { rumor, senderNostrPublicKey } = await openNostrGiftWrap({
        signer: bob.signer,
        giftWrap: event,
        localNostrPublicKey: bob.nostrPublicKey
    });

    const envelope = JSON.parse(rumor.content);
    const inner = JSON.parse(envelope.sealed.payload);
    inner.webrtc.description.sdp = 'v=0\r\na=candidate:9 1 udp 1 192.0.2.66 9 typ host';
    envelope.sealed.payload = JSON.stringify(inner);

    await assert.rejects(
        () =>
            verifyNostrDMInvitation({
                signer: bob.signer,
                rumor: { ...rumor, content: JSON.stringify(envelope) },
                senderNostrPublicKey,
                localNostrPublicKey: bob.nostrPublicKey,
                localAddress: bob.address
            }),
        /signature verification failed/i
    );
});

test('an invitation addressed to a different identity is rejected', async () => {
    const { alice, bob, eve } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    const { rumor, senderNostrPublicKey } = await openNostrGiftWrap({
        signer: bob.signer,
        giftWrap: event,
        localNostrPublicKey: bob.nostrPublicKey
    });

    await assert.rejects(
        () =>
            verifyNostrDMInvitation({
                signer: eve.signer,
                rumor,
                senderNostrPublicKey,
                localNostrPublicKey: eve.nostrPublicKey,
                localAddress: eve.address
            }),
        /recipient does not match current user/i
    );
});

test('a NIP-59 seal signed by nobody is rejected', async () => {
    const { alice, bob } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    await assert.rejects(
        () =>
            openNostrGiftWrap({
                signer: bob.signer,
                giftWrap: { ...event, sig: 'f'.repeat(128) },
                localNostrPublicKey: bob.nostrPublicKey
            }),
        /signature verification/i
    );
});

// ─── 5. A locked wallet cannot signal at all ─────────────────────────────

test('a locked wallet cannot create an invitation', async () => {
    const { alice, bob } = await wallets();
    await alice.lock();

    await assert.rejects(
        () =>
            createNostrDMInvitation({
                signer: alice.signer,
                identity: { address: alice.address },
                eciesPublicKey: alice.publicKey,
                role: 'offer',
                webrtcDescription: OFFER_DESC,
                recipient: bob.npub
            }),
        /unlock your wallet|locked/i
    );
});

test('a locked wallet cannot open an inbound gift wrap', async () => {
    const { alice, bob } = await wallets();
    const { event } = await createNostrDMInvitation({
        signer: alice.signer,
        identity: { address: alice.address },
        eciesPublicKey: alice.publicKey,
        role: 'offer',
        webrtcDescription: OFFER_DESC,
        recipient: bob.npub
    });

    await bob.lock();
    await assert.rejects(
        () => openNostrGiftWrap({ signer: bob.signer, giftWrap: event, localNostrPublicKey: bob.nostrPublicKey }),
        /failed to decrypt|locked/i
    );
});

// ─── 6. Chat fallback events ─────────────────────────────────────────────

test('a chat fallback event is a NIP-17 rumor carrying the Web25 ciphertext', async () => {
    const { alice, bob } = await wallets();
    const wire = await ecies.eciesEncrypt(JSON.stringify({ plaintext: 'x', signature: 'y' }), bob.publicKey);

    const { event } = await createNostrChatEvent({ signer: alice.signer, recipient: bob.npub, wire });
    assert.equal(event.kind, nip59.NOSTR_KIND_GIFT_WRAP);
    assert.ok(!JSON.stringify(event).includes(wire), 'the Web25 ciphertext must not be publicly readable');

    const { rumor, senderNostrPublicKey } = await openNostrGiftWrap({
        signer: bob.signer,
        giftWrap: event,
        localNostrPublicKey: bob.nostrPublicKey
    });

    assert.equal(rumor.kind, NOSTR_CONFIG.NIP17_CHAT_KIND);
    assert.equal(rumor.content, wire);
    assert.equal(senderNostrPublicKey, alice.nostrPublicKey);
    assert.ok(rumor.tags.some((tag) => tag[0] === 'web25'));
});
