// @ts-check
/**
 * `.torrentchain` — the signed source of truth for a Web25 site.
 *
 * The manifest names who published the bundle, what the bundle contains, which
 * fragments of it are encrypted, and who may decrypt them. All of that lives
 * *inside* the signed payload: access control that sat outside the signature
 * could be rewritten by anyone who can serve the file, so nothing
 * security-critical is left there. `manifest.files` is kept alongside the
 * payload for readability, but the payload carries its digest, so a tampered
 * file list fails verification just like a tampered signature would.
 */

import { signPublishPayload, verifyPublishSignature } from '../auth/SigningService.js';
import {
    bytesToHex,
    canonicalJson,
    hexToBytes,
    sha256Bytes,
    sha256Hex,
    timingSafeEqualHex,
    utf8Bytes
} from './CanonicalJson.js';
import {
    canonicalizeProtectedAssets,
    normalizeRecipientPublicKey,
    TORRENTCHAIN_SCHEMA,
    validateProtectedAssets
} from './ProtectedAssetProtocol.js';
import { isValidUncompressedPublicKey } from '../channels/ecies.js';

export const TORRENTCHAIN_SIGNATURE_ALGORITHM = 'EVM_SECP256K1';

const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;
const NPUB_RE = /^npub1[023456789acdefghjklmnpqrstuvwxyz]{20,}$/;

export async function buildTorrentChainDraft(inMemoryFiles) {
    const fileEntries = [];
    let totalBytes = 0;

    for (const file of inMemoryFiles) {
        const path = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!path || path === '.torrentchain') continue;

        const buffer = await file.arrayBuffer();
        const sha256 = await sha256Hex(new Uint8Array(buffer));
        totalBytes += buffer.byteLength;
        fileEntries.push({
            path,
            size: buffer.byteLength,
            sha256
        });
    }

    fileEntries.sort((a, b) => a.path.localeCompare(b.path));

    let level = fileEntries.map((entry) => hexToBytes(entry.sha256));
    if (level.length === 0) {
        level = [await sha256Bytes(utf8Bytes('empty-bundle'))];
    }

    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1] || left;
            const combined = new Uint8Array(left.length + right.length);
            combined.set(left, 0);
            combined.set(right, left.length);
            next.push(await sha256Bytes(combined));
        }
        level = next;
    }

    return {
        fileEntries,
        fileCount: fileEntries.length,
        totalBytes,
        merkleRoot: bytesToHex(level[0]),
        filesHash: await hashFileEntries(fileEntries)
    };
}

/**
 * Digest of the whole file list — paths and sizes included, not just the
 * content digests the Merkle root covers. This is what ties `manifest.files`
 * to the signature.
 * @param {{path: string, size: number, sha256: string}[]} fileEntries
 */
export function hashFileEntries(fileEntries) {
    return sha256Hex(
        utf8Bytes(
            canonicalJson(
                [...(fileEntries || [])]
                    .map((entry) => ({
                        path: `${entry.path}`,
                        size: Number(entry.size),
                        sha256: `${entry.sha256}`.toLowerCase()
                    }))
                    .sort((left, right) => left.path.localeCompare(right.path))
            )
        )
    );
}

/**
 * The publisher's identity, as the manifest records it.
 *
 * All four fields are views of the *same* secp256k1 key: the EVM address and
 * the Nostr key are both derived from the ECIES public key, and the npub is the
 * NIP-19 form of the Nostr key. They are recorded together so a viewer who has
 * no decrypt grant can still be told, from verified data, whom to ask.
 *
 * @param {{ evmAddress: string, eciesPublicKey: string, nostrPublicKey?: string, npub?: string }} owner
 */
export function canonicalizeOwner(owner) {
    const evmAddress = `${owner?.evmAddress || ''}`.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(evmAddress)) {
        throw new Error('Owner evmAddress must be a 20-byte 0x-prefixed address.');
    }
    // Throws for anything that is not a real uncompressed secp256k1 key —
    // including a point that merely looks like one but is not on the curve.
    const eciesPublicKey = normalizeRecipientPublicKey(owner?.eciesPublicKey, { isValidUncompressedPublicKey });

    const nostrPublicKey = `${owner?.nostrPublicKey || ''}`.trim().toLowerCase();
    if (nostrPublicKey && !NOSTR_PUBKEY_RE.test(nostrPublicKey)) {
        throw new Error('Owner nostrPublicKey must be a 32-byte hex key.');
    }
    const npub = `${owner?.npub || ''}`.trim();
    if (npub && !NPUB_RE.test(npub)) {
        throw new Error('Owner npub must be a NIP-19 npub string.');
    }

    return { evmAddress, eciesPublicKey, nostrPublicKey, npub };
}

/**
 * The exact bytes the publisher signs. Canonical JSON, so the same payload
 * always produces the same message no matter which order the fields were
 * assembled in.
 * @param {Record<string, any>} payload
 */
export function canonicalTorrentChainMessage(payload) {
    return canonicalJson(payload);
}

/**
 * @param {{
 *   inMemoryFiles: any[],
 *   publisher: string,
 *   chainId: number,
 *   identityType: string,
 *   createdAt: string,
 *   siteId: string,
 *   owner: { evmAddress: string, eciesPublicKey: string, nostrPublicKey?: string, npub?: string },
 *   bundle?: any,
 *   filesSemantics?: string,
 *   protectedAssets?: any[]
 * }} input
 */
