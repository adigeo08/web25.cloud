// @ts-check

import { renderIdentityBadge } from './IdentityBadge.js';

export function renderAuthPanel(state) {
    renderIdentityBadge(state);

    const status = document.getElementById('auth-status');
    if (status) {
        status.textContent = `Status: ${state.status}`;
    }

    const localMeta = document.getElementById('local-wallet-meta');
    if (localMeta) {
        localMeta.textContent = state.localWalletExists
            ? `Local wallet: ${state.localWalletUnlocked ? 'unlocked' : 'locked'}`
            : 'Local wallet: not registered';
    }
}
