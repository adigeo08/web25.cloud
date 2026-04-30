// @ts-check

const DM_STEPS = ['dm-choose-role', 'dm-host-signaling', 'dm-guest-waiting', 'dm-chat-active'];

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

export function bindChannelsPanel({ onCreateOffer, onCreateAnswer, onApplyAnswer, onLeave, onSend }) {
    const createOfferBtn = document.getElementById('channels-create-offer-btn');
    const createAnswerBtn = document.getElementById('channels-create-answer-btn');
    const applyAnswerBtn = document.getElementById('channels-apply-answer-btn');
    const leaveBtn = document.getElementById('channels-leave-btn');
    const sendBtn = document.getElementById('channels-send-btn');
    const hostBackBtn = document.getElementById('dm-host-back-btn');
    const guestBackBtn = document.getElementById('dm-guest-back-btn');
    const copyOfferBtn = document.getElementById('dm-copy-offer-btn');
    const copyAnswerBtn = document.getElementById('dm-copy-answer-btn');

    const remoteOfferInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-remote-offer-input'));
    const remoteAnswerInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-remote-answer-input'));
    const localOfferOutput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-local-offer-output'));
    const localAnswerOutput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('channels-local-answer-output'));
    const messageInput = /** @type {HTMLInputElement|null} */ (document.getElementById('channels-message-input'));

    createOfferBtn?.addEventListener('click', async () => {
        setDmError('dm-choose-role-error', '');
        try {
            const ok = await onCreateOffer();
            if (ok === true) showDmStep('dm-host-signaling');
        } catch (err) {
            setDmError('dm-choose-role-error', err instanceof Error ? err.message : String(err));
        }
    });

    createAnswerBtn?.addEventListener('click', async () => {
        setDmError('dm-choose-role-error', '');
        try {
            const ok = await onCreateAnswer({
                offerMagnet: remoteOfferInput?.value || ''
            });
            if (ok === true) showDmStep('dm-guest-waiting');
        } catch (err) {
            setDmError('dm-choose-role-error', err instanceof Error ? err.message : String(err));
        }
    });

    applyAnswerBtn?.addEventListener('click', async () => {
        setDmError('dm-apply-answer-error', '');
        try {
            await onApplyAnswer(remoteAnswerInput?.value || '');
        } catch (err) {
            setDmError('dm-apply-answer-error', err instanceof Error ? err.message : String(err));
        }
    });

    hostBackBtn?.addEventListener('click', () => {
        onLeave();
        showDmStep('dm-choose-role');
    });

    guestBackBtn?.addEventListener('click', () => {
        onLeave();
        showDmStep('dm-choose-role');
    });

    leaveBtn?.addEventListener('click', () => {
        onLeave();
        showDmStep('dm-choose-role');
    });

    copyOfferBtn?.addEventListener('click', () => {
        const code = localOfferOutput?.value || '';
        if (code) copyToClipboard(code);
    });

    copyAnswerBtn?.addEventListener('click', () => {
        const code = localAnswerOutput?.value || '';
        if (code) copyToClipboard(code);
    });

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
        status.className = 'status-chip status-pending';
        showDmStep('dm-choose-role');
        return;
    }
    if (connected && peers < 1) {
        status.textContent = `Connecting to room "${channel}"...`;
        status.className = 'status-chip status-pending';
        return;
    }
    status.textContent = `Connected to room "${channel}" · peers: ${peers}`;
    status.className = 'status-chip status-success';
    showDmStep('dm-chat-active');
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
