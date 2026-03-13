// @ts-check

export function bindRecoverWallet(onRecover) {
    const button = document.getElementById('recover-wallet-btn');
    if (button) button.addEventListener('click', onRecover);
}
