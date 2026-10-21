/**
 * Account page, navigation and sign-in wall markup.
 *
 * These are contracts the auth code relies on but cannot assert for itself:
 * which tabs a visitor without an identity can see, which onboarding steps
 * precede the Account page, and which controls the sign-in wall offers.
 * They break in a browser, silently, so they are checked against index.html.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const NAV = MARKUP.slice(MARKUP.indexOf('<nav id="primary-nav"'), MARKUP.indexOf('</nav>'));
const ACCOUNT = MARKUP.slice(MARKUP.indexOf('id="tab-auth"'), MARKUP.indexOf('<!-- ── PUBLISH TAB ── -->'));

test('the navigation reads Search, Sign in, Account, Chat, About', () => {
    assert.match(NAV, /data-tab="browse"[\s\S]{0,120}🔍 Search/);
    assert.match(NAV, /data-tab="auth"[\s\S]{0,160}👤 Account/);
    assert.match(NAV, /data-tab="channels"[\s\S]{0,160}💬 Chat/);
    assert.match(NAV, /data-tab="about"[\s\S]{0,120}ℹ️ About/);
});

test('the Deploy tab ships signed out, because a page that has just loaded is', () => {
    // The signing worker starts locked on every page load, so "Sign in" is not
    // a guess about this visitor — it is true of every first paint. It used to
    // ship as "Deploy" and be corrected by the first auth render, which on a
    // phone meant a Deploy tab offered to a guest for as long as the libraries
    // took to load. `setupAuthAwareUi` swaps it to Deploy on unlock.
    assert.match(NAV, /data-tab="publish"[\s\S]{0,200}🔐 Sign in/);
    assert.match(NAV, /data-tab="publish"[^>]*aria-busy="true"/);
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

test('the wall waits behind a placeholder until it knows which way in applies', () => {
    const wall = MARKUP.slice(MARKUP.indexOf('id="deploy-auth-wall"'), MARKUP.indexOf('id="deploy-panel"'));

    // Whether this browser holds a wallet takes an IndexedDB read to answer.
    // Offering Unlock and Create together and then withdrawing one is worse
    // than a moment of waiting, so the row starts hidden behind a skeleton and
    // `applyAuthPhase` swaps them once the read lands.
    assert.match(wall, /id="deploy-wall-loading"[^>]*class="auth-skeleton"/);
    assert.match(wall, /id="deploy-wall-actions"[^>]*class="button-group hidden"/);
    assert.match(wall, /id="deploy-auth-wall"[^>]*aria-busy="true"/);
    assert.ok(wall.indexOf('deploy-wall-loading') < wall.indexOf('deploy-wall-actions'));
});

test('the Account page no longer carries the recovery phrase', () => {
    // The phrase belongs to the onboarding step between Create Wallet and
    // Account; once a user lands here it is gone for good.
    assert.doesNotMatch(ACCOUNT, /seed-phrase-screen|seed-phrase-box|close-seed-screen-btn|seed-backup/);
});

test('the recovery phrase backup step lists its parts in order, ahead of the sign-in wall', () => {
    const publish = MARKUP.slice(MARKUP.indexOf('<!-- ── PUBLISH TAB ── -->'));
    const screen = publish.slice(publish.indexOf('id="seed-backup-screen"'), publish.indexOf('id="deploy-auth-wall"'));

    assert.ok(publish.indexOf('id="seed-backup-screen"') > -1, 'the backup step lives on the Sign in tab');
    assert.match(screen, /id="seed-backup-screen"[^>]*class="seed-backup card-base hidden"/);

    const order = [
        'Save your recovery phrase',
        'id="seed-backup-words"',
        'only way to recover this wallet and its identities',
        'Download Recovery Phrase (.txt)',
        'id="seed-backup-copy-btn"',
        'Security warning',
        "I understand and I've copied/downloaded my seed"
    ].map((needle) => screen.indexOf(needle));
    order.forEach((at, index) => assert.ok(at > -1, `part ${index} is present`));
    assert.deepEqual(
        [...order].sort((a, b) => a - b),
        order,
        'and in the specified order'
    );
});

test('the sign-in wall offers a reset for a backup that was never confirmed', () => {
    const wall = MARKUP.slice(MARKUP.indexOf('id="deploy-auth-wall"'), MARKUP.indexOf('id="deploy-panel"'));
    assert.match(wall, /id="seed-backup-interrupted"[^>]*class="seed-backup-interrupted hidden"/);
    assert.match(wall, /id="reset-unconfirmed-wallet-btn"/);
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
    const headerBlock = ACCOUNT.slice(0, ACCOUNT.indexOf('id="identity-keys-panel"'));
    assert.match(headerBlock, /id="lock-disconnect-auth-btn"/);
    assert.match(headerBlock, /id="add-passkey-btn"/);
    assert.doesNotMatch(headerBlock, /id="delete-local-wallet-btn"/);
});
