// @ts-check

export function bindUnlockWallet(onUnlock) {
    const button = document.getElementById('unlock-wallet-btn');
    if (button) button.addEventListener('click', onUnlock);
}
