// @ts-check
/**
 * The WebLLM tab: the install screen, then the chat.
 *
 * Renders `WebLLMController` state and forwards clicks to it — no logic of its
 * own beyond what is on screen. The chat borrows the Direct Messenger's window,
 * bubbles and composer classes; none of its code runs here.
 *
 * Model output is untrusted text: it is always written with `textContent` and
 * never interpreted as markup. Code fences, inline code, bold and headings are
 * drawn as elements by replyFormat.js, which builds them from text alone.
 */

import { describeProgress } from '../../webllm/webllmProgress.js';
import { codeForCopyButton, renderReply } from './replyFormat.js';
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
 * @typedef {{ isLast: boolean, generating: boolean, lookup: string|null }} BubbleContext
 */

/**
 * @param {import('../../webllm/WebLLMController.js').ChatMessage} message
 * @param {BubbleContext} context
 */
function createBubble(message, context) {
    const item = document.createElement('div');
    item.dataset.messageId = `${message.id}`;
    const body = document.createElement('div');
    body.className = 'channels-message-body';
    item.appendChild(body);
    updateBubble(item, message, context);
    return item;
}

/**
 * A small block under a bubble's text, created on demand and removed when empty.
 * @param {any} item
 * @param {string} className
 * @param {boolean} wanted
 */
function slot(item, className, wanted) {
    let el = item.querySelector(`.${className}`);
    if (!wanted) {
        el?.remove();
        return null;
    }
    if (!el) {
        el = document.createElement('div');
        el.className = className;
        item.appendChild(el);
    }
    el.textContent = '';
    return el;
}

/**
 * @param {any} item
 * @param {import('../../webllm/WebLLMController.js').ChatMessage} message
 * @param {BubbleContext} context
 */
function updateBubble(item, message, context) {
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
        dots.setAttribute(
            'aria-label',
            context.lookup === 'searching' ? 'Checking MDN documentation' : 'Llama is thinking'
        );
        for (let i = 0; i < 3; i += 1) dots.appendChild(document.createElement('span'));
        body.appendChild(dots);
        if (context.lookup === 'searching') {
            const label = document.createElement('span');
            label.className = 'webllm-lookup-label';
            label.textContent = 'Checking MDN…';
            body.appendChild(label);
        }
    } else {
        renderReply(body, message.content);
    }

    // How the question was taken: a short answer, or a plan written in steps.
    const mode = message.role === 'assistant' && !message.error ? modeLabel(message) : '';
    const modeEl = slot(item, 'webllm-mode', Boolean(mode));
    if (modeEl) {
        modeEl.dataset.mode = `${message.mode}`;
        modeEl.textContent = mode;
    }

    // Where the documentation came from: MDN pages only, opened outside the app.
    const sources = Array.isArray(message.sources) ? message.sources.filter((entry) => isMdnLink(entry?.url)) : [];
    const sourcesEl = slot(item, 'webllm-sources', sources.length > 0 && !message.pending);
    if (sourcesEl) {
        sourcesEl.append('Source: ');
        sources.forEach((source, index) => {
            if (index > 0) sourcesEl.append(', ');
            const link = document.createElement('a');
            link.href = source.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = `MDN — ${source.title}`;
            sourcesEl.appendChild(link);
        });
    }

    const note = message.error || message.notice || (message.stopped ? 'Stopped.' : '') || message.lookupNote || '';
    const noteEl = slot(item, 'webllm-message-note', Boolean(note) && !message.pending);
    if (noteEl) noteEl.textContent = note;

    // A reply cut at the length limit: one click picks it up where it stopped.
    const offer = message.role === 'assistant' && message.continuable && context.isLast && !message.pending;
    const continueEl = slot(item, 'webllm-continue', offer);
    if (continueEl) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'webllm-continue-btn';
        button.dataset.continue = `${message.id}`;
        button.textContent = 'Continue →';
        button.setAttribute('aria-label', 'Continue this reply');
        button.disabled = context.generating;
        continueEl.appendChild(button);
    }
}

/** @param {import('../../webllm/WebLLMController.js').ChatMessage} message */
function modeLabel(message) {
    if (message.mode === 'informative') return 'Informative · short answer';
    if (message.mode === 'productive') {
        return message.steps > 1 ? `Productive · ${message.steps} steps` : 'Productive';
    }
    return '';
}

