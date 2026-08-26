// @ts-check
/**
 * Browse tab: NosNS directory search.
 *
 * A second mode alongside the existing "Load by Hash" flow. NosNS mode is
 * discovery only — every result is opened through the same WEB25 loader, so
 * there is exactly one website loading implementation and the `.torrentchain`
 * render gate stays authoritative.
 *
 * Nostr availability never affects hash loading: the two modes are independent.
 */

import { WEB25_VERIFICATION } from '../../nosns/NosNSEvent.js';
import { nosnsDisplayName } from '../../nosns/NosNSProtocol.js';
import { populateCategorySelect, readCategorySelect } from '../nosns/CategorySelect.js';

const VERIFICATION_LABELS = {
    [WEB25_VERIFICATION.VERIFIED]: { text: '✅ Publisher verified', className: 'registry-verify is-verified' },
    [WEB25_VERIFICATION.INVALID]: { text: '⛔ Invalid publisher proof', className: 'registry-verify is-invalid' },
    [WEB25_VERIFICATION.MALFORMED]: { text: '⚠️ Malformed metadata', className: 'registry-verify is-invalid' },
    [WEB25_VERIFICATION.UNVERIFIED]: { text: '❔ No publisher proof', className: 'registry-verify is-unverified' }
};

function shorten(value, head = 10, tail = 6) {
    const text = `${value || ''}`;
    if (text.length <= head + tail + 1) return text;
    return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/**
 * @param {'hash'|'registry'} mode
 */
export function showBrowseMode(mode) {
    const hashPanel = document.getElementById('browse-hash-mode');
    const registryPanel = document.getElementById('browse-registry-mode');
    if (hashPanel) hashPanel.classList.toggle('hidden', mode !== 'hash');
    if (registryPanel) registryPanel.classList.toggle('hidden', mode !== 'registry');

    document.querySelectorAll('[data-browse-mode]').forEach((button) => {
        const isActive = button.getAttribute('data-browse-mode') === mode;
        button.classList.toggle('is-active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
}

/** @returns {string} the currently selected browse category */
export function selectedBrowseCategory() {
    return readCategorySelect(/** @type {HTMLSelectElement|null} */ (document.getElementById('nosns-browse-category')));
}

/**
 * @param {{ onModeChange: (mode: 'hash'|'registry') => void,
 *           onSearch: (query: string, category: string) => void,
 *           onCategoryChange?: (category: string) => void,
 *           onOpen: (infohash: string) => void,
 *           initialCategory?: string }} handlers
 */
export function bindNosnsPanel({ onModeChange, onSearch, onCategoryChange, onOpen, initialCategory }) {
    document.querySelectorAll('[data-browse-mode]').forEach((button) => {
        button.addEventListener('click', () => {
            const mode = /** @type {'hash'|'registry'} */ (button.getAttribute('data-browse-mode') || 'hash');
            showBrowseMode(mode);
            onModeChange(mode);
        });
    });

    const categorySelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('nosns-browse-category'));
    if (categorySelect && !categorySelect.dataset.populated) {
        populateCategorySelect(categorySelect, initialCategory);
        categorySelect.dataset.populated = '1';
    }
    if (categorySelect && !categorySelect.dataset.bound) {
        categorySelect.dataset.bound = '1';
        categorySelect.addEventListener('change', () => onCategoryChange?.(readCategorySelect(categorySelect)));
    }

    const searchBtn = document.getElementById('registry-search-btn');
    const searchInput = /** @type {HTMLInputElement|null} */ (document.getElementById('registry-search-input'));

    const run = () => onSearch(searchInput?.value?.trim() || '', selectedBrowseCategory());
    searchBtn?.addEventListener('click', run);
    searchInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') run();
    });

    // One delegated handler: results are re-rendered on every search.
    const results = document.getElementById('registry-results');
    results?.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const button = target.closest('[data-registry-open]');
        if (!button) return;
        const infohash = button.getAttribute('data-registry-open') || '';
        if (infohash) onOpen(infohash);
    });
}

/**
 * @param {string} message
 * @param {'idle'|'pending'|'ok'|'error'} [tone]
 */
export function renderNosnsQueryStatus(message, tone = 'idle') {
    const el = document.getElementById('registry-status');
    if (!el) return;
    el.textContent = message;
    el.className = `registry-status is-${tone}`;
}

/**
 * Render the discovered sites.
 *
 * Every field here came from a public relay, so all of it is written with
 * `textContent` and nothing is interpreted as markup.
 *
 * @param {any[]} results
 */
export function renderNosnsResults(results) {
    const container = document.getElementById('registry-results');
    if (!container) return;

    container.textContent = '';

    if (!results || results.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'registry-empty';
        empty.textContent = 'No NosNS websites matched.';
        container.appendChild(empty);
        return;
    }

    for (const result of results) {
        container.appendChild(renderNosnsRow(result));
    }
}

/**
 * @param {any} result
 * @returns {HTMLElement}
 */
function renderNosnsRow(result) {
    const row = document.createElement('div');
    row.className = 'registry-row';

    const main = document.createElement('div');
    main.className = 'registry-row-main';

    const title = document.createElement('p');
    title.className = 'registry-row-title';
    // Display strips the protocol suffix; `result.title` keeps the raw name.
    title.textContent = result.displayName || nosnsDisplayName(result.title) || 'Untitled site';
    title.title = result.title || '';
    main.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'registry-row-meta';
    const published = result.createdAt ? new Date(result.createdAt * 1000).toLocaleDateString() : 'unknown date';
    meta.textContent = `${shorten(result.web25Publisher || 'no EVM publisher', 10, 6)} · ${shorten(result.npub || result.nostrPubkey, 10, 6)} · ${published}`;
    main.appendChild(meta);

    const hash = document.createElement('p');
    hash.className = 'registry-row-hash';
    hash.textContent = result.infohash;
    main.appendChild(hash);

    const verification = document.createElement('p');
    const label =
        VERIFICATION_LABELS[result.web25VerificationState] || VERIFICATION_LABELS[WEB25_VERIFICATION.UNVERIFIED];
    verification.className = label.className;
    verification.textContent = label.text;
    main.appendChild(verification);

    const open = document.createElement('button');
    open.className = 'btn btn-primary btn-sm';
    open.textContent = 'Open';
    open.setAttribute('data-registry-open', result.infohash);

    row.appendChild(main);
    row.appendChild(open);
    return row;
}

/**
 * Client-side filtering over the fetched result set: site name, infohash, EVM
 * publisher, or npub / Nostr pubkey.
 *
 * NosNS deliberately does not depend on NIP-50 full-text search — the relay is
 * asked only for a category, and the text match happens here.
 *
 * @param {any[]} results
 * @param {string} query
 * @returns {any[]}
 */
export function filterNosnsResults(results, query) {
    const needle = `${query || ''}`.trim().toLowerCase();
    if (!needle) return results;

    return (results || []).filter((result) =>
        [result.displayName, result.title, result.infohash, result.web25Publisher, result.npub, result.nostrPubkey]
            .map((value) => `${value || ''}`.toLowerCase())
            .some((value) => value.includes(needle))
    );
}
