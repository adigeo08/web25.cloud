/**
 * Trusted contacts: the authorization layer under the DM consent model.
 *
 * Two things are pinned here. First, that trust is only ever granted to an
 * identity whose Nostr key, ECIES key and EVM address are demonstrably one
 * secp256k1 key — a record that merely *claims* three matching strings is not
 * trust. Second, that the store is genuinely wallet-protected: a locked wallet
 * can read nothing, and IndexedDB never holds a peer identity, a name, or any
 * key material in the clear.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ContactsStore,
    TRUST,
    CONTACTS_DB_NAME,
    contactOwnerTag,
    contactRecordId,
    filterContacts,
    recoverEciesPublicKey,
    verifyIdentityTuple
} from '../src/channels/ContactsStore.js';
import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';
import { createWalletWorkerCore } from '../src/auth/walletWorkerCore.js';
import { WALLET_WORKER_OPS } from '../src/auth/walletWorkerProtocol.js';
import * as ecies from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

const OWNER_PRIV = '0x1111111111111111111111111111111111111111111111111111111111111111';

/** A peer's three bound identities, derived from one key the way a real one is. */
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
const BOB = peerFrom('3333333333333333333333333333333333333333333333333333333333333333');

/**
 * The real wallet worker plus the narrow capability handle the app is given.
 * Nothing here hands the store a key: it gets `nostrEncrypt` / `nostrDecrypt`
 * and nothing else, exactly as `createLocalWalletSigner()` produces.
 */
function makeWallet(privateKey = OWNER_PRIV) {
    const core = createWalletWorkerCore({ ecies, nostr: nostrCore });
    const calls = { encrypt: 0, decrypt: 0 };
    let counter = 0;

    const call = async (type, payload = {}) => {
        counter += 1;
        const response = await core.handle({ id: `w${counter}`, type, payload });
        if (!response.ok) throw new Error(response.error);
        return response.result;
    };

    return {
        nostrPublicKey: nostrCore.getNostrPublicKey(privateKey.slice(2)),
        calls,
        unlock: () => core.handle({ id: 'unlock', type: WALLET_WORKER_OPS.UNLOCK, payload: { privateKey } }),
        lock: () => core.handle({ id: 'lock', type: WALLET_WORKER_OPS.LOCK }),
        signer: {
            getNostrIdentity: async () => {
                try {
                    return await call(WALLET_WORKER_OPS.NOSTR_GET_PUBLIC_KEY);
                } catch (_) {
                    // Matches `getLocalWalletNostrIdentity`, which returns null
                    // rather than throwing when the wallet is locked.
                    return null;
                }
            },
            nostrEncrypt: async (plaintext, peerPublicKey) => {
                calls.encrypt += 1;
                return (await call(WALLET_WORKER_OPS.NOSTR_NIP44_ENCRYPT, { plaintext, peerPublicKey })).payload;
            },
            nostrDecrypt: async (payload, peerPublicKey) => {
                calls.decrypt += 1;
                return (await call(WALLET_WORKER_OPS.NOSTR_NIP44_DECRYPT, { payload, peerPublicKey })).plaintext;
            }
        }
    };
}

async function storeWith({ unlocked = true } = {}) {
    const fake = installFakeIndexedDb();
    const wallet = makeWallet();
    if (unlocked) await wallet.unlock();
    return { store: new ContactsStore({ signer: wallet.signer }), wallet, fake };
}

// ─── 1. Identity binding ─────────────────────────────────────────────────

test('a genuine identity tuple validates', () => {
    assert.deepEqual(verifyIdentityTuple(ALICE), { ok: true, reason: null });
});

test('a Nostr key that is not the x coordinate of the ECIES key is rejected', () => {
    const tampered = { ...ALICE, nostrPublicKey: BOB.nostrPublicKey };
    const result = verifyIdentityTuple(tampered);
    assert.equal(result.ok, false);
    assert.match(result.reason, /x coordinate/i);
});

test('an EVM address not derived from the ECIES key is rejected', () => {
    const tampered = { ...ALICE, evmAddress: BOB.evmAddress };
    const result = verifyIdentityTuple(tampered);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not derived/i);
});