/**
 * The status line while a reply is written: which step of the sequence.
 * @param {any} state
 */
export function thinkingLabel(state) {
    const thinking = state.thinking;
    const lookup = state.lookup === 'searching';
    if (!thinking) return lookup ? 'Checking MDN…' : 'Generating…';
    if (thinking.mode === 'informative') return lookup ? 'Short answer · checking MDN…' : 'Short answer · writing…';
    if (thinking.phase === 'planning') return 'Planning the steps…';
    const step = thinking.total > 1 ? `Step ${thinking.step}/${thinking.total}` : 'Writing code';
    return lookup ? `${step} · checking MDN…` : `${step} · writing…`;
}

/** Only links to MDN docs pages are ever rendered. */
function isMdnLink(url) {
    try {
        const parsed = new URL(url);
        return parsed.origin === 'https://developer.mozilla.org' && /^\/[a-zA-Z-]+\/docs\//.test(parsed.pathname);
    } catch (_) {
        return false;
    }
}

/** "5 min ago", "Yesterday", "3 Oct" — when a conversation was last used. */
export function relativeTime(timestamp, now = Date.now()) {
    const minutes = Math.floor((now - timestamp) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    if (hours < 48) return 'Yesterday';
    return new Date(timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function renderEmptyThread(list) {
    const empty = document.createElement('div');
    empty.className = 'webllm-empty';
    const title = document.createElement('p');
    title.className = 'webllm-empty-title';
    title.textContent = 'Llama is ready';
    const sub = document.createElement('p');
    sub.className = 'webllm-empty-sub';
    sub.textContent =
        'Ask about JavaScript, HTML, CSS, Web APIs or anything else. Replies are generated on this device.';
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
    const layout = byId('webllm-layout');
    const sidebarToggle = byId('webllm-sidebar-toggle');
    /** On a phone the conversation list is a drawer over the chat. */
    function setSidebarOpen(open) {
        layout?.classList.toggle('is-sidebar-open', open);
        sidebarToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    sidebarToggle?.addEventListener('click', () => setSidebarOpen(!layout?.classList.contains('is-sidebar-open')));

    byId('webllm-new-chat-btn')?.addEventListener('click', () => {
        controller.newChat();
        setSidebarOpen(false);
        input?.focus();
    });
    byId('webllm-delete-btn')?.addEventListener('click', () => {
        const ok = confirm(
            'Delete this conversation? Its messages are removed from this browser. The downloaded model is not affected.'
        );
        if (ok) void controller.deleteConversation();
    });

    byId('webllm-conversations')?.addEventListener('click', (event) => {
        const button = /** @type {any} */ (event.target)?.closest?.('[data-conversation-id]');
        if (!button) return;
        void controller.openConversation(button.dataset.conversationId);
        setSidebarOpen(false);
    });

    messages?.addEventListener('click', (event) => {
        const copy = /** @type {any} */ (event.target)?.closest?.('[data-copy-code]');
        if (copy) {
            void copyCode(copy);
            return;
        }
        const button = /** @type {any} */ (event.target)?.closest?.('[data-continue]');
        if (!button || button.disabled) return;
        void controller.continueReply(button.dataset.continue);
    });

    const settings = /** @type {any} */ (byId('webllm-settings'));
    const retention = /** @type {any} */ (byId('webllm-retention'));
    const mdnToggle = /** @type {any} */ (byId('webllm-mdn-toggle'));
    byId('webllm-settings-btn')?.addEventListener('click', () => {
        if (typeof settings?.showModal === 'function') settings.showModal();
        else settings?.setAttribute('open', '');
    });
    retention?.addEventListener('change', () => void controller.setRetention(retention.value));
    mdnToggle?.addEventListener('change', () => void controller.setMdnEnabled(mdnToggle.checked));

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
        renderConversations(state);
        renderSettings(state);
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

        const device = byId('webllm-device');
        if (device) device.textContent = deviceLine(state);

        const chip = byId('webllm-chat-status');
        if (chip) {
            // Only when the dev-only profile override is in use: which one.
            const profile = controller.profile?.overridden ? ` · ${controller.profile.id} profile (dev)` : '';
            chip.textContent =
                (state.generating || state.lookup === 'searching'
                    ? thinkingLabel(state)
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
     * Where streamed text goes: the reply's bubble and the text it already
     * shows, so a flush with nothing new does nothing. Reset whenever the
     * thread is rebuilt.
     * @type {{ id: string, item: any, shown: string } | null}
     */
    let stream = null;

    function renderConversations(state) {
        const list = byId('webllm-conversations');
        if (!list) return;
        list.textContent = '';
        for (const conversation of state.conversations) {
            const row = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'webllm-conversation';
            button.dataset.conversationId = conversation.id;
            const active = conversation.id === state.activeConversationId;
            if (active) button.setAttribute('aria-current', 'true');
            const title = document.createElement('span');
            title.className = 'webllm-conversation-title';
            title.textContent = conversation.title;
            const time = document.createElement('span');
            time.className = 'webllm-conversation-time';
            time.textContent = relativeTime(conversation.updatedAt);
            button.append(title, time);
            row.appendChild(button);
            list.appendChild(row);
        }
        const count = byId('webllm-conversation-count');
        if (count) count.textContent = `${state.conversations.length}`;
        setHidden(byId('webllm-conversations-empty'), state.conversations.length > 0);

        const note = byId('webllm-history-note');
        if (note) {
            note.textContent =
                state.history === 'unavailable'
                    ? 'Conversations can’t be saved in this browser; they last until you lock your wallet.'
                    : state.history === 'off'
                      ? 'Conversations are not saved in this session.'
                      : 'Saved only in this browser, for this wallet.';
        }
    }

    function renderSettings(state) {
        if (retention) retention.value = state.settings.retention;
        if (mdnToggle) mdnToggle.checked = Boolean(state.settings.mdnEnabled);
    }

    function renderMessages(state) {
        if (!messages) return;
        stream = null;
        const follow = isNearBottom(messages);
        messages.textContent = '';
        if (state.messages.length === 0) {
            renderEmptyThread(messages);
        } else {
            const last = state.messages.length - 1;
            state.messages.forEach((message, index) =>
                messages.appendChild(
                    createBubble(message, {
                        isLast: index === last,
                        generating: state.generating,
                        lookup: state.lookup
                    })
                )
            );
        }
        if (follow) scrollToBottom(messages);
        setHidden(scrollBtn, isNearBottom(messages));
    }

    /**
     * Draw the latest text of a streaming reply: one layout read, one redraw
     * of the reply's body, and one scroll.
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
            stream = { id: messageId, item, shown: '' };
        }
        const content = message.content;
        if (content === stream.shown) return;

        const follow = isNearBottom(messages);
        const body = stream.item.firstElementChild;
        // Redrawn whole, so a code fence that has just opened or closed is
        // drawn as one; the batcher keeps this to one redraw per frame.
        renderReply(body, content);
        stream.shown = content;

        if (follow) scrollToBottom(messages);
        else setHidden(scrollBtn, false);
    }

    function renderComposer(state) {
        const ready = state.status === 'ready';
        if (input) {
            input.disabled = !ready;
            input.placeholder = state.generating
                ? 'Llama is replying…'
                : 'Ask about JavaScript, HTML, CSS or anything else…';
        }
        const send = /** @type {any} */ (byId('webllm-send-btn'));
        if (send) send.disabled = !ready || state.generating;
        setHidden(send, state.generating);
        setHidden(byId('webllm-stop-btn'), !state.generating);
        const newChat = /** @type {any} */ (byId('webllm-new-chat-btn'));
        if (newChat) newChat.disabled = state.messages.length === 0 && !state.activeConversationId;
        const remove = /** @type {any} */ (byId('webllm-delete-btn'));
        if (remove) remove.disabled = state.messages.length === 0 && !state.activeConversationId;
    }

    return render;
}

/**
 * Copy a code block's text, and say so on the button for a moment.
 * @param {any} button
 */
async function copyCode(button) {
    const text = codeForCopyButton(button);
    let copied = false;
    try {
        await navigator.clipboard.writeText(text);
        copied = true;
    } catch (_) {
        copied = false;
    }
    button.textContent = copied ? 'Copied' : 'Copy failed';
    setTimeout(() => {
        button.textContent = 'Copy';
    }, 1500);
}

/** Grow the textarea with its content, up to the CSS max-height. */
function autosize(input) {
    if (!input?.style) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
}