export async function createTorrentChainArtifact({
    inMemoryFiles,
    publisher,
    chainId,
    identityType,
    createdAt,
    siteId,
    owner,
    bundle = null,
    filesSemantics = 'torrent-entries',
    protectedAssets = [],
    // @internal — injectable for unit testing; production always signs through
    // the wallet worker via signPublishPayload.
    _signPayloadFn = null
}) {
    const draft = await buildTorrentChainDraft(inMemoryFiles);
    const canonicalOwner = canonicalizeOwner(owner);

    if (canonicalOwner.evmAddress !== `${publisher}`.toLowerCase()) {
        throw new Error('The .torrentchain owner must be the publisher signing it.');
    }

    // Validated before signing: a manifest that would fail its own verification
    // must never be produced, let alone deployed.
    const canonicalAssets = await validateProtectedAssets(canonicalizeProtectedAssets(protectedAssets), { siteId });

    const payload = {
        schema: TORRENTCHAIN_SCHEMA,
        publisher,
        chainId,
        createdAt,
        siteId,
        owner: canonicalOwner,
        fileCount: draft.fileCount,
        totalBytes: draft.totalBytes,
        merkleRoot: draft.merkleRoot,
        filesHash: draft.filesHash,
        filesSemantics,
        protectedAssets: canonicalAssets,
        ...(bundle ? { bundle } : {})
    };

    const message = canonicalTorrentChainMessage(payload);
    const signed = await (_signPayloadFn || signPublishPayload)(payload, identityType, message);

    const manifest = {
        schema: payload.schema,
        payload,
        message,
        signature: signed.signature,
        signatureAlgorithm: TORRENTCHAIN_SIGNATURE_ALGORITHM,
        files: draft.fileEntries
    };

    return {
        manifest,
        content: utf8Bytes(JSON.stringify(manifest, null, 2)),
        signature: signed.signature,
        signatureAlgorithm: TORRENTCHAIN_SIGNATURE_ALGORITHM,
        payload,
        message,
        protectedAssets: canonicalAssets
    };
}

/**
 * Verify a `.torrentchain` manifest end to end.
 *
 * The signature is checked against a message this function recomputes from the
 * payload, never against the `message` field as supplied — otherwise a tampered
 * payload could travel with the original signed message and pass. The file list
 * and the protected-asset structure are then checked against the payload they
 * are supposed to belong to.
 *
 * @param {any} manifest
 * @param {{ _verifySignatureFn?: ((message: string, signature: string, publisher: string) => Promise<boolean>) | null }} [options]
 * @returns {Promise<{ verified: boolean, reason?: string, publisher?: string, payload?: any,
 *                     owner?: any, siteId?: string | null, protectedAssets?: any[] }>}
 */
export async function verifyTorrentChainManifest(manifest, { _verifySignatureFn = null } = {}) {
    if (!manifest?.payload || !manifest?.signature || !manifest?.payload?.publisher) {
        return { verified: false, reason: 'Missing payload/signature/publisher' };
    }

    const payload = manifest.payload;
    if (payload.schema !== TORRENTCHAIN_SCHEMA) {
        return { verified: false, reason: `Unsupported .torrentchain schema: ${payload.schema}` };
    }

    let message;
    try {
        message = canonicalTorrentChainMessage(payload);
    } catch (error) {
        return { verified: false, reason: `Payload is not canonically serialisable: ${error.message}` };
    }

    if (typeof manifest.message === 'string' && manifest.message !== message) {
        return { verified: false, reason: 'Signed message does not match the manifest payload' };
    }

    // @internal — the verifier is injectable for unit testing; production always
    // recovers the EIP-191 signer.
    const verified = await (_verifySignatureFn || verifyPublishSignature)(
        message,
        manifest.signature,
        payload.publisher
    );
    if (!verified) {
        return {
            verified: false,
            reason: 'Signature does not recover to the publisher',
            publisher: payload.publisher,
            payload
        };
    }

    let owner;
    try {
        owner = canonicalizeOwner(payload.owner);
    } catch (error) {
        return {
            verified: false,
            reason: `Owner block is invalid: ${error.message}`,
            publisher: payload.publisher,
            payload
        };
    }
    if (owner.evmAddress !== `${payload.publisher}`.toLowerCase()) {
        return {
            verified: false,
            reason: 'Owner does not match the signing publisher',
            publisher: payload.publisher,
            payload
        };
    }

    if (Array.isArray(manifest.files)) {
        const filesHash = await hashFileEntries(manifest.files);
        if (!timingSafeEqualHex(filesHash, `${payload.filesHash || ''}`)) {
            return {
                verified: false,
                reason: 'File list does not match the signed filesHash',
                publisher: payload.publisher,
                payload
            };
        }
    } else if (payload.filesHash) {
        return {
            verified: false,
            reason: 'Manifest is missing the file list its signature covers',
            publisher: payload.publisher,
            payload
        };
    }

    let protectedAssets = [];
    if (payload.protectedAssets && payload.protectedAssets.length > 0) {
        if (!payload.siteId) {
            return {
                verified: false,
                reason: 'Protected assets require a siteId',
                publisher: payload.publisher,
                payload
            };
        }
        try {
            protectedAssets = await validateProtectedAssets(payload.protectedAssets, { siteId: payload.siteId });
        } catch (error) {
            return {
                verified: false,
                reason: `Protected assets are invalid: ${error.message}`,
                publisher: payload.publisher,
                payload
            };
        }
    }

    return {
        verified: true,
        publisher: payload.publisher,
        payload,
        owner,
        siteId: payload.siteId || null,
        protectedAssets
    };
}
