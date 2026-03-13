// @ts-check

export function bindRegisterWallet(onRegister) {
    const button = document.getElementById('register-wallet-btn');
    if (button) button.addEventListener('click', onRegister);
}
