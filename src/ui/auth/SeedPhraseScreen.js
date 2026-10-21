// @ts-check

import { copyToClipboard } from '../ClipboardButton.js';

/**
 * The full-page recovery phrase backup step shown once, right after a wallet
 * is created.
 *
 * The phrase is held here, in this module, only while the screen is open:
 * never in AuthState (whose listeners fan it out across the app) and never in
 * storage. `hideSeedPhrase` drops it from both the DOM and this variable.
 */

/** @type {string|null} */
let currentPhrase = null;

export const RECOVERY_FILE_NAME = 'web25-recovery-phrase.txt';

/** @param {string} phrase */
export function recoveryFileText(phrase) {
    return [
        'web25.cloud — wallet recovery phrase',
        '',
        phrase,
        '',
        'These 12 words are the only way to recover this wallet and its identities.',
        'Anyone holding them controls the identity. Keep this file private and offline.',
        ''
    ].join('\n');
}

function downloadPhrase() {
    if (!currentPhrase) return;
    const blob = new Blob([recoveryFileText(currentPhrase)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = RECOVERY_FILE_NAME;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Wire the backup screen's buttons once.
 * @param {{ onConfirm: () => void, onCopyResult?: (copied: boolean) => void }} handlers
 */
export function bindSeedPhraseScreen({ onConfirm, onCopyResult }) {
    const downloadBtn = document.getElementById('seed-backup-download-btn');
    const copyBtn = document.getElementById('seed-backup-copy-btn');
    const confirmBtn = document.getElementById('seed-backup-confirm-btn');

    if (downloadBtn) downloadBtn.addEventListener('click', () => downloadPhrase());
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            if (!currentPhrase) return;
            copyToClipboard(currentPhrase)
                .then(() => onCopyResult?.(true))
                .catch(() => onCopyResult?.(false));
        });
    }
    if (confirmBtn) confirmBtn.addEventListener('click', () => onConfirm());
}

/** @param {string} seedPhrase */
export function showSeedPhrase(seedPhrase) {
    const list = document.getElementById('seed-backup-words');
    const panel = document.getElementById('seed-backup-screen');
    if (!list || !panel) return;

    currentPhrase = seedPhrase;
    list.textContent = '';
    seedPhrase.split(/\s+/).forEach((word) => {
        const item = document.createElement('li');
        item.textContent = word;
        list.appendChild(item);
    });
    panel.classList.remove('hidden');
}

export function hideSeedPhrase() {
    currentPhrase = null;
    const list = document.getElementById('seed-backup-words');
    if (list) list.textContent = '';
    const panel = document.getElementById('seed-backup-screen');
    if (panel) panel.classList.add('hidden');
}

/** Whether a phrase is on screen right now. */
export function isSeedPhraseShown() {
    return currentPhrase !== null;
}
