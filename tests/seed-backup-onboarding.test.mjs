/**
 * Create Wallet → Seed Phrase Backup → Account.
 *
 * A wallet created a moment ago is unlocked inside the signing worker while
 * its recovery phrase is on the backup screen, and that is not the same as
 * being signed in. These tests pin the difference: nothing signed-in-only
 * appears, starts or navigates until the backup is acknowledged, and once it
 * is, the phrase is gone and the user lands on Account.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

function installOnboardingDom() {
    const installed = installFakeDom({
        browseTab: { tag: 'button', attrs: { 'data-tab': 'browse' }, classes: ['tab-btn'] },
        publishTab: { tag: 'button', attrs: { 'data-tab': 'publish' }, classes: ['tab-btn', 'active'] },
        pagesTab: { tag: 'button', attrs: { 'data-tab': 'pages' }, classes: ['tab-btn'] },
        authTab: { tag: 'button', attrs: { 'data-tab': 'auth' }, classes: ['tab-btn'] },
        channelsTab: { tag: 'button', attrs: { 'data-tab': 'channels' }, classes: ['tab-btn'] },
        aboutTab: { tag: 'button', attrs: { 'data-tab': 'about' }, classes: ['tab-btn'] },
        authPanel: { tag: 'div', id: 'tab-auth' },
        channelsPanel: { tag: 'div', id: 'tab-channels' },
        pagesPanel: { tag: 'div', id: 'tab-pages' },
        wall: { tag: 'section', id: 'deploy-auth-wall' },
        deployPanel: { tag: 'div', id: 'deploy-panel', classes: ['hidden'] },
        interrupted: { tag: 'div', id: 'seed-backup-interrupted', classes: ['hidden'] },
        screen: { tag: 'section', id: 'seed-backup-screen', classes: ['hidden'] },
        words: { tag: 'ol', id: 'seed-backup-words' },
        download: { tag: 'button', id: 'seed-backup-download-btn' },
        copy: { tag: 'button', id: 'seed-backup-copy-btn' },
        confirm: { tag: 'button', id: 'seed-backup-confirm-btn' }
    });
    // Revealing Account clears its inline display.
    const panel = installed.nodes.authPanel;
    panel.style.removeProperty = (name) => delete panel.style[name];
    return installed;
}

function memoryStorage() {
    const store = new Map();
    return {
        store,
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, `${value}`),
        removeItem: (key) => store.delete(key)
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A PeerWeb-shaped context carrying the real lifecycle mixin. */
async function context(state) {
    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    const calls = { gofile: 0, nostr: 0, resume: 0 };
    return {
        ...lifecycle,
        calls,
        log() {},
        toast: { info() {}, warning() {}, error() {}, success() {} },
        authController: { state },
        nostrDmSession: {
            started: false,
            start: async () => {
                calls.nostr += 1;
            },
            stop() {}
        },
        applyResumeHint: () => {
            calls.resume += 1;
            return 'browse';
        },
        ensureGoFileCredential: async () => {
            calls.gofile += 1;
            return 'present';
        }
    };
}

function unlockedState(overrides = {}) {
    return {
        localWalletExists: true,
        localWalletUnlocked: true,
        address: '0xabc',
        identityType: 'local',
        npub: 'npub1test',
        nostrPublicKey: 'ab'.repeat(32),
        nostrEnabled: true,
        seedBackupPending: true,
        seedBackupInterrupted: false,
        ...overrides
    };
}

let dom;
let previousLocalStorage;
test.beforeEach(() => {
    dom = installOnboardingDom();
    previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = memoryStorage();
});
test.afterEach(async () => {
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');
    screen.hideSeedPhrase();
    dom.restore();
    globalThis.localStorage = previousLocalStorage;
});

test('an unlocked wallet on its backup step is not signed in', async () => {
    const state = unlockedState();
    const peerweb = await context(state);

    peerweb.setupAuthAwareUi.call(peerweb, state);
    await flush();

    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), false);
    // Only Search, Sign in and About: every signed-in tab stays closed.
    assert.equal(dom.nodes.authTab.style.display, 'none');
    assert.equal(dom.nodes.channelsTab.style.display, 'none');
    assert.equal(dom.nodes.pagesTab.style.display, 'none');
    assert.equal(dom.nodes.deployPanel.classList.contains('hidden'), true);
    // The backup screen stands in for the sign-in wall.
    assert.equal(dom.nodes.wall.classList.contains('hidden'), true);
    assert.equal(dom.nodes.publishTab.textContent, '🔐 Sign in');
    // Nothing signed-in-only starts, and nobody is moved to Account.
    assert.deepEqual(peerweb.calls, { gofile: 0, nostr: 0, resume: 0 });
    assert.equal(dom.nodes.publishTab.classList.contains('active'), true);
});