test('a malformed member of the tuple is rejected rather than skipped', () => {
    assert.equal(verifyIdentityTuple({ ...ALICE, eciesPublicKey: '0xdead' }).ok, false);
    assert.equal(verifyIdentityTuple({ ...ALICE, evmAddress: '0xnope' }).ok, false);
    assert.equal(verifyIdentityTuple({ ...ALICE, nostrPublicKey: 'nope' }).ok, false);
    assert.equal(verifyIdentityTuple({}).ok, false);
});

test('a compressed or truncated ECIES key is not accepted as uncompressed', () => {
    assert.equal(verifyIdentityTuple({ ...ALICE, eciesPublicKey: `02${ALICE.nostrPublicKey}` }).ok, false);
    assert.equal(verifyIdentityTuple({ ...ALICE, eciesPublicKey: ALICE.eciesPublicKey.slice(0, 60) }).ok, false);
});

// ─── 2. Storing and reading ──────────────────────────────────────────────

test('a saved contact round-trips through the encrypted store', async () => {
    const { store, fake } = await storeWith();
    try {
        const saved = await store.save({ ...ALICE, name: '  Alice  ' });
        assert.equal(saved.name, 'Alice');
        assert.equal(saved.trust, TRUST.TRUSTED);

        const read = await store.get(ALICE.nostrPublicKey);
        assert.equal(read.nostrPublicKey, ALICE.nostrPublicKey);
        assert.equal(read.eciesPublicKey, ALICE.eciesPublicKey);
        assert.equal(read.evmAddress, ALICE.evmAddress);
        assert.equal(read.name, 'Alice');
    } finally {
        fake.restore();
    }
});

test('a contact whose tuple does not hold is refused at write time', async () => {
    const { store, fake } = await storeWith();
    try {
        await assert.rejects(
            () => store.save({ ...ALICE, evmAddress: BOB.evmAddress, name: 'Impostor' }),
            /Refusing to store a contact/i
        );
        assert.equal(await store.get(ALICE.nostrPublicKey), null);
    } finally {
        fake.restore();
    }
});

test('isTrusted is true only for an explicitly trusted contact', async () => {
    const { store, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, trust: TRUST.TRUSTED });
        await store.save({ ...BOB, trust: TRUST.PENDING });

        assert.equal(await store.isTrusted(ALICE.nostrPublicKey), true);
        assert.equal(await store.isTrusted(BOB.nostrPublicKey), false, 'pending is not trust');
        assert.equal(await store.isTrusted(peerFrom('44'.repeat(32)).nostrPublicKey), false, 'unknown is not trust');
    } finally {
        fake.restore();
    }
});

test('a tampered stored record is rejected even though a contact by that key exists', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });

        // Rewrite the ciphertext in place with a record whose EVM address is
        // somebody else's. It decrypts perfectly; the tuple no longer holds.
        const id = contactRecordId(wallet.nostrPublicKey, ALICE.nostrPublicKey);
        const row = fake.rawRows().find((entry) => entry.id === id);
        const forged = { ...ALICE, evmAddress: BOB.evmAddress, trust: TRUST.TRUSTED, name: 'Alice' };
        row.ciphertext = await wallet.signer.nostrEncrypt(JSON.stringify(forged), wallet.nostrPublicKey);

        assert.equal(await store.get(ALICE.nostrPublicKey), null, 'a broken tuple is not a contact');
        assert.equal(await store.isTrusted(ALICE.nostrPublicKey), false);
        assert.deepEqual(await store.list(), [], 'and it is not listed either');
    } finally {
        fake.restore();
    }
});

test('a record re-keyed to another peer cannot impersonate that peer', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });

        // A valid, self-consistent Bob record stored under Alice's row id.
        const id = contactRecordId(wallet.nostrPublicKey, ALICE.nostrPublicKey);
        const row = fake.rawRows().find((entry) => entry.id === id);
        row.ciphertext = await wallet.signer.nostrEncrypt(
            JSON.stringify({ ...BOB, trust: TRUST.TRUSTED }),
            wallet.nostrPublicKey
        );

        assert.equal(await store.get(ALICE.nostrPublicKey), null, 'the row must describe the key it is filed under');
    } finally {
        fake.restore();
    }
});

// ─── 3. Wallet protection ────────────────────────────────────────────────

test('a locked wallet cannot read contacts', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });
        assert.equal((await store.list()).length, 1);

        await wallet.lock();

        await assert.rejects(() => store.list(), /unlock your wallet/i);
        await assert.rejects(() => store.get(ALICE.nostrPublicKey), /unlock your wallet/i);
        await assert.rejects(() => store.isTrusted(ALICE.nostrPublicKey), /unlock your wallet/i);
    } finally {
        fake.restore();
    }
});

