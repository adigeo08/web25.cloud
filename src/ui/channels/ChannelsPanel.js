// @ts-check
/**
 * Direct Messenger panel.
 *
 * The panel has two states: find someone to message, and the conversation
 * itself. Addressing is by Nostr address only — the manual magnet exchange and
 * the raw ECIES key display were removed in favour of the search flow. The
 * WebTorrent bootstrap modules are unchanged and still available to callers.
 */

import { bindCopyButton } from '../ClipboardButton.js';

const DM_STEPS = ['dm-choose-role', 'dm-chat-active'];

/**
 * The one connection indicator.
 *
 * Both working states are green: once a conversation works, the transport is a
 * detail, not a warning. There is deliberately no second flag that could say
 * something different at the same time.
 */
export const DM_CONNECTION_LABELS = {
    idle: { text: 'Not connected', className: 'status-chip status-pending' },
    'awaiting-peer': { text: 'Waiting for them to accept…', className: 'status-chip status-pending' },
    // Set when the handshake *starts*, so it must not read as finished.
    handshake: { text: 'Setting up the connection…', className: 'status-chip status-pending' },
    'connecting-webrtc': { text: 'Connecting via WebRTC…', className: 'status-chip status-pending' },
    'connected-webrtc': { text: 'Connected · WebRTC', className: 'status-chip status-success' },
    'connected-nostr': { text: 'Connected · Nostr', className: 'status-chip status-success' },
    disconnected: { text: 'Disconnected', className: 'status-chip status-error' }
};

export function showDmStep(step) {
    DM_STEPS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (id === step) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });
}

function setDmError(elementId, message) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (message) {
        el.textContent = message;
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

function shortAddress(address) {
    if (!address) return 'anonymous';
    if (address.length < 14) return address;
    return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

/**
 * @param {{
 *   onSearch: (query: string) => Promise<any>,
 *   onStartChat: (result: any) => Promise<boolean>,
 *   onLeave: () => void,
 *   onSend: (text: string) => void
 * }} handlers
 */
export function bindChannelsPanel({ onSearch, onStartChat, onLeave, onSend }) {
    const searchBtn = document.getElementById('dm-nostr-search-btn');
    const startChatBtn = document.getElementById('channels-nostr-invite-btn');
    const leaveBtn = document.getElementById('channels-leave-btn');
    const sendBtn = document.getElementById('channels-send-btn');
    const copyOwnNpubBtn = document.getElementById('dm-copy-own-npub-btn');

    const messageInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-message-input'));
    const recipientInput = /** @type {HTMLInputElement|null} */ (document.getElementById('dm-recipient-npub-input'));

    /** The address the search resolved, held until the user starts the chat. */
    let pendingResult = null;

    const runSearch = async () => {
        setDmError('dm-choose-role-error', '');
        pendingResult = null;
        renderDmSearchResult(null);

        const query = recipientInput?.value?.trim() || '';
        if (!query) {
            setDmSearchHint('Paste an npub, or a raw 64-character hex key.');
            return;
        }

        setDmSearchHint('Searching the relay pool…', 'pending');
        try {
            const result = await onSearch(query);
            if (!result) return;
            pendingResult = result;
            renderDmSearchResult(result);
            setDmSearchHint(
                result.profile ? 'Found on the relay pool.' : 'Valid address. No public profile found on the relays.',
                'ok'
            );
        } catch (err) {
            setDmSearchHint('', '');
            setDmError('dm-choose-role-error', err instanceof Error ? err.message : String(err));
        }
    };

    searchBtn?.addEventListener('click', () => void runSearch());
    recipientInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') void runSearch();
    });
    recipientInput?.addEventListener('input', () => {
        // A changed address invalidates whatever the last search resolved.
        pendingResult = null;
        renderDmSearchResult(null);
        setDmError('dm-choose-role-error', '');
        setDmSearchHint('Paste an npub, or a raw 64-character hex key.');
    });

    startChatBtn?.addEventListener('click', async () => {
        setDmError('dm-choose-role-error', '');
        if (!pendingResult) {
            setDmError('dm-choose-role-error', 'Search for a Nostr address first.');
            return;
        }
        try {
            const ok = await onStartChat(pendingResult);
            if (ok === true) showDmStep('dm-chat-active');
        } catch (err) {
            setDmError('dm-choose-role-error', err instanceof Error ? err.message : String(err));
        }
    });

    leaveBtn?.addEventListener('click', () => {
        onLeave();
        showDmStep('dm-choose-role');
    });

    bindCopyButton(copyOwnNpubBtn, () => document.getElementById('dm-own-npub-value')?.textContent || '');

    // The address itself is the obvious thing to click, so it drives the same
    // copy button rather than carrying a second clipboard implementation (and
    // its own success/failure flash) alongside it.
    const ownNpubValue = document.getElementById('dm-own-npub-value');
    if (ownNpubValue && !ownNpubValue.dataset.copyBound) {
        ownNpubValue.dataset.copyBound = '1';
        const copyOwnNpub = () => copyOwnNpubBtn?.dispatchEvent(new MouseEvent('click'));
        ownNpubValue.addEventListener('click', copyOwnNpub);
        ownNpubValue.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                copyOwnNpub();
            }
        });
    }

    sendBtn?.addEventListener('click', () => onSend(messageInput?.value || ''));
    messageInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') onSend(messageInput.value || '');
    });
}