test('confirming the backup signs in, lands on Account and provisions GoFile', async () => {
    const state = unlockedState();
    const peerweb = await context(state);
    let landed = 0;
    dom.nodes.authTab.addEventListener('click', () => {
        landed += 1;
    });

    peerweb.setupAuthAwareUi.call(peerweb, state);
    await flush();
    assert.equal(landed, 0);

    state.seedBackupPending = false;
    peerweb.setupAuthAwareUi.call(peerweb, state);
    await flush();

    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), true);
    assert.equal(dom.nodes.authTab.style.display, 'inline-flex');
    assert.equal(dom.nodes.channelsTab.style.display, 'inline-flex');
    assert.equal(dom.nodes.deployPanel.classList.contains('hidden'), false);
    assert.equal(dom.nodes.wall.classList.contains('hidden'), true);
    // Account, even though a remembered tab would otherwise win.
    assert.equal(landed, 1);
    assert.equal(peerweb.calls.resume, 0);
    assert.equal(peerweb.calls.gofile, 1);
    assert.equal(peerweb.calls.nostr, 1);
});

test('an ordinary unlock still resumes where the user was', async () => {
    const state = unlockedState({ seedBackupPending: false });
    const peerweb = await context(state);
    let landed = 0;
    dom.nodes.authTab.addEventListener('click', () => {
        landed += 1;
    });

    peerweb.setupAuthAwareUi.call(peerweb, state);
    await flush();

    assert.equal(peerweb.calls.resume, 1);
    assert.equal(landed, 0, 'the remembered tab wins over Account');
    assert.equal(peerweb.calls.gofile, 1);
});

test('an interrupted backup is announced on the wall, with its reset', async () => {
    const state = unlockedState({
        localWalletUnlocked: false,
        seedBackupPending: false,
        seedBackupInterrupted: true
    });
    const peerweb = await context(state);

    peerweb.setupAuthAwareUi.call(peerweb, state);

    assert.equal(dom.nodes.wall.classList.contains('hidden'), false);
    assert.equal(dom.nodes.interrupted.classList.contains('hidden'), false);
});

test('the backup screen shows the words, and confirming removes them', async () => {
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');
    let confirmed = 0;
    screen.bindSeedPhraseScreen({
        onConfirm: () => {
            confirmed += 1;
            screen.hideSeedPhrase();
        }
    });

    screen.showSeedPhrase(PHRASE);
    assert.equal(dom.nodes.screen.classList.contains('hidden'), false);
    assert.equal(dom.nodes.words.children.length, 12);
    assert.equal(dom.nodes.words.children[0].textContent, 'abandon');
    assert.equal(screen.isSeedPhraseShown(), true);

    dom.nodes.confirm.click();
    assert.equal(confirmed, 1);
    assert.equal(dom.nodes.screen.classList.contains('hidden'), true);
    assert.equal(dom.nodes.words.children.length, 0);
    assert.equal(dom.nodes.words.textContent, '');
    assert.equal(screen.isSeedPhraseShown(), false);
    // Never written to storage.
    for (const value of globalThis.localStorage.store.values()) {
        assert.doesNotMatch(value, /abandon/);
    }
});

test('the downloaded file carries the phrase as plain text', async () => {
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');
    assert.equal(screen.RECOVERY_FILE_NAME.endsWith('.txt'), true);
    assert.match(screen.recoveryFileText(PHRASE), new RegExp(`\\n${PHRASE}\\n`));
});

test('the controller holds the identity back until the backup is confirmed', async () => {
    const { default: AuthController } = await import('../src/auth/AuthController.js');
    const { readSeedBackupPending, markSeedBackupPending } = await import('../src/auth/SeedBackupState.js');
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');

    const controller = new AuthController({ info() {}, warning() {}, error() {}, success() {} });
    controller.render = () => {};
    const seen = [];
    controller.onChange((state) => seen.push(state.seedBackupPending));

    Object.assign(controller.state, unlockedState(), { status: 'local_unlocked', publicKey: '02ab' });
    markSeedBackupPending();
    screen.showSeedPhrase(PHRASE);

    // No identity to act with while the step is open.
    assert.equal(controller.getActiveIdentity().address, null);

    // A second Create Wallet press is ignored rather than making a new wallet.
    await controller.registerLocal();
    assert.equal(screen.isSeedPhraseShown(), true);

    controller.confirmSeedBackup();
    assert.equal(controller.state.seedBackupPending, false);
    assert.equal(screen.isSeedPhraseShown(), false);
    assert.equal(readSeedBackupPending(), false);
    assert.equal(controller.getActiveIdentity().address, '0xabc');
    assert.deepEqual(seen, [false]);

    // Confirming twice is a no-op.
    controller.confirmSeedBackup();
    assert.deepEqual(seen, [false]);
});
