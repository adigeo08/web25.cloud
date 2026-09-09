// @ts-check

import {
    createProtectedAssetDecryptHandler,
    PROTECTED_DECRYPT_STATUS,
    verifyProtectedAssetsAgainstBundle
} from '../renderer/ProtectedAssetRuntime.js';
import {
    getLocalWalletPublicKey,
    isLocalWalletUnlocked,
    protectedAssetDecryptWithLocalWallet
} from '../../auth/LocalWalletService.js';

/**
 * Build a decrypt handler as soon as a verified manifest declares protected
 * assets. Do not require the eager ciphertext map to still be populated at the
 * exact moment the delayed sandbox starts: if necessary, re-verify the assets
 * against currentSiteData before touching the wallet.
 */
export function buildProtectedDecryptHandler() {
    const context = this.currentProtectedSite;
    if (!context || !Array.isArray(context.protectedAssets) || context.protectedAssets.length === 0) return null;

    const siteId = context.siteId;
    const owner = context.owner || {};
    const protectedAssets = context.protectedAssets;
    let verifiedAssets = context.assets instanceof Map && context.assets.size > 0 ? context.assets : null;
    let decryptHandler = null;

    const ensureHandler = async () => {
        if (decryptHandler) return decryptHandler;

        if (!verifiedAssets || verifiedAssets.size === 0) {
            const siteData = this.currentSiteData;
            if (!siteData) throw new Error('Protected site data is no longer available.');

            const verification = await verifyProtectedAssetsAgainstBundle({ protectedAssets, siteData });
            if (!verification.ok) {
                throw new Error(verification.reason || 'Protected assets failed bundle verification.');
            }
            verifiedAssets = verification.assets;

            // Keep the normal loader context warm when it is still the same
            // verified site, but never rely on this mutable field for security.
            if (this.currentProtectedSite === context) context.assets = verifiedAssets;
        }

        decryptHandler = createProtectedAssetDecryptHandler({
            siteId,
            owner,
            assets: verifiedAssets,
            isWalletUnlocked: () => isLocalWalletUnlocked(),
            getViewerPublicKey: () => getLocalWalletPublicKey(),
            decryptProtectedAsset: (request) =>
                protectedAssetDecryptWithLocalWallet(request).then((result) => ({ plaintext: result.plaintext })),
            log: (message) => this.log(message)
        });
        return decryptHandler;
    };

    return async (assetId) => {
        try {
            const handler = await ensureHandler();
            const result = await handler(assetId);

            if (result?.status === PROTECTED_DECRYPT_STATUS.NO_GRANT && result.authorNpub) {
                this.showProtectedAccessContactModal({ assetId, authorNpub: result.authorNpub });
            }
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`[Protected] could not prepare decrypt handler: ${message}`);
            return {
                status: PROTECTED_DECRYPT_STATUS.ERROR,
                assetId,
                message: 'This protected content could not be verified for decryption.'
            };
        }
    };
}

/**
 * Ask before leaving the viewed site for Direct Messenger. The npub displayed
 * here comes from the already verified TorrentChain owner block; no value from
 * the sandboxed site itself is trusted for the handoff.
 */
export function showProtectedAccessContactModal({ assetId, authorNpub }) {
    const npub = `${authorNpub || ''}`.trim();
    if (!npub) return;

    document.getElementById('protected-access-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'protected-access-modal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'protected-access-modal-title');

    const content = document.createElement('div');
    content.className = 'modal-content';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('h4');
    title.id = 'protected-access-modal-title';
    title.textContent = '🔐 Access required';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close-btn';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const message = document.createElement('p');
    message.textContent = 'Your wallet does not have a decrypt grant for this content. Contact the verified site owner in Direct Messenger?';

    const ownerLabel = document.createElement('p');
    ownerLabel.style.marginTop = '1rem';
    const strong = document.createElement('strong');
    strong.textContent = 'Owner: ';
    const code = document.createElement('code');
    code.textContent = npub;
    ownerLabel.append(strong, code);

    const actions = document.createElement('div');
    actions.className = 'button-group';
    actions.style.marginTop = '1.25rem';
    actions.style.marginBottom = '0';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-clear';
    cancel.textContent = 'Cancel';

    const contact = document.createElement('button');
    contact.type = 'button';
    contact.className = 'btn btn-primary';
    contact.textContent = '💬 Contact owner';

    actions.append(cancel, contact);
    body.append(message, ownerLabel, actions);
    content.append(header, body);
    modal.appendChild(content);
    document.body.appendChild(modal);

    const dismiss = () => modal.remove();
    close.addEventListener('click', dismiss);
    cancel.addEventListener('click', dismiss);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) dismiss();
    });
    contact.addEventListener('click', () => {
        dismiss();
        this.openOwnerInDirectMessenger(npub, assetId);
    });
}

/**
 * Leave the site viewer, switch through the application's existing tab
 * navigation, pre-fill the verified owner npub and run the normal DM lookup.
 * This deliberately does not auto-send an invitation: the user still presses
 * the existing Invite/Start control after seeing the resolved identity.
 */
export function openOwnerInDirectMessenger(authorNpub, _assetId = null) {
    const npub = `${authorNpub || ''}`.trim();
    if (!npub) return false;

    this.showMainContent();

    const tabButton = /** @type {HTMLButtonElement | null} */ (
        document.querySelector('.tab-btn[data-tab="channels"]')
    );
    tabButton?.click();

    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('dm-recipient-npub-input'));
    if (!input) {
        this.toast?.error?.('Direct Messenger recipient input is unavailable.', 'Direct Messenger');
        return false;
    }

    input.value = npub;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();

    // Reuse the normal search flow so Nostr parsing/profile lookup/presence
    // behavior stays in one place and its pendingResult is populated correctly.
    const searchButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('dm-nostr-search-btn'));
    searchButton?.click();
    return true;
}
