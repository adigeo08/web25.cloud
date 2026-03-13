// @ts-check

export function bindRecoverWallet(onRecover) {
    const openButton = document.getElementById('recover-wallet-btn');
    const modal = document.getElementById('recover-wallet-modal');
    const form = document.getElementById('recover-wallet-form');
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('recover-seed-input'));
    const cancelButton = document.getElementById('recover-wallet-cancel');
    const cancelSecondary = document.getElementById('recover-wallet-cancel-secondary');

    if (!openButton || !modal || !form || !input) return;

    const hideModal = () => {
        modal.classList.add('hidden');
        input.value = '';
    };

    openButton.addEventListener('click', () => {
        modal.classList.remove('hidden');
        input.focus();
    });

    cancelButton?.addEventListener('click', hideModal);
    cancelSecondary?.addEventListener('click', hideModal);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const seedPhrase = input.value.trim();
        if (!seedPhrase) return;

        const recovered = await onRecover(seedPhrase);
        if (recovered) {
            hideModal();
        }
    });
}
