// @ts-check

import { passkeySupported } from '../../auth/SecureKeyStore.js';
import { renderIdentityBadge } from './IdentityBadge.js';

export function renderAuthPanel(state) {
    renderIdentityBadge(state);

    const profileCard = document.getElementById('identity-profile-card');
    if (profileCard) {
        profileCard.classList.toggle('hidden', !state.localWalletExists);
    }

    const lockWalletBtn = document.getElementById('lock-disconnect-auth-btn');
    if (lockWalletBtn) {
        lockWalletBtn.classList.toggle('hidden', !state.localWalletUnlocked);
    }

    const deleteWalletBtn = document.getElementById('delete-local-wallet-btn');
    if (deleteWalletBtn) {
        deleteWalletBtn.classList.toggle('hidden', !state.localWalletExists);
    }

    const addPasskeyBtn = document.getElementById('add-passkey-btn');
    if (addPasskeyBtn) {
        const canAddPasskey = state.localWalletUnlocked && passkeySupported();
        addPasskeyBtn.classList.toggle('hidden', !canAddPasskey);
    }
}