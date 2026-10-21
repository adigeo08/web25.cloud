/**
 * What the About page promises about the passkey.
 *
 * The Identity card described the passkey as an unlock gate, which undersells
 * what PasskeyVault actually does: the PRF output is the only secret, and it is
 * what the vault key is wrapped under. A reader deciding whether to trust the
 * thing with a wallet needs that, so it is a contract rather than prose.
 *
 * The card is the Markdown chapter content/about/identity.md, which the About
 * page renders; that file is where the wording is checked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VAULT = readFileSync(new URL('../src/auth/PasskeyVault.js', import.meta.url), 'utf8');

// Whitespace collapsed, so re-wrapping the Markdown cannot break a sentence apart.
const CARD = readFileSync(new URL('../content/about/identity.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('the Identity card names the PRF extension and what it derives', () => {
    assert.ok(CARD.includes('PRF'), 'the card names PRF');
    assert.match(CARD, /HKDF-SHA256/);
    assert.match(CARD, /AES-GCM/);
    assert.match(CARD, /wraps the vault/);
});

test('it says the PRF secret is never stored, which is the whole claim', () => {
    assert.match(CARD, /never leaves the call stack/);
    assert.match(CARD, /never written to storage/);
    // The vault says the same thing, and the two must not drift apart.
    assert.match(VAULT, /never written to IndexedDB, localStorage or any other storage/);
});

test('it says a browser without PRF is refused rather than downgraded', () => {
    assert.match(CARD, /refused rather than quietly handed a weaker path/);
    assert.match(VAULT, /does not fall back to a weaker unlock path/);
});

test('the feature list reflects that several passkeys open one wallet', () => {
    assert.match(CARD, /WebAuthn PRF unlock/);
    assert.match(CARD, /each wraps the same key/);
    assert.match(VAULT, /Every passkey enrolled against a vault wraps the \*same\* vault key/);
});