/**
 * @param {string} message
 * @param {string} [tone] '' | 'pending' | 'ok'
 */
export function setDmSearchHint(message, tone = '') {
    const el = document.getElementById('dm-search-hint');
    if (!el) return;
    el.textContent = message;
    el.className = `dm-search-hint${tone ? ` is-${tone}` : ''}`;
}

/**
 * Render (or clear) the resolved recipient.
 *
 * Profile fields come from public relays, so everything is written with
 * `textContent` — never markup — and the profile picture is deliberately not
 * fetched or displayed.
 *
 * @param {{ npub: string, shortNpub: string, profile: any }|null} result
 */
export function renderDmSearchResult(result) {
    const container = document.getElementById('dm-search-result');
    const nameEl = document.getElementById('dm-search-result-name');
    const npubEl = document.getElementById('dm-search-result-npub');
    const aboutEl = document.getElementById('dm-search-result-about');
    if (!container) return;

    if (!result) {
        container.classList.add('hidden');
        if (nameEl) nameEl.textContent = '';
        if (npubEl) npubEl.textContent = '';
        if (aboutEl) aboutEl.textContent = '';
        return;
    }

    const profile = result.profile || null;
    const displayName = profile?.displayName || profile?.name || '';

    if (nameEl) nameEl.textContent = displayName || 'Unnamed Nostr identity';
    if (npubEl) npubEl.textContent = result.shortNpub || result.npub || '';
    if (aboutEl) {
        aboutEl.textContent = profile?.nip05 || profile?.about || '';
        aboutEl.classList.toggle('hidden', !aboutEl.textContent);
    }

    container.classList.remove('hidden');
}

/**
 * Show the local Nostr address when the wallet is unlocked and the identity is
 * present. `enabled: false` means the user removed it on the Identity page.
 *
 * @param {{ npub: string|null, enabled?: boolean }} params
 */
export function updateDmNostrIdentity({ npub, enabled = true }) {
    const panel = document.getElementById('dm-my-npub-panel');
    const lockedPanel = document.getElementById('dm-my-npub-locked');
    const disabledPanel = document.getElementById('dm-nostr-disabled');
    const valueEl = document.getElementById('dm-own-npub-value');
    const search = document.querySelector('.dm-search');

    const hasIdentity = Boolean(npub) && enabled !== false;

    if (panel) panel.classList.toggle('hidden', !hasIdentity);
    if (valueEl) valueEl.textContent = hasIdentity ? `${npub}` : '';
    if (disabledPanel) disabledPanel.classList.toggle('hidden', enabled !== false);
    if (lockedPanel) lockedPanel.classList.toggle('hidden', Boolean(npub) || enabled === false);
    if (search) search.classList.toggle('hidden', !hasIdentity);
}

/**
 * Render the single connection status.
 *
 * @param {string} state one of `DM_CONNECTION_LABELS`
 * @param {{ peerLabel?: string }} [options]
 */
export function renderDmConnectionState(state, { peerLabel = '' } = {}) {
    const el = document.getElementById('dm-connection-status');
    if (el) {
        const label = DM_CONNECTION_LABELS[state] || DM_CONNECTION_LABELS.idle;
        el.textContent = label.text;
        el.className = label.className;
    }

    const peerEl = document.getElementById('dm-peer-label');
    if (peerEl) peerEl.textContent = peerLabel;

    // Anything past waiting means there is a conversation pane worth showing.
    if (state !== 'idle' && state !== 'awaiting-peer') showDmStep('dm-chat-active');
}

export function clearChannelsMessages() {
    const container = document.getElementById('channels-messages');
    if (container) container.innerHTML = '';
}

export function clearDmSearch() {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('dm-recipient-npub-input'));
    if (input) input.value = '';
    renderDmSearchResult(null);
    setDmSearchHint('Paste an npub, or a raw 64-character hex key.');
    setDmError('dm-choose-role-error', '');
}

/** Where a link is allowed to point. Everything else stays plain text. */
const LINKABLE_PROTOCOLS = new Set(['http:', 'https:']);

/** Matches a bare http(s) URL inside ordinary prose. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;

/**
 * Trailing punctuation belongs to the sentence, not to the URL.
 * `(see https://example.com/a).` should not link the closing bracket.
 * @param {string} candidate
 */
