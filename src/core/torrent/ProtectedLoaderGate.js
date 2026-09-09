// @ts-check

import { verifyProtectedAssetsForRender as verifyProtectedAssetsForRenderBase } from './TorrentLoader.js';

const PLACEHOLDER_RE = /<web25-protected\b[^>]*\bdata-asset-id\s*=\s*["']([0-9a-f-]{36})["'][^>]*>/gi;

/**
 * A protected placeholder is security metadata too: every placeholder rendered
 * by the site must correspond one-to-one with a protected asset in the verified
 * TorrentChain manifest. Otherwise a broken/forged site could silently leave an
 * empty custom element where the publisher expected a decrypt control.
 */
export async function verifyProtectedAssetsForRender(siteData) {
    if (!(await verifyProtectedAssetsForRenderBase.call(this, siteData))) return false;

    const occurrences = new Map();
    for (const [path, entry] of Object.entries(siteData || {})) {
        if (!/\.x?html?$/i.test(path) || !entry?.content) continue;
        let bytes = entry.content;
        if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
        else if (ArrayBuffer.isView(bytes) && !(bytes instanceof Uint8Array)) {
            bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
        if (!(bytes instanceof Uint8Array)) continue;

        const html = new TextDecoder().decode(bytes);
        PLACEHOLDER_RE.lastIndex = 0;
        let match;
        while ((match = PLACEHOLDER_RE.exec(html))) {
            const assetId = match[1].toLowerCase();
            occurrences.set(assetId, (occurrences.get(assetId) || 0) + 1);
        }
    }

    const declared = new Set(
        (this.currentProtectedSite?.protectedAssets || []).map((asset) => `${asset.assetId || ''}`.toLowerCase())
    );

    for (const [assetId, count] of occurrences) {
        if (!declared.has(assetId)) {
            this.reportVerificationIssue?.(`Render blocked: protected placeholder ${assetId} is not declared by the verified .torrentchain manifest.`);
            this.currentProtectedSite = null;
            return false;
        }
        if (count !== 1) {
            this.reportVerificationIssue?.(`Render blocked: protected asset ${assetId} appears ${count} times in the staged HTML; expected exactly once.`);
            this.currentProtectedSite = null;
            return false;
        }
    }

    for (const assetId of declared) {
        if ((occurrences.get(assetId) || 0) !== 1) {
            this.reportVerificationIssue?.(`Render blocked: protected asset ${assetId} has no unique placeholder in the staged HTML.`);
            this.currentProtectedSite = null;
            return false;
        }
    }

    return true;
}
