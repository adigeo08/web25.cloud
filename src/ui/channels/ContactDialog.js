// @ts-check
/**
 * The messenger's own small dialog, for the two questions contacts ask: "what
 * should this person be called?" and "are you sure?".
 *
 * `window.prompt` and `window.confirm` used to ask them. Many in-app browsers
 * and webviews — the ones a link shared in a chat app opens in — suppress both,
 * and a suppressed prompt returns `null`, which reads exactly like Cancel: the
 * person pressed Save contact and nothing happened. A native `<dialog>` cannot
 * be suppressed, carries the peer's address so you can see who you are naming,
 * and is a bottom sheet on a phone like the rest of the panel.
 *
 * Where there is no dialog element to use (an old browser, a test without the
 * markup) the platform prompt is still the fallback, so the question is always
 * asked one way or the other.
 */

import { paintAvatar } from './Avatar.js';

const MAX_NAME_LENGTH = 64;

/** @returns {HTMLDialogElement|null} */
function dialogElement() {
    const element = typeof document !== 'undefined' ? document.getElementById('dm-prompt-dialog') : null;
    return element && typeof (/** @type {any} */ (element).showModal) === 'function'
        ? /** @type {HTMLDialogElement} */ (element)
        : null;
}

/**
 * @param {string} id
 * @param {string} text
 */
function setText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
}

/**
 * Open the dialog and settle with what the person chose.
 *
 * @param {{ title: string, subtitle?: string, body?: string, avatar?: string, confirmLabel: string,
 *           tone?: 'primary'|'danger', withName?: boolean, name?: string }} content
 * @returns {Promise<{ confirmed: boolean, name: string }>}
 */
function ask(content) {
    const dialog = /** @type {HTMLDialogElement} */ (dialogElement());
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById('dm-prompt-input'));
    const confirm = document.getElementById('dm-prompt-confirm');

    setText('dm-prompt-title', content.title);
    setText('dm-prompt-subtitle', content.subtitle || '');
    setText('dm-prompt-body', content.body || '');
    document.getElementById('dm-prompt-body')?.classList.toggle('hidden', !content.body);
    paintAvatar(document.getElementById('dm-prompt-avatar'), content.avatar || content.title);
    document.getElementById('dm-prompt-field')?.classList.toggle('hidden', !content.withName);
    if (input) input.value = content.withName ? `${content.name || ''}`.slice(0, MAX_NAME_LENGTH) : '';
    if (confirm) {
        confirm.textContent = content.confirmLabel;
        confirm.className = `btn ${content.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`;
    }

    // One question at a time: an earlier one still open is answered "no".
    if (dialog.open) dialog.close();
    // `returnValue` survives from the previous close; Escape leaves it alone.
    dialog.returnValue = '';
    return new Promise((resolve) => {
        dialog.addEventListener(
            'close',
            () => resolve({ confirmed: dialog.returnValue === 'confirm', name: input?.value || '' }),
            { once: true }
        );
        dialog.showModal();
        if (content.withName && input) {
            input.focus();
            input.select();
        }
    });
}

/**
 * Ask for a contact's name.
 *
 * @param {{ title: string, npub?: string, name?: string, note?: string, confirmLabel?: string }} options
 * @returns {Promise<string|null>} the name, or null if the person cancelled
 */
export async function askContactName({ title, npub = '', name = '', note = '', confirmLabel = 'Save' }) {
    if (!dialogElement()) {
        const answer = typeof window !== 'undefined' && window.prompt ? window.prompt(`${title}:`, name) : null;
        return answer === null || answer === undefined ? null : `${answer}`;
    }
    const result = await ask({
        title,
        subtitle: npub,
        body: note,
        avatar: name || npub,
        confirmLabel,
        withName: true,
        name
    });
    return result.confirmed ? result.name.trim() : null;
}

/**
 * Ask before something that changes who can reach you.
 *
 * @param {{ title: string, body?: string, subtitle?: string, avatar?: string, confirmLabel: string,
 *           tone?: 'primary'|'danger' }} options
 * @returns {Promise<boolean>}
 */
export async function askConfirm({ title, body = '', subtitle = '', avatar = '', confirmLabel, tone = 'primary' }) {
    if (!dialogElement()) {
        return typeof window !== 'undefined' && window.confirm ? window.confirm(`${title}\n\n${body}`) : false;
    }
    const result = await ask({ title, subtitle, body, avatar: avatar || title, confirmLabel, tone });
    return result.confirmed;
}
