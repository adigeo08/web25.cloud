// @ts-check

export function bindConnectWallet(onConnect) {
    const button = document.getElementById('connect-wallet-btn');
    if (button) button.addEventListener('click', onConnect);
}
