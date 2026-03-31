// @ts-check

export function bindRegisterWallet(onRegister) {
    const openButton = document.getElementById('register-wallet-btn');
    const modal = document.getElementById('register-wallet-modal');
    const form = document.getElementById('register-wallet-form');
    const consent = /** @type {HTMLInputElement | null} */ (document.getElementById('register-policy-consent'));
    const submitBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('register-wallet-confirm'));
    const cancelButton = document.getElementById('register-wallet-cancel');
    const cancelSecondary = document.getElementById('register-wallet-cancel-secondary');

    if (!openButton || !modal || !form || !consent || !submitBtn) return;

    const hideModal = () => {
        modal.classList.add('hidden');
        consent.checked = false;
        submitBtn.disabled = true;
    };

    openButton.addEventListener('click', () => {
        modal.classList.remove('hidden');
    });

    consent.addEventListener('change', () => {
        submitBtn.disabled = !consent.checked;
    });

    cancelButton?.addEventListener('click', hideModal);
    cancelSecondary?.addEventListener('click', hideModal);

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!consent.checked) return;
        await onRegister();
        hideModal();
    });
}