test('a locked wallet cannot write or remove contacts either', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await wallet.lock();
        await assert.rejects(() => store.save({ ...ALICE, name: 'Alice' }), /unlock your wallet/i);
        await assert.rejects(() => store.remove(ALICE.nostrPublicKey), /unlock your wallet/i);
    } finally {
        fake.restore();
    }
});

test('unlocking again restores access to the same contacts', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });
        await wallet.lock();
        await assert.rejects(() => store.list(), /unlock your wallet/i);

        await wallet.unlock();
        const contacts = await store.list();
        assert.equal(contacts.length, 1);
        assert.equal(contacts[0].name, 'Alice');
        assert.equal(contacts[0].nostrPublicKey, ALICE.nostrPublicKey);
    } finally {
        fake.restore();
    }
});

test('IndexedDB holds no peer identity, name or key material in the clear', async () => {
    const { store, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice Example' });
        const rows = fake.rawRows();
        assert.equal(rows.length, 1);

        const wire = JSON.stringify(rows);

        for (const secret of [
            OWNER_PRIV,
            OWNER_PRIV.slice(2),
            ALICE.nostrPublicKey,
            ALICE.eciesPublicKey,
            ALICE.evmAddress,
            ALICE.npub,
            'Alice Example',
            'trusted'
        ]) {
            assert.ok(!wire.includes(secret), `a stored row must not contain ${secret.slice(0, 24)}`);
        }

        assert.ok(!/nsec1/.test(wire), 'no nsec');
        // Only opaque ids, ciphertext and timestamps.
        assert.deepEqual(Object.keys(rows[0]).sort(), ['ciphertext', 'createdAt', 'id', 'ownerTag', 'updatedAt']);
    } finally {
        fake.restore();
    }
});

test('the row id and owner tag are opaque, not the keys themselves', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });
        const [row] = fake.rawRows();

        assert.equal(row.id, contactRecordId(wallet.nostrPublicKey, ALICE.nostrPublicKey));
        assert.equal(row.ownerTag, contactOwnerTag(wallet.nostrPublicKey));
        assert.notEqual(row.id, ALICE.nostrPublicKey);
        assert.notEqual(row.ownerTag, wallet.nostrPublicKey);
        assert.match(row.id, /^[0-9a-f]{64}$/);
    } finally {
        fake.restore();
    }
});

test('contacts live in their own database, never the wallet vault', async () => {
    assert.equal(CONTACTS_DB_NAME, 'web25-contacts');
    assert.notEqual(CONTACTS_DB_NAME, 'web25-auth');
});

/** Source with comments stripped, so prose about a rule cannot satisfy it. */
async function contactsStoreCode() {
    const source = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../src/channels/ContactsStore.js', import.meta.url), 'utf8')
    );
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('the store is handed a capability, never a key', async () => {
    const code = (await contactsStoreCode()).toLowerCase();

    // No private-key handling of any kind: encryption happens in the worker,
    // and nothing sensitive is written to browser storage.
    for (const forbidden of ['privatekey', 'getprivatekey', 'nsec', 'prf', 'localstorage', 'sessionstorage']) {
        assert.ok(!code.includes(forbidden), `must not use ${forbidden}`);
    }

    // The only capabilities it reaches for are the three narrow worker ops.
    assert.ok(code.includes('nostrEncrypt'.toLowerCase()));
    assert.ok(code.includes('nostrDecrypt'.toLowerCase()));
    assert.ok(code.includes('getNostrIdentity'.toLowerCase()));
});

test('nothing in the contacts module publishes to a relay', async () => {
    const code = await contactsStoreCode();
    for (const forbidden of ['wss://', 'RelayPool', 'fetch(', 'WebSocket', '.publish(']) {
        assert.ok(!code.includes(forbidden), `contacts must stay local: found ${forbidden}`);
    }
});

// ─── 4. Rename and remove ────────────────────────────────────────────────

test('renaming changes the label and nothing else', async () => {
    const { store, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });
        const renamed = await store.rename(ALICE.nostrPublicKey, 'Alice at work');

        assert.equal(renamed.name, 'Alice at work');
        assert.equal(renamed.nostrPublicKey, ALICE.nostrPublicKey);
        assert.equal(renamed.eciesPublicKey, ALICE.eciesPublicKey);
        assert.equal(renamed.evmAddress, ALICE.evmAddress);
        assert.equal(renamed.trust, TRUST.TRUSTED);
    } finally {
        fake.restore();
    }
});

