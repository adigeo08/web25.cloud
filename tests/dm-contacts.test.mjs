/**
 * Local contacts.
 *
 * The store is local-only by design: a friendly name is the user's own label
 * for someone, and publishing it would attach a human name to a public key for
 * everyone on the relays to read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { filterContacts, normalizeContact } from '../src/channels/ContactsStore.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

const ALICE = nostrCore.getNostrPublicKey('1111111111111111111111111111111111111111111111111111111111111111');
const BOB = nostrCore.getNostrPublicKey('2222222222222222222222222222222222222222222222222222222222222222');
const EVM = '0x4de1f0e0c5a4b0d1a2b3c4d5e6f708192a3b4c5d';

// ─── Validation ──────────────────────────────────────────────────────────

test('a contact keeps both identities plus a local name', () => {
    const contact = normalizeContact({
        nostrPublicKey: ALICE.toUpperCase(),
        npub: npubEncode(ALICE),
        evmAddress: EVM.toUpperCase(),
        name: '  Alice  '
    });

    assert.equal(contact.nostrPublicKey, ALICE, 'keys are normalized to lowercase hex');
    assert.equal(contact.evmAddress, EVM);
    assert.equal(contact.npub, npubEncode(ALICE));
    assert.equal(contact.name, 'Alice');
});

test('a contact without an EVM address is allowed', () => {
    // The EVM identity is only learned once an invitation has been verified,
    // so a contact saved from a search has the Nostr identity alone.
    const contact = normalizeContact({ nostrPublicKey: ALICE, name: 'Just an npub' });
    assert.equal(contact.evmAddress, null);
});

test('a contact without a usable Nostr key is rejected', () => {
    for (const bad of ['', 'nope', ALICE.slice(0, 40), null]) {
        assert.throws(() => normalizeContact({ nostrPublicKey: bad, name: 'x' }), `"${bad}" must be rejected`);
    }
});

test('a malformed EVM address is rejected rather than silently stored', () => {
    assert.throws(() => normalizeContact({ nostrPublicKey: ALICE, evmAddress: '0xnope' }), /EVM address/i);
});

test('names are stripped of control and bidi characters, and capped', () => {
    const bidi = String.fromCharCode(0x202e);
    const contact = normalizeContact({ nostrPublicKey: ALICE, name: `Alice${bidi}evil` });
    assert.ok(!contact.name.includes(bidi), 'a name must not be able to reorder the contact list');

    const long = normalizeContact({ nostrPublicKey: ALICE, name: 'n'.repeat(500) });
    assert.ok(long.name.length <= 64);
});

test('a contact record carries no key material', () => {
    const contact = normalizeContact({ nostrPublicKey: ALICE, npub: npubEncode(ALICE), evmAddress: EVM, name: 'Alice' });
    const serialized = JSON.stringify(contact);

    assert.ok(!/nsec/.test(serialized));
    assert.ok(!serialized.includes('1111111111111111111111111111111111111111111111111111111111111111'));
    assert.deepEqual(Object.keys(contact).sort(), ['evmAddress', 'name', 'nostrPublicKey', 'npub']);
});

// ─── Search ──────────────────────────────────────────────────────────────

const CONTACTS = [
    { nostrPublicKey: ALICE, npub: npubEncode(ALICE), evmAddress: EVM, name: 'Alice' },
    { nostrPublicKey: BOB, npub: npubEncode(BOB), evmAddress: null, name: 'Bob' }
];

test('contacts are searchable by name, npub, pubkey and EVM address', () => {
    assert.deepEqual(filterContacts(CONTACTS, 'alice').map((c) => c.name), ['Alice']);
    assert.deepEqual(filterContacts(CONTACTS, npubEncode(BOB).slice(0, 14)).map((c) => c.name), ['Bob']);
    assert.deepEqual(filterContacts(CONTACTS, ALICE.slice(0, 12)).map((c) => c.name), ['Alice']);
    assert.deepEqual(filterContacts(CONTACTS, '0x4de1').map((c) => c.name), ['Alice']);
});

test('an empty filter lists everyone and an unmatched one lists nobody', () => {
    assert.equal(filterContacts(CONTACTS, '').length, 2);
    assert.equal(filterContacts(CONTACTS, '   ').length, 2);
    assert.deepEqual(filterContacts(CONTACTS, 'carol'), []);
});

test('filtering tolerates contacts with missing fields', () => {
    const sparse = [{ nostrPublicKey: ALICE, name: '' }];
    assert.equal(filterContacts(sparse, ALICE.slice(0, 8)).length, 1);
    assert.equal(filterContacts(sparse, '0xdead').length, 0);
});

// ─── The store is local-only ─────────────────────────────────────────────

test('contacts live in their own database, never the wallet vault', async () => {
    const { CONTACTS_DB_NAME } = await import('../src/channels/ContactsStore.js');
    assert.equal(CONTACTS_DB_NAME, 'web25-contacts');
    assert.notEqual(CONTACTS_DB_NAME, 'web25-auth', 'the wallet vault database is never touched');
});

test('nothing in the contacts module publishes to a relay', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/channels/ContactsStore.js', import.meta.url), 'utf8');

    // Strip comments so this checks the code rather than the prose describing it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // A friendly name is the user's own label; it must never reach a relay.
    for (const forbidden of ['publish', 'relay', 'nostrSignEvent', 'pool.', 'fetch(', 'WebSocket']) {
        assert.ok(!code.includes(forbidden), `the contacts store must have no network path (found "${forbidden}")`);
    }
    assert.ok(!/^import .*(nostr|Relay)/m.test(code), 'and no Nostr imports');
});
