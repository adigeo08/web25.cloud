/**
 * Markup contracts for the Pages tab, the local library and the viewer chrome.
 *
 * All three are driven from JavaScript by element id, so a rename or a deletion
 * in index.html breaks them silently in a browser and nowhere else. They are
 * checked here against the template itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const NAV = MARKUP.slice(MARKUP.indexOf('<nav id="primary-nav"'), MARKUP.indexOf('</nav>'));
const PAGES = MARKUP.slice(
    MARKUP.indexOf('<!-- ── PAGES TAB ── -->'),
    MARKUP.indexOf('<!-- ── DIRECT MESSENGER TAB ── -->')
);
const VIEWER = MARKUP.slice(MARKUP.indexOf('<div id="site-viewer"'), MARKUP.indexOf('id="site-frame"'));

test('Pages sits next to Deploy and starts hidden', () => {
    assert.match(NAV, /data-tab="pages"[\s\S]{0,160}📄 Pages/);
    // The tab is meaningless with nothing seeding, so it is absent from first
    // paint and PagesPanel.js reveals it only when a session exists.
    assert.match(NAV, /data-tab="pages"[^>]*style="display: none"/);
    assert.ok(NAV.indexOf('data-tab="publish"') < NAV.indexOf('data-tab="pages"'));
});

test('the Pages panel carries the list and counter the panel renders into', () => {
    assert.match(PAGES, /id="tab-pages"[^>]*class="tab-panel"/);
    assert.match(PAGES, /id="tab-pages"[^>]*style="display: none"/);
    assert.match(PAGES, /id="pages-count"/);
    assert.match(PAGES, /id="pages-list"/);
});

test('stopping a session is a confirmation, not a stray click', () => {
    const modal = MARKUP.slice(
        MARKUP.indexOf('id="stop-seeding-modal"'),
        MARKUP.indexOf('<!-- Torrent Creator Modal -->')
    );

    assert.match(modal, /class="modal hidden"/);
    assert.match(modal, /id="stop-seeding-name"/);
    assert.match(modal, /id="stop-seeding-confirm"/);
    assert.match(modal, /id="stop-seeding-cancel"/);
    assert.match(modal, /id="stop-seeding-close"/);
    // One dialog serves Stop, Resume and Delete, so the question, the
    // explanation and the button labels are all written from JavaScript.
    assert.match(modal, /id="stop-seeding-prompt"/);
    assert.match(modal, /id="stop-seeding-detail"/);
});

test('the deploy page has no advanced drawer left to clear anything from', () => {
    assert.ok(!MARKUP.includes('id="clear-cache"'), 'the button that stopped every session is gone');
    // And the drawer that held it is gone too: a finished deployment is managed
    // from Pages, so the Deploy page has nothing to explain in a footnote.
    assert.ok(!MARKUP.includes('deploy-advanced-details'), 'no Advanced Tools drawer');
    assert.ok(!MARKUP.includes('deploy-advanced-note'));
    // The torrent creator it used to hide is still there, just not behind a
    // disclosure triangle.
    assert.match(MARKUP, /id="create-torrent"[\s\S]{0,160}Advanced Torrent Creator/);
});

test('the local library has a search field and a place for results', () => {
    const library = MARKUP.slice(MARKUP.indexOf('id="site-library"'), MARKUP.indexOf('class="gateway-facts"'));

    assert.match(library, /id="site-library"[^>]*class="library card-base hidden"/);
    assert.match(library, /id="library-search"/);
    assert.match(library, /id="library-results"/);
    assert.match(library, /id="library-count"/);
    assert.match(library, /id="library-empty"/);
});

test('the viewer header carries a way back, the hash, the source and the signature', () => {
    assert.match(VIEWER, /id="back-to-peerweb"/);
    assert.match(VIEWER, /id="current-hash"/);
    assert.match(VIEWER, /id="cache-status"/);
    assert.match(VIEWER, /id="site-signature-status"/);
    // Back comes first: it is the control a visitor needs most while looking
    // at somebody else's site.
    assert.ok(VIEWER.indexOf('back-to-peerweb') < VIEWER.indexOf('site-signature-status'));
});

test('the sign-in wall has one line to say why a session ended', () => {
    const wall = MARKUP.slice(MARKUP.indexOf('id="deploy-auth-wall"'), MARKUP.indexOf('id="deploy-panel"'));

    // One sentence in the place the user is already reading, rather than a
    // banner to dismiss: AuthPanel.js swaps its text when a session was
    // interrupted and names the tab unlocking will return to.
    assert.match(wall, /id="deploy-wall-intro"/);
    assert.match(wall, /Choose how you want to continue\./);
    assert.ok(!MARKUP.includes('session-resume-notice'), 'the banner is gone');
});

test('the stop confirmation is announced as a modal dialog', () => {
    const modal = MARKUP.slice(
        MARKUP.indexOf('id="stop-seeding-modal"'),
        MARKUP.indexOf('<!-- Torrent Creator Modal -->')
    );

    // Without these a screen-reader user is left on the card behind a
    // destructive prompt, with nothing saying a decision is being asked for.
    assert.match(modal, /role="dialog"/);
    assert.match(modal, /aria-modal="true"/);
    assert.match(modal, /aria-labelledby="stop-seeding-title"/);
    assert.match(modal, /id="stop-seeding-title"/);
    assert.match(modal, /aria-describedby="stop-seeding-description"/);
    assert.match(modal, /id="stop-seeding-description"/);
});

test('Pages is gated on the wallet, like Chat', () => {
    // Seeding does not stop when the wallet locks — managing it is what goes
    // away — so the tab ships hidden and Lifecycle reveals it with the session.
    assert.match(NAV, /data-tab="pages"[^>]*style="display: none"/);
    assert.match(NAV, /data-tab="channels"[^>]*style="display: none"/);
});
