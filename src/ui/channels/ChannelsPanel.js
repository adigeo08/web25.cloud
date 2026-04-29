// @ts-check

const DM_STEPS = ['dm-join', 'dm-connecting', 'dm-chat-active'];

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

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        console.warn('Clipboard API failed, falling back to execCommand:', err);
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        // execCommand is deprecated but used here for legacy browser support
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
}

function shortAddress(address) {
    if (!address) return 'anonymous';
    if (address.length < 14) return address;
    return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

export function bindChannelsPanel({ onJoinRoom, onLeave, onSend }) {
    const joinRoomBtn = document.getElementById('channels-join-room-btn');
    const sendBtn = document.getElementById('channels-send-btn');
    const roomKeyInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-name-input'));
    const messageInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-message-input'));

    joinRoomBtn?.addEventListener('click', async () => {
        setDmError('dm-join-error', '');
        const roomKey = roomKeyInput?.value || '';
        if (!roomKey.trim()) {
            setDmError('dm-join-error', 'Room key is required.');
            return;
        }
        try {
            await onJoinRoom({ roomKey });
        } catch (err) {
            setDmError('dm-join-error', err instanceof Error ? err.message : String(err));
        }
    });

    // Bind all leave/cancel buttons (appear in both dm-connecting and dm-chat-active)
    document.querySelectorAll('.channels-leave-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            onLeave();
            showDmStep('dm-join');
        });
    });

    sendBtn?.addEventListener('click', () => onSend(messageInput?.value || ''));
    messageInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') onSend(messageInput.value || '');
    });
}

export function renderChannelsStatus({ channel = '', peers = 0, connected = false }) {
    if (!connected) {
        showDmStep('dm-join');
        document.querySelectorAll('.channels-status').forEach((el) => {
            el.textContent = 'Disconnected';
            el.className = 'channels-status status-chip status-pending';
        });
        return;
    }
    if (connected && peers < 1) {
        showDmStep('dm-connecting');
        document.querySelectorAll('.channels-status').forEach((el) => {
            el.textContent = `Connecting to room "${channel}"...`;
            el.className = 'channels-status status-chip status-pending';
        });
        return;
    }
    showDmStep('dm-chat-active');
    document.querySelectorAll('.channels-status').forEach((el) => {
        el.textContent = `Connected · room "${channel}"`;
        el.className = 'channels-status status-chip status-success';
    });
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