function trimUrlTail(candidate) {
    let url = candidate;
    while (url.length > 0 && '.,;:!?'.includes(url[url.length - 1])) url = url.slice(0, -1);
    // Balance brackets rather than counting them: only a trailing one that was
    // never opened inside the URL is punctuation.
    while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
        url = url.slice(0, -1);
    }
    return url;
}

/**
 * Render message text with its links clickable.
 *
 * A message is written by the peer, so this never touches `innerHTML`: the text
 * is split, the pieces are appended as text nodes, and a link is a real element
 * whose `href` was parsed and checked first. Only `http:` and `https:` survive
 * that check — a `javascript:` or `data:` URL is left as the plain text it is.
 *
 * Links open in a new tab, with `rel="noopener noreferrer"` so the opened page
 * gets neither a handle on this one nor a referrer naming the gateway.
 *
 * @param {HTMLElement} target
 * @param {string} text
 */
export function renderMessageText(target, text) {
    const value = `${text || ''}`;
    let lastIndex = 0;

    for (const match of value.matchAll(URL_PATTERN)) {
        const raw = match[0];
        const index = match.index ?? 0;
        const href = trimUrlTail(raw);

        let parsed = null;
        try {
            parsed = new URL(href);
        } catch (_) {
            parsed = null;
        }
        if (!parsed || !LINKABLE_PROTOCOLS.has(parsed.protocol)) continue;

        if (index > lastIndex) target.appendChild(document.createTextNode(value.slice(lastIndex, index)));

        const link = document.createElement('a');
        link.href = parsed.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'channels-message-link';
        link.textContent = href;
        target.appendChild(link);

        lastIndex = index + href.length;
    }

    if (lastIndex < value.length) target.appendChild(document.createTextNode(value.slice(lastIndex)));
}

export function appendChannelsMessage(message, isOwn = false) {
    const container = document.getElementById('channels-messages');
    if (!container) return;

    const item = document.createElement('div');
    item.className = `channels-message ${isOwn ? 'is-own' : ''}`.trim();

    const meta = document.createElement('div');
    meta.className = 'channels-message-meta';
    const time = new Date(message.timestamp || Date.now()).toLocaleTimeString();
    meta.textContent = `${shortAddress(message.from)} · ${time}`;

    const body = document.createElement('div');
    body.className = 'channels-message-body';
    renderMessageText(body, message.text || '');

    item.appendChild(meta);
    item.appendChild(body);
    container.appendChild(item);
    container.scrollTop = container.scrollHeight;
}

export function clearChannelsComposer() {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-message-input'));
    if (input) input.value = '';
}

export function bindFileInput(onFile) {
    const attachBtn = document.getElementById('channels-attach-btn');
    const fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-file-input'));
    attachBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
        const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
        if (file) {
            onFile(file);
            if (fileInput) fileInput.value = '';
        }
    });
}

/**
 * One row per transfer, in either direction.
 *
 * Over the relay a transfer takes seconds per megabyte rather than an instant,
 * so the row has to be honest while it runs: the sender sees its own progress,
 * the receiver sees a name and a percentage instead of a stuck placeholder, and
 * a transfer that dies mid-way says so rather than freezing at 94%.
 *
 * @param {{ fileId: string, fileName?: string, fileSize?: number, url?: string|null,
 *           received?: number, direction?: 'in'|'out', state?: 'active'|'error',
 *           overRelay?: boolean }} transfer
 */
export function appendFileTransfer({
    fileId,
    fileName = '',
    fileSize = 0,
    url = null,
    received = 0,
    direction = 'in',
    state = 'active',
    overRelay = false
}) {
    const container = document.getElementById('channels-files');
    if (!container) return;
    let item = document.getElementById(`file-transfer-${fileId}`);
    if (!item) {
        item = document.createElement('div');
        item.id = `file-transfer-${fileId}`;
        item.className = 'file-transfer';
        container.appendChild(item);
        item.dataset.fileName = fileName;
    }
    // Progress events carry less than the first event did; whatever the row was
    // named when it opened is what it stays called.
    if (fileName) item.dataset.fileName = fileName;
    const label = item.dataset.fileName || fileName || 'file';

    item.textContent = '';
    item.classList.toggle('is-error', state === 'error');

    if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.download = label;
        link.className = 'btn btn-secondary btn-sm';
        link.textContent = `💾 ${label}`;
        item.appendChild(link);
        return;
    }

    const span = document.createElement('span');
    if (state === 'error') {
        span.textContent = `⚠️ ${label} — transfer interrupted`;
    } else {
        const progress = fileSize > 0 ? Math.round((received / fileSize) * 100) : 0;
        const arrow = direction === 'out' ? '📤' : '📥';
        const via = overRelay ? ' · over relay' : '';
        span.textContent = `${arrow} ${label} — ${progress}%${via}`;
    }
    item.appendChild(span);
}
