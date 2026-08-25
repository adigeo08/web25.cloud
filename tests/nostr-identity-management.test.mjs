/**
 * Nostr identity management and the Direct Messenger address search.
 *
 * Two behaviours are pinned here:
 *
 *   - Add/Delete on the Identity page controls *reachability*, not a key.
 *     Removing and re-adding always yields the same `npub`, because there is
 *     only ever one wallet key.
 *   - The address search resolves locally and treats any profile a relay
 *     returns as untrusted display text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clearNostrIdentityPreference,
    isNostrIdentityEnabled,
    setNostrIdentityEnabled
} from '../src/nostr/NostrIdentityPreference.js';
import { lookupNostrProfile, parseNostrProfile } from '../src/nostr/NostrProfileLookup.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode, normalizeNostrPublicKey, shortNpub } from '../src/nostr/nip19.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const PRIV = '1111111111111111111111111111111111111111111111111111111111111111';
const PUBKEY = nostrCore.getNostrPublicKey(PRIV);

/** Minimal localStorage stand-in; Node has no DOM storage. */
class MemoryStorage {
    constructor() {
        this.map = new Map();
    }
    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
        this.map.set(key, `${value}`);
    }
    removeItem(key) {
        this.map.delete(key);
    }
}

/** Storage that throws on every access, as a locked-down browser would. */
const HOSTILE_STORAGE = {
    getItem() {
        throw new Error('storage blocked');
    },
    setItem() {
        throw new Error('storage blocked');
    },
    removeItem() {
        throw new Error('storage blocked');
    }
};

const originalStorage = globalThis.localStorage;
test.beforeEach(() => {
    globalThis.localStorage = new MemoryStorage();
});
test.afterEach(() => {
    globalThis.localStorage = originalStorage;
});

// ─── 1. Reachability preference ──────────────────────────────────────────

test('a wallet is reachable over Nostr by default', () => {
    assert.equal(isNostrIdentityEnabled(ADDRESS), true);
});

test('deleting and re-adding the Nostr identity round-trips', () => {
    setNostrIdentityEnabled(ADDRESS, false);
    assert.equal(isNostrIdentityEnabled(ADDRESS), false);

    setNostrIdentityEnabled(ADDRESS, true);
    assert.equal(isNostrIdentityEnabled(ADDRESS), true);
});

test('the preference is per wallet and case-insensitive on the address', () => {
    setNostrIdentityEnabled(ADDRESS, false);

    assert.equal(isNostrIdentityEnabled(ADDRESS.toUpperCase()), false, 'same wallet, different casing');
    assert.equal(isNostrIdentityEnabled(OTHER_ADDRESS), true, 'a different wallet is unaffected');
});

test('clearing the preference restores the default', () => {
    setNostrIdentityEnabled(ADDRESS, false);
    clearNostrIdentityPreference(ADDRESS);
    assert.equal(isNostrIdentityEnabled(ADDRESS), true);
});

test('no key material is ever written to storage', () => {
    setNostrIdentityEnabled(ADDRESS, false);
    setNostrIdentityEnabled(OTHER_ADDRESS, true);

    const dumped = JSON.stringify([...globalThis.localStorage.map.entries()]);
    assert.ok(!dumped.includes(PRIV), 'the private key must never be persisted');
    assert.ok(!dumped.includes(PUBKEY), 'not even public key material is persisted');
    assert.ok(!/nsec/.test(dumped));
    for (const value of globalThis.localStorage.map.values()) {
        assert.ok(value === 'on' || value === 'off', `unexpected stored value: ${value}`);
    }
});

test('blocked storage falls back to the default instead of throwing', () => {
    globalThis.localStorage = HOSTILE_STORAGE;
    assert.equal(isNostrIdentityEnabled(ADDRESS), true);
    assert.equal(setNostrIdentityEnabled(ADDRESS, false), false);
    assert.doesNotThrow(() => clearNostrIdentityPreference(ADDRESS));
});

test('an absent address is never reported as reachable', () => {
    assert.equal(isNostrIdentityEnabled(''), false);
    assert.equal(isNostrIdentityEnabled(null), false);
});

test('removing the identity cannot change what the npub would be', () => {
    const before = npubEncode(nostrCore.getNostrPublicKey(PRIV));
    setNostrIdentityEnabled(ADDRESS, false);
    setNostrIdentityEnabled(ADDRESS, true);
    const after = npubEncode(nostrCore.getNostrPublicKey(PRIV));

    // One key, one address: "delete" removes reachability, not the identity.
    assert.equal(after, before);
});

// ─── 2. Address resolution for the search box ────────────────────────────

