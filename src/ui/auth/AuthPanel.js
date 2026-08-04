// @ts-check

import { passkeySupported } from '../../auth/SecureKeyStore.js';
import { AUTH_STATUS } from '../../auth/AuthState.js';
import { renderIdentityBadge } from './IdentityBadge.js';
import { getUnlockedPrivateKey } from '../../auth/LocalWalletService.js';
import { getPublicKeyFromPrivateKey } from '../../channels/ecies.js';

export function renderAuthPanel(state) {
    renderIdentityBadge(state);

    const status = document.getElementById('auth-status');
    if (status) {
        status.textContent = `Status: ${state.status}`;
    }

    // Full address + ECIES public key panel (only when unlocked)
    const keysPanel = document.getElementById('identity-keys-panel');
    const fullAddress = document.getElementById('identity-full-address');
    const fullPubkey = document.getElementById('identity-full-pubkey');
    const copyPubkeyBtn = document.getElementById('copy-pubkey-btn');

    const privateKey = getUnlockedPrivateKey();
    const isUnlocked = Boolean(state.localWalletUnlocked && state.address && privateKey);

    if (keysPanel) {
        keysPanel.classList.toggle('hidden', !isUnlocked);
    }

    if (isUnlocked && state.address) {
        let derivedPubKey = '';

        try {
            derivedPubKey = getPublicKeyFromPrivateKey(
                /** @type {string} */ (privateKey)
            );
        } catch (_) {
            derivedPubKey = '';
        }

        if (fullAddress) {
            fullAddress.textContent = state.address;
        }

        if (fullPubkey) {
            fullPubkey.textContent = derivedPubKey;
        }

        if (copyPubkeyBtn && !copyPubkeyBtn.dataset.bound) {
            copyPubkeyBtn.dataset.bound = '1';

            copyPubkeyBtn.addEventListener('click', () => {
                const key = fullPubkey?.textContent || '';

                if (!key) {
                    return;
                }

                const originalText = copyPubkeyBtn.textContent || '📋 Copy';

                navigator.clipboard
                    .writeText(key)
                    .then(() => {
                        copyPubkeyBtn.textContent = '✅ Copied!';

                        setTimeout(() => {
                            copyPubkeyBtn.textContent = originalText;
                        }, 2000);
                    })
                    .catch(() => {
                        // Fallback for browsers without Clipboard API
                        try {
                            const textarea = document.createElement('textarea');

                            textarea.value = key;
                            textarea.style.position = 'fixed';
                            textarea.style.opacity = '0';

                            document.body.appendChild(textarea);

                            textarea.select();
                            document.execCommand('copy');

                            document.body.removeChild(textarea);

                            copyPubkeyBtn.textContent = '✅ Copied!';

                            setTimeout(() => {
                                copyPubkeyBtn.textContent = originalText;
                            }, 2000);
                        } catch (_) {
                            copyPubkeyBtn.textContent = '❌ Failed';

                            setTimeout(() => {
                                copyPubkeyBtn.textContent = originalText;
                            }, 2000);
                        }
                    });
            });
        }
    } else {
        if (fullAddress) {
            fullAddress.textContent = '';
        }

        if (fullPubkey) {
            fullPubkey.textContent = '';
        }
    }

    const passKeyBadge = document.getElementById('passkey-protection-badge');
    if (passKeyBadge) {
        passKeyBadge.classList.toggle(
            'hidden',
            !state.localWalletExists || !passkeySupported()
        );
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

    const lockWalletBtn = document.getElementById('lock-disconnect-auth-btn');
    if (lockWalletBtn) {
        lockWalletBtn.classList.toggle('hidden', !state.localWalletUnlocked);
    }

    const deleteWalletBtn = document.getElementById('delete-local-wallet-btn');
    if (deleteWalletBtn) {
        deleteWalletBtn.classList.toggle('hidden', !state.localWalletExists);
    }

    const migrationPanel = document.getElementById('legacy-migration-panel');
    if (migrationPanel) {
        migrationPanel.classList.toggle(
            'hidden',
            state.status !== AUTH_STATUS.LOCAL_NEEDS_MIGRATION
        );
    }
}