// @ts-check

import { passkeySupported } from '../../auth/SecureKeyStore.js';
import { AUTH_STATUS } from '../../auth/AuthState.js';
import { renderIdentityBadge } from './IdentityBadge.js';

/**
 * Copy-to-clipboard with a Clipboard-API-free fallback, bound once per button.
 * @param {HTMLElement|null} button
 * @param {() => string} readValue
 */
function bindCopyButton(button, readValue) {
    if (!button || button.dataset.bound) return;
    button.dataset.bound = '1';

    button.addEventListener('click', () => {
        const value = readValue();
        if (!value) return;

        const originalText = button.textContent || '📋 Copy';
        const done = (text) => {
            button.textContent = text;
            setTimeout(() => {
                button.textContent = originalText;
            }, 2000);
        };

        navigator.clipboard
            .writeText(value)
            .then(() => done('✅ Copied!'))
            .catch(() => {
                try {
                    const textarea = document.createElement('textarea');
                    textarea.value = value;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                    done('✅ Copied!');
                } catch (_) {
                    done('❌ Failed');
                }
            });
    });
}

/**
 * Render the Nostr section of the keys panel.
 *
 * The Nostr identity is a view of the same wallet key, so "add" and "delete"
 * control reachability — whether this identity is derived, shown and subscribed
 * on the relays — not the existence of a key.
 *
 * @param {{ npub: string|null, nostrPublicKey: string|null, nostrEnabled: boolean, unlocked: boolean }} params
 */
function renderNostrIdentitySection({ npub, nostrPublicKey, nostrEnabled, unlocked }) {
    const present = document.getElementById('identity-nostr-present');
    const absent = document.getElementById('identity-nostr-absent');
    const npubValue = document.getElementById('identity-full-npub');
    const pubkeyValue = document.getElementById('identity-full-nostr-pubkey');
    const addBtn = document.getElementById('add-nostr-identity-btn');
    const deleteBtn = document.getElementById('delete-nostr-identity-btn');

    const hasIdentity = Boolean(unlocked && nostrEnabled && npub);

    if (present) present.classList.toggle('hidden', !hasIdentity);
    if (absent) absent.classList.toggle('hidden', hasIdentity || !unlocked);
    if (npubValue) npubValue.textContent = hasIdentity ? `${npub}` : '';
    if (pubkeyValue) pubkeyValue.textContent = hasIdentity ? `${nostrPublicKey || ''}` : '';

    // Only the applicable action is offered, so the section never shows a
    // button that would be a no-op.
    if (addBtn) addBtn.classList.toggle('hidden', !unlocked || nostrEnabled);
    if (deleteBtn) deleteBtn.classList.toggle('hidden', !unlocked || !nostrEnabled);
}

export function renderAuthPanel(state) {
    renderIdentityBadge(state);

    const status = document.getElementById('auth-status');
    if (status) {
        status.textContent = `Status: ${state.status}`;
    }

    const keysPanel = document.getElementById('identity-keys-panel');
    const fullAddress = document.getElementById('identity-full-address');
    const fullPubkey = document.getElementById('identity-full-pubkey');

    // The private key lives in the signing worker; the panel only ever sees the
    // public material AuthController pulled from it.
    const publicKey = state.publicKey || null;
    const isUnlocked = Boolean(state.localWalletUnlocked && state.address && publicKey);

    if (keysPanel) {
        keysPanel.classList.toggle('hidden', !isUnlocked);
    }

    if (isUnlocked && state.address) {
        if (fullAddress) fullAddress.textContent = state.address;
        if (fullPubkey) fullPubkey.textContent = publicKey;
    } else {
        if (fullAddress) fullAddress.textContent = '';
        if (fullPubkey) fullPubkey.textContent = '';
    }

    renderNostrIdentitySection({
        npub: state.npub || null,
        nostrPublicKey: state.nostrPublicKey || null,
        nostrEnabled: state.nostrEnabled !== false,
        unlocked: isUnlocked
    });

    bindCopyButton(document.getElementById('copy-address-btn'), () => fullAddress?.textContent || '');
    bindCopyButton(document.getElementById('copy-pubkey-btn'), () => fullPubkey?.textContent || '');
    bindCopyButton(
        document.getElementById('copy-npub-btn'),
        () => document.getElementById('identity-full-npub')?.textContent || ''
    );
    bindCopyButton(
        document.getElementById('copy-nostr-pubkey-btn'),
        () => document.getElementById('identity-full-nostr-pubkey')?.textContent || ''
    );

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
