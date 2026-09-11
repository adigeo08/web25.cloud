// @ts-check
/**
 * The local library: sites this browser has already loaded.
 *
 * A WEB25 address is a 40-character hash, which nobody remembers and nothing
 * autocompletes. Every site that ever rendered here is still in the cache, so
 * this is the other way in — type a word from the title, a file name, the
 * publisher address, or the first few characters of the hash.
 *
 * It searches the local index and nothing else. No request leaves the browser
 * to answer a query, and the section is not rendered at all until there is at
 * least one cached site to look through.
 *
 * Titles and file names come from sites other people published, so every value
 * is written with `textContent`.
 */

/** Keystrokes are cheap; an IndexedDB sweep per keystroke is not. */
const SEARCH_DEBOUNCE_MS = 140;

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
 * @param {{ onSearch: (query: string) => void, onOpen: (hash: string) => void }} handlers
 */
export function bindLibraryPanel({ onSearch, onOpen }) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('library-search'));
    const results = document.getElementById('library-results');

    if (input && !input.dataset.bound) {
        input.dataset.bound = '1';
        let timer = null;
        input.addEventListener('input', () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => onSearch(input.value.trim()), SEARCH_DEBOUNCE_MS);
        });
        // Enter is "search now", not "submit the gateway form".
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (timer) clearTimeout(timer);
            onSearch(input.value.trim());
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
 * @param {any} entry
 */
function buildResult(entry) {
    const card = el('button', 'library-result');
    card.setAttribute('type', 'button');
    card.setAttribute('data-library-hash', entry.hash);

    const head = el('div', 'library-result-head');
    head.appendChild(el('span', 'library-result-title', entry.title || entry.entryPath || 'Untitled site'));
    head.appendChild(
        el(
            'span',
            entry.verified ? 'status-chip status-success' : 'status-chip status-pending',
            entry.verified ? 'Verified' : 'Unverified'
        )
    );
    card.appendChild(head);

    if (entry.description) card.appendChild(el('p', 'library-result-desc', entry.description));

    const meta = el('div', 'library-result-meta');
    meta.appendChild(el('code', 'library-result-hash', `${entry.hash}`.slice(0, 16)));
    meta.appendChild(el('span', '', `${entry.fileCount} ${entry.fileCount === 1 ? 'file' : 'files'}`));
    meta.appendChild(el('span', '', formatBytes(entry.size)));
    if (entry.publisher) meta.appendChild(el('span', '', `by ${`${entry.publisher}`.slice(0, 10)}…`));
    const when = formatWhen(entry.savedAt);
    if (when) meta.appendChild(el('span', '', when));
    card.appendChild(meta);

    return card;
}

/**
 * @param {any[]} entries
 * @param {{ query?: string, total?: number }} [state]
 */
export function renderLibrary(entries, { query = '', total = 0 } = {}) {
    const section = document.getElementById('site-library');
    const results = document.getElementById('library-results');
    const count = document.getElementById('library-count');
    const empty = document.getElementById('library-empty');

    const rows = entries || [];
    const library = Math.max(total, rows.length);

    // Nothing cached and nothing typed: there is no library to talk about yet.
    if (section instanceof HTMLElement) section.classList.toggle('hidden', library === 0 && !query);
    if (count) count.textContent = `${library} ${library === 1 ? 'site' : 'sites'}`;

    if (empty) {
        empty.classList.toggle('hidden', rows.length > 0);
        empty.textContent = query
            ? `Nothing in this browser matches “${query}”.`
            : 'Sites you open are kept here so you can find them again by name.';
    }

    if (!results) return;
    results.textContent = '';
    rows.forEach((entry) => results.appendChild(buildResult(entry)));
}
