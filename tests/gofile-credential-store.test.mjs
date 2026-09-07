import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GOFILE_CREDENTIAL_DB_NAME,
    GOFILE_CREDENTIAL_STORE_NAME,
    GoFileCredentialStore
} from '../src/gofile/GoFileCredentialStore.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

const PRIVATE_KEY = `0x${'71'.repeat(32)}`;

function wallet() {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let id = 0;
    const call = async (type, payload = {}) => {
        const response = await core.handle({ id: `${++id}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    return {
        unlock: () => call(WALLET_WORKER_OPS.UNLOCK, { privateKey: PRIVATE_KEY }),
        lock: () => call(WALLET_WORKER_OPS.LOCK),
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

test('guest token round-trips through wallet encryption and IndexedDB contains ciphertext only', async () => {
    const fake = installFakeIndexedDb();
    const local = wallet();
    await local.unlock();
    const store = new GoFileCredentialStore({ signer: local.signer, now: () => 123 });
    try {
        await store.write({ token: 'guest-plaintext-secret', folderId: 'folder-uuid' });
        assert.deepEqual(await store.read(), { token: 'guest-plaintext-secret', folderId: 'folder-uuid' });
        const rows = fake.rawRows(GOFILE_CREDENTIAL_DB_NAME, GOFILE_CREDENTIAL_STORE_NAME);
        assert.equal(rows.length, 1);
        assert.deepEqual(Object.keys(rows[0]).sort(), ['ciphertext', 'folderId', 'id', 'updatedAt']);
        assert.doesNotMatch(JSON.stringify(rows), /guest-plaintext-secret/);
    } finally {
        fake.restore();
    }
});

test('locked wallet cannot read, write, or reset the credential', async () => {
    const fake = installFakeIndexedDb();
    const local = wallet();
    const store = new GoFileCredentialStore({ signer: local.signer });
    try {
        for (const operation of [() => store.read(), () => store.write('token'), () => store.clearInvalidToken()]) {
            await assert.rejects(operation, /unlock your wallet/i);
        }
    } finally {
        fake.restore();
    }
});

test('invalid-token reset deletes only the dedicated GoFile credential', async () => {
    const fake = installFakeIndexedDb();
    const local = wallet();
    await local.unlock();
    const store = new GoFileCredentialStore({ signer: local.signer });
    try {
        await store.write({ token: 'expired', folderId: 'guest-folder' });
        await store.clearInvalidToken();
        assert.equal(await store.read(), null);
        assert.equal(fake.databases.has('web25-auth'), false, 'the wallet database is never opened or changed');
    } finally {
        fake.restore();
    }
});
