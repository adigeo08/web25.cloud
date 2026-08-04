// @ts-check

export function renderIdentityBadge(state) {
    const statusNode = document.getElementById('local-wallet-meta');

    if (!statusNode) return;

    if (state.localWalletUnlocked) {
        statusNode.textContent = 'Local wallet: unlocked';
        return;
    }

    if (state.localWalletExists) {
        statusNode.textContent = 'Local wallet: locked';
        return;
    }

    statusNode.textContent = 'Local wallet: not registered';
}