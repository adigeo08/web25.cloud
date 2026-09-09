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
import { GoFileService } from '../src/gofile/GoFileService.js';
import { gofileMirrorFilename } from '../src/gofile/GoFileMirrorCodec.js';

const PRIVATE_KEY = `0x${'71'.repeat(32)}`;

function wallet() {
    return walletFor(PRIVATE_KEY);
}

function walletFor(privateKey) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let id = 0;
    const call = async (type, payload = {}) => {
        const response = await core.handle({ id: `${++id}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    return {
        unlock: () => call(WALLET_WORKER_OPS.UNLOCK, { privateKey }),
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
        await store.write({ token: 'guest-plaintext-secret' });
        assert.deepEqual(await store.read(), { token: 'guest-plaintext-secret' });
        const rows = fake.rawRows(GOFILE_CREDENTIAL_DB_NAME, GOFILE_CREDENTIAL_STORE_NAME);
        assert.equal(rows.length, 1);
        // No upload folder is remembered: one would become a public index of
        // every deployment this publisher has ever mirrored.
        assert.deepEqual(Object.keys(rows[0]).sort(), ['ciphertext', 'id', 'updatedAt']);
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
        await store.write({ token: 'expired' });
        await store.clearInvalidToken();
        assert.equal(await store.read(), null);
        assert.equal(fake.databases.has('web25-auth'), false, 'the wallet database is never opened or changed');
    } finally {
        fake.restore();
    }
});

test('wallet credentials are isolated by owner and clearing A keeps B', async () => {
    const fake = installFakeIndexedDb();
    const ownerA = 'a'.repeat(64);
    const ownerB = 'b'.repeat(64);
    const signer = (owner) => ({
        getNostrIdentity: async () => ({ nostrPublicKey: owner }),
        nostrEncrypt: async (plaintext) => `${owner}:${plaintext}`,
        nostrDecrypt: async (ciphertext) => {
            if (!ciphertext.startsWith(`${owner}:`)) throw new Error('wrong owner');
            return ciphertext.slice(owner.length + 1);
        }
    });
    const storeA = new GoFileCredentialStore({ signer: signer(ownerA) });
    const storeB = new GoFileCredentialStore({ signer: signer(ownerB) });
    try {
        await storeA.write('token-a');
        await storeB.write('token-b');
        assert.deepEqual(await storeA.read(), { token: 'token-a' });
        assert.deepEqual(await storeB.read(), { token: 'token-b' });
        await storeA.clearInvalidToken();
        assert.equal(await storeA.read(), null);
        assert.deepEqual(await storeB.read(), { token: 'token-b' });
    } finally {
        fake.restore();
    }
});

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('the token put on the wire is the decrypted one, not the stored ciphertext', async () => {
    const fake = installFakeIndexedDb();
    const local = wallet();
    await local.unlock();
    const store = new GoFileCredentialStore({ signer: local.signer });
    try {
        await store.write({ token: 'guest-plaintext-secret' });

        const row = fake.rawRows(GOFILE_CREDENTIAL_DB_NAME, GOFILE_CREDENTIAL_STORE_NAME)[0];
        assert.notEqual(row.ciphertext, 'guest-plaintext-secret', 'the row really is encrypted');

        // Round-trip the way both call sites do: read from IndexedDB, decrypt,
        // hand the plaintext to the service, and inspect the actual header.
        const credential = await store.read();
        const headers = [];
        const service = new GoFileService({
            fetchImpl: async (url, init) => {
                headers.push(init?.headers?.Authorization ?? null);
                if (url.startsWith('https://api.gofile.io/contents')) {
                    return new Response(
                        JSON.stringify({
                            status: 'ok',
                            data: {
                                type: 'file',
                                name: gofileMirrorFilename(HASH),
                                link: 'https://cold1.gofile.io/download/one'
                            }
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } }
                    );
                }
                return new Response(new Uint8Array([1, 2, 3]));
            }
        });

        await service.downloadPublicMirror('file_1', {
            token: credential.token,
            expectedFilename: gofileMirrorFilename(HASH)
        });

        assert.equal(headers[0], 'Bearer guest-plaintext-secret');
        assert.doesNotMatch(`${headers[0]}`, /[{}]/, 'no ciphertext envelope reaches the header');
    } finally {
        fake.restore();
    }
});

test('a credential written by one identity is invisible to another', async () => {
    // Two wallets in one browser: the record id is per owner and the payload is
    // encrypted to that owner, so B can neither read nor decrypt A's token.
    const fake = installFakeIndexedDb();
    const a = wallet();
    await a.unlock();
    const storeA = new GoFileCredentialStore({ signer: a.signer });
    try {
        await storeA.write({ token: 'identity-a-token' });
        assert.deepEqual(await storeA.read(), { token: 'identity-a-token' });

        const b = walletFor(`0x${'42'.repeat(32)}`);
        await b.unlock();
        const storeB = new GoFileCredentialStore({ signer: b.signer });
        assert.equal(await storeB.read(), null, 'B sees no credential of its own');

        await storeB.write({ token: 'identity-b-token' });
        assert.deepEqual(await storeA.read(), { token: 'identity-a-token' }, "A's token is untouched");
        assert.deepEqual(await storeB.read(), { token: 'identity-b-token' });
        assert.equal(fake.rawRows(GOFILE_CREDENTIAL_DB_NAME, GOFILE_CREDENTIAL_STORE_NAME).length, 2);
    } finally {
        fake.restore();
    }
});
