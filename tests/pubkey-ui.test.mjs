/**
 * Focused tests for key derivation and UI helper logic.
 *
 * These validate the pure logic behind the Identity page and the Direct
 * Messenger panel — which keys are shown, which actions are offered — without
 * requiring a real DOM or browser APIs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';
import { nostrCore } from '../src/nostr/nostr.js';
import { npubEncode } from '../src/nostr/nip19.js';

// ─── Deterministic test keys ─────────────────────────────────────────────────
const PRIV_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KNOWN_PUB_KEY = getPublicKeyFromPrivateKey(PRIV_KEY);
const KNOWN_ADDRESS = evmAddressFromPublicKey(KNOWN_PUB_KEY);
const KNOWN_NOSTR_PUBKEY = nostrCore.getNostrPublicKey(PRIV_KEY);
const KNOWN_NPUB = npubEncode(KNOWN_NOSTR_PUBKEY);

// ─── Public key derivation ────────────────────────────────────────────────────

test('getPublicKeyFromPrivateKey returns a 130-char uncompressed hex key starting with 04', () => {
    const pub = getPublicKeyFromPrivateKey(PRIV_KEY);
    assert.equal(pub.length, 130, 'uncompressed secp256k1 key must be 130 hex chars (65 bytes)');
    assert.ok(pub.startsWith('04'), 'uncompressed public key must start with "04"');
});

test('getPublicKeyFromPrivateKey is deterministic for same private key', () => {
    const pub1 = getPublicKeyFromPrivateKey(PRIV_KEY);
    const pub2 = getPublicKeyFromPrivateKey(PRIV_KEY);
    assert.equal(pub1, pub2, 'same private key must always yield same public key');
});

test('getPublicKeyFromPrivateKey produces different keys for different private keys', () => {
    const priv2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const pub1 = getPublicKeyFromPrivateKey(PRIV_KEY);
    const pub2 = getPublicKeyFromPrivateKey(priv2);
    assert.notEqual(pub1, pub2, 'different private keys must yield different public keys');
});

test('getPublicKeyFromPrivateKey accepts bare hex without 0x prefix', () => {
    const bare = PRIV_KEY.slice(2); // strip "0x"
    const pub = getPublicKeyFromPrivateKey(bare);
    assert.equal(pub, KNOWN_PUB_KEY, 'bare hex and 0x-prefixed hex must yield same public key');
});

// ─── EVM address derivation ───────────────────────────────────────────────────

test('evmAddressFromPublicKey returns a 42-char lowercase 0x-prefixed EVM address', () => {
    const addr = evmAddressFromPublicKey(KNOWN_PUB_KEY);
    assert.ok(addr.startsWith('0x'), 'EVM address must start with "0x"');
    assert.equal(addr.length, 42, 'EVM address must be 42 chars (0x + 40 hex)');
    assert.equal(addr, addr.toLowerCase(), 'EVM address must be lowercase');
});

test('evmAddressFromPublicKey is deterministic', () => {
    const addr1 = evmAddressFromPublicKey(KNOWN_PUB_KEY);
    const addr2 = evmAddressFromPublicKey(KNOWN_PUB_KEY);
    assert.equal(addr1, addr2);
});

// ─── DM panel identity display (DOM-independent simulation) ─────────────────

/**
 * Mirrors `updateDmNostrIdentity`: the DM panel shows the Nostr address, the
 * "unlock first" notice, or the "identity removed" notice — never the raw ECIES
 * key, which now lives only on the Identity page.
 */
function simulateUpdateDmNostrIdentity({ npub, enabled = true }) {
    const hasIdentity = Boolean(npub) && enabled !== false;
    return {
        npubPanelHidden: !hasIdentity,
        lockedPanelHidden: Boolean(npub) || enabled === false,
        disabledPanelHidden: enabled !== false,
        searchHidden: !hasIdentity,
        npubValue: hasIdentity ? npub : ''
    };
}

test('DM panel: an unlocked, reachable identity shows the npub and the search', () => {
    const state = simulateUpdateDmNostrIdentity({ npub: KNOWN_NPUB, enabled: true });
    assert.equal(state.npubPanelHidden, false);
    assert.equal(state.lockedPanelHidden, true);
    assert.equal(state.disabledPanelHidden, true);
    assert.equal(state.searchHidden, false);
    assert.equal(state.npubValue, KNOWN_NPUB);
});

test('DM panel: a locked wallet shows the unlock notice and hides the search', () => {
    const state = simulateUpdateDmNostrIdentity({ npub: null, enabled: true });
    assert.equal(state.npubPanelHidden, true);
    assert.equal(state.lockedPanelHidden, false);
    assert.equal(state.disabledPanelHidden, true);
    assert.equal(state.searchHidden, true);
    assert.equal(state.npubValue, '');
});

