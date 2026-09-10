/**
 * Account page, navigation and sign-in wall markup.
 *
 * These are contracts the auth code relies on but cannot assert for itself:
 * which tabs a visitor without an identity can see, where the one-time seed
 * band sits on the Account page, and which controls the sign-in wall offers.
 * They break in a browser, silently, so they are checked against index.html.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const NAV = MARKUP.slice(MARKUP.indexOf('<nav class="tab-nav"'), MARKUP.indexOf('</nav>'));
const ACCOUNT = MARKUP.slice(MARKUP.indexOf('id="tab-auth"'), MARKUP.indexOf('<!-- ── PUBLISH TAB ── -->'));

test('the navigation reads Search, Deploy, Account, Chat, About', () => {
    assert.match(NAV, /data-tab="browse"[\s\S]{0,120}🔍 Search/);
    assert.match(NAV, /data-tab="publish"[\s\S]{0,120}🚀 Deploy/);
    assert.match(NAV, /data-tab="auth"[\s\S]{0,160}👤 Account/);
    assert.match(NAV, /data-tab="channels"[\s\S]{0,160}💬 Chat/);
    assert.match(NAV, /data-tab="about"[\s\S]{0,120}ℹ️ About/);
});

test('Account and Chat are hidden until an identity exists', () => {
    // Hidden in the markup itself, so they are never visible in the moment
    // between first paint and the first auth render.
    assert.match(NAV, /data-tab="auth"[^>]*style="display: none"/);
    assert.match(NAV, /data-tab="channels"[^>]*style="display: none"/);
    assert.match(MARKUP, /id="tab-auth"[^>]*style="display: none"/);
    assert.match(MARKUP, /id="tab-channels"[^>]*style="display: none"/);

    // The Deploy tab is the exception on purpose: it carries the sign-in wall,
    // which holds the only unlock/create/recover controls in the app. Hiding it
    // would leave a visitor with no way to sign in at all.
    assert.doesNotMatch(NAV, /data-tab="publish"[^>]*style="display: none"/);
});

test('the sign-in wall offers unlock, create and recover', () => {
    const wall = MARKUP.slice(MARKUP.indexOf('id="deploy-auth-wall"'), MARKUP.indexOf('id="deploy-panel"'));
    for (const id of ['unlock-wallet-btn', 'register-wallet-btn', 'recover-wallet-btn']) {
        assert.match(wall, new RegExp(`id="${id}"`), `${id} belongs to the sign-in wall`);
    }
    // Unlock and Create are alternatives chosen at render time by
    // localWalletExists; neither may be hidden in the markup, or the wall would
    // start with the wrong one missing.
    assert.doesNotMatch(wall, /id="unlock-wallet-btn"[^>]*class="[^"]*hidden/);
    assert.doesNotMatch(wall, /id="register-wallet-btn"[^>]*class="[^"]*hidden/);
});

test('the one-time seed band spans the Account page above the identity columns', () => {
    const header = ACCOUNT.indexOf('class="account-header');
    const seed = ACCOUNT.indexOf('id="seed-phrase-screen"');
    const keys = ACCOUNT.indexOf('id="identity-keys-panel"');

    assert.ok(header > -1 && seed > header, 'the seed band follows the account header');
    assert.ok(seed > -1 && seed < keys, 'the seed band comes before the two identity cards');
    // It is a band, not a third column: nothing inside the keys panel.
    assert.doesNotMatch(ACCOUNT.slice(keys), /id="seed-phrase-screen"/);
    // Hidden until a wallet is created, and revealed by class alone.
    assert.match(ACCOUNT, /id="seed-phrase-screen"[^>]*class="account-seed hidden"/);
    assert.match(ACCOUNT, /id="seed-phrase-box"/);
    assert.match(ACCOUNT, /id="close-seed-screen-btn"/);
});

test('the two identity cards each carry their own destructive action', () => {
    const panel = ACCOUNT.slice(ACCOUNT.indexOf('id="identity-keys-panel"'));
    const wallet = panel.slice(0, panel.indexOf('id="identity-nostr-block"'));
    const nostr = panel.slice(panel.indexOf('id="identity-nostr-block"'));

    assert.match(wallet, /id="identity-full-address"/);
    assert.match(wallet, /id="identity-full-pubkey"/);
    assert.match(wallet, /id="delete-local-wallet-btn"/);

    assert.match(nostr, /id="identity-full-npub"/);
    assert.match(nostr, /id="identity-full-nostr-pubkey"/);
    assert.match(nostr, /id="delete-nostr-identity-btn"/);
    assert.match(nostr, /id="add-nostr-identity-btn"/);

    // Session actions stay in the header, away from the keys.
    const headerBlock = ACCOUNT.slice(0, ACCOUNT.indexOf('id="seed-phrase-screen"'));
    assert.match(headerBlock, /id="lock-disconnect-auth-btn"/);
    assert.match(headerBlock, /id="add-passkey-btn"/);
    assert.doesNotMatch(headerBlock, /id="delete-local-wallet-btn"/);
});
