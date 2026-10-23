// @ts-check
/**
 * The WebLLM tab: the install screen, then the chat.
 *
 * Renders `WebLLMController` state and forwards clicks to it — no logic of its
 * own beyond what is on screen. The chat borrows the Direct Messenger's window,
 * bubbles and composer classes; none of its code runs here.
 *
 * Model output is untrusted text: it is always written with `textContent` and
 * never interpreted as markup.
 */

import { describeProgress } from '../../webllm/webllmProgress.js';
import { createStreamBatcher } from './streamBatcher.js';

const STEP_ORDER = ['download', 'cache', 'shaders'];

/** How close to the bottom still counts as "following the reply". */
const FOLLOW_THRESHOLD_PX = 80;

/** @param {string} id */
const byId = (id) => document.getElementById(id);

/**
 * @param {Element|null} el
 * @param {boolean} hidden
 */
function setHidden(el, hidden) {
    el?.classList.toggle('hidden', hidden);
}

function isNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

function scrollToBottom(el) {
    if (el) el.scrollTop = el.scrollHeight;
}

/**
 * @param {import('../../webllm/WebLLMController.js').ChatMessage} message
 */
function createBubble(message) {
    const item = document.createElement('div');
    item.dataset.messageId = `${message.id}`;
    const body = document.createElement('div');
    body.className = 'channels-message-body';
    item.appendChild(body);
    updateBubble(item, message);
    return item;
}

/**
 * @param {any} item
 * @param {import('../../webllm/WebLLMController.js').ChatMessage} message
 */
function updateBubble(item, message) {
    const typing = message.pending && !message.content;
    item.className = [
        'channels-message',
        'webllm-message',
        message.role === 'user' ? 'is-own' : 'is-assistant',
        message.pending ? 'is-streaming' : '',
        message.error ? 'is-error' : '',
        message.finishReason === 'loop' ? 'is-looped' : ''
    ]
        .filter(Boolean)
        .join(' ');
    item.setAttribute('aria-busy', message.pending ? 'true' : 'false');

    const body = item.firstElementChild;
    if (typing) {
        body.textContent = '';
        const dots = document.createElement('span');
        dots.className = 'webllm-typing';
        dots.setAttribute('aria-label', 'Llama is thinking');
        for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement('span'));
        body.appendChild(dots);
    } else {
        body.textContent = message.content;
    }

    const note = message.error || message.notice || (message.stopped ? 'Stopped.' : '');
    let noteEl = item.querySelector('.webllm-message-note');
    if (note) {
        if (!noteEl) {
            noteEl = document.createElement('div');
            noteEl.className = 'webllm-message-note';
            item.appendChild(noteEl);
        }
        noteEl.textContent = note;
    } else {
        noteEl?.remove();
    }
}

function renderEmptyThread(list) {
    const empty = document.createElement('div');
    empty.className = 'webllm-empty';
    const title = document.createElement('p');
    title.className = 'webllm-empty-title';
    title.textContent = 'Llama is ready';
    const sub = document.createElement('p');
    sub.className = 'webllm-empty-sub';
    sub.textContent = 'Ask anything. Replies are generated on this device and never leave your browser.';
    empty.appendChild(title);
    empty.appendChild(sub);
    list.appendChild(empty);
}

/**
 * Bind the tab's controls to a controller and return the renderer.
 *
 * @param {import('../../webllm/WebLLMController.js').WebLLMController} controller
 * @param {{ confirm?: (message: string) => boolean }} [options]
 */
