// @ts-check

function shortAddress(address) {
    if (!address) return 'anonymous';
    if (address.length < 14) return address;
    return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

export function bindChannelsPanel({ onJoin, onLeave, onSend }) {
    const joinBtn = document.getElementById('channels-join-btn');
    const leaveBtn = document.getElementById('channels-leave-btn');
    const sendBtn = document.getElementById('channels-send-btn');
    const channelInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-name-input'));
    const messageInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-message-input'));

    joinBtn?.addEventListener('click', () => onJoin(channelInput?.value || ''));
    leaveBtn?.addEventListener('click', () => onLeave());
    sendBtn?.addEventListener('click', () => onSend(messageInput?.value || ''));
    messageInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') onSend(messageInput.value || '');
    });
    channelInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') onJoin(channelInput.value || '');
    });
}

export function renderChannelsStatus({ channel = '', channelHash = '', peers = 0, connected = false }) {
    const status = document.getElementById('channels-status');
    if (!status) return;
    if (!connected) {
        status.textContent = 'Disconnected';
        return;
    }

    const hashLabel = channelHash ? ` · hash: ${channelHash.slice(0, 12)}…` : '';
    status.textContent = `Connected to #${channel} · peers: ${peers}${hashLabel}`;
}

export function clearChannelsMessages() {
    const container = document.getElementById('channels-messages');
    if (container) container.innerHTML = '';
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
