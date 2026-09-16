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

test('"Deploy another site" is a reset, not a step back', () => {
    const result = MARKUP.slice(MARKUP.indexOf('id="upload-result"'), MARKUP.indexOf('deploy-help-details'));

    // Navigating back to the drop zone would leave the last deployment's files,
    // signature and saved session attached to the next one. Lifecycle.js wires
    // this id to the real reset, so it carries no data-deploy-nav of its own.
    assert.match(result, /id="deploy-another-site"[\s\S]{0,160}Deploy another site/);
    const button = result.slice(result.indexOf('id="deploy-another-site"'));
    assert.doesNotMatch(button.slice(0, 200), /data-deploy-nav/);
    // The receipt itself stays: link, transport, mirror row, identity.
    assert.match(result, /id="result-url"/);
    assert.match(result, /id="result-transport"/);
    assert.match(result, /id="result-gofile-row"/);
    assert.match(result, /id="result-signature-status"/);
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

test('the gateway box has one switch between resolving and searching', () => {
    const gateway = MARKUP.slice(MARKUP.indexOf('class="gateway-search"'), MARKUP.indexOf('class="gateway-meta"'));

    // Same box, same pill, one checkbox under it — LibraryPanel.js rewrites the
    // placeholder, the button and the hints around it.
    assert.match(gateway, /id="gateway-search-mode"[^>]*/);
    assert.doesNotMatch(gateway, /id="gateway-search-mode"[^>]*checked/, 'it resolves addresses until asked');
    assert.ok(gateway.indexOf('id="hash-input"') < gateway.indexOf('id="gateway-search-mode"'));
    assert.match(gateway, /id="gateway-load-hints"/);
    assert.match(gateway, /id="gateway-search-hints"[^>]*class="hidden"/);
});

test('the search results page is a results page, hidden until there is a query', () => {
    const library = MARKUP.slice(MARKUP.indexOf('id="site-library"'), MARKUP.indexOf('class="gateway-facts"'));

    assert.match(library, /id="site-library"[\s\S]{0,200}class="library serp hidden"/);
    // A result arriving under the box has to be announced, not just appear.
    assert.match(library, /aria-live="polite"/);
    assert.match(library, /id="library-results"/);
    assert.match(library, /id="library-count"/);
    assert.match(library, /id="library-empty"/);
    // The old always-on listing of everything cached is gone with its input.
    assert.ok(!MARKUP.includes('id="library-search"'), 'the second search box is gone');
    assert.ok(!MARKUP.includes('Sites you have opened</h3>'), 'and so is the listing it headed');
});

test('the viewer header carries a way back and the two decisions, and nothing else', () => {
    // Back comes first: it is the control a visitor needs most while looking
    // at somebody else's site.
    assert.match(VIEWER, /id="back-to-peerweb"/);
    assert.match(VIEWER, /id="viewer-reseed"/);
    assert.match(VIEWER, /id="viewer-forget"/);
    assert.ok(VIEWER.indexOf('back-to-peerweb') < VIEWER.indexOf('viewer-reseed'));
    assert.ok(VIEWER.indexOf('viewer-reseed') < VIEWER.indexOf('viewer-forget'));
});

test('the viewer header is not a place for labels nobody can act on', () => {
    // Which transport fetched the bytes, and which hash it was: both facts
    // about the load rather than about the site, and both were spending the
    // width the two buttons need — on a phone, enough to push them off the row.
    assert.ok(!MARKUP.includes('id="cache-status"'), 'the transport label is gone');
    assert.ok(!MARKUP.includes('id="current-hash"'), 'and so is the hash');
    assert.ok(!MARKUP.includes('class="viewer-identity"'));
});

test('the signature and the offer to host are one control', () => {
    // Whether to rehost somebody else's bytes and whether their publisher
    // checks out are the same question, so they are the same button: the mark
    // sits inside it, and the wording a mark cannot carry is on the button.
    const button = VIEWER.slice(VIEWER.indexOf('id="viewer-reseed"'), VIEWER.indexOf('id="viewer-forget"'));
    assert.match(button, /id="site-signature-status"/);
    assert.match(button, /id="viewer-reseed-label"/);
    // It ships unverified and disabled: a site is not vouched for until its
    // signature has been checked, and nothing offers to seed it until then.
    assert.match(button, /class="viewer-verified is-unverified"/);
    assert.match(button, /Unverified/);
    assert.match(button, /aria-label="Publisher: unverified"/);
    assert.match(button, /\sdisabled/);
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