test('a removed friend is unknown again, and no key is touched', async () => {
    const { store, wallet, fake } = await storeWith();
    try {
        await store.save({ ...ALICE, name: 'Alice' });
        assert.equal(await store.isTrusted(ALICE.nostrPublicKey), true);

        await store.remove(ALICE.nostrPublicKey);

        assert.equal(await store.isTrusted(ALICE.nostrPublicKey), false, 'their next invitation needs approval');
        assert.equal(await store.get(ALICE.nostrPublicKey), null);
        assert.deepEqual(fake.rawRows(), []);

        // The local identity is completely unaffected by forgetting somebody.
        const identity = await wallet.signer.getNostrIdentity();
        assert.equal(identity.nostrPublicKey, wallet.nostrPublicKey);
    } finally {
        fake.restore();
    }
});

test('names are stripped of control and bidi characters, and capped', async () => {
    const { store, fake } = await storeWith();
    try {
        const saved = await store.save({
            ...ALICE,
            name: `Ali‮ce‎ ${'x'.repeat(200)}`
        });

        assert.ok(!/[ -‎‪-‮]/.test(saved.name), 'no bidi or control characters survive');
        assert.ok(saved.name.length <= 64);
    } finally {
        fake.restore();
    }
});

// ─── 5. Migrating the v1 plaintext store ─────────────────────────────────

test('a v1 contact\'s ECIES key is recovered, not guessed', () => {
    // The Nostr key is the x coordinate; the stored EVM address picks the
    // parity. The result is verified against that address, so it is a recovery.
    assert.equal(recoverEciesPublicKey(ALICE.nostrPublicKey, ALICE.evmAddress), ALICE.eciesPublicKey);
    assert.equal(recoverEciesPublicKey(BOB.nostrPublicKey, BOB.evmAddress), BOB.eciesPublicKey);
});

test('a v1 record whose two identities disagree recovers nothing', () => {
    assert.equal(recoverEciesPublicKey(ALICE.nostrPublicKey, BOB.evmAddress), null);
    assert.equal(recoverEciesPublicKey(ALICE.nostrPublicKey, ''), null, 'no EVM address, no recovery');
    assert.equal(recoverEciesPublicKey('nope', ALICE.evmAddress), null);
    assert.equal(recoverEciesPublicKey('ff'.repeat(32), ALICE.evmAddress), null, 'not a point on the curve');
});

test('existing v1 contacts survive the upgrade, encrypted', async () => {
    const fake = installFakeIndexedDb();
    try {
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: ALICE.evmAddress, name: 'Alice' },
            { nostrPublicKey: BOB.nostrPublicKey, npub: BOB.npub, evmAddress: BOB.evmAddress, name: 'Bob' }
        ]);

        const wallet = makeWallet();
        await wallet.unlock();
        const store = new ContactsStore({ signer: wallet.signer });

        const contacts = await store.list();
        assert.deepEqual(contacts.map((c) => c.name), ['Alice', 'Bob'], 'nobody is lost');

        const alice = await store.get(ALICE.nostrPublicKey);
        assert.equal(alice.eciesPublicKey, ALICE.eciesPublicKey, 'the missing key was recovered');
        assert.equal(alice.evmAddress, ALICE.evmAddress);
        assert.equal(alice.trust, TRUST.TRUSTED, 'a v1 contact was an explicit, verified save');
        assert.deepEqual(verifyIdentityTuple(alice), { ok: true, reason: null });
    } finally {
        fake.restore();
    }
});

test('the v1 plaintext rows are deleted by the migration', async () => {
    const fake = installFakeIndexedDb();
    try {
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: ALICE.evmAddress, name: 'Alice' }
        ]);

        const wallet = makeWallet();
        await wallet.unlock();
        await new ContactsStore({ signer: wallet.signer }).list();

        assert.deepEqual(fake.legacyRows(), [], 'no plaintext contact survives the first unlocked operation');

        // And what replaced it reveals nothing.
        const wire = JSON.stringify(fake.rawRows());
        for (const secret of [ALICE.nostrPublicKey, ALICE.evmAddress, ALICE.npub, 'Alice']) {
            assert.ok(!wire.includes(secret), `migrated row must not contain ${secret.slice(0, 20)}`);
        }
    } finally {
        fake.restore();
    }
});

