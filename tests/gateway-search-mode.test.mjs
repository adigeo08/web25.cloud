/**
 * One box, two jobs.
 *
 * The gateway field resolves a WEB25 address. Ticking the checkbox under it
 * turns the same field into a search over the sites this browser has already
 * loaded, and unticking it turns it back. These pin what each mode says, what
 * it does with what is typed, and that the results page is a results page —
 * shown for a query and for nothing else, never as a listing of the cache.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeBrowseDom } from './helpers/fake-browse-dom.mjs';

// Lifecycle.js pulls in the app config, which reads the hostname at import.
globalThis.window = globalThis.window || {
    location: { hostname: 'localhost', origin: 'https://web25.cloud', pathname: '/', search: '' }
};

const HASH = '0123456789abcdef0123456789abcdef01234567';

function entry(overrides = {}) {
    return {
        hash: HASH,
        title: "Mara's Darkroom",
        description: 'Film photography notes and a print shop.',
        keywords: 'photography, darkroom',
        publisher: '0xabc0000000000000000000000000000000000001',
        fileCount: 3,
        size: 2048,
        savedAt: Date.parse('2026-03-12T10:00:00.000Z'),
        verified: true,
        ...overrides
    };
}

let dom;
let panel;
test.beforeEach(async () => {
    dom = installFakeBrowseDom();
    // A fresh import per test also resets the one-shot bind guards.
    panel = await import(`../src/ui/browse/LibraryPanel.js?${Math.random()}`);
});
test.afterEach(() => dom.restore());

test('the box resolves addresses until the checkbox is ticked', () => {
    panel.bindLibraryPanel({ onSearch() {}, onOpen() {} });

    assert.equal(panel.isLibrarySearchMode(), false);
    assert.equal(dom.nodes.button.textContent, 'Load Site');
    assert.match(dom.nodes.input.placeholder, /torrent hash/i);
    assert.equal(dom.nodes.loadHints.classList.contains('hidden'), false);
    assert.equal(dom.nodes.searchHints.classList.contains('hidden'), true);

    dom.nodes.toggle.checked = true;
    dom.nodes.toggle.dispatch('change');

    assert.equal(panel.isLibrarySearchMode(), true);
    assert.equal(dom.nodes.button.textContent, 'Search');
    assert.match(dom.nodes.input.placeholder, /search sites you have opened/i);
    assert.equal(dom.nodes.input.getAttribute('aria-label'), 'Search the sites cached in this browser');
    // The three address formats are not what a keyword search accepts.
    assert.equal(dom.nodes.loadHints.classList.contains('hidden'), true);
    assert.equal(dom.nodes.searchHints.classList.contains('hidden'), false);
});

test('ticking the box searches what is already typed, unticking clears the page', () => {
    const searches = [];
    panel.bindLibraryPanel({ onSearch: (query) => searches.push(query), onOpen() {} });

    dom.nodes.input.value = 'darkroom';
    dom.nodes.toggle.checked = true;
    dom.nodes.toggle.dispatch('change');

    dom.nodes.toggle.checked = false;
    dom.nodes.toggle.dispatch('change');

    // An empty query is what takes the results away, rather than leaving a
    // stale page under a box that no longer searches.
    assert.deepEqual(searches, ['darkroom', '']);
});

test('typing only searches while the box is a search box', async () => {
    const searches = [];
    panel.bindLibraryPanel({ onSearch: (query) => searches.push(query), onOpen() {} });

    dom.nodes.input.value = '0123456789abcdef0123456789abcdef01234567';
    dom.nodes.input.dispatch('input');
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(searches, [], 'pasting a hash is not a query');

    dom.nodes.toggle.checked = true;
    dom.nodes.toggle.dispatch('change');
    searches.length = 0;
    dom.nodes.input.value = 'photo';
    dom.nodes.input.dispatch('input');
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(searches, ['photo']);
});

test('a query renders results that read like search results', () => {
    panel.renderLibrary([entry()], { query: 'darkroom', total: 7 });

    assert.equal(dom.nodes.section.classList.contains('hidden'), false);
    assert.equal(dom.nodes.count.textContent, '1 result · 7 sites in this browser');

    const [result] = dom.nodes.results.querySelectorAll('article');
    assert.equal(result.getAttribute('data-library-hash'), HASH);
    // Address line, then the title to click, then the line that says whether
    // this is the one — the shape everybody already knows how to read.
    assert.match(result.querySelector('.serp-url').textContent, /web25 › 0123456789ab/);
    assert.equal(result.querySelector('.serp-link').textContent, "Mara's Darkroom");
    assert.match(result.querySelector('.serp-snippet').textContent, /Film photography notes/);
    assert.match(result.querySelector('.serp-meta').textContent, /3 files/);
});

test('nothing is shown for an empty box, however much is cached', () => {
    panel.renderLibrary([entry()], { query: 'darkroom', total: 7 });
    panel.renderLibrary([], { query: '', total: 7 });

    // The gateway is not a bookmarks folder: with no query there is no page.
    assert.equal(dom.nodes.section.classList.contains('hidden'), true);
    assert.equal(dom.nodes.results.children.length, 0);
    assert.equal(dom.nodes.empty.classList.contains('hidden'), true);
    assert.equal(dom.nodes.count.textContent, '');
});

test('a query with no matches is still a page, and says so', () => {
    panel.renderLibrary([], { query: 'zeppelin', total: 7 });

    assert.equal(dom.nodes.section.classList.contains('hidden'), false);
    assert.equal(dom.nodes.empty.classList.contains('hidden'), false);
    assert.match(dom.nodes.empty.textContent, /Nothing in this browser matches “zeppelin”/);
    assert.equal(dom.nodes.count.textContent, '0 results · 7 sites in this browser');
});

test('the button and Enter do whichever job the box is doing', async () => {
    const lifecycle = await import('../src/core/bootstrap/Lifecycle.js');
    const loaded = [];
    const searched = [];
    const context = {
        submitGatewayQuery: lifecycle.submitGatewayQuery,
        loadSite: (address) => loaded.push(address),
        refreshLibrary: async (query) => searched.push(query)
    };

    dom.nodes.input.value = `  ${HASH}  `;
    context.submitGatewayQuery();

    assert.deepEqual(loaded, [HASH], 'the address is resolved, trimmed');
    assert.deepEqual(searched, []);

    dom.nodes.toggle.checked = true;
    dom.nodes.input.value = 'darkroom prints';
    context.submitGatewayQuery();

    assert.deepEqual(loaded, [HASH], 'nothing is loaded from a search');
    assert.deepEqual(searched, ['darkroom prints']);
});

test('clicking a result opens that site', () => {
    const opened = [];
    panel.bindLibraryPanel({ onSearch() {}, onOpen: (hash) => opened.push(hash) });
    panel.renderLibrary([entry()], { query: 'darkroom', total: 1 });

    dom.nodes.results.querySelector('.serp-link').click();

    assert.deepEqual(opened, [HASH]);
});
