/**
 * The Pages card's three buttons.
 *
 * Stopping a site used to delete it: the only way to pause hosting was to throw
 * the deployment away, and the card went with it. Stop, Resume and Delete are
 * separate decisions now, and these tests pin which of them a card offers, what
 * each one asks before it happens, and that nothing happens on a cancel.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakePagesDom } from './helpers/fake-pages-dom.mjs';

const HASH = '0123456789abcdef0123456789abcdef01234567';

function session(overrides = {}) {
    return {
        hash: HASH,
        siteName: 'my-site',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileCount: 2,
        length: 2048,
        url: `https://web25.cloud/?orc=${HASH}`,
        signedBy: '0xabc',
        signature: '0xsignature',
        signatureStatus: 'VERIFIED',
        mirrorState: 'disabled',
        hasTorrentFile: true,
        state: 'seeding',
        error: null,
        peers: 2,
        uploaded: 1024,
        ...overrides
    };
}

let dom;
let panel;
test.beforeEach(async () => {
    dom = installFakePagesDom();
    // Imported after the document exists; the module reads it at call time, but
    // a fresh import per test also resets the one-shot `bindPagesPanel` guard.
    panel = await import(`../src/ui/pages/PagesPanel.js?${Math.random()}`);
});
test.afterEach(() => dom.restore());

/** The action buttons of the single card, by their data-page-action. */
function cardActions() {
    return dom.nodes.list.querySelectorAll('[data-page-action]').map((node) => node.getAttribute('data-page-action'));
}

test('a seeding card offers Stop and Delete, not Resume', () => {
    panel.renderPages([session()]);

    assert.deepEqual(cardActions(), ['open', 'copy', 'download', 'stop', 'delete']);
});

test('a paused card offers Resume in place of Stop, and keeps its card', () => {
    panel.renderPages([session({ state: 'paused', peers: 0, hasTorrentFile: false })]);

    assert.deepEqual(cardActions(), ['open', 'copy', 'resume', 'delete']);
    // The point of pausing: the site is still here, and says so rather than
    // vanishing from the tab.
    assert.equal(dom.nodes.count.textContent, '1 site');
    assert.match(dom.nodes.list.querySelector('.status-chip').textContent, /Paused/);
});

test('a session that failed to resume can be put back on the air', () => {
    panel.renderPages([session({ state: 'error', error: 'tracker exploded', peers: 0, hasTorrentFile: false })]);

    assert.deepEqual(cardActions(), ['open', 'copy', 'resume', 'delete']);
});

test('each button reaches its own handler', () => {
    const calls = [];
    const record = (name) => (hash) => calls.push([name, hash]);
    panel.bindPagesPanel({
        onOpen: record('open'),
        onCopy: record('copy'),
        onDownload: record('download'),
        onStop: record('stop'),
        onResume: record('resume'),
        onDelete: record('delete')
    });

    panel.renderPages([session()]);
    dom.nodes.list.querySelector('[data-page-action="stop"]').click();
    dom.nodes.list.querySelector('[data-page-action="delete"]').click();

    panel.renderPages([session({ state: 'paused' })]);
    dom.nodes.list.querySelector('[data-page-action="resume"]').click();

    assert.deepEqual(calls, [
        ['stop', HASH],
        ['delete', HASH],
        ['resume', HASH]
    ]);
});

test('stopping and deleting do not ask the same question', async () => {
    const asked = [];
    const capture = () => asked.push([dom.nodes.title.textContent, dom.nodes.detail.textContent]);

    const stopping = panel.confirmSeedingAction('pause', { siteName: 'my-site', hash: HASH });
    capture();
    dom.nodes.cancel.click();
    assert.equal(await stopping, false, 'cancelling means nothing happens');

    const deleting = panel.confirmSeedingAction('delete', { siteName: 'my-site', hash: HASH });
    capture();
    dom.nodes.confirm.click();
    assert.equal(await deleting, true);

    const [[stopTitle, stopDetail], [deleteTitle, deleteDetail]] = asked;
    assert.match(stopTitle, /Stop seeding/);
    // Stopping has to promise the site stays; deleting has to say it does not.
    assert.match(stopDetail, /resume seeding it at any time/i);
    assert.match(deleteTitle, /Delete website/);
    assert.match(deleteDetail, /cannot be undone/i);
    assert.notEqual(stopDetail, deleteDetail);
});

test('the dialog names the site, and closes on Escape without acting', async () => {
    const pending = panel.confirmSeedingAction('resume', { siteName: 'my-site', hash: HASH });

    assert.equal(dom.nodes.name.textContent, 'my-site');
    assert.equal(dom.nodes.modal.classList.contains('hidden'), false);
    // The safe choice holds focus, so Enter on a dialog nobody read is a no-op.
    assert.equal(dom.document.activeElement, dom.nodes.cancel);

    dom.document.press('Escape');

    assert.equal(await pending, false);
    assert.equal(dom.nodes.modal.classList.contains('hidden'), true);
});

test('the tab stays away while the wallet is locked, sessions or not', () => {
    panel.renderPages([session()], { visible: false });

    // Hidden, not stopped: the sites go on seeding underneath, and the cards
    // are there the moment the tab comes back.
    assert.equal(dom.nodes.tabBtn.style.display, 'none');
    assert.equal(dom.nodes.panel.style.display, 'none');
});