export function bindWebLLMPanel(controller, { confirm = (message) => window.confirm(message) } = {}) {
    const installBtn = byId('webllm-install-btn');
    const composer = byId('webllm-composer');
    const input = /** @type {HTMLTextAreaElement|null} */ (byId('webllm-input'));
    const messages = byId('webllm-messages');
    const scrollBtn = byId('webllm-scroll-bottom');

    installBtn?.addEventListener('click', () => {
        if (controller.state.status === 'error') void controller.retry();
        else void controller.install();
    });

    composer?.addEventListener('submit', (event) => {
        event.preventDefault?.();
        sendFromInput();
    });

    input?.addEventListener('keydown', (event) => {
        // Enter sends, Shift+Enter is a new line; an IME composition is left alone.
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault?.();
            sendFromInput();
        }
    });
    input?.addEventListener('input', () => autosize(input));

    byId('webllm-stop-btn')?.addEventListener('click', () => controller.stop());
    byId('webllm-new-chat-btn')?.addEventListener('click', () => {
        controller.newChat();
        input?.focus();
    });
    byId('webllm-remove-btn')?.addEventListener('click', () => {
        const ok = confirm(
            'Remove Llama 3.2 1B from this browser? The downloaded model files (about 800 MB) are deleted and the next chat needs a new download.'
        );
        if (ok) void controller.removeModel();
    });

    document.querySelectorAll('[data-webllm-remove-legacy]').forEach((button) =>
        button.addEventListener('click', () => {
            const ok = confirm(
                'Remove the earlier version of Llama 3.2 1B from this browser? The model you use now is not affected.'
            );
            if (ok) void controller.removeLegacyModels();
        })
    );

    messages?.addEventListener('scroll', () => setHidden(scrollBtn, isNearBottom(messages)));
    scrollBtn?.addEventListener('click', () => {
        scrollToBottom(messages);
        setHidden(scrollBtn, true);
    });

    function sendFromInput() {
        if (!input) return;
        const text = input.value;
        if (!text.trim() || controller.state.generating) return;
        input.value = '';
        autosize(input);
        void controller.send(text);
    }

    let lastStatus = '';

    /**
     * @param {any} state
     * @param {{ type: string, messageId?: number }} [change]
     */
    // Streamed text is drawn in batches (see streamBatcher.js); a delta only
    // marks its message as changed. The flush reads the controller's state, so
    // whatever arrived in between is all drawn.
    const batcher = createStreamBatcher({ flush: (messageId) => renderDelta(controller.state, messageId) });

    function render(state, change = { type: 'state' }) {
        if (change.type === 'delta') {
            batcher.schedule(change.messageId);
            return;
        }
        if (change.type === 'progress') {
            renderProgress(state);
            return;
        }
        // Every other change (finished, stopped, failed, New chat, lock) redraws
        // the thread from state, final text included: a pending batch is moot.
        batcher.cancel();
        renderScreen(state);
        renderMessages(state);
        renderComposer(state);
        if (state.status === 'ready' && lastStatus !== 'ready') input?.focus();
        lastStatus = state.status;
    }

    function renderScreen(state) {
        const chat = state.status === 'ready';
        setHidden(byId('webllm-install'), chat);
        setHidden(byId('webllm-chat'), !chat);

        const busy = state.status === 'installing' || state.status === 'checking' || state.status === 'idle';
        setHidden(byId('webllm-progress'), state.status !== 'installing');
        if (state.status === 'installing') renderProgress(state);

        const error = byId('webllm-error');
        const showError = (state.status === 'error' || state.status === 'unsupported') && state.error;
        if (error) error.textContent = showError ? state.error.message : '';
        setHidden(error, !showError);

        if (installBtn) {
            installBtn.textContent = state.status === 'error' ? 'Retry' : 'Install Llama 3.2 1B';
            /** @type {any} */ (installBtn).disabled =
                busy || state.status === 'unsupported' || state.status === 'locked';
            installBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
            setHidden(installBtn, state.status === 'installing');
        }

        // The earlier build: offered for removal, never while an install is writing to the same caches.
        const legacyBytes = Number(state.cache?.legacyBytes) || 0;
        const showLegacy = legacyBytes > 0 && state.status !== 'locked' && state.status !== 'installing';
        setHidden(byId('webllm-legacy'), !showLegacy || chat);
        setHidden(byId('webllm-legacy-chat'), !showLegacy || !chat);
        const megabytes = Math.round(legacyBytes / (1024 * 1024));
        document.querySelectorAll('.webllm-legacy-size').forEach((el) => {
            el.textContent = megabytes >= 1 ? ` (about ${megabytes} MB)` : '';
        });

        const device = byId('webllm-device');
        if (device) device.textContent = deviceLine(state);

        const chip = byId('webllm-chat-status');
        if (chip) {
            // Only when the dev-only profile override is in use: which one.
            const profile = controller.profile?.overridden ? ` · ${controller.profile.id} profile (dev)` : '';
            chip.textContent =
                (state.generating
                    ? 'Generating…'
                    : state.engineKind === 'page'
                      ? 'Running on this device · main thread'
                      : 'Running on this device') + profile;
            chip.className = `status-chip ${state.generating ? 'status-pending' : 'status-success'}`;
        }
    }

    function deviceLine(state) {
        switch (state.status) {
            case 'checking':
                return 'Checking your device for WebGPU support…';
            case 'unsupported':
                return 'This device cannot run Llama in the browser.';
            case 'installing':
                if (state.waitingForOtherTab) {
                    return 'Another WEB25 tab is downloading Llama. This tab continues when it finishes.';
                }
                return state.fromCache
                    ? 'Loading Llama from this browser’s cache…'
                    : 'Installing — keep this tab open.';
            case 'not-installed':
            case 'error': {
                if (state.cache?.state === 'partial' && state.cache.percent > 0) {
                    return `${state.cache.percent}% already downloaded — installing resumes from there.`;
                }
                if (state.gpu?.supported) {
                    const gpu = [state.gpu.vendor, state.gpu.description].filter(Boolean).join(' · ');
                    return gpu ? `WebGPU ready · ${gpu}` : 'WebGPU ready on this device.';
                }
                return '';
            }
            default:
                return '';
        }
    }

    function renderProgress(state) {
        const progress = state.progress;
        if (!progress) return;
        const label = byId('webllm-progress-label');
        const percent = byId('webllm-progress-percent');
        const bar = byId('webllm-progress-bar');
        const track = byId('webllm-progress-track');

        let text = describeProgress(progress);
        if (state.waitingForOtherTab) text = 'Waiting for another tab…';
        else if (progress.phase === 'init' && progress.percent === 0) {
            text = state.fromCache ? 'Starting the engine…' : 'Preparing the download…';
        }
        if (label) label.textContent = text;
        if (percent) percent.textContent = `${progress.percent}%`;
        if (bar) bar.style.width = `${progress.percent}%`;
        track?.setAttribute('aria-valuenow', `${progress.percent}`);

        const current = STEP_ORDER.indexOf(progress.phase);
        document.querySelectorAll('.webllm-steps li').forEach((step) => {
            const index = STEP_ORDER.indexOf(step.getAttribute('data-step') || '');
            let stepState = 'todo';
            if (progress.phase === 'done' || (current >= 0 && index < current)) stepState = 'done';
            else if (index === current) stepState = 'active';
            // Weights already in the cache were never downloaded.
            if (index === 0 && state.fromCache && current > 0) stepState = 'skipped';
            step.setAttribute('data-state', stepState);
        });
    }

    /**
     * Where streamed text goes: the reply's text node and how much of the reply
     * it already shows, so a flush appends only what is new. Reset whenever the
     * thread is rebuilt.
     * @type {{ id: number, item: any, text: Text|null, shown: string } | null}
     */
    let stream = null;

    function renderMessages(state) {
        if (!messages) return;
        stream = null;
        const follow = isNearBottom(messages);
        messages.textContent = '';
        if (state.messages.length === 0) {
            renderEmptyThread(messages);
        } else {
            state.messages.forEach((message) => messages.appendChild(createBubble(message)));
        }
        if (follow) scrollToBottom(messages);
        setHidden(scrollBtn, isNearBottom(messages));
    }

    /**
     * Draw the latest text of a streaming reply: one layout read, one text
     * write — appending only what is new — and one scroll.
     */
    function renderDelta(state, messageId) {
        if (!messages) return;
        let message = null;
        for (let i = state.messages.length - 1; i >= 0; i -= 1) {
            if (state.messages[i].id === messageId) {
                message = state.messages[i];
                break;
            }
        }
        if (!message) return;
        if (stream?.id !== messageId) {
            const item = messages.querySelector(`[data-message-id="${messageId}"]`);
            if (!item) return renderMessages(state);
            stream = { id: messageId, item, text: null, shown: '' };
        }
        const content = message.content;
        if (content === stream.shown) return;

        const follow = isNearBottom(messages);
        const body = stream.item.firstElementChild;
        if (!stream.text) {
            // The first text replaces the typing dots.
            body.textContent = '';
            stream.text = document.createTextNode('');
            body.appendChild(stream.text);
        }
        if (content.startsWith(stream.shown)) stream.text.appendData(content.slice(stream.shown.length));
        else stream.text.data = content;
        stream.shown = content;

        if (follow) scrollToBottom(messages);
        else setHidden(scrollBtn, false);
    }

    function renderComposer(state) {
        const ready = state.status === 'ready';
        if (input) {
            input.disabled = !ready;
            input.placeholder = state.generating ? 'Llama is replying…' : 'Message Llama…';
        }
        const send = /** @type {any} */ (byId('webllm-send-btn'));
        if (send) send.disabled = !ready || state.generating;
        setHidden(send, state.generating);
        setHidden(byId('webllm-stop-btn'), !state.generating);
        const newChat = /** @type {any} */ (byId('webllm-new-chat-btn'));
        if (newChat) newChat.disabled = state.messages.length === 0 && !state.generating;
    }

    return render;
}

/** Grow the textarea with its content, up to the CSS max-height. */
function autosize(input) {
    if (!input?.style) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}