test('the search resolves an npub, a hex key and a 0x-prefixed key alike', () => {
    const npub = npubEncode(PUBKEY);
    assert.equal(normalizeNostrPublicKey(npub), PUBKEY);
    assert.equal(normalizeNostrPublicKey(PUBKEY), PUBKEY);
    assert.equal(normalizeNostrPublicKey(`  ${npub}  `), PUBKEY);
    assert.equal(normalizeNostrPublicKey(`0x${PUBKEY}`), PUBKEY);
});

test('the search rejects anything that is not an address', () => {
    for (const bad of ['', '   ', 'alice@example.com', 'npub1nope', PUBKEY.slice(0, 40)]) {
        assert.throws(() => normalizeNostrPublicKey(bad), `"${bad}" must be rejected`);
    }
});

test('the search result shortens the npub for display without losing its prefix', () => {
    const npub = npubEncode(PUBKEY);
    const short = shortNpub(npub);
    assert.ok(short.startsWith('npub1'));
    assert.ok(short.endsWith(npub.slice(-6)));
    assert.ok(short.length < npub.length);
});

// ─── 3. Relay profiles are untrusted display text ────────────────────────

test('a profile is parsed into bounded, plain-text fields', () => {
    const profile = parseNostrProfile({
        kind: 0,
        content: JSON.stringify({ name: '  alice  ', display_name: 'Alice', about: 'builder', nip05: 'alice@example.com' })
    });

    assert.deepEqual(profile, { name: 'alice', displayName: 'Alice', about: 'builder', nip05: 'alice@example.com' });
});

test('hostile profile fields are neutralised', () => {
    const bidiOverride = String.fromCharCode(0x202e);
    const profile = parseNostrProfile({
        kind: 0,
        content: JSON.stringify({
            name: `alice${bidiOverride}bad`,
            about: 'x'.repeat(5000),
            display_name: { not: 'a string' },
            picture: 'https://tracker.example/pixel.png'
        })
    });

    assert.ok(!profile.name.includes(bidiOverride), 'bidi overrides must not reach the UI');
    assert.ok(profile.about.length <= 280, 'a long about must be capped');
    assert.equal(profile.displayName, '', 'a non-string field yields an empty string');
    assert.ok(!('picture' in profile), 'the picture URL is never surfaced');
});

test('malformed profile events are ignored', () => {
    assert.equal(parseNostrProfile(null), null);
    assert.equal(parseNostrProfile({ kind: 1, content: '{}' }), null, 'only kind 0 is a profile');
    assert.equal(parseNostrProfile({ kind: 0, content: 'not json' }), null);
    assert.equal(parseNostrProfile({ kind: 0, content: '[1,2,3]' }), null);
    assert.equal(parseNostrProfile({ kind: 0, content: 42 }), null);
});

// ─── 4. Profile lookup over the pool ─────────────────────────────────────

/** A pool double that hands the subscription a scripted set of events. */
function poolWith(events, { onClose = () => {} } = {}) {
    return {
        subscribe(filters, onEvent) {
            for (const event of events) onEvent(event, 'wss://fake.relay');
            return { close: onClose };
        }
    };
}

function profileEvent(createdAt, name) {
    return { kind: 0, created_at: createdAt, pubkey: PUBKEY, content: JSON.stringify({ name }) };
}

test('the newest profile wins when relays disagree', async () => {
    const pool = poolWith([profileEvent(100, 'old'), profileEvent(300, 'current'), profileEvent(200, 'stale')]);
    const profile = await lookupNostrProfile({ pool, publicKey: PUBKEY, timeoutMs: 5 });

    assert.equal(profile.name, 'current');
    assert.equal(profile.createdAt, 300);
});

test('a lookup with no results resolves to null rather than failing', async () => {
    const profile = await lookupNostrProfile({ pool: poolWith([]), publicKey: PUBKEY, timeoutMs: 5 });
    assert.equal(profile, null);
});

test('the subscription is always closed once the lookup settles', async () => {
    let closed = false;
    const pool = poolWith([profileEvent(100, 'alice')], { onClose: () => { closed = true; } });

    await lookupNostrProfile({ pool, publicKey: PUBKEY, timeoutMs: 5 });
    assert.equal(closed, true, 'a lookup must not leak a relay subscription');
});

test('a pool that throws does not break the search', async () => {
    const pool = {
        subscribe() {
            throw new Error('no relay reachable');
        }
    };
    assert.equal(await lookupNostrProfile({ pool, publicKey: PUBKEY, timeoutMs: 5 }), null);
});

test('a lookup for a malformed key never touches the pool', async () => {
    let subscribed = false;
    const pool = {
        subscribe() {
            subscribed = true;
            return { close() {} };
        }
    };

    assert.equal(await lookupNostrProfile({ pool, publicKey: 'nope', timeoutMs: 5 }), null);
    assert.equal(subscribed, false);
});
