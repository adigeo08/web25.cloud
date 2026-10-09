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
import { paintAvatar } from './Avatar.js';

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

/**
 * Which of the two panes a phone is showing.
 *
 * Desktop shows the contact list and the conversation side by side and has no
 * use for this: the class it toggles only means anything inside the narrow
 * media query, and only while a conversation pane is open. A phone cannot show
 * both, so a conversation takes the whole tab the way a phone messenger does —
 * and leaving that screen has to be possible without leaving the conversation,
 * which is what Disconnect is for.
 *
 * @param {'contacts'|'conversation'} pane
 */
export function showDmPane(pane) {
    const layout = document.querySelector('.dm-layout');
    if (!layout) return;
    layout.classList.toggle('dm-show-contacts', pane === 'contacts');
    // A thread that filled up while it was off screen could not scroll, so
    // coming back to it lands on the latest message, the way a messenger
    // reopens a chat.
    if (pane === 'conversation') scrollThreadToBottom();
}

/** How close to the bottom still counts as reading the latest message. */
const NEAR_BOTTOM_PX = 120;

function messagesContainer() {
    return document.getElementById('channels-messages');
}

/** @param {HTMLElement} container */
function isNearBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
}

/**
 * The jump-to-latest button, shown only while the latest is off screen.
 * @param {HTMLElement|null} [container]
 */
function syncScrollButton(container = messagesContainer()) {
    const button = document.getElementById('dm-scroll-bottom');
    if (!button || !container) return;
    button.classList.toggle('hidden', isNearBottom(container));
}

/** @param {HTMLElement|null} [container] */
function scrollThreadToBottom(container = messagesContainer()) {
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    syncScrollButton(container);
}

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

    // A conversation that has just opened is what the person asked to see, so
    // on a phone it gets the screen. The finder needs no such claim: with no
    // conversation open both panes simply stack.
    if (step === 'dm-chat-active') showDmPane('conversation');
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

    // The phone's two panes. Neither touches the conversation: this is which
    // screen you are looking at, not whether you are still connected.
    document.getElementById('dm-back-to-contacts')?.addEventListener('click', () => showDmPane('contacts'));
    document.getElementById('dm-back-to-chat')?.addEventListener('click', () => showDmPane('conversation'));

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
    // Pressing Send must not take focus from the field: on a phone that closes
    // the keyboard after every message, which no messenger does.
    sendBtn?.addEventListener('mousedown', (event) => event.preventDefault());

    // Reading back through the thread is not interrupted by new messages; the
    // button below is how you get back to them.
    const thread = messagesContainer();
    thread?.addEventListener('scroll', () => syncScrollButton(thread), { passive: true });
    document.getElementById('dm-scroll-bottom')?.addEventListener('click', () => {
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        thread?.scrollTo({ top: thread.scrollHeight, behavior: still ? 'auto' : 'smooth' });
    });
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

    paintAvatar(document.getElementById('dm-search-result-avatar'), displayName || result.npub || '');
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
    paintAvatar(document.getElementById('dm-peer-avatar'), peerLabel);

    // Anything past waiting means there is a conversation pane worth showing.
    if (state !== 'idle' && state !== 'awaiting-peer') showDmStep('dm-chat-active');
}

