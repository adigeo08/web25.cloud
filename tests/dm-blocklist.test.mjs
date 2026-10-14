/**
 * Blocking somebody.
 *
 * A block has to work on the thinnest thing a stranger can send — a chat
 * request, which carries an npub and nothing else — so it cannot be a contact
 * record with a verified identity tuple. These pin the store's side of it: a
 * block needs only the npub, is sealed like a contact, ends any friendship
 * with that person, and survives the database upgrade that introduced it
 * without costing anybody their existing contacts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ContactsStore,
    BLOCKED_STORE_NAME,
    CONTACTS_DB_NAME,
    CONTACTS_STORE_NAME,
    blockedRecordId,
    contactRecordId
} from '../src/channels/ContactsStore.js';
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
const MALLORY = peerFrom('55'.repeat(32));

function makeWallet(privateKey = `0x${'11'.repeat(32)}`) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    let counter = 0;
    const call = async (type, payload = {}) => {
        const response = await core.handle({ id: `b${++counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };
    return {
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        lock: () => core.handle({ id: 'lock', type: WALLET_WORKER_OPS.LOCK }),
        signer: {
            getNostrIdentity: async () => call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY).catch(() => null),
            nostrEncrypt: async (plaintext, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload,
            nostrDecrypt: async (payload, peerPublicKey) =>
                (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext
        }
    };
}

async function storeWith() {
    const fake = installFakeIndexedDb();
    const wallet = makeWallet();
    await wallet.unlock();
    return { fake, wallet, contacts: new ContactsStore({ signer: wallet.signer }) };
}

test('a stranger is blocked by npub alone', async () => {
    const { fake, contacts } = await storeWith();
    try {
        await contacts.block({ nostrPublicKey: MALLORY.nostrPublicKey, npub: MALLORY.npub, name: 'Spam' });
        assert.equal(await contacts.isBlocked(MALLORY.nostrPublicKey), true);
        assert.equal(await contacts.isBlocked(ALICE.nostrPublicKey), false);
        const [entry] = await contacts.listBlocked();
        assert.equal(entry.nostrPublicKey, MALLORY.nostrPublicKey);
        assert.equal(entry.npub, MALLORY.npub);
    } finally {
        fake.restore();
    }
});

test('blocking a friend ends the friendship', async () => {
    const { fake, contacts } = await storeWith();
    try {
        await contacts.save({ ...ALICE, name: 'Alice' });
        assert.equal(await contacts.isTrusted(ALICE.nostrPublicKey), true);

        await contacts.block({ nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, name: 'Alice' });

        assert.equal(await contacts.isTrusted(ALICE.nostrPublicKey), false);
        assert.deepEqual(await contacts.list(), []);
        assert.equal(await contacts.isBlocked(ALICE.nostrPublicKey), true);
    } finally {
        fake.restore();
    }
});

test('unblocking makes them unknown again, not a friend', async () => {
    const { fake, contacts } = await storeWith();
    try {
        await contacts.save({ ...ALICE, name: 'Alice' });
        await contacts.block({ nostrPublicKey: ALICE.nostrPublicKey });
        await contacts.unblock(ALICE.nostrPublicKey);

        assert.equal(await contacts.isBlocked(ALICE.nostrPublicKey), false);
        assert.equal(await contacts.isTrusted(ALICE.nostrPublicKey), false, 'trust is not restored by unblocking');
        assert.deepEqual(await contacts.listBlocked(), []);
    } finally {
        fake.restore();
    }
});

test('the blocklist is sealed: no key, npub or name in the clear', async () => {
    const { fake, contacts } = await storeWith();
    try {
        await contacts.block({
            nostrPublicKey: MALLORY.nostrPublicKey,
            npub: MALLORY.npub,
            name: 'Mallory the spammer'
        });
        const raw = JSON.stringify(fake.rawRows(CONTACTS_DB_NAME, BLOCKED_STORE_NAME));
        for (const secret of [MALLORY.nostrPublicKey, MALLORY.npub, 'Mallory the spammer']) {
            assert.ok(!raw.includes(secret), `${secret} must not be stored in the clear`);
        }
        // A different id domain from contacts: the two stores never share a key.
        const owner = nostrCore.getNostrPublicKey('11'.repeat(32));
        assert.notEqual(blockedRecordId(owner, MALLORY.nostrPublicKey), contactRecordId(owner, MALLORY.nostrPublicKey));
    } finally {
        fake.restore();
    }
});

test('a locked wallet can neither read nor change the blocklist', async () => {
    const { fake, wallet, contacts } = await storeWith();
    try {
        await contacts.block({ nostrPublicKey: MALLORY.nostrPublicKey });
        await wallet.lock();
        await assert.rejects(() => contacts.listBlocked(), /Unlock your wallet/);
        await assert.rejects(() => contacts.block({ nostrPublicKey: ALICE.nostrPublicKey }), /Unlock your wallet/);
        await assert.rejects(() => contacts.unblock(MALLORY.nostrPublicKey), /Unlock your wallet/);
    } finally {
        fake.restore();
    }
});

test('a malformed key is refused rather than blocking nobody in particular', async () => {
    const { fake, contacts } = await storeWith();
    try {
        await assert.rejects(() => contacts.block({ nostrPublicKey: 'npub1notahexkey' }), /malformed/);
        assert.equal(await contacts.isBlocked('not-a-key'), false);
    } finally {
        fake.restore();
    }
});

test('upgrading an existing v2 database keeps every contact', async () => {
    const { fake, contacts } = await storeWith();
    try {
        await contacts.save({ ...ALICE, name: 'Alice' });

        // Wind the database back to what a v2 user has on disk: the encrypted
        // contacts store and nothing else.
        const db = fake.databases.get(CONTACTS_DB_NAME);
        db.stores.delete(BLOCKED_STORE_NAME);
        db.version = 2;
        assert.equal(fake.hasStore(BLOCKED_STORE_NAME), false);

        const listed = await contacts.list();
        assert.deepEqual(
            listed.map((c) => c.name),
            ['Alice'],
            'the upgrade must not recreate the contacts store'
        );
        assert.equal(fake.hasStore(BLOCKED_STORE_NAME), true);
        assert.equal(fake.rawRows(CONTACTS_DB_NAME, CONTACTS_STORE_NAME).length, 1);
    } finally {
        fake.restore();
    }
});
