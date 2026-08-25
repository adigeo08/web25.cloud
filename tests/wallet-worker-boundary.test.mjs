/**
 * Security boundary #2 — the EVM private key lives only inside the dedicated
 * wallet worker.
 *
 * These tests pin the properties the boundary depends on: the worker exposes a
 * closed operation set, none of those operations hands the key back, a locked
 * or expired session refuses to sign, and the service worker no longer carries
 * any wallet-session message.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { validateWalletRequest, WALLET_WORKER_OPS, WALLET_SESSION_TTL_MS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { eciesEncrypt, evmAddressFromPublicKey, getPublicKeyFromPrivateKey, verifySignature } from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

const PRIV_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const PUB_KEY = getPublicKeyFromPrivateKey(PRIV_KEY);
const ADDRESS = evmAddressFromPublicKey(PUB_KEY);

function newCore(options = {}) {
    return createWalletWorkerCore({ ecies, nostr: nostrCore, ...options });
}

let requestId = 0;
function send(core, type, payload) {
    requestId += 1;
    return core.handle({ id: `t${requestId}`, type, payload });
}

async function unlockedCore(options = {}) {
    const core = newCore(options);
    const response = await send(core, 'UNLOCK', { privateKey: PRIV_KEY });
    assert.equal(response.ok, true, response.error);
    return core;
}

// ─── the operation set is closed ─────────────────────────────────────────

test('the worker exposes exactly the agreed operations and no generic executor', () => {
    assert.deepEqual(Object.keys(WALLET_WORKER_OPS).sort(), [
        'ECIES_DECRYPT',
        'ECIES_SIGN',
        'GET_PUBLIC_KEY',
        'LOCK',
        'NOSTR_GET_PUBLIC_KEY',
        'NOSTR_NIP44_DECRYPT',
        'NOSTR_NIP44_ENCRYPT',
        'NOSTR_SIGN_EVENT',
        'SIGN_MESSAGE',
        'STATUS',
        'UNLOCK'
    ]);

    for (const op of Object.keys(WALLET_WORKER_OPS)) {
        assert.ok(
            !/EXEC|EVAL|RUN|CALL|EXPORT|GET_PRIVATE|REVEAL/i.test(op),
            `operation ${op} looks like an arbitrary-execution or key-export command`
        );
    }
});

test('the session TTL is 30 minutes', () => {
    assert.equal(WALLET_SESSION_TTL_MS, 30 * 60 * 1000);
});

test('unknown message types are rejected before any key material is touched', async () => {
    const core = await unlockedCore();

    for (const type of ['EXECUTE', 'GET_PRIVATE_KEY', 'EXPORT_KEY', 'eval', '', null, 42]) {
        const response = await core.handle({ id: 'x', type });
        assert.equal(response.ok, false, `type ${String(type)} must be rejected`);
        assert.match(response.error, /Unsupported wallet worker operation/);
    }
});

test('malformed envelopes and payloads are rejected by schema', async () => {
    const core = newCore();

    assert.equal((await core.handle(null)).ok, false);
    assert.equal((await core.handle('SIGN_MESSAGE')).ok, false);
    assert.equal((await core.handle({ type: 'STATUS' })).ok, false, 'missing id');
    assert.equal((await core.handle({ id: 'a', type: 'STATUS', payload: [] })).ok, false, 'array payload');

    // UNLOCK only accepts a well-formed 32-byte key.
    for (const privateKey of ['not-a-key', '0x1234', PRIV_KEY.slice(2), 123, null]) {
        const response = await send(core, 'UNLOCK', { privateKey });
        assert.equal(response.ok, false, `key ${String(privateKey)} must be rejected`);
    }

    // A TTL longer than the policy maximum is refused rather than silently clamped.
    const tooLong = await send(core, 'UNLOCK', { privateKey: PRIV_KEY, ttlMs: WALLET_SESSION_TTL_MS + 1 });
    assert.equal(tooLong.ok, false);

    // ECIES_DECRYPT rejects anything that is not a well-formed ECIES payload.
    await send(core, 'UNLOCK', { privateKey: PRIV_KEY });
    for (const ciphertext of ['zz', 'abc', '04'.repeat(10), 12, null]) {
        const response = await send(core, 'ECIES_DECRYPT', { ciphertext });
        assert.equal(response.ok, false, `ciphertext ${String(ciphertext)} must be rejected`);
    }
});

// ─── no operation returns the key ────────────────────────────────────────

test('no worker operation ever returns the private key', async () => {
    const core = await unlockedCore();
    const ciphertext = await eciesEncrypt('hello', PUB_KEY);

    const responses = await Promise.all([
        send(core, 'STATUS', {}),
        send(core, 'GET_PUBLIC_KEY', {}),
        send(core, 'SIGN_MESSAGE', { message: 'siwe payload' }),
        send(core, 'ECIES_SIGN', { message: 'dm payload' }),
        send(core, 'ECIES_DECRYPT', { ciphertext })
    ]);

    for (const response of responses) {
        assert.equal(response.ok, true, response.error);
        const serialized = JSON.stringify(response);
        assert.ok(!serialized.includes(PRIV_KEY), 'response leaked the 0x-prefixed private key');
        assert.ok(!serialized.includes(PRIV_KEY.slice(2)), 'response leaked the bare private key');
    }
});

test('the UNLOCK response reports identity only, not key material', async () => {
    const core = newCore();
    const response = await send(core, 'UNLOCK', { privateKey: PRIV_KEY });

    assert.equal(response.ok, true);
    assert.deepEqual(Object.keys(response.result).sort(), ['address', 'expiresAt', 'publicKey', 'unlocked']);
    assert.equal(response.result.address, ADDRESS);
    assert.equal(response.result.publicKey, PUB_KEY);
    assert.ok(!JSON.stringify(response.result).includes(PRIV_KEY.slice(2)));
});

// ─── the operations actually work ────────────────────────────────────────

test('SIGN_MESSAGE produces an EIP-191 signature that recovers to the wallet address', async () => {
    const { secp256k1 } = await import('@noble/curves/secp256k1');
    const { keccak_256 } = await import('@noble/hashes/sha3');

    const core = await unlockedCore();
    const message = 'web25 publish payload';
    const response = await send(core, 'SIGN_MESSAGE', { message });
    assert.equal(response.ok, true, response.error);

    const raw = response.result.signature.slice(2);
    assert.equal(raw.length, 130, '65-byte r||s||v signature');

    const messageBytes = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
    const preimage = new Uint8Array(prefix.length + messageBytes.length);
    preimage.set(prefix, 0);
    preimage.set(messageBytes, prefix.length);

    const signature = secp256k1.Signature.fromCompact(raw.slice(0, 128)).addRecoveryBit(parseInt(raw.slice(128), 16) - 27);
    const recovered = signature.recoverPublicKey(keccak_256(preimage)).toRawBytes(false);
    const recoveredHex = Array.from(recovered)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    assert.equal(evmAddressFromPublicKey(recoveredHex), ADDRESS);
});

test('ECIES_SIGN and ECIES_DECRYPT serve the Direct Messenger without exposing the key', async () => {
    const core = await unlockedCore();

    const signed = await send(core, 'ECIES_SIGN', { message: 'chat envelope' });
    assert.equal(await verifySignature('chat envelope', signed.result.signature, PUB_KEY), true);

    const ciphertext = await eciesEncrypt('inbound direct message', PUB_KEY);
    const decrypted = await send(core, 'ECIES_DECRYPT', { ciphertext });
    assert.equal(decrypted.result.plaintext, 'inbound direct message');
});

// ─── locking ─────────────────────────────────────────────────────────────

test('LOCK wipes the key immediately: later operations fail', async () => {
    const core = await unlockedCore();

    const lock = await send(core, 'LOCK', {});
    assert.deepEqual(lock.result, { unlocked: false });

    for (const op of ['SIGN_MESSAGE', 'ECIES_SIGN']) {
        const response = await send(core, op, { message: 'after lock' });
        assert.equal(response.ok, false);
        assert.match(response.error, /locked/i);
    }
    assert.equal((await send(core, 'GET_PUBLIC_KEY', {})).ok, false);
    assert.equal((await send(core, 'STATUS', {})).result.unlocked, false);
});

test('an expired session refuses to sign and reports itself locked', async () => {
    let clock = 1_000_000;
    const core = await unlockedCore({ now: () => clock });

    assert.equal((await send(core, 'STATUS', {})).result.unlocked, true);

    clock += WALLET_SESSION_TTL_MS + 1;

    const response = await send(core, 'SIGN_MESSAGE', { message: 'too late' });
    assert.equal(response.ok, false);
    assert.match(response.error, /expired/i);
    assert.equal((await send(core, 'STATUS', {})).result.unlocked, false);
});

test('activity extends the inactivity window', async () => {
    let clock = 1_000_000;
    const core = await unlockedCore({ now: () => clock });

    // Use the key just before the deadline, then step past the original one.
    clock += WALLET_SESSION_TTL_MS - 1000;
    assert.equal((await send(core, 'SIGN_MESSAGE', { message: 'keepalive' })).ok, true);

    clock += 2000;
    assert.equal((await send(core, 'SIGN_MESSAGE', { message: 'still alive' })).ok, true);
});

test('a fresh worker starts locked — restarting it means a locked wallet', async () => {
    const restarted = newCore();
    assert.equal((await send(restarted, 'STATUS', {})).result.unlocked, false);
    assert.equal((await send(restarted, 'SIGN_MESSAGE', { message: 'x' })).ok, false);
});

// ─── the main thread has no key accessor ─────────────────────────────────

test('LocalWalletService exposes no accessor that returns the private key', async () => {
    const service = await import('../src/auth/LocalWalletService.js');

    assert.equal(service.getUnlockedPrivateKey, undefined);
    for (const name of Object.keys(service)) {
        assert.ok(
            !/privatekey/i.test(name) || name === 'eciesDecryptWithLocalWallet',
            `LocalWalletService must not export a private-key accessor: ${name}`
        );
    }

    const source = readFileSync(new URL('../src/auth/LocalWalletService.js', import.meta.url), 'utf8');
    assert.ok(!/export\s+function\s+getUnlockedPrivateKey/.test(source));
});

test('ChannelsService is constructed with a capability handle, not a key', async () => {
    const source = readFileSync(new URL('../src/channels/ChannelsService.js', import.meta.url), 'utf8');

    assert.ok(!source.includes('getUnlockedPrivateKey'), 'ChannelsService must not import the key');
    assert.ok(!source.includes('getPrivateKey'), 'ChannelsService must not accept a key getter');
    assert.ok(source.includes('this._signer'), 'ChannelsService talks to a signer handle');
});

// ─── the service worker no longer carries the key ────────────────────────

test('the service worker answers no wallet-session message', async () => {
    const require = createRequire(import.meta.url);
    let messageListener = null;
    const posted = [];

    global.self = {
        addEventListener: (name, listener) => {
            if (name === 'message') messageListener = listener;
        },
        location: { origin: 'http://localhost' },
        clients: { claim: async () => {}, matchAll: async () => [] },
        skipWaiting: () => {}
    };

    delete require.cache[require.resolve('../peerweb-sw.js')];
    require('../peerweb-sw.js');
    assert.ok(messageListener, 'the service worker registered a message listener');

    const source = { postMessage: (message) => posted.push(message) };
    for (const type of ['SESSION_STORE', 'SESSION_EXTEND', 'SESSION_QUERY', 'SESSION_CLEAR']) {
        messageListener({ data: { type, privateKey: PRIV_KEY, ttlMs: 1000 }, source });
    }

    assert.deepEqual(posted, [], 'the service worker must not answer wallet-session messages');

    // And nothing it holds can produce a key afterwards.
    messageListener({ data: { type: 'SESSION_QUERY' }, source });
    assert.deepEqual(posted, []);

    const swSource = readFileSync(new URL('../peerweb-sw.js', import.meta.url), 'utf8');
    assert.ok(!/sessionState/.test(swSource), 'the service worker keeps no wallet session state');
    assert.ok(!/SESSION_RESPONSE/.test(swSource), 'the SESSION_RESPONSE channel is gone');
});