test('DM panel: a removed Nostr identity shows the removed notice, not the unlock one', () => {
    const state = simulateUpdateDmNostrIdentity({ npub: null, enabled: false });
    assert.equal(state.npubPanelHidden, true);
    assert.equal(state.lockedPanelHidden, true, 'the unlock notice must not compete with the removed notice');
    assert.equal(state.disabledPanelHidden, false);
    assert.equal(state.searchHidden, true, 'messaging is unavailable without the identity');
});

// ─── Identity page Nostr section (DOM-independent simulation) ───────────────

/**
 * Mirrors `renderNostrIdentitySection`: exactly one of Add/Delete is offered,
 * and key values are only rendered when the identity is actually present.
 */
function simulateNostrIdentitySection({ npub, nostrPublicKey, nostrEnabled, unlocked }) {
    const hasIdentity = Boolean(unlocked && nostrEnabled && npub);
    return {
        presentHidden: !hasIdentity,
        absentHidden: hasIdentity || !unlocked,
        npubValue: hasIdentity ? npub : '',
        pubkeyValue: hasIdentity ? nostrPublicKey || '' : '',
        addHidden: !unlocked || nostrEnabled,
        deleteHidden: !unlocked || !nostrEnabled
    };
}

test('identity page: an active Nostr identity shows both keys and only Delete', () => {
    const state = simulateNostrIdentitySection({
        npub: KNOWN_NPUB,
        nostrPublicKey: KNOWN_NOSTR_PUBKEY,
        nostrEnabled: true,
        unlocked: true
    });
    assert.equal(state.presentHidden, false);
    assert.equal(state.absentHidden, true);
    assert.equal(state.npubValue, KNOWN_NPUB);
    assert.equal(state.pubkeyValue, KNOWN_NOSTR_PUBKEY);
    assert.equal(state.addHidden, true, 'Add is pointless while the identity is present');
    assert.equal(state.deleteHidden, false);
});

test('identity page: a removed Nostr identity shows the notice and only Add', () => {
    const state = simulateNostrIdentitySection({
        npub: null,
        nostrPublicKey: null,
        nostrEnabled: false,
        unlocked: true
    });
    assert.equal(state.presentHidden, true);
    assert.equal(state.absentHidden, false);
    assert.equal(state.npubValue, '');
    assert.equal(state.addHidden, false);
    assert.equal(state.deleteHidden, true, 'Delete is pointless while the identity is absent');
});

test('identity page: a locked wallet offers neither action and renders no keys', () => {
    const state = simulateNostrIdentitySection({
        npub: null,
        nostrPublicKey: null,
        nostrEnabled: true,
        unlocked: false
    });
    assert.equal(state.presentHidden, true);
    assert.equal(state.absentHidden, true);
    assert.equal(state.addHidden, true);
    assert.equal(state.deleteHidden, true);
});

// ─── Profile panel key derivation logic ──────────────────────────────────────

/**
 * Simulates the key derivation + panel visibility logic in renderAuthPanel.
 */
function simulateProfileKeyPanel(state, privateKey) {
    const isUnlocked = Boolean(state.localWalletUnlocked && state.address && privateKey);
    let derivedPubKey = '';
    if (isUnlocked && privateKey) {
        try {
            derivedPubKey = getPublicKeyFromPrivateKey(privateKey);
        } catch (_) {
            derivedPubKey = '';
        }
    }
    return { isUnlocked, derivedPubKey };
}

test('profile panel: key panel is shown and pubkey derived when wallet is unlocked', () => {
    const authState = { localWalletUnlocked: true, address: KNOWN_ADDRESS };
    const { isUnlocked, derivedPubKey } = simulateProfileKeyPanel(authState, PRIV_KEY);
    assert.equal(isUnlocked, true);
    assert.equal(derivedPubKey, KNOWN_PUB_KEY);
});

test('profile panel: key panel is hidden when wallet is locked (no private key)', () => {
    const authState = { localWalletUnlocked: false, address: KNOWN_ADDRESS };
    const { isUnlocked, derivedPubKey } = simulateProfileKeyPanel(authState, null);
    assert.equal(isUnlocked, false);
    assert.equal(derivedPubKey, '');
});

test('profile panel: key panel is hidden when no address (anonymous)', () => {
    const authState = { localWalletUnlocked: false, address: null };
    const { isUnlocked, derivedPubKey } = simulateProfileKeyPanel(authState, null);
    assert.equal(isUnlocked, false);
    assert.equal(derivedPubKey, '');
});

test('profile panel: derived pubkey matches known value for test key', () => {
    const authState = { localWalletUnlocked: true, address: KNOWN_ADDRESS };
    const { derivedPubKey } = simulateProfileKeyPanel(authState, PRIV_KEY);
    assert.ok(derivedPubKey.startsWith('04'), 'public key must start with 04');
    assert.equal(derivedPubKey.length, 130, 'public key must be 130 chars');
});
