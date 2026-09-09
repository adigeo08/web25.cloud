// @ts-check
/**
 * Turning a staged site plus a set of preview selections into the protected
 * site that actually gets signed.
 *
 * This runs after the publisher leaves the Preview & Protect step and before
 * anything is bundled, hashed or signed — so the torrent hash, the bundle hash
 * and the `.torrentchain` signature all cover the *encrypted* site, never the
 * plaintext one.
 *
 * The owner always receives a decrypt grant on every asset. That is not a
 * convenience: a publisher who cannot read their own site back has silently
 * destroyed content, so the owner grant is added here rather than left to the
 * UI to remember.
 */

import {
    createProtectedAsset,
    newUuid,
    normalizeRecipientPublicKey,
    protectedAssetCipherPath
} from './ProtectedAssetProtocol.js';
import {
    applyProtectedSelections,
    prepareAuthoringDocument,
    serializeStagedDocument,
    TextLocatorError
} from './ProtectedTextLocator.js';
import { utf8Bytes, utf8Text } from './CanonicalJson.js';

/**
 * @typedef {{ path: string, contentType: string, bytes: Uint8Array }} StagedFile
 * @typedef {{ path: string, containerId: string, startOffset: number, endOffset: number,
 *             exact: string, prefix: string, suffix: string }} SelectionLocator
 * @typedef {{ id?: string, locator: SelectionLocator, recipientPublicKeys?: string[] }} ProtectionRequest
 */

export class ProtectedBuildError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'protected-build-failed') {
        super(message);
        this.name = 'ProtectedBuildError';
        this.code = code;
    }
}

/**
 * Which staged files can host a protected selection.
 * @param {string} path
 */
export function isProtectableDocument(path) {
    return /\.x?html?$/i.test(`${path}`);
}

/**
 * Prepare the preview: every HTML file in the staged site, parsed into an
 * authoring document and re-serialised with temporary preview ids.
 *
 * @param {StagedFile[]} files
 * @returns {Map<string, ReturnType<typeof prepareAuthoringDocument>>}
 */
export function prepareProtectionWorkspace(files) {
    const documents = new Map();
    for (const file of files || []) {
        if (!isProtectableDocument(file.path)) continue;
        documents.set(file.path, prepareAuthoringDocument(utf8Text(file.bytes), file.path));
    }
    return documents;
}

/**
 * Build the protected representation of a staged site.
 *
 * @param {{
 *   files: StagedFile[],
 *   selections: ProtectionRequest[],
 *   owner: { eciesPublicKey: string },
 *   ecies: {
 *     eciesEncrypt: (plaintext: string, publicKey: string) => Promise<string>,
 *     evmAddressFromPublicKey: (publicKey: string) => string,
 *     isValidUncompressedPublicKey?: (publicKey: string) => boolean
 *   },
 *   siteId?: string
 * }} input
 * @returns {Promise<{ siteId: string, files: StagedFile[], protectedAssets: any[], changedPaths: string[] }>}
 */
export async function buildProtectedSite({ files, selections, owner, ecies, siteId }) {
    const stagedFiles = [...(files || [])];
    const requests = [...(selections || [])];
    const resolvedSiteId = siteId || newUuid();

    // Nothing protected: the staged files travel through untouched, and the
    // rest of the deploy flow behaves exactly as it did before this feature.
    if (requests.length === 0) {
        return { siteId: resolvedSiteId, files: stagedFiles, protectedAssets: [], changedPaths: [] };
    }

    const ownerKey = normalizeRecipientPublicKey(owner?.eciesPublicKey, ecies);

    /** @type {Map<string, ProtectionRequest[]>} */
    const byPath = new Map();
    for (const request of requests) {
        const path = `${request?.locator?.path || ''}`;
        const file = stagedFiles.find((entry) => entry.path === path);
        if (!file) {
            throw new ProtectedBuildError(
                `Protected selection refers to a file that is not staged: ${path}`,
                'unknown-source-file'
            );
        }
        if (!isProtectableDocument(path)) {
            throw new ProtectedBuildError(
                `Only HTML documents can host protected fragments: ${path}`,
                'unprotectable-source'
            );
        }
        const list = byPath.get(path) || [];
        list.push(request);
        byPath.set(path, list);
    }

    const protectedAssets = [];
    /** @type {Map<string, Uint8Array>} */
    const ciphertexts = new Map();
    const changedPaths = [];

    for (const [path, pathRequests] of byPath) {
        const file = /** @type {StagedFile} */ (stagedFiles.find((entry) => entry.path === path));
        const document = prepareAuthoringDocument(utf8Text(file.bytes), path);

        const assetIds = pathRequests.map(() => newUuid());
        let fragments;
        try {
            fragments = applyProtectedSelections(
                document,
                pathRequests.map((request, index) => ({ assetId: assetIds[index], locator: request.locator }))
            );
        } catch (error) {
            if (error instanceof TextLocatorError) {
                throw new ProtectedBuildError(
                    `A protected selection in ${path} could not be resolved: ${error.message}`,
                    error.code
                );
            }
            throw error;
        }

        for (const fragment of fragments) {
            const request = pathRequests[assetIds.indexOf(fragment.assetId)];
            // The owner is implicit and cannot be dropped: a site whose author
            // cannot read it back is a site with lost content.
            const recipientPublicKeys = [
                ownerKey,
                ...(request?.recipientPublicKeys || []).map((key) => normalizeRecipientPublicKey(key, ecies))
            ];

            const { asset, ciphertext } = await createProtectedAsset({
                siteId: resolvedSiteId,
                assetId: fragment.assetId,
                plaintext: fragment.fragmentHtml,
                source: { path, locator: fragment.locator },
                recipientPublicKeys,
                ecies
            });

            protectedAssets.push(asset);
            ciphertexts.set(asset.assetId, ciphertext);
        }

        const rewritten = serializeStagedDocument(document);
        const index = stagedFiles.findIndex((entry) => entry.path === path);
        stagedFiles[index] = { ...file, bytes: utf8Bytes(rewritten) };
        changedPaths.push(path);
    }

    for (const asset of protectedAssets) {
        const cipherPath = protectedAssetCipherPath(asset.assetId);
        if (stagedFiles.some((entry) => entry.path === cipherPath)) {
            throw new ProtectedBuildError(`Duplicate protected asset path: ${cipherPath}`, 'duplicate-asset-path');
        }
        stagedFiles.push({
            path: cipherPath,
            contentType: 'application/octet-stream',
            bytes: /** @type {Uint8Array} */ (ciphertexts.get(asset.assetId))
        });
    }

    return { siteId: resolvedSiteId, files: stagedFiles, protectedAssets, changedPaths };
}
