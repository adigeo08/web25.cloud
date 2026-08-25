// @ts-check
/**
 * Shared copy-to-clipboard button behaviour.
 *
 * The Clipboard API is unavailable in insecure contexts and older browsers, and
 * `navigator.clipboard` is then `undefined` — reaching for `.writeText` on it
 * throws synchronously, which would skip a `.catch()`-based fallback entirely.
 * So availability is checked first and the whole call is wrapped, leaving the
 * `execCommand` path reachable everywhere.
 */

/**
 * Copy `text`, falling back to a hidden textarea when the Clipboard API is
 * missing or refuses.
 *
 * @param {string} text
 * @returns {Promise<void>} rejects only when no method worked
 */
export async function copyToClipboard(text) {
    const value = `${text ?? ''}`;
    if (!value) throw new Error('Nothing to copy.');

    // `navigator.clipboard` is undefined outside secure contexts, so this is a
    // presence check, not just an error handler.
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch (error) {
            console.warn('Clipboard API failed, falling back to execCommand:', error);
        }
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        // execCommand is deprecated but remains the only fallback available.
        const copied = document.execCommand('copy');
        if (!copied) throw new Error('execCommand("copy") reported failure.');
    } finally {
        document.body.removeChild(textarea);
    }
}

/**
 * Wire a copy button once, flashing the outcome without losing its label.
 *
 * `readValue` is called at click time rather than bind time, so the button
 * always copies whatever the panel currently displays.
 *
 * @param {HTMLElement|null} button may be absent from the current DOM
 * @param {() => string} readValue supplies the text to copy
 * @param {{ idleLabel?: string }} [options]
 */
export function bindCopyButton(button, readValue, { idleLabel = '📋 Copy' } = {}) {
    if (!button || button.dataset.bound) return;
    button.dataset.bound = '1';

    button.addEventListener('click', () => {
        const value = readValue();
        if (!value) return;

        const originalText = button.textContent || idleLabel;
        const flash = (text) => {
            button.textContent = text;
            setTimeout(() => {
                button.textContent = originalText;
            }, 2000);
        };

        copyToClipboard(value)
            .then(() => flash('✅ Copied!'))
            .catch(() => flash('❌ Failed'));
    });
}