test('a v1 contact with no EVM address is dropped rather than trusted', async () => {
    const fake = installFakeIndexedDb();
    try {
        // v1 allowed saving a bare npub from a search: never a verified peer,
        // so it cannot become a trusted contact under the new rules.
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: null, name: 'Unverified' },
            { nostrPublicKey: BOB.nostrPublicKey, npub: BOB.npub, evmAddress: BOB.evmAddress, name: 'Bob' }
        ]);

        const wallet = makeWallet();
        await wallet.unlock();
        const store = new ContactsStore({ signer: wallet.signer });

        assert.deepEqual((await store.list()).map((c) => c.name), ['Bob']);
        assert.equal(await store.isTrusted(ALICE.nostrPublicKey), false);
        assert.deepEqual(fake.legacyRows(), [], 'dropped rows are deleted too, not left in plaintext');
    } finally {
        fake.restore();
    }
});

test('a v1 row whose identities disagree is dropped, never migrated', async () => {
    const fake = installFakeIndexedDb();
    try {
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: BOB.evmAddress, name: 'Impostor' }
        ]);

        const wallet = makeWallet();
        await wallet.unlock();
        const store = new ContactsStore({ signer: wallet.signer });

        assert.deepEqual(await store.list(), []);
        assert.equal(await store.isTrusted(ALICE.nostrPublicKey), false);
    } finally {
        fake.restore();
    }
});

test('migration runs once and is not repeated on later operations', async () => {
    const fake = installFakeIndexedDb();
    try {
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: ALICE.evmAddress, name: 'Alice' }
        ]);

        const wallet = makeWallet();
        await wallet.unlock();
        const store = new ContactsStore({ signer: wallet.signer });

        await store.list();
        await store.rename(ALICE.nostrPublicKey, 'Alice renamed');
        const contacts = await store.list();

        assert.equal(contacts.length, 1, 'no duplicate is created by a second drain');
        assert.equal(contacts[0].name, 'Alice renamed', 'and the rename is not undone by one');
    } finally {
        fake.restore();
    }
});

test('a locked wallet cannot trigger the migration', async () => {
    const fake = installFakeIndexedDb();
    try {
        fake.seedLegacy([
            { nostrPublicKey: ALICE.nostrPublicKey, npub: ALICE.npub, evmAddress: ALICE.evmAddress, name: 'Alice' }
        ]);

        const store = new ContactsStore({ signer: makeWallet().signer });
        await assert.rejects(() => store.list(), /unlock your wallet/i);

        // The upgrade never fired, so nothing was read, written or destroyed.
        assert.equal(fake.legacyRows().length, 1, 'v1 data is not touched while locked');
        assert.equal(fake.hasStore('secure_contacts'), false);
    } finally {
        fake.restore();
    }
});

// ─── 5. Filtering ────────────────────────────────────────────────────────

const ROWS = [
    { ...ALICE, name: 'Alice' },
    { ...BOB, name: 'Bob' }
];

test('contacts are searchable by name, npub, pubkey and EVM address', () => {
    assert.deepEqual(filterContacts(ROWS, 'alice').map((c) => c.name), ['Alice']);
    assert.deepEqual(filterContacts(ROWS, BOB.npub.slice(0, 12)).map((c) => c.name), ['Bob']);
    assert.deepEqual(filterContacts(ROWS, ALICE.nostrPublicKey.slice(0, 10)).map((c) => c.name), ['Alice']);
    assert.deepEqual(filterContacts(ROWS, BOB.evmAddress.slice(0, 8)).map((c) => c.name), ['Bob']);
});

test('an empty filter lists everyone and an unmatched one lists nobody', () => {
    assert.equal(filterContacts(ROWS, '').length, 2);
    assert.equal(filterContacts(ROWS, '   ').length, 2);
    assert.deepEqual(filterContacts(ROWS, 'nobody'), []);
});

test('filtering tolerates contacts with missing fields', () => {
    const sparse = [{ nostrPublicKey: ALICE.nostrPublicKey }];
    assert.equal(filterContacts(sparse, ALICE.nostrPublicKey.slice(0, 8)).length, 1);
    assert.equal(filterContacts(sparse, '0xdead').length, 0);
});
