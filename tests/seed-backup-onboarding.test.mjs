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
let previousButton;
test.beforeEach(() => {
    dom = installOnboardingDom();
    previousButton = globalThis.HTMLButtonElement;
    globalThis.HTMLButtonElement = globalThis.HTMLElement;
    previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = memoryStorage();
});
test.afterEach(async () => {
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');
    screen.hideSeedPhrase();
    dom.restore();
    globalThis.HTMLButtonElement = previousButton;
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

/**
 * The signing worker and passkey vault, in memory: a stored record, a worker
 * that is unlocked or not, and the one phrase that belongs to the record.
 */
function fakeWallet({ failAfterPersist = false } = {}) {
    const wallet = {
        record: null,
        unlocked: false,
        phrase: null,
        created: 0,
        unlockAttempts: 0,
        async getLocalWalletStatus() {
            return {
                exists: Boolean(wallet.record),
                address: wallet.record?.address || null,
                unlocked: wallet.unlocked,
                needsMigration: false,
                passkeyProtected: true
            };
        },
        async getLocalWalletRecord() {
            return wallet.record;
        },
        async getLocalWalletPublicKey() {
            return wallet.unlocked ? '02ab' : null;
        },
        async getLocalWalletNostrIdentity() {
            return wallet.unlocked ? { nostrPublicKey: 'ab'.repeat(32), npub: 'npub1test' } : null;
        },
        async clearLocalWalletSession() {
            wallet.unlocked = false;
        },
        async registerLocalWallet() {
            if (wallet.record) throw new Error('A local wallet already exists on this device.');
            wallet.created += 1;
            wallet.phrase = PHRASE;
            wallet.record = { address: '0xabc' };
            if (failAfterPersist) throw new Error('Worker hand-off failed.');
            wallet.unlocked = true;
            return { address: '0xabc', seedPhrase: PHRASE };
        },
        async unlockLocalWallet() {
            wallet.unlockAttempts += 1;
            wallet.unlocked = true;
            return { address: wallet.record.address };
        },
        async seedPhraseMatchesLocalWallet(seedPhrase) {
            return Boolean(wallet.record) && seedPhrase.trim() === wallet.phrase;
        },
        async registerLocalWalletFromSeed() {
            throw new Error('A local wallet already exists. Delete it first before recovering from a seed phrase.');
        },
        async removeLocalWallet() {
            wallet.record = null;
            wallet.unlocked = false;
        }
    };
    return wallet;
}

const quietToast = () => {
    const messages = [];
    const record = (kind) => (message) => messages.push({ kind, message });
    return {
        messages,
        info: record('info'),
        warning: record('warning'),
        error: record('error'),
        success: record('success')
    };
};

/** A controller over the fake wallet, rendering into the real Lifecycle gate. */
async function onboardingSession(wallet) {
    const { default: AuthController } = await import('../src/auth/AuthController.js');
    const toast = quietToast();
    const controller = new AuthController(toast, { wallet });
    controller.render = () => {};
    const peerweb = await context(controller.state);
    peerweb.authController = controller;
    controller.onChange((state) => peerweb.setupAuthAwareUi.call(peerweb, state));
    return { controller, peerweb, toast };
}

/** Nothing of the signed-in app is reachable. */
async function assertSignedOut(controller, peerweb) {
    await flush();
    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), false);
    assert.equal(controller.getActiveIdentity().address, null);
    assert.equal(dom.nodes.authTab.style.display, 'none');
    assert.equal(dom.nodes.channelsTab.style.display, 'none');
    assert.equal(dom.nodes.pagesTab.style.display, 'none');
    assert.equal(dom.nodes.deployPanel.classList.contains('hidden'), true);
    assert.equal(peerweb.calls.gofile, 0, 'GoFile is not provisioned');
    assert.equal(peerweb.calls.nostr, 0, 'the Nostr inbox is not started');
}

test('the controller holds the identity back until the backup is confirmed', async () => {
    const wallet = fakeWallet();
    const { controller, peerweb } = await onboardingSession(wallet);
    const { readSeedBackupPending } = await import('../src/auth/SeedBackupState.js');
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');

    await controller.registerLocal();
    assert.equal(controller.state.seedBackupPending, true);
    assert.equal(screen.isSeedPhraseShown(), true);
    assert.equal(readSeedBackupPending(), true);
    await assertSignedOut(controller, peerweb);

    // A second Create Wallet press is ignored rather than making a new wallet.
    await controller.registerLocal();
    assert.equal(wallet.created, 1);

    assert.equal(await controller.confirmSeedBackup(), true);
    assert.equal(controller.state.seedBackupPending, false);
    assert.equal(screen.isSeedPhraseShown(), false);
    assert.equal(readSeedBackupPending(), false);
    assert.equal(controller.getActiveIdentity().address, '0xabc');
    await flush();
    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), true);
    assert.equal(peerweb.calls.gofile, 1);

    // Confirming twice is a no-op.
    assert.equal(await controller.confirmSeedBackup(), false);
});

