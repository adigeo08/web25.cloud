/**
 * What a guest is allowed to see, and what a loading page is allowed to claim.
 *
 * Two things went wrong here, and both showed the same symptom on a phone: the
 * Deploy page in front of somebody who was not signed in.
 *
 * The first was `restoreDeploySession`, which ran on every load and then
 * revealed the deploy panel outright. The wallet session dies with the page, so
 * after a refresh *nobody* is signed in — and any browser holding a signed
 * bundle from the last half hour got the deploy pipeline anyway.
 *
 * The second was the gap before the first auth render. The markup shipped a
 * "Deploy" tab and all three ways in, and JavaScript corrected them once the
 * wallet had been read; on a slow connection that correction is visible. A
 * page that has just loaded is always signed out, so the markup says so, and
 * the parts that genuinely are unknown wait behind a placeholder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

function installAuthDom() {
    return installFakeDom({
        deployTab: { tag: 'button', id: 'deploy-tab', attrs: { 'data-tab': 'publish', 'aria-busy': 'true' } },
        wall: { tag: 'section', id: 'deploy-auth-wall', attrs: { 'aria-busy': 'true' } },
        loading: { tag: 'div', id: 'deploy-wall-loading', classes: ['auth-skeleton'] },
        actions: { tag: 'div', id: 'deploy-wall-actions', classes: ['button-group', 'hidden'] },
        panel: { tag: 'div', id: 'deploy-panel', classes: ['hidden'] }
    });
}

/** A PeerWeb-shaped context carrying the real lifecycle mixin. */
async function context({ unlocked = false } = {}) {
    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    const logs = [];
    return {
        ...lifecycle,
        logs,
        log: (message) => logs.push(message),
        toast: { info() {}, warning() {}, error() {}, success() {} },
        clientReady: true,
        client: { add() {}, get: () => null },
        authController: {
            state: unlocked
                ? { localWalletUnlocked: true, address: '0xabc', identityType: 'local' }
                : { localWalletUnlocked: false, address: null, identityType: null }
        }
    };
}

/** A stored deploy session, as `persistDeploySession` leaves it. */
function storeDeploySession() {
    const payload = {
        hash: '0123456789abcdef0123456789abcdef01234567',
        siteName: 'my-site',
        createdAt: new Date().toISOString(),
        signature: { payload: { publisherAddress: '0xabc' } },
        signedTorrentBase64: 'ZGVlNGU=',
        signedBy: '0xabc',
        savedAt: Date.now()
    };
    const store = new Map([['web25.deploy.session.v1', JSON.stringify(payload)]]);
    globalThis.localStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, `${value}`),
        removeItem: (key) => store.delete(key)
    };
    return store;
}

let dom;
let previousLocalStorage;
test.beforeEach(() => {
    dom = installAuthDom();
    previousLocalStorage = globalThis.localStorage;
});
test.afterEach(() => {
    dom.restore();
    globalThis.localStorage = previousLocalStorage;
});

test('a stored deploy session stays stored while nobody is signed in', async () => {
    const store = storeDeploySession();
    const peerweb = await context({ unlocked: false });

    await peerweb.restoreDeploySession.call(peerweb);

    // The panel is what a guest must never be shown, and it is still hidden.
    assert.equal(dom.nodes.panel.classList.contains('hidden'), true);
    assert.equal(dom.nodes.wall.classList.contains('hidden'), false);
    assert.equal(peerweb.lastPublishCandidate, undefined, 'and nothing was staged on their behalf');
    // Kept, not discarded: it belongs to whoever signed it, and comes back
    // when they do.
    assert.ok(store.has('web25.deploy.session.v1'));
    assert.ok(peerweb.logs.some((line) => /no identity is unlocked/.test(line)));
});

test('the placeholders give way to the real state, and never the other way round', async () => {
    const peerweb = await context();

    peerweb.applyAuthPhase.call(peerweb, 'pending');
    assert.equal(dom.nodes.loading.classList.contains('hidden'), false);
    assert.equal(dom.nodes.actions.classList.contains('hidden'), true);
    assert.equal(dom.nodes.wall.getAttribute('aria-busy'), 'true');
    assert.equal(dom.nodes.deployTab.getAttribute('aria-busy'), 'true');

    peerweb.applyAuthPhase.call(peerweb, 'resolved');
    assert.equal(dom.nodes.loading.classList.contains('hidden'), true);
    assert.equal(dom.nodes.actions.classList.contains('hidden'), false);
    assert.equal(dom.nodes.wall.getAttribute('aria-busy'), null);
    assert.equal(dom.nodes.deployTab.getAttribute('aria-busy'), null);

    // Waiting never hides the panel's own decision: that belongs to
    // `setupAuthAwareUi`, and a guest's panel was already hidden in the markup.
    assert.equal(dom.nodes.panel.classList.contains('hidden'), true);
});

test('an unlocked identity is what reveals the deploy pipeline', async () => {
    const peerweb = await context({ unlocked: true });
    assert.equal(peerweb.isAuthenticatedIdentity.call(peerweb), true);

    const guest = await context({ unlocked: false });
    assert.equal(guest.isAuthenticatedIdentity.call(guest), false);
});

test('a page restored from the back/forward cache re-asks who is signed in', async () => {
    const peerweb = await context({ unlocked: true });
    const listeners = [];
    const previousWindow = globalThis.window;
    globalThis.window = {
        location: { hostname: 'localhost' },
        addEventListener: (type, handler) => listeners.push({ type, handler })
    };

    let rechecked = 0;
    peerweb.authController.refreshLocalWalletState = async () => {
        rechecked += 1;
    };
    peerweb.authController.render = () => {};
    peerweb.authController.notify = () => {};

    try {
        peerweb.setupSessionRevalidation.call(peerweb);
        // Installed once, however many times start-up runs.
        peerweb.setupSessionRevalidation.call(peerweb);
        assert.equal(listeners.length, 1);
        assert.equal(listeners[0].type, 'pageshow');

        // An ordinary load needs no re-check: the state was just read.
        listeners[0].handler({ persisted: false });
        await Promise.resolve();
        assert.equal(rechecked, 0);

        // A restore comes back with a frozen DOM, which may be describing a
        // session that has since gone.
        listeners[0].handler({ persisted: true });
        await Promise.resolve();
        assert.equal(rechecked, 1);
    } finally {
        globalThis.window = previousWindow;
    }
});
