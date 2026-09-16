/**
 * The strip above somebody else's page.
 *
 * It is the only WEB25 UI on screen while a peer-hosted site is rendered, so
 * every millimetre of it has to be something a visitor can act on. The hash
 * and the transport label that used to sit there were facts about the load
 * rather than about the site; the room belongs to the two decisions.
 *
 * The signature and the offer to host are one control, because they are one
 * question: whether to put this browser's bandwidth behind somebody else's
 * bytes. Signed reads "✔ Reseed" and acts; unsigned reads "⚠ Unverified" and
 * offers nothing at all.
 *
 * Both decisions are claims about what strangers can pull from this browser,
 * so the state of the buttons is asked of the store rather than assumed: a
 * Reseed is only offered when there genuinely is a payload to reseed, and it
 * says why when there is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const HASH = '0123456789abcdef0123456789abcdef01234567';

function installViewerDom() {
    return installFakeDom({
        badge: { tag: 'span', id: 'site-signature-status', classes: ['viewer-verified', 'is-unverified'] },
        reseed: { tag: 'button', id: 'viewer-reseed', classes: ['btn', 'viewer-action'] },
        label: { tag: 'span', id: 'viewer-reseed-label' },
        forget: { tag: 'button', id: 'viewer-forget', classes: ['btn', 'viewer-action'] }
    });
}

/**
 * A PeerWeb-shaped context carrying the real navigation mixin.
 * @param {{ seeding?: boolean, record?: any, payload?: any }} options
 */
async function context({ seeding = false, record = null, payload = null, verified = true } = {}) {
    const navigation = await import('../src/core/navigation/Navigation.js');
    const logs = [];
    return {
        ...navigation,
        currentHash: HASH,
        // What the signature layer decided about the site on screen. The
        // combined control reads this before it offers anything.
        _siteVerified: verified,
        _siteVerdictLabel: verified ? 'Verified publisher: 0xfeed0000…' : 'Publisher: unverified',
        log: (message) => logs.push(message),
        logs,
        toast: { warning() {} },
        seedingTorrents: () => new Map(seeding ? [[HASH, { infoHash: HASH }]] : []),
        seedingStore: () => ({ get: async () => record }),
        resolveReseedPayload: async () => payload
    };
}

let dom;
test.beforeEach(() => {
    dom = installViewerDom();
});
test.afterEach(() => {
    dom.restore();
});

test('a verified publisher is a tick on the button that acts on it', async () => {
    const peerweb = await context({ payload: { files: [] } });

    peerweb.updateSiteSignatureBadge.call(peerweb, { verified: true, label: 'Verified publisher: 0xfeed0000…' });
    await Promise.resolve();
    await Promise.resolve();

    // The mark is the whole verdict. No address, no sentence — it was spending
    // the width the buttons need.
    assert.equal(dom.nodes.badge.textContent, '✔');
    assert.equal(dom.nodes.badge.className, 'viewer-verified is-verified');
    // A mark alone explains nothing, so what it means is on the button, where
    // a pointer and a screen reader both find it.
    assert.match(dom.nodes.reseed.getAttribute('aria-label'), /^Verified publisher: 0xfeed0000…/);
    assert.match(dom.nodes.reseed.getAttribute('title'), /^Verified publisher: 0xfeed0000…/);
});

test('an unverified publisher is never silent, and is never offered a reseed', async () => {
    const peerweb = await context({ payload: { files: [{ path: 'index.html' }] } });

    peerweb.updateSiteSignatureBadge.call(peerweb, { verified: false, label: 'Publisher: unverified' });
    await Promise.resolve();

    // Showing nothing would read as nothing being wrong, so the absence of a
    // signature gets a mark of its own.
    assert.equal(dom.nodes.badge.textContent, '⚠');
    assert.equal(dom.nodes.badge.className, 'viewer-verified is-unverified');
    // And the button says what it is instead of offering to host: this browser
    // does not put its bandwidth behind bytes nobody has vouched for — even
    // though the payload to do it with is right here.
    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'unverified');
    assert.equal(dom.nodes.reseed.disabled, true);
    assert.equal(dom.nodes.label.textContent, 'Unverified');
    assert.equal(dom.nodes.reseed.getAttribute('aria-label'), 'Publisher: unverified');
});