test('create → refresh → unlock without confirming stays out of the app', async () => {
    const wallet = fakeWallet();
    const first = await onboardingSession(wallet);
    await first.controller.registerLocal();

    // The page reloads: the worker starts locked and the phrase is gone.
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');
    screen.hideSeedPhrase();
    wallet.unlocked = false;
    const { controller, peerweb, toast } = await onboardingSession(wallet);
    await controller.refreshLocalWalletState();
    controller.notify();

    assert.equal(controller.state.seedBackupInterrupted, true);
    assert.equal(dom.nodes.interrupted.classList.contains('hidden'), false);
    assert.equal(dom.nodes.wall.classList.contains('hidden'), false);

    assert.equal(await controller.unlockLocal(), false);
    assert.equal(wallet.unlockAttempts, 0, 'no passkey ceremony, no session');
    assert.equal(wallet.unlocked, false);
    assert.ok(toast.messages.some(({ kind }) => kind === 'warning'));
    await assertSignedOut(controller, peerweb);

    // A worker that is somehow unlocked is locked again on the next read.
    wallet.unlocked = true;
    await controller.refreshLocalWalletState();
    controller.notify();
    assert.equal(wallet.unlocked, false);
    await assertSignedOut(controller, peerweb);

    // The wrong phrase proves nothing.
    assert.equal(await controller.recoverLocal('wrong words'), false);
    await assertSignedOut(controller, peerweb);

    // The original phrase does: the flag clears and the wallet unlocks.
    assert.equal(await controller.recoverLocal(PHRASE), true);
    const { readSeedBackupPending } = await import('../src/auth/SeedBackupState.js');
    assert.equal(readSeedBackupPending(), false);
    assert.equal(controller.state.seedBackupInterrupted, false);
    await flush();
    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), true);
    assert.equal(peerweb.calls.gofile, 1);
});

test('wallet persisted → provisioning failure → reload keeps the backup warning', async () => {
    const wallet = fakeWallet({ failAfterPersist: true });
    const { controller, peerweb, toast } = await onboardingSession(wallet);
    const { readSeedBackupPending } = await import('../src/auth/SeedBackupState.js');
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');

    await controller.registerLocal();
    assert.ok(toast.messages.some(({ kind }) => kind === 'error'));
    assert.equal(readSeedBackupPending(), true, 'a saved wallet keeps its unconfirmed flag');
    assert.equal(screen.isSeedPhraseShown(), false);
    assert.equal(controller.state.seedBackupInterrupted, true);
    await assertSignedOut(controller, peerweb);

    // No replacement phrase over the saved wallet.
    await controller.registerLocal();
    assert.equal(wallet.created, 1);

    // After a reload the notice is still there, with its reset.
    const reloaded = await onboardingSession(wallet);
    await reloaded.controller.refreshLocalWalletState();
    reloaded.controller.notify();
    assert.equal(reloaded.controller.state.seedBackupInterrupted, true);
    assert.equal(dom.nodes.interrupted.classList.contains('hidden'), false);
    await assertSignedOut(reloaded.controller, reloaded.peerweb);

    // Delete & Start Over clears it.
    globalThis.window.confirm = () => true;
    await reloaded.controller.resetUnconfirmedWallet();
    assert.equal(wallet.record, null);
    assert.equal(readSeedBackupPending(), false);
});

test('a failure before anything is saved forgets the flag', async () => {
    const wallet = fakeWallet();
    wallet.registerLocalWallet = async () => {
        throw new Error('Passkey ceremony cancelled.');
    };
    const { controller } = await onboardingSession(wallet);
    const { readSeedBackupPending } = await import('../src/auth/SeedBackupState.js');

    await controller.registerLocal();
    assert.equal(readSeedBackupPending(), false);
    assert.equal(controller.state.seedBackupInterrupted, false);
});

test('create → backup screen → worker timeout → confirmation does not sign in', async () => {
    const wallet = fakeWallet();
    const { controller, peerweb, toast } = await onboardingSession(wallet);
    const { readSeedBackupPending } = await import('../src/auth/SeedBackupState.js');
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');

    await controller.registerLocal();
    assert.equal(screen.isSeedPhraseShown(), true);

    // The TTL expires with the screen open, before the lock event lands.
    wallet.unlocked = false;
    assert.equal(await controller.confirmSeedBackup(), false);
    assert.equal(screen.isSeedPhraseShown(), false);
    assert.equal(dom.nodes.words.children.length, 0);
    assert.equal(controller.state.seedBackupPending, false);
    assert.equal(controller.state.seedBackupInterrupted, true);
    assert.equal(readSeedBackupPending(), true);
    assert.ok(toast.messages.some(({ kind }) => kind === 'warning'));
    await assertSignedOut(controller, peerweb);
    assert.equal(dom.nodes.interrupted.classList.contains('hidden'), false);

    // Unlocking afterwards still does not get around the backup.
    assert.equal(await controller.unlockLocal(), false);
    await assertSignedOut(controller, peerweb);
});

test('the worker lock event itself ends the backup step', async () => {
    const wallet = fakeWallet();
    const { controller, peerweb } = await onboardingSession(wallet);
    const screen = await import('../src/ui/auth/SeedPhraseScreen.js');

    await controller.registerLocal();
    wallet.unlocked = false;
    await controller.handleWorkerLock();

    assert.equal(screen.isSeedPhraseShown(), false);
    assert.equal(controller.state.seedBackupInterrupted, true);
    assert.equal(controller.state.resumeHint?.wasUnlocked, undefined, 'nobody was signed in to be signed out');
    assert.equal(await controller.confirmSeedBackup(), false);
    await assertSignedOut(controller, peerweb);
});

test('a wallet with a confirmed backup unlocks as before', async () => {
    const wallet = fakeWallet();
    wallet.record = { address: '0xabc' };
    const { controller, peerweb } = await onboardingSession(wallet);
    await controller.refreshLocalWalletState();

    assert.equal(controller.state.seedBackupInterrupted, false);
    assert.equal(await controller.unlockLocal(), true);
    assert.equal(wallet.unlockAttempts, 1);
    await flush();
    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), true);
    assert.equal(peerweb.calls.gofile, 1);
});
