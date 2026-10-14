/**
 * Writes that wait on the wallet worker must not hold an IndexedDB
 * transaction open across that wait.
 *
 * A real transaction commits as soon as control returns to the event loop
 * with no request pending, and the wallet worker answers through
 * `postMessage` — a later task. So `store.put({ ciphertext: await seal() })`
 * opens the transaction, waits for the worker, and then calls `put` on a
 * transaction that has already finished:
 *
 *   Failed to execute 'put' on 'IDBObjectStore': The transaction has finished.
 *
 * That is exactly how Save contact failed in the browser while every test
 * passed: the test wallets answered on microtasks, inside the same task. The
 * wallet here answers on a later task, as the worker does, and the fake
 * IndexedDB ends transactions the way the browser does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContactsStore, CONTACTS_DB_NAME, CONTACTS_STORE_NAME } from '../src/channels/ContactsStore.js';
import { MessageArchive } from '../src/channels/MessageArchive.js';
import { GoFileCredentialStore } from '../src/gofile/GoFileCredentialStore.js';
import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

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

const ALICE = peerFrom('22'.repeat(32));

/** A wallet that answers on a later task, the way a Worker's postMessage does. */
async function workerLikeWallet() {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    await core.handle({
        id: 'unlock',
        type: WALLET_WORKER_OPS.UNLOCK,
        payload: { privateKey: `0x${'11'.repeat(32)}` }
    });
    let counter = 0;
    const call = async (type, payload = {}) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const response = await core.handle({ id: `t${++counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    return {
        getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY).catch(() => null),
        nostrEncrypt: async (plaintext, peerPublicKey) =>
            (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
        nostrDecrypt: async (payload, peerPublicKey) =>
            (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
    };
}

test('the fake ends a transaction the way the browser does', async () => {
    const fake = installFakeIndexedDb();
    try {
        const db = await new Promise((resolve) => {
            const request = indexedDB.open('timing-check', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('s', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
        });
        const store = db.transaction('s', 'readwrite').objectStore('s');
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.throws(() => store.put({ id: 1 }), /The transaction has finished/);
    } finally {
        fake.restore();
    }
});

test('saving a contact works when the wallet answers on a later task', async () => {
    const fake = installFakeIndexedDb();
    try {
        const contacts = new ContactsStore({ signer: await workerLikeWallet() });
        await contacts.save({ ...ALICE, name: 'Alice' });
        assert.deepEqual(
            (await contacts.list()).map((c) => c.name),
            ['Alice']
        );
        // Saving again (an update, which first reads the existing record).
        await contacts.save({ ...ALICE, name: 'Alice P.' });
        await contacts.rename(ALICE.nostrPublicKey, 'Ally');
        assert.equal((await contacts.get(ALICE.nostrPublicKey)).name, 'Ally');
    } finally {
        fake.restore();
    }
});

test('blocking and unblocking work when the wallet answers on a later task', async () => {
    const fake = installFakeIndexedDb();
    try {
        const contacts = new ContactsStore({ signer: await workerLikeWallet() });
        await contacts.save({ ...ALICE, name: 'Alice' });
        await contacts.block({ nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, name: 'Alice' });
        assert.equal(await contacts.isBlocked(ALICE.nostrPublicKey), true);
        assert.deepEqual(await contacts.list(), []);
        await contacts.unblock(ALICE.nostrPublicKey);
        assert.deepEqual(await contacts.listBlocked(), []);
    } finally {
        fake.restore();
    }
});

test('migrating v1 contacts works when the wallet answers on a later task', async () => {
    const fake = installFakeIndexedDb();
    try {
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: ALICE.evmAddress, name: 'Alice' }
        ]);
        const contacts = new ContactsStore({ signer: await workerLikeWallet() });
        assert.deepEqual(
            (await contacts.list()).map((c) => c.name),
            ['Alice']
        );
        assert.equal(fake.rawRows(CONTACTS_DB_NAME, CONTACTS_STORE_NAME).length, 1);
        assert.deepEqual(fake.legacyRows(), []);
    } finally {
        fake.restore();
    }
});

test('keeping messages works when the wallet answers on a later task', async () => {
    const fake = installFakeIndexedDb();
    try {
        const archive = new MessageArchive({ signer: await workerLikeWallet() });
        await archive.setRetention(ALICE.nostrPublicKey, 24 * 60 * 60 * 1000);
        await archive.record(ALICE.nostrPublicKey, { id: 'm1', from: '0x', text: 'hi', timestamp: Date.now() });
        assert.deepEqual(
            (await archive.history(ALICE.nostrPublicKey)).map((m) => m.text),
            ['hi']
        );
        await archive.setRetention(ALICE.nostrPublicKey, 0);
    } finally {
        fake.restore();
    }
});

test('the GoFile credential store works when the wallet answers on a later task', async () => {
    const fake = installFakeIndexedDb();
    try {
        const credentials = new GoFileCredentialStore({ signer: await workerLikeWallet() });
        await credentials.write('token-123');
        assert.deepEqual(await credentials.read(), { token: 'token-123' });
    } finally {
        fake.restore();
    }
});
