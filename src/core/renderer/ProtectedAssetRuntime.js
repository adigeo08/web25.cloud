// @ts-check
/**
 * The viewer's half of protected assets.
 *
 * By the time anything here runs, the torrent (or its GoFile mirror) has been
 * fetched, the `.torrentchain` signature has been verified and the bundle's
 * integrity has been checked. This module adds the last two verification steps
 * — the ciphertext each asset claims, and the grants that name who may open it
 * — and only then lets the site render.
 *
 * Decryption itself never happens on its own. A viewer clicks 🔐 Decrypt, and
 * even then the plaintext exists only in the sandboxed frame's DOM: nothing in
 * this module writes a fragment or a key to IndexedDB, localStorage, the
 * Service Worker cache or the PeerWeb cache.
 */

import {
    findGrantForPublicKey,
    TORRENTCHAIN_SCHEMA,
    verifyProtectedAssetCiphertext
} from '../../torrent/ProtectedAssetProtocol.js';

/** What a decrypt attempt can come back as. */
export const PROTECTED_DECRYPT_STATUS = Object.freeze({
    OK: 'ok',
    WALLET_LOCKED: 'wallet-locked',
    NO_GRANT: 'no-grant',
    UNKNOWN_ASSET: 'unknown-asset',
    ERROR: 'error'
});

/**
 * A locked wallet is not a refusal — it is a wallet that has not been asked
 * yet. Telling a viewer "no access" when they simply have not unlocked would
 * send them looking for permission they may already hold.
 */
export const WALLET_LOCKED_MESSAGE = 'Unlock your local wallet to decrypt this content.';

/**
 * @param {{ npub?: string, nostrPublicKey?: string }} owner
 */
export function noAccessMessage(owner) {
    const author = `${owner?.npub || owner?.nostrPublicKey || 'unknown'}`;
    return `You do not have decryption rights for this content.\nAuthor: ${author}`;
}

/**
 * @param {any} siteData
 * @param {string} path
 * @returns {Uint8Array | null}
 */
function readSiteFile(siteData, path) {
    const entry = siteData?.[path];
    if (!entry || !entry.content) return null;
    if (entry.content instanceof Uint8Array) return entry.content;
    if (entry.content instanceof ArrayBuffer) return new Uint8Array(entry.content);
    if (ArrayBuffer.isView(entry.content)) {
        return new Uint8Array(entry.content.buffer, entry.content.byteOffset, entry.content.byteLength);
    }
    if (Array.isArray(entry.content)) return new Uint8Array(entry.content);
    return null;
}

/**
 * Check every protected asset against the bundle that shipped with it.
 *
 * The manifest's grant hashes were already recomputed during signature
 * verification; what is added here is the ciphertext itself, which lives in the
 * bundle rather than in the manifest. A missing or altered `.bin` blocks the
 * render outright — a site that would show a broken padlock to every viewer is
 * a site that has been tampered with.
 *
 * @param {{ protectedAssets: any[], siteData: any }} input
 * @returns {Promise<{ ok: boolean, reason?: string, assets: Map<string, any> }>}
 */
export async function verifyProtectedAssetsAgainstBundle({ protectedAssets, siteData }) {
    /** @type {Map<string, any>} */
    const assets = new Map();
    for (const asset of protectedAssets || []) {
        if (assets.has(asset.assetId)) {
            return { ok: false, reason: `duplicate protected asset ${asset.assetId}`, assets };
        }
        const ciphertext = readSiteFile(siteData, asset.cipherPath);
        try {
            await verifyProtectedAssetCiphertext(asset, ciphertext);
        } catch (error) {
            return {
                ok: false,
                reason: error instanceof Error ? error.message : 'protected asset verification failed',
                assets
            };
        }
        assets.set(asset.assetId, { asset, ciphertext });
    }
    return { ok: true, assets };
}

/**
 * Build the handler the sandbox bridge calls when a viewer clicks 🔐 Decrypt.
 *
 * The sandboxed site supplies one thing: an asset id. Everything else — the
 * site id, the ciphertext, the wrapped key, both digests — is taken from the
 * verified manifest held here, so a site's own JavaScript cannot ask for
 * anything the manifest does not already describe, and cannot reach the wallet
 * at all.
 *
 * @param {{
 *   siteId: string,
 *   owner: { npub?: string, nostrPublicKey?: string },
 *   assets: Map<string, { asset: any, ciphertext: Uint8Array }>,
 *   isWalletUnlocked: () => Promise<boolean>,
 *   getViewerPublicKey: () => Promise<string | null>,
 *   decryptProtectedAsset: (request: any) => Promise<{ plaintext: string }>,
 *   log?: (message: string) => void
 * }} deps
 */
export function createProtectedAssetDecryptHandler({
    siteId,
    owner,
    assets,
    isWalletUnlocked,
    getViewerPublicKey,
    decryptProtectedAsset,
    log = null
}) {
    const note = log || (() => {});

    /**
     * @param {string} assetId
     */
    return async function handleProtectedDecrypt(assetId) {
        const entry = assets.get(`${assetId}`.toLowerCase());
        if (!entry) {
            // An id that is not in the verified manifest is refused before any
            // wallet state is even looked at.
            return { status: PROTECTED_DECRYPT_STATUS.UNKNOWN_ASSET, assetId, message: 'Unknown protected asset.' };
        }

        if (!(await isWalletUnlocked())) {
            return { status: PROTECTED_DECRYPT_STATUS.WALLET_LOCKED, assetId, message: WALLET_LOCKED_MESSAGE };
        }

        const viewerPublicKey = await getViewerPublicKey();
        const grant = viewerPublicKey ? findGrantForPublicKey(entry.asset, viewerPublicKey) : null;
        if (!grant) {
            // No grant means no crypto is attempted at all — and the viewer is
            // told whom to ask, from the verified owner block.
            return {
                status: PROTECTED_DECRYPT_STATUS.NO_GRANT,
                assetId,
                message: noAccessMessage(owner),
                authorNpub: owner?.npub || null
            };
        }

        try {
            const { plaintext } = await decryptProtectedAsset({
                schema: TORRENTCHAIN_SCHEMA,
                siteId,
                assetId: entry.asset.assetId,
                contentHash: entry.asset.contentHash,
                cipherHash: entry.asset.cipherHash,
                contentSalt: entry.asset.contentSalt,
                iv: entry.asset.cipher.iv,
                algorithm: entry.asset.cipher.algorithm,
                wrappedKey: grant.wrappedKey,
                ciphertext: entry.ciphertext
            });
            return { status: PROTECTED_DECRYPT_STATUS.OK, assetId, html: plaintext };
        } catch (error) {
            note(`[Protected] decrypt failed for ${assetId}: ${error instanceof Error ? error.message : error}`);
            return {
                status: PROTECTED_DECRYPT_STATUS.ERROR,
                assetId,
                message: 'This content could not be decrypted.'
            };
        }
    };
}
