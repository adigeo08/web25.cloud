// @ts-check

export function renderIdentityBadge(state) {
    const node = document.getElementById('local-wallet-meta');

    if (!node) {
        return;
    }

    if (!state.localWalletExists) {
        node.textContent = 'Local wallet: not registered';
        return;
    }

    node.textContent = state.localWalletUnlocked
        ? 'Local wallet: unlocked'
        : 'Local wallet: locked';
}