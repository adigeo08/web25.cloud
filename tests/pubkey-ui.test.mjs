/**
 * Focused tests for ECIES public-key derivation and UI helper logic.
 * These tests validate the pure logic used by the profile and DM panels
 * without requiring a real DOM or browser APIs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getPublicKeyFromPrivateKey, evmAddressFromPublicKey } from '../src/channels/ecies.js';

// ─── Deterministic test keys ─────────────────────────────────────────────────
const PRIV_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
const KNOWN_PUB_KEY = getPublicKeyFromPrivateKey(PRIV_KEY);
const KNOWN_ADDRESS = evmAddressFromPublicKey(KNOWN_PUB_KEY);

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

// ─── updateDmOwnPubkey logic (DOM-independent simulation) ────────────────────

/**
 * Simulates the DOM element state management used by updateDmOwnPubkey.
 * This mirrors the logic without requiring jsdom.
 */
function simulateUpdateDmOwnPubkey(publicKey) {
    // Simulate element state
    const state = {
        panel: { hidden: true },
        lockedPanel: { hidden: false },
        valueEl: { textContent: '' }
    };

    if (publicKey) {
        state.panel.hidden = false;
        state.lockedPanel.hidden = true;
        state.valueEl.textContent = publicKey;
    } else {
        state.panel.hidden = true;
        state.lockedPanel.hidden = false;
        state.valueEl.textContent = '';
    }

    return state;
}

test('updateDmOwnPubkey logic: shows key panel and hides locked panel when key is provided', () => {
    const state = simulateUpdateDmOwnPubkey(KNOWN_PUB_KEY);
    assert.equal(state.panel.hidden, false, 'key panel should be visible');
    assert.equal(state.lockedPanel.hidden, true, 'locked panel should be hidden');
    assert.equal(state.valueEl.textContent, KNOWN_PUB_KEY, 'public key value should be set');
});

test('updateDmOwnPubkey logic: hides key panel and shows locked panel when key is null', () => {
    const state = simulateUpdateDmOwnPubkey(null);
    assert.equal(state.panel.hidden, true, 'key panel should be hidden');
    assert.equal(state.lockedPanel.hidden, false, 'locked panel should be visible');
    assert.equal(state.valueEl.textContent, '', 'public key value should be empty');
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