export function clearChannelsMessages() {
    const container = document.getElementById('channels-messages');
    if (container) {
        container.innerHTML = '';
        // The next message starts a new day chip, whatever day it is.
        delete container.dataset.day;
    }
    document.getElementById('dm-scroll-bottom')?.classList.add('hidden');
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

/** Consecutive messages from one side within this window read as one burst. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * A peer supplies the timestamp, so a value that does not parse falls back to
 * now rather than printing "Invalid Date" into the thread.
 * @param {any} value
 */
function messageDate(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

/** @param {Date} date */
function dayKey(date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** @param {Date} date */
function dayLabel(date) {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (dayKey(date) === dayKey(today)) return 'Today';
    if (dayKey(date) === dayKey(yesterday)) return 'Yesterday';
    return date.toLocaleDateString([], {
        day: 'numeric',
        month: 'long',
        ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
    });
}

/**
 * A date chip whenever the thread crosses into a new day.
 * @param {HTMLElement} container
 * @param {Date} date
 */
function markDay(container, date) {
    const key = dayKey(date);
    if (container.dataset.day === key) return;
    container.dataset.day = key;

    const chip = document.createElement('div');
    chip.className = 'channels-day';
    chip.setAttribute('role', 'separator');
    const label = document.createElement('span');
    label.textContent = dayLabel(date);
    chip.appendChild(label);
    container.appendChild(chip);
}

/**
 * The clock in the corner of a bubble.
 * @param {Date} date
 */
function messageStamp(date) {
    const meta = document.createElement('span');
    meta.className = 'channels-message-meta';
    meta.textContent = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return meta;
}

/**
 * One message, as a bubble.
 *
 * In a one-to-one conversation the side a bubble sits on already says who
 * wrote it, so the bubble carries only the time; the sender's address and the
 * full date are in its tooltip. A run of messages from the same side shares
 * one tail, a new day gets a chip, and a notice the service writes itself
 * ("Peer verified …") is a centred pill rather than a message from anybody.
 *
 * @param {any} message
 * @param {boolean} [isOwn]
 */
export function appendChannelsMessage(message, isOwn = false) {
    const container = messagesContainer();
    if (!container) return;

    // Someone reading back through the thread stays where they are; your own
    // message always brings you to the bottom.
    const follow = isOwn || isNearBottom(container);
    const date = messageDate(message.timestamp);
    markDay(container, date);

    const system = message.from === 'system';
    const side = system ? 'system' : isOwn ? 'out' : 'in';
    const from = `${message.from || ''}`;

    const item = document.createElement('div');
    item.className = ['channels-message', side === 'out' ? 'is-own' : '', system ? 'is-system' : '']
        .filter(Boolean)
        .join(' ');
    item.dataset.side = side;
    item.dataset.from = from;
    item.dataset.ts = `${date.getTime()}`;
    item.title = `${system ? 'Notice' : shortAddress(message.from)} · ${date.toLocaleString()}`;

    const previous = /** @type {HTMLElement|null} */ (container.lastElementChild);
    if (
        !system &&
        previous?.dataset?.side === side &&
        previous.dataset.from === from &&
        date.getTime() - Number(previous.dataset.ts || 0) < GROUP_WINDOW_MS
    ) {
        item.classList.add('is-continued');
    }

    const body = document.createElement('div');
    body.className = 'channels-message-body';
    renderMessageText(body, message.text || '');
    // Inside the body, after the text, so it can float onto the last line.
    if (!system) body.appendChild(messageStamp(date));

    item.appendChild(body);
    container.appendChild(item);

    if (follow) scrollThreadToBottom(container);
    else syncScrollButton(container);
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

/** @param {number} bytes */
function formatBytes(bytes) {
    if (!(bytes > 0)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * One bubble per transfer, in either direction.
 *
 * A file is part of the conversation, so it sits in the thread where it was
 * sent, on the side of whoever sent it. Over the relay a transfer takes
 * seconds per megabyte rather than an instant, so the bubble has to be honest
 * while it runs: the sender sees its own progress, the receiver sees a name
 * and a percentage instead of a stuck placeholder, and a transfer that dies
 * mid-way says so rather than freezing at 94%. A finished file is the bubble
 * itself: tapping it saves it.
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
    const container = messagesContainer();
    if (!container) return;

    let follow = false;
    let item = document.getElementById(`file-transfer-${fileId}`);
    if (!item) {
        follow = direction === 'out' || isNearBottom(container);
        const now = new Date();
        markDay(container, now);
        item = document.createElement('div');
        item.id = `file-transfer-${fileId}`;
        item.className = 'channels-message file-transfer';
        item.dataset.fileName = fileName;
        item.dataset.ts = `${now.getTime()}`;
        container.appendChild(item);
    }
    // Progress events carry less than the first event did; whatever the row was
    // named when it opened is what it stays called.
    if (fileName) item.dataset.fileName = fileName;
    if (fileSize > 0) item.dataset.fileSize = `${fileSize}`;
    // A file this browser is sending stays outgoing: its own announcement is
    // reported as an incoming transfer before the send starts.
    if (direction === 'out' || !item.dataset.side) item.dataset.side = direction === 'out' ? 'out' : 'in';

    const label = item.dataset.fileName || fileName || 'file';
    const outgoing = item.dataset.side === 'out';
    const size = formatBytes(Number(item.dataset.fileSize || 0));

    item.textContent = '';
    item.classList.toggle('is-own', outgoing);
    item.classList.toggle('is-error', state === 'error');
    item.classList.toggle('is-ready', Boolean(url));

    const card = document.createElement(url ? 'a' : 'div');
    card.className = 'file-transfer-card';
    if (url && card instanceof HTMLAnchorElement) {
        card.href = url;
        card.download = label;
        card.title = `Save ${label}`;
    }

    const icon = document.createElement('span');
    icon.className = 'file-transfer-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = state === 'error' ? '⚠️' : url ? '💾' : outgoing ? '📤' : '📥';

    const info = document.createElement('span');
    info.className = 'file-transfer-info';
    const name = document.createElement('span');
    name.className = 'file-transfer-name';
    name.textContent = label;
    const status = document.createElement('span');
    status.className = 'file-transfer-status';

    const progress = fileSize > 0 ? Math.min(100, Math.round((received / fileSize) * 100)) : 0;
    const via = overRelay ? ' · over relay' : '';
    if (state === 'error') {
        status.textContent = 'Transfer interrupted';
    } else if (url) {
        status.textContent = [size, 'Tap to save'].filter(Boolean).join(' · ');
    } else if (outgoing && progress >= 100) {
        status.textContent = [size, `Sent${via}`].filter(Boolean).join(' · ');
    } else {
        status.textContent = `${outgoing ? 'Sending' : 'Receiving'} · ${progress}%${via}`;
    }

    info.appendChild(name);
    info.appendChild(status);
    card.appendChild(icon);
    card.appendChild(info);
    item.appendChild(card);

    if (state !== 'error' && !url && progress < 100) {
        const bar = document.createElement('div');
        bar.className = 'file-transfer-progress';
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', `${progress}`);
        bar.setAttribute('aria-label', label);
        const fill = document.createElement('span');
        fill.style.width = `${progress}%`;
        bar.appendChild(fill);
        item.appendChild(bar);
    }

    item.appendChild(messageStamp(messageDate(Number(item.dataset.ts))));

    if (follow) scrollThreadToBottom(container);
    else syncScrollButton(container);
}