test('pressing a reseed on an unverified site does nothing but say why', async () => {
    const peerweb = await context({ verified: false, payload: { files: [] } });
    const warnings = [];
    peerweb.toast = { warning: (body, title) => warnings.push(title) };
    let asked = 0;
    peerweb.confirmReseedSite = async () => {
        asked += 1;
        return true;
    };

    await peerweb.handleViewerReseed.call(peerweb);

    // The rule is stated where it is enforced, not only where it is drawn.
    assert.equal(asked, 0);
    assert.deepEqual(warnings, ['Unverified publisher']);
});

test('Reseed is offered when this browser actually holds the payload', async () => {
    const peerweb = await context({ payload: { files: [{ path: 'index.html' }] } });

    await peerweb.refreshViewerActions.call(peerweb, HASH);

    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'available');
    assert.equal(dom.nodes.reseed.disabled, false);
    assert.equal(dom.nodes.label.textContent, 'Reseed');
    assert.equal(dom.nodes.forget.disabled, false);
});

test('a site with no payload here says why rather than offering a reseed that cannot work', async () => {
    const peerweb = await context({ payload: null });

    await peerweb.refreshViewerActions.call(peerweb, HASH);

    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'unavailable');
    assert.equal(dom.nodes.reseed.disabled, true);
    assert.match(dom.nodes.reseed.getAttribute('title'), /does not hold the original payload/);
    assert.match(dom.nodes.reseed.getAttribute('title'), /^Verified publisher/, 'the verdict leads');
});

test('a site already seeding from here is not offered again', async () => {
    const peerweb = await context({ seeding: true, payload: { files: [] } });

    await peerweb.refreshViewerActions.call(peerweb, HASH);

    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'seeding');
    assert.equal(dom.nodes.reseed.disabled, true);
});

test('a site stored here but off the air is a resume, not a second copy', async () => {
    const peerweb = await context({ record: { hash: HASH, paused: true }, payload: null });

    await peerweb.refreshViewerActions.call(peerweb, HASH);

    // The bytes are already here: offering "Reseed" would suggest fetching and
    // storing them a second time.
    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'resume');
    assert.equal(dom.nodes.reseed.disabled, false);
    assert.equal(dom.nodes.label.textContent, 'Resume seeding');
});

test('an answer that arrives after the visitor has moved on is dropped', async () => {
    const peerweb = await context({ payload: { files: [] } });
    // The store lookup is asynchronous; by the time it lands the viewer is
    // showing a different site, and writing this answer into the header would
    // describe a page that is no longer up.
    peerweb.resolveReseedPayload = async () => {
        peerweb.currentHash = 'fedcba9876543210fedcba9876543210fedcba98';
        return { files: [] };
    };

    await peerweb.refreshViewerActions.call(peerweb, HASH);

    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'pending');
    assert.equal(dom.nodes.reseed.disabled, true);
});

test('leaving the viewer closes it after the data behind it is deleted', async () => {
    const peerweb = await context({ payload: { files: [] } });
    let left = 0;
    peerweb.showMainContent = () => {
        left += 1;
    };
    peerweb.confirmForgetSiteData = async () => true;
    peerweb.currentSiteTitle = () => 'Mara’s darkroom';

    await peerweb.handleViewerForget.call(peerweb);

    // A page still on screen after its bytes are gone cannot be reloaded,
    // searched for or navigated within.
    assert.equal(left, 1);
});

test('a delete the visitor cancels leaves the viewer exactly as it was', async () => {
    const peerweb = await context({ payload: { files: [] } });
    let left = 0;
    peerweb.showMainContent = () => {
        left += 1;
    };
    peerweb.confirmForgetSiteData = async () => false;

    await peerweb.handleViewerForget.call(peerweb);

    assert.equal(left, 0);
    assert.equal(dom.nodes.reseed.getAttribute('data-reseed-state'), 'available');
});
