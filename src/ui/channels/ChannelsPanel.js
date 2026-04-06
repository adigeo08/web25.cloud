// @ts-check

function shortAddress(address) {
    if (!address) return 'anonymous';
    if (address.length < 14) return address;
    return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

export function bindChannelsPanel({ onCreateOffer, onCreateAnswer, onApplyAnswer, onLeave, onSend }) {
    const createOfferBtn = document.getElementById('channels-create-offer-btn');
    const createAnswerBtn = document.getElementById('channels-create-answer-btn');
    const applyAnswerBtn = document.getElementById('channels-apply-answer-btn');
    const leaveBtn = document.getElementById('channels-leave-btn');
    const sendBtn = document.getElementById('channels-send-btn');

    const roomKeyInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-name-input'));
    const remoteOfferInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-remote-offer-input'));
    const remoteAnswerInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-remote-answer-input'));
    const messageInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-message-input'));

    createOfferBtn?.addEventListener('click', () =>
        onCreateOffer({
            roomKey: roomKeyInput?.value || ''
        })
    );
    createAnswerBtn?.addEventListener('click', () =>
        onCreateAnswer({
            roomKey: roomKeyInput?.value || '',
            offerCode: remoteOfferInput?.value || ''
        })
    );
    applyAnswerBtn?.addEventListener('click', () => onApplyAnswer(remoteAnswerInput?.value || ''));
    leaveBtn?.addEventListener('click', () => onLeave());
    sendBtn?.addEventListener('click', () => onSend(messageInput?.value || ''));
    messageInput?.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') onSend(messageInput.value || '');
    });
}

export function renderChannelsStatus({ channel = '', peers = 0, connected = false }) {
    const status = document.getElementById('channels-status');
    if (!status) return;
    if (!connected) {
        status.textContent = 'Disconnected';
        return;
    }
    if (connected && peers < 1) {
        status.textContent = `Connecting to room "${channel}"...`;
        return;
    }
    status.textContent = `Connected to room "${channel}" · peers: ${peers}`;
}

export function setLocalOfferCode(code) {
    const output = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-local-offer-output'));
    if (output) output.value = code || '';
}

export function setLocalAnswerCode(code) {
    const output = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-local-answer-output'));
    if (output) output.value = code || '';
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
    if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.className = 'btn btn-secondary btn-sm';
        link.textContent = `💾 ${fileName}`;
        item.textContent = '';
        item.appendChild(link);
    } else {
        const span = document.createElement('span');
        span.textContent = `📥 ${fileName} — ${progress}%`;
        item.textContent = '';
        item.appendChild(span);
    }
}
