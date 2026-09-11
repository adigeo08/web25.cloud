// @ts-check
/**
 * The Pages tab: one card per site this browser is seeding.
 *
 * The tab only exists when there is something to show. A publisher with no
 * active session has no Pages tab at all, rather than a tab that opens onto an
 * empty state.
 *
 * Each card is collapsed to the one line that matters — what is live, and
 * whether anyone is pulling it — and opens onto the full deployment record as
 * it stood the moment it went live. Every value is written with `textContent`;
 * a site name comes from a folder the publisher picked, and nothing here
 * interprets it as markup.
 */

const STATE_LABELS = {
    seeding: { text: 'Seeding', className: 'status-chip status-success' },
    stopped: { text: 'Not announcing', className: 'status-chip status-pending' },
    error: { text: 'Could not resume', className: 'status-chip status-error' }
};

const MIRROR_LABELS = {
    disabled: 'Not created — WebTorrent only',
    idle: 'Not created — WebTorrent only',
    pending: 'Creating…',
    unavailable: 'Not created — WebTorrent only'
};

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
    return `${parseFloat((value / Math.pow(1024, index)).toFixed(2))} ${units[index]}`;
}

function formatDate(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function shortHash(hash) {
    const value = `${hash || ''}`;
    return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** @param {string} tag @param {string} className @param {string} [text] */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function statTile(label, value) {
    const tile = el('div', 'page-stat');
    tile.appendChild(el('span', 'page-stat-value', value));
    tile.appendChild(el('span', 'page-stat-label', label));
    return tile;
}

function factRow(label, value, { code = false } = {}) {
    const row = el('div', 'page-fact');
    row.appendChild(el('span', 'page-fact-label', label));
    row.appendChild(el(code ? 'code' : 'span', 'page-fact-value', value));
    return row;
}

/**
 * Wire the card actions once. Cards are rebuilt on every refresh, so the
 * listener is delegated from the list.
 *
 * @param {{ onOpen: (hash: string) => void, onCopy: (hash: string) => void,
 *           onDownload: (hash: string) => void, onStop: (hash: string) => void }} handlers
 */
export function bindPagesPanel({ onOpen, onCopy, onDownload, onStop }) {
    const list = document.getElementById('pages-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';

    list.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const button = target.closest('[data-page-action]');
        if (!button) return;
        const hash = button.getAttribute('data-page-hash') || '';
        if (!hash) return;
        switch (button.getAttribute('data-page-action')) {
            case 'open':
                onOpen(hash);
                break;
            case 'copy':
                onCopy(hash);
                break;
            case 'download':
                onDownload(hash);
                break;
            case 'stop':
                onStop(hash);
                break;
            default:
                break;
        }
    });
}

/**
 * Ask before ending a session for good.
 *
 * Stopping is not reversible from here — the record is deleted, so the site
 * does not come back on the next load — which is exactly the kind of thing
 * that deserves a sentence and two buttons rather than a stray click.
 *
 * @param {{ siteName?: string, hash?: string }} session
 * @returns {Promise<boolean>}
 */
export function confirmStopSeeding({ siteName = '', hash = '' } = {}) {
    const modal = document.getElementById('stop-seeding-modal');
    const nameEl = document.getElementById('stop-seeding-name');
    const confirmBtn = document.getElementById('stop-seeding-confirm');
    const cancelBtn = document.getElementById('stop-seeding-cancel');
    const closeBtn = document.getElementById('stop-seeding-close');

    if (!modal || !confirmBtn || !cancelBtn) {
        return Promise.resolve(
            window.confirm(`Stop seeding ${siteName || hash}? Visitors will no longer be able to load it from you.`)
        );
    }

    if (nameEl) nameEl.textContent = siteName || shortHash(hash);
    modal.classList.remove('hidden');

    // Focus goes into the dialog and comes back out to whatever opened it.
    // Without this a keyboard or screen-reader user is left on the card behind
    // a destructive prompt they have not been told about, and Tab walks the
    // page rather than the two choices in front of them.
    const opener = document.activeElement;
    const focusable = () => [closeBtn, confirmBtn, cancelBtn].filter(Boolean);
    cancelBtn.focus?.();

    return new Promise((resolve) => {
        const finish = (result) => {
            modal.classList.add('hidden');
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn?.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            if (opener && typeof (/** @type {any} */ (opener).focus) === 'function') {
                /** @type {any} */ (opener).focus();
            }
            resolve(result);
        };
        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);
        const onKey = (event) => {
            if (event.key === 'Escape') {
                finish(false);
                return;
            }
            if (event.key !== 'Tab') return;

            // Keep Tab inside the dialog while it is up.
            const stops = focusable();
            if (stops.length === 0) return;
            const first = stops[0];
            const last = stops[stops.length - 1];
            const active = document.activeElement;
            if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus?.();
            } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last.focus?.();
            } else if (!stops.includes(/** @type {any} */ (active))) {
                event.preventDefault();
                first.focus?.();
            }
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn?.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}

/**
 * Build one card. Open state is preserved across refreshes so a live counter
 * ticking does not fold a card the user is reading.
 * @param {any} session
 * @param {Set<string>} openHashes
 */
function buildCard(session, openHashes) {
    const card = el('article', 'page-card');
    card.setAttribute('data-page-hash', session.hash);

    const shell = /** @type {HTMLDetailsElement} */ (el('details', 'page-card-shell'));
    shell.open = openHashes.has(session.hash);

    const summary = el('summary', 'page-card-summary');
    const heading = el('div', 'page-card-heading');
    heading.appendChild(el('span', 'page-card-title', session.siteName || 'website'));
    heading.appendChild(el('code', 'page-card-hash', shortHash(session.hash)));
    summary.appendChild(heading);

    const state = STATE_LABELS[session.state] || STATE_LABELS.stopped;
    const chipText =
        session.state === 'seeding'
            ? `${state.text} · ${session.peers} ${session.peers === 1 ? 'peer' : 'peers'}`
            : state.text;
    summary.appendChild(el('span', state.className, chipText));
    shell.appendChild(summary);

    const body = el('div', 'page-card-body');

    const stats = el('div', 'page-card-stats');
    stats.appendChild(statTile('Peers', `${session.peers}`));
    stats.appendChild(statTile('Uploaded', formatBytes(session.uploaded)));
    stats.appendChild(statTile('Bundle', formatBytes(session.length)));
    stats.appendChild(statTile('Files', `${session.fileCount}`));
    body.appendChild(stats);

    if (session.error) {
        const warning = el('p', 'page-card-error', `Could not resume seeding: ${session.error}`);
        body.appendChild(warning);
    }

    const facts = el('div', 'page-card-facts');
    facts.appendChild(factRow('WEB25 link', session.url || '—', { code: true }));
    facts.appendChild(factRow('Torrent hash', session.hash, { code: true }));
    facts.appendChild(factRow('Transport', 'WebTorrent / P2P from this browser'));
    facts.appendChild(
        factRow(
            'GoFile fallback mirror',
            session.mirror?.locator || MIRROR_LABELS[session.mirrorState] || 'Not created',
            { code: Boolean(session.mirror?.locator) }
        )
    );
    facts.appendChild(factRow('Signed by', session.signedBy || 'Unknown', { code: true }));
    facts.appendChild(
        factRow('Signature', session.signature ? `${session.signature.slice(0, 24)}…` : 'N/A', { code: true })
    );
    facts.appendChild(factRow('Signature status', session.signatureStatus || 'VERIFIED'));
    facts.appendChild(factRow('Deployed', formatDate(session.createdAt)));
    body.appendChild(facts);

    const actions = el('div', 'page-card-actions');
    const open = el('button', 'btn btn-primary btn-sm', '🚀 Open site');
    open.setAttribute('data-page-action', 'open');
    open.setAttribute('data-page-hash', session.hash);
    actions.appendChild(open);

    const copy = el('button', 'btn btn-secondary btn-sm', '📋 Copy link');
    copy.setAttribute('data-page-action', 'copy');
    copy.setAttribute('data-page-hash', session.hash);
    actions.appendChild(copy);

    if (session.hasTorrentFile) {
        const download = el('button', 'btn btn-secondary btn-sm', '💾 Download .torrent');
        download.setAttribute('data-page-action', 'download');
        download.setAttribute('data-page-hash', session.hash);
        actions.appendChild(download);
    }

    const stop = el('button', 'btn btn-clear btn-sm', '⏹ Stop seeding');
    stop.setAttribute('data-page-action', 'stop');
    stop.setAttribute('data-page-hash', session.hash);
    actions.appendChild(stop);

    body.appendChild(actions);
    shell.appendChild(body);
    card.appendChild(shell);
    return card;
}

/**
 * Render the whole tab, including whether it exists at all.
 * @param {any[]} sessions
 */
export function renderPages(sessions) {
    const entries = sessions || [];
    const tabBtn = document.querySelector('[data-tab="pages"]');
    const tabPanel = document.getElementById('tab-pages');
    const list = document.getElementById('pages-list');
    const count = document.getElementById('pages-count');

    const hasSessions = entries.length > 0;
    if (tabBtn instanceof HTMLElement) tabBtn.style.display = hasSessions ? 'inline-flex' : 'none';
    if (tabPanel instanceof HTMLElement) tabPanel.style.display = hasSessions ? '' : 'none';
    if (count) {
        count.textContent = `${entries.length} ${entries.length === 1 ? 'site' : 'sites'}`;
    }

    // A tab that disappears under the reader would leave the page blank.
    if (!hasSessions && tabBtn && tabBtn.classList.contains('active')) {
        const browseTab = document.querySelector('[data-tab="browse"]');
        if (browseTab instanceof HTMLElement) browseTab.click();
    }

    if (!list) return;
    const openHashes = new Set(
        [...list.querySelectorAll('details.page-card-shell[open]')].map(
            (node) => node.closest('[data-page-hash]')?.getAttribute('data-page-hash') || ''
        )
    );

    list.textContent = '';
    entries.forEach((session) => list.appendChild(buildCard(session, openHashes)));
}

/**
 * Update only the live counters, without rebuilding the cards.
 *
 * Rebuilding on a five-second tick would close every open card and fight with
 * whatever the user is doing in one.
 *
 * @param {any[]} sessions
 */
export function updatePagesLiveStats(sessions) {
    (sessions || []).forEach((session) => {
        const card = document.querySelector(`.page-card[data-page-hash="${CSS.escape(session.hash)}"]`);
        if (!card) return;

        const chip = card.querySelector('.page-card-summary .status-chip');
        const state = STATE_LABELS[session.state] || STATE_LABELS.stopped;
        if (chip) {
            chip.className = state.className;
            chip.textContent =
                session.state === 'seeding'
                    ? `${state.text} · ${session.peers} ${session.peers === 1 ? 'peer' : 'peers'}`
                    : state.text;
        }

        const values = card.querySelectorAll('.page-stat-value');
        if (values[0]) values[0].textContent = `${session.peers}`;
        if (values[1]) values[1].textContent = formatBytes(session.uploaded);
    });
}
