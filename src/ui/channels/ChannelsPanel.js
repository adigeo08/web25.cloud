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
 * Transport labels shown in the chat header. Deliberately plain: the user only
 * needs to know whether the conversation is peer-to-peer or going through a
 * public relay.
 */
export const DM_TRANSPORT_LABELS = {
    connecting: { text: 'Connecting…', className: 'status-chip status-pending' },
    webrtc: { text: 'P2P · WebRTC', className: 'status-chip status-success' },
    nostr: { text: 'Relay fallback · Nostr', className: 'status-chip status-pending' },
    disconnected: { text: 'Disconnected', className: 'status-chip status-pending' }
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
 * @param {string} transport one of `connecting`, `webrtc`, `nostr`, `disconnected`
 */
export function renderDmTransport(transport) {
    const el = document.getElementById('dm-transport-chip');
    if (!el) return;
    const label = DM_TRANSPORT_LABELS[transport] || DM_TRANSPORT_LABELS.disconnected;
    el.textContent = label.text;
    el.className = label.className;
}

export function renderChannelsStatus({ channel = '', peers = 0, connected = false }) {
    const status = document.getElementById('channels-status');
    if (!status) return;
    if (!connected) {
        status.textContent = 'Disconnected';
        status.className = 'status-chip status-pending';
        return;
    }
    if (connected && peers < 1) {
        status.textContent = 'Connecting…';
        status.className = 'status-chip status-pending';
        return;
    }
    status.textContent = `Connected · peers: ${peers}`;
    status.className = 'status-chip status-success';
    showDmStep('dm-chat-active');
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
    body.textContent = message.text || '';

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

export function appendFileTransfer({ fileId, fileName, fileSize, url = null, received = 0 }) {
    const container = document.getElementById('channels-files');
    if (!container) return;
    let item = document.getElementById(`file-transfer-${fileId}`);
    if (!item) {
        item = document.createElement('div');
        item.id = `file-transfer-${fileId}`;
        item.className = 'file-transfer';
        container.appendChild(item);
    }
    const progress = fileSize > 0 ? Math.round((received / fileSize) * 100) : 0;
    item.textContent = '';
    if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.className = 'btn btn-secondary btn-sm';
        link.textContent = `💾 ${fileName}`;
        item.appendChild(link);
    } else {
        const span = document.createElement('span');
        span.textContent = `📥 ${fileName} — ${progress}%`;
        item.appendChild(span);
    }
}
