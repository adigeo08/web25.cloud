// @ts-check

let hasCopiedSeed = false;

function updateSeedCopyStatus(message) {
    const status = document.getElementById('seed-copy-status');
    if (status) {
        status.textContent = message;
    }
}

export function showSeedPhrase(seedPhrase) {
    const box = document.getElementById('seed-phrase-box');
    const panel = document.getElementById('seed-phrase-screen');
    if (!box || !panel) return;

    hasCopiedSeed = false;
    updateSeedCopyStatus('Copy the seed phrase before closing this panel.');
    box.textContent = seedPhrase;
    panel.classList.remove('hidden');
}

export function hideSeedPhrase() {
    const panel = document.getElementById('seed-phrase-screen');
    if (panel) panel.classList.add('hidden');
}

export function bindSeedPhraseActions({ toast, onAllowClose }) {
    const copyBtn = document.getElementById('copy-seed-btn');
    const closeBtn = document.getElementById('close-seed-screen-btn');
    const box = document.getElementById('seed-phrase-box');

    copyBtn?.addEventListener('click', async () => {
        const seedPhrase = box?.textContent?.trim();
        if (!seedPhrase) return;

        try {
            await navigator.clipboard.writeText(seedPhrase);
            hasCopiedSeed = true;
            updateSeedCopyStatus('Seed phrase copied. You can now close this panel.');
            toast.success('Seed phrase copied to clipboard.', 'Copied');
        } catch (error) {
            toast.error('Clipboard copy failed. Copy manually before continuing.', 'Copy failed');
        }
    });

    closeBtn?.addEventListener('click', () => {
        if (!hasCopiedSeed) {
            toast.error('Copy the seed phrase to clipboard before closing.', 'Action required');
            return;
        }
        onAllowClose();
    });
}
