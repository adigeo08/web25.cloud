// @ts-check

import { passkeySupported } from '../../auth/SecureKeyStore.js';
import { AUTH_STATUS } from '../../auth/AuthState.js';
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
            ? `Local wallet: ${state.localWalletUnlocked ? 'unlocked 🔓' : 'locked 🔒'}`
            : 'Local wallet: not registered';
    }

    const passKeyBadge = document.getElementById('passkey-protection-badge');
    if (passKeyBadge) {
        passKeyBadge.classList.toggle('hidden', !state.localWalletExists || !passkeySupported());
    }

    const unsupportedWarn = document.getElementById('passkey-unsupported-warning');
    if (unsupportedWarn) {
        unsupportedWarn.classList.toggle('hidden', passkeySupported());
    }

    const addPasskeyBtn = document.getElementById('add-passkey-btn');
    if (addPasskeyBtn) {
        addPasskeyBtn.classList.toggle('hidden', !state.localWalletUnlocked);
    }

    const sessionIndicator = document.getElementById('biometric-session-indicator');
    if (sessionIndicator) {
        sessionIndicator.classList.toggle('hidden', !state.localWalletUnlocked);
    }

    const lockBtn = document.getElementById('lock-session-btn');
    if (lockBtn) {
        lockBtn.classList.toggle('hidden', !state.localWalletUnlocked);
    }

    const migrationPanel = document.getElementById('legacy-migration-panel');
    if (migrationPanel) {
        migrationPanel.classList.toggle('hidden', state.status !== AUTH_STATUS.LOCAL_NEEDS_MIGRATION);
    }
}
