/**
 * One local secp256k1 key, three identities.
 *
 * These tests pin that the Nostr identity is *derived from the existing wallet
 * key* rather than generated separately, that its `npub` is correct, that
 * events signed inside the wallet worker verify, and that none of the new
 * worker operations leaks key material or works while the wallet is locked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { evmAddressFromPublicKey, getPublicKeyFromPrivateKey } from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubDecode, npubEncode, normalizeNostrPublicKey, shortNpub } from '../src/nostr/nip19.js';
import { bech32Decode, bech32Encode, convertBits } from '../src/nostr/bech32.js';

const PRIV_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const OTHER_PRIV_KEY = '0x2222222222222222222222222222222222222222222222222222222222222222';
const PUB_KEY = getPublicKeyFromPrivateKey(PRIV_KEY);
const ADDRESS = evmAddressFromPublicKey(PUB_KEY);

let requestId = 0;
function send(core, type, payload) {
    requestId += 1;
    return core.handle({ id: `n${requestId}`, type, payload });
}

function newCore(options = {}) {
    return createWalletWorkerCore({ ecies, nostr: nostrCore, ...options });
}

async function unlockedCore(options = {}) {
    const core = newCore(options);
    const response = await send(core, WALLET_WORKER_OPS.UNLOCK, { privateKey: PRIV_KEY });
    assert.equal(response.ok, true, response.error);
    return core;
}

// ─── 1. The Nostr identity is the existing key, not a new one ────────────

test('the Nostr public key is the x coordinate of the wallet ECIES public key', () => {
    const nostrPublicKey = nostrCore.getNostrPublicKey(PRIV_KEY);
    assert.equal(nostrPublicKey.length, 64);
    assert.equal(nostrPublicKey, nostrCore.nostrPublicKeyFromEciesPublicKey(PUB_KEY));
    assert.equal(nostrPublicKey, PUB_KEY.slice(2, 66).toLowerCase());
});

test('the Nostr identity is stable across derivations of the same wallet key', () => {
    assert.equal(nostrCore.getNostrPublicKey(PRIV_KEY), nostrCore.getNostrPublicKey(PRIV_KEY));
    assert.equal(nostrCore.getNostrPublicKey(PRIV_KEY), nostrCore.getNostrPublicKey(PRIV_KEY.slice(2)));
});

test('different wallet keys give different Nostr identities', () => {
    assert.notEqual(nostrCore.getNostrPublicKey(PRIV_KEY), nostrCore.getNostrPublicKey(OTHER_PRIV_KEY));
});

test('the EVM address and the Nostr key describe the very same key pair', async () => {
    const core = await unlockedCore();
    const evm = await send(core, WALLET_WORKER_OPS.GET_PUBLIC_KEY);
    const nostr = await send(core, WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY);

    assert.equal(evm.result.address, ADDRESS);
    assert.equal(nostr.result.nostrPublicKey, nostrCore.nostrPublicKeyFromEciesPublicKey(evm.result.publicKey));
});

// ─── 2. npub encoding ────────────────────────────────────────────────────

test('npubEncode matches the canonical NIP-19 test vector', () => {
    assert.equal(
        npubEncode('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'),
        'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
    );
});

test('npub round-trips and the worker reports the npub of its own key', async () => {
    const core = await unlockedCore();
    const { result } = await send(core, WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY);

    assert.match(result.npub, /^npub1[0-9a-z]+$/);
    assert.equal(npubDecode(result.npub), result.nostrPublicKey);
    assert.equal(npubEncode(result.nostrPublicKey), result.npub);
});

test('normalizeNostrPublicKey accepts npub and raw hex, and rejects anything else', () => {
    const hex = nostrCore.getNostrPublicKey(PRIV_KEY);
    assert.equal(normalizeNostrPublicKey(npubEncode(hex)), hex);
    assert.equal(normalizeNostrPublicKey(hex.toUpperCase()), hex);
    assert.equal(normalizeNostrPublicKey(`0x${hex}`), hex);

    for (const bad of ['', 'not-an-npub', 'npub1invalid', hex.slice(0, 60), `${PUB_KEY}`]) {
        assert.throws(() => normalizeNostrPublicKey(bad), `"${bad}" must be rejected`);
    }
});

test('a corrupted npub fails its bech32 checksum', () => {
    const npub = npubEncode(nostrCore.getNostrPublicKey(PRIV_KEY));
    const flipped = `${npub.slice(0, -1)}${npub.endsWith('q') ? 'p' : 'q'}`;
    assert.throws(() => npubDecode(flipped), /checksum/i);
});

test('bech32 rejects mixed case and non-charset payloads', () => {
    const words = convertBits(new Uint8Array(32).fill(7), 8, 5, true);
    const encoded = bech32Encode('npub', words);
    assert.equal(bech32Decode(encoded).hrp, 'npub');
    assert.throws(() => bech32Decode(`${encoded.slice(0, 10).toUpperCase()}${encoded.slice(10)}`), /case/i);
    assert.throws(() => bech32Decode(encoded.replace(/.$/, 'b')), /character|checksum/i);
});

test('shortNpub keeps the display form recognisable', () => {
    const npub = npubEncode(nostrCore.getNostrPublicKey(PRIV_KEY));
    const short = shortNpub(npub);
    assert.ok(short.startsWith('npub1'));
    assert.ok(short.length < npub.length);
});

// ─── 3. Event signing happens inside the worker and verifies ─────────────

test('NOSTR_SIGN_EVENT returns a valid, correctly bound BIP-340 event', async () => {
    const core = await unlockedCore();
    const { result } = await send(core, WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, {
        kind: 13,
        created_at: 1700000000,
        tags: [['p', 'a'.repeat(64)]],
        content: 'sealed-content'
    });

    const event = result.event;
    assert.equal(event.pubkey, nostrCore.getNostrPublicKey(PRIV_KEY));
    assert.equal(event.id, nostrCore.getEventHash(event));
    assert.equal(nostrCore.verifyEvent(event), true);
});

test('a tampered event no longer verifies', async () => {
    const core = await unlockedCore();
    const { result } = await send(core, WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, {
        kind: 14,
        created_at: 1700000000,
        tags: [],
        content: 'original'
    });

    assert.equal(nostrCore.verifyEvent({ ...result.event, content: 'tampered' }), false);
    assert.equal(nostrCore.verifyEvent({ ...result.event, sig: 'f'.repeat(128) }), false);
    assert.equal(nostrCore.verifyEvent({ ...result.event, id: 'f'.repeat(64) }), false);
});

test('the worker rejects event templates outside the narrow schema', async () => {
    const core = await unlockedCore();

    const rejected = [
        { kind: -1, created_at: 1, tags: [], content: '' },
        { kind: 1.5, created_at: 1, tags: [], content: '' },
        { kind: 1, created_at: 'now', tags: [], content: '' },
        { kind: 1, created_at: 1, tags: 'p', content: '' },
        { kind: 1, created_at: 1, tags: [['p', 1]], content: '' },
        { kind: 1, created_at: 1, tags: [[]], content: '' },
        { kind: 1, created_at: 1, tags: [], content: 42 }
    ];

    for (const payload of rejected) {
        const response = await send(core, WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, payload);
        assert.equal(response.ok, false, `${JSON.stringify(payload)} must be rejected`);
    }
});

// ─── 4. NIP-44 through the worker ────────────────────────────────────────

test('NIP-44 encrypt/decrypt round-trips between two wallets', async () => {
    const alice = await unlockedCore();
    const bob = newCore();
    await send(bob, WALLET_WORKER_OPS.UNLOCK, { privateKey: OTHER_PRIV_KEY });

    const alicePub = nostrCore.getNostrPublicKey(PRIV_KEY);
    const bobPub = nostrCore.getNostrPublicKey(OTHER_PRIV_KEY);

    const encrypted = await send(alice, WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, {
        plaintext: 'sdp-and-ice-live-in-here',
        peerPublicKey: bobPub
    });
    assert.equal(encrypted.ok, true, encrypted.error);
    assert.ok(!encrypted.result.payload.includes('sdp-and-ice-live-in-here'));

    const decrypted = await send(bob, WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, {
        payload: encrypted.result.payload,
        peerPublicKey: alicePub
    });
    assert.equal(decrypted.result.plaintext, 'sdp-and-ice-live-in-here');
});

test('a third party cannot decrypt a NIP-44 payload addressed to someone else', async () => {
    const alice = await unlockedCore();
    const eve = newCore();
    await send(eve, WALLET_WORKER_OPS.UNLOCK, {
        privateKey: '0x3333333333333333333333333333333333333333333333333333333333333333'
    });

    const encrypted = await send(alice, WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, {
        plaintext: 'private',
        peerPublicKey: nostrCore.getNostrPublicKey(OTHER_PRIV_KEY)
    });

    const attempt = await send(eve, WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, {
        payload: encrypted.result.payload,
        peerPublicKey: nostrCore.getNostrPublicKey(PRIV_KEY)
    });
    assert.equal(attempt.ok, false);
    assert.match(attempt.error, /MAC/i);
});

test('malformed NIP-44 arguments are rejected by schema', async () => {
    const core = await unlockedCore();
    const peer = nostrCore.getNostrPublicKey(OTHER_PRIV_KEY);

    const bad = [
        [WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext: '', peerPublicKey: peer }],
        [WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext: 'x', peerPublicKey: 'nope' }],
        [WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext: 5, peerPublicKey: peer }],
        [WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload: 'not base64!!', peerPublicKey: peer }],
        [WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload: '', peerPublicKey: peer }]
    ];

    for (const [type, payload] of bad) {
        const response = await send(core, type, payload);
        assert.equal(response.ok, false, `${type} ${JSON.stringify(payload)} must be rejected`);
    }
});

// ─── 5. The worker never hands back key material ─────────────────────────

test('no Nostr operation returns the private key or an nsec', async () => {
    const core = await unlockedCore();
    const peer = nostrCore.getNostrPublicKey(OTHER_PRIV_KEY);
    const bare = PRIV_KEY.slice(2);

    const responses = [
        await send(core, WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY),
        await send(core, WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, { kind: 1, created_at: 1, tags: [], content: 'x' }),
        await send(core, WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext: 'x', peerPublicKey: peer })
    ];

    for (const response of responses) {
        const serialized = JSON.stringify(response);
        assert.equal(response.ok, true, response.error);
        assert.ok(!serialized.includes(bare), 'the private key must never appear in a worker response');
        assert.ok(!serialized.includes(PRIV_KEY), 'the private key must never appear in a worker response');
        assert.ok(!/nsec1/.test(serialized), 'no response may contain an nsec');
    }
});

test('the codebase contains no nsec encoder and no private-key accessor', () => {
    const sources = [
        'src/nostr/nostrCore.js',
        'src/nostr/nip19.js',
        'src/nostr/nip59.js',
        'src/nostr/nostr.js',
        'src/nostr/NostrRelayPool.js',
        'src/auth/walletWorkerCore.js',
        'src/auth/walletWorkerProtocol.js',
        'src/auth/WalletWorkerClient.js',
        'src/auth/LocalWalletService.js',
        'src/channels/NostrDirectMessageBootstrap.js',
        'src/channels/NostrDirectMessageSession.js'
    ];

    for (const path of sources) {
        const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
        assert.ok(!/nsecEncode|toNsec|nsec1/.test(source), `${path} must not encode an nsec`);
        assert.ok(!/getPrivateKey|exportPrivateKey|revealPrivateKey/.test(source), `${path} must not expose the key`);
    }
});

test('the new operations are narrow: none of them looks like an executor', () => {
    for (const op of Object.keys(WALLET_WORKER_OPS)) {
        assert.ok(
            !/EXEC|EVAL|RUN|CALL|EXPORT|GET_PRIVATE|REVEAL|NSEC/i.test(op),
            `operation ${op} looks like an arbitrary-execution or key-export command`
        );
    }
});

// ─── 6. A locked wallet blocks every Nostr private-key operation ─────────

test('a locked wallet refuses every Nostr operation that needs the key', async () => {
    const core = newCore();
    const peer = nostrCore.getNostrPublicKey(OTHER_PRIV_KEY);

    const locked = [
        [WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY, {}],
        [WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, { kind: 1, created_at: 1, tags: [], content: 'x' }],
        [WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext: 'x', peerPublicKey: peer }],
        [WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload: 'AgAA', peerPublicKey: peer }]
    ];

    for (const [type, payload] of locked) {
        const response = await send(core, type, payload);
        assert.equal(response.ok, false, `${type} must fail while locked`);
        assert.match(response.error, /locked|invalid|base64|size limit/i);
    }
});

test('an explicit LOCK stops Nostr signing immediately', async () => {
    const core = await unlockedCore();
    assert.equal((await send(core, WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY)).ok, true);

    await send(core, WALLET_WORKER_OPS.LOCK);

    const afterLock = await send(core, WALLET_WORKER_OPS.NOSTR_SIGN_EVENT, {
        kind: 13,
        created_at: 1700000000,
        tags: [],
        content: 'x'
    });
    assert.equal(afterLock.ok, false);
    assert.match(afterLock.error, /Wallet is locked/);
});

test('an expired session stops Nostr operations', async () => {
    let clock = 1_000_000;
    const core = newCore({ now: () => clock });
    const unlocked = await send(core, WALLET_WORKER_OPS.UNLOCK, { privateKey: PRIV_KEY, ttlMs: 1000 });
    assert.equal(unlocked.ok, true, unlocked.error);

    clock += 5000;
    const response = await send(core, WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY);
    assert.equal(response.ok, false);
    assert.match(response.error, /expired/i);
});
