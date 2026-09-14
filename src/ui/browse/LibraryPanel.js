// @ts-check
/**
 * The gateway's other mode: searching the sites this browser has already seen.
 *
 * A WEB25 address is a 40-character hash, which nobody remembers and nothing
 * autocompletes. Every site that ever rendered here is still in the cache, so
 * the same box that resolves an address also searches that cache — a word from
 * the title, a file name, the publisher address, or the first characters of the
 * hash — with one checkbox deciding which of the two it is doing.
 *
 * The results read as a search engine's results, because that is what they are:
 * an address line, a title to click, and the snippet that says whether this is
 * the site you meant. What they are not is a listing: nothing is shown until
 * somebody searches, and an empty box shows an empty page.
 *
 * It searches the local index and nothing else. No request leaves the browser
 * to answer a query. Titles and file names come from sites other people
 * published, so every value is written with `textContent`.
 */

/** Keystrokes are cheap; an IndexedDB sweep per keystroke is not. */
const SEARCH_DEBOUNCE_MS = 140;

const PLACEHOLDERS = {
    load: 'Paste a torrent hash, hash&mirror, or WEB25 URL',
    search: 'Search sites you have opened — title, keyword, file, publisher'
};

const ARIA_LABELS = {
    load: 'Torrent hash, hash and mirror locator, or complete WEB25 URL',
    search: 'Search the sites cached in this browser'
};

const BUTTON_LABELS = { load: 'Load Site', search: 'Search' };

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${parseFloat((value / Math.pow(1024, index)).toFixed(2))} ${units[index]}`;
}

function formatWhen(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/**
 * Is the gateway box searching the local library rather than resolving an
 * address? Read from the checkbox itself, so there is one answer and no second
 * copy of it to drift.
 */
export function isLibrarySearchMode() {
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('gateway-search-mode'));
    return Boolean(toggle?.checked);
}

/** Point the box, its button and the hints under it at one of the two modes. */
export function applyGatewayMode() {
    const searching = isLibrarySearchMode();
    const mode = searching ? 'search' : 'load';
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('hash-input'));
    const button = document.getElementById('load-site');
    const loadHints = document.getElementById('gateway-load-hints');
    const searchHints = document.getElementById('gateway-search-hints');

    if (input) {
        input.placeholder = PLACEHOLDERS[mode];
        input.setAttribute('aria-label', ARIA_LABELS[mode]);
    }
    if (button) button.textContent = BUTTON_LABELS[mode];
    loadHints?.classList.toggle('hidden', searching);
    searchHints?.classList.toggle('hidden', !searching);
    return searching;
}

/**
 * @param {{ onSearch: (query: string) => void, onOpen: (hash: string) => void }} handlers
 */
export function bindLibraryPanel({ onSearch, onOpen }) {
    const toggle = /** @type {HTMLInputElement|null} */ (document.getElementById('gateway-search-mode'));
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('hash-input'));
    const results = document.getElementById('library-results');

    applyGatewayMode();

    if (toggle && !toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        toggle.addEventListener('change', () => {
            const searching = applyGatewayMode();
            // Ticking the box with a word already typed is a search; unticking
            // it takes the results page away rather than leaving a stale one
            // under a box that no longer searches.
            onSearch(searching ? `${input?.value || ''}`.trim() : '');
            input?.focus?.();
        });
    }

    if (input && !input.dataset.libraryBound) {
        input.dataset.libraryBound = '1';
        let timer = null;
        input.addEventListener('input', () => {
            if (!isLibrarySearchMode()) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => onSearch(input.value.trim()), SEARCH_DEBOUNCE_MS);
        });
    }

    if (results && !results.dataset.bound) {
        results.dataset.bound = '1';
        results.addEventListener('click', (event) => {
            const target = /** @type {HTMLElement} */ (event.target);
            const card = target.closest('[data-library-hash]');
            if (!card) return;
            onOpen(card.getAttribute('data-library-hash') || '');
        });
    }
}

/**
 * One result, in the shape a search engine has taught everyone to read: where
 * it is, what it is called, and enough of it to tell whether it is the one.
 * @param {any} entry
 */
function buildResult(entry) {
    const row = el('article', 'serp-result');
    row.setAttribute('data-library-hash', entry.hash);

    const address = el('div', 'serp-url');
    address.appendChild(el('span', 'serp-favicon', '🌐'));
    address.appendChild(el('span', 'serp-url-text', `web25 › ${`${entry.hash}`.slice(0, 12)}…`));
    address.appendChild(
        el(
            'span',
            entry.verified ? 'serp-badge serp-badge-ok' : 'serp-badge',
            entry.verified ? 'Signature verified' : 'Unverified'
        )
    );
    row.appendChild(address);

    const title = el('h3', 'serp-title');
    const link = el('button', 'serp-link', entry.title || entry.entryPath || 'Untitled site');
    link.setAttribute('type', 'button');
    link.setAttribute('data-library-hash', entry.hash);
    title.appendChild(link);
    row.appendChild(title);

    const snippet = el('p', 'serp-snippet');
    const when = formatWhen(entry.savedAt);
    if (when) snippet.appendChild(el('span', 'serp-date', `${when} — `));
    snippet.appendChild(
        el('span', '', entry.description || entry.keywords || 'No description was published with this site.')
    );
    row.appendChild(snippet);

    const meta = el('div', 'serp-meta');
    meta.appendChild(el('span', '', `${entry.fileCount} ${entry.fileCount === 1 ? 'file' : 'files'}`));
    meta.appendChild(el('span', '', formatBytes(entry.size)));
    if (entry.publisher) meta.appendChild(el('span', '', `signed by ${`${entry.publisher}`.slice(0, 10)}…`));
    meta.appendChild(el('code', 'serp-hash', `${entry.hash}`.slice(0, 16)));
    row.appendChild(meta);

    return row;
}

/**
 * Render the results page.
 *
 * No query, no page: an empty box is not a request to list the cache, and the
 * gateway is not a bookmarks folder. A query with no matches is a page — it has
 * to say that this browser holds nothing like that.
 *
 * @param {any[]} entries
 * @param {{ query?: string, total?: number }} [state]
 */
export function renderLibrary(entries, { query = '', total = 0 } = {}) {
    const section = document.getElementById('site-library');
    const results = document.getElementById('library-results');
    const count = document.getElementById('library-count');
    const empty = document.getElementById('library-empty');

    const rows = entries || [];
    const searched = Math.max(total, rows.length);

    if (section instanceof HTMLElement) section.classList.toggle('hidden', !query);

    if (count) {
        count.textContent = query
            ? `${rows.length} ${rows.length === 1 ? 'result' : 'results'} · ${searched} ` +
              `${searched === 1 ? 'site' : 'sites'} in this browser`
            : '';
    }

    if (empty) {
        empty.classList.toggle('hidden', !query || rows.length > 0);
        empty.textContent = query
            ? `Nothing in this browser matches “${query}”. Sites are searchable here once you have opened them.`
            : '';
    }

    if (!results) return;
    results.textContent = '';
    if (query) rows.forEach((entry) => results.appendChild(buildResult(entry)));
}
