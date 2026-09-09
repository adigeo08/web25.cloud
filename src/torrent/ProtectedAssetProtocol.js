// @ts-check
/**
 * The cryptographic model behind `.torrentchain` protected assets.
 *
 * A protected asset is one fragment of the published site that was replaced by
 * a `<web25-protected>` placeholder before signing. The plaintext exists only
 * as AES-256-GCM ciphertext in the bundle; the content-encryption key (CEK) is
 * wrapped once per authorised recipient with ECIES on their public key.
 *
 * Everything is bound to everything else, so no piece can be moved between
 * assets or between sites:
 *
 *   contentHash = SHA256(contentSalt || plaintext)
 *   AAD         = canonical({ schema, siteId, assetId, contentHash })
 *   ciphertext  = AES-256-GCM(CEK, plaintext, AAD)
 *   cipherHash  = SHA256(ciphertext)
 *   envelope    = { schema, siteId, assetId, contentHash, cipherHash, cek }
 *   wrappedKey  = ECIES(recipientPublicKey, canonical(envelope))
 *   grantHash   = SHA256(canonical({ siteId, assetId, contentHash, cipherHash,
 *                                    recipientPublicKey, wrappedKey, can }))
 *
 * A wrapped key from asset A therefore fails on asset B (the envelope names
 * asset A), and ciphertext from asset A fails on asset B (its cipherHash is the
 * signed one for B, and the AAD names B).
 *
 * This module deliberately imports nothing but `CanonicalJson.js`: it runs
 * unchanged on the main thread, inside the dedicated wallet worker (which has
 * no import map) and in Node tests. ECIES itself is injected, so the worker
 * uses its own `@noble` build and the page uses the page's.
 */

import {
    base64ToBytes,
    bytesToBase64,
    bytesToHex,
    canonicalJson,
    concatBytes,
    hexToBytes,
    sha256Hex,
    timingSafeEqualHex,
    utf8Bytes,
    utf8Text
} from './CanonicalJson.js';

/** The manifest schema protected assets are bound to. */
export const TORRENTCHAIN_SCHEMA = 'web25-torrentchain-v1';
/** The schema of the ECIES-wrapped key envelope. */
export const PROTECTED_KEY_SCHEMA = 'web25-protected-key-v1';
/** The only content cipher this version understands. */
export const PROTECTED_CIPHER_ALGORITHM = 'AES-256-GCM';
/** The only capability a grant can carry today. */
export const PROTECTED_CAPABILITY_DECRYPT = 'decrypt';
/** Where a protected asset's ciphertext lives inside the staged site. */
export const PROTECTED_ASSET_DIRECTORY = '.web25/protected/';
/** The placeholder element left in the published HTML. */
export const PROTECTED_PLACEHOLDER_TAG = 'web25-protected';

const CEK_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^[0-9a-f]+$/;
const UNCOMPRESSED_PUBKEY_RE = /^04[0-9a-f]{128}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

export class ProtectedAssetError extends Error {
    /**
     * @param {string} message
     * @param {string} [code]
     */
    constructor(message, code = 'protected-asset-invalid') {
        super(message);
        this.name = 'ProtectedAssetError';
        this.code = code;
    }
}

/**
 * @param {unknown} condition
 * @param {string} message
 * @param {string} [code]
 * @returns {asserts condition}
 */
function ensure(condition, message, code) {
    if (!condition) throw new ProtectedAssetError(message, code);
}

// ─── normalisation ───────────────────────────────────────────────────────

/**
 * Recipients are addressed by their full uncompressed secp256k1 public key. A
 * bare `0x…` EVM address is not encryption material — an address is a hash of
 * a key, and nothing can be encrypted to it — so it is rejected outright with a
 * message that says why.
 *
 * @param {unknown} value
 * @param {{ isValidUncompressedPublicKey?: (key: string) => boolean }} [ecies]
 * @returns {string} lowercase `04…` hex, no `0x` prefix
 */
export function normalizeRecipientPublicKey(value, ecies = {}) {
    const raw = typeof value === 'string' ? value.trim() : '';
    const stripped = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
    const normalized = stripped.toLowerCase();

    if (EVM_ADDRESS_RE.test(raw.toLowerCase())) {
        throw new ProtectedAssetError(
            'A 0x… Ethereum address is not encryption material. Paste the recipient’s full uncompressed public key (04…).',
            'recipient-address-not-a-key'
        );
    }
    if (!UNCOMPRESSED_PUBKEY_RE.test(normalized)) {
        throw new ProtectedAssetError(
            'Recipient key must be a 130-character uncompressed secp256k1 public key starting with 04.',
            'recipient-key-malformed'
        );
    }
    if (ecies.isValidUncompressedPublicKey && !ecies.isValidUncompressedPublicKey(normalized)) {
        throw new ProtectedAssetError(
            'Recipient key is not a valid point on the secp256k1 curve.',
            'recipient-key-off-curve'
        );
    }
    return normalized;
}

/** @param {unknown} value */
function requireUuid(value, label) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    ensure(UUID_RE.test(normalized), `${label} must be a UUID.`, 'malformed-id');
    return normalized;
}

/** @param {unknown} value */
function requireSha256Hex(value, label) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    ensure(SHA256_HEX_RE.test(normalized), `${label} must be a 32-byte hex SHA-256 digest.`, 'malformed-hash');
    return normalized;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {number} [maxLength]
 */
function requireHex(value, label, maxLength = 4096) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    ensure(
        normalized.length > 0 &&
            normalized.length % 2 === 0 &&
            normalized.length <= maxLength &&
            HEX_RE.test(normalized),
        `${label} must be a hex string.`,
        'malformed-hex'
    );
    return normalized;
}

// ─── canonical binding material ──────────────────────────────────────────

/**
 * The additional authenticated data bound into the content cipher. Callers
 * never pass an AAD in: it is always recomputed from values the verifier
 * already trusts, so a mismatch fails the GCM tag check.
 *
 * @param {{ siteId: string, assetId: string, contentHash: string }} binding
 * @returns {string}
 */
export function buildProtectedAssetAad({ siteId, assetId, contentHash }) {
    return canonicalJson({
        schema: TORRENTCHAIN_SCHEMA,
        siteId: requireUuid(siteId, 'siteId'),
        assetId: requireUuid(assetId, 'assetId'),
        contentHash: requireSha256Hex(contentHash, 'contentHash')
    });
}

/**
 * `contentHash = SHA256(contentSalt || plaintext)`.
 * @param {string} contentSalt hex
 * @param {Uint8Array} plaintextBytes
 */
export function computeContentHash(contentSalt, plaintextBytes) {
    return sha256Hex(concatBytes(hexToBytes(requireHex(contentSalt, 'contentSalt', 256)), plaintextBytes));
}

/** @param {Uint8Array} ciphertext */
export function computeCipherHash(ciphertext) {
    return sha256Hex(ciphertext);
}

/**
 * The grant's self-binding digest. It covers the site, the asset, both content
 * digests, the recipient and the wrapped key, so a grant cannot be lifted onto
 * another asset, another recipient or another site.
 *
 * @param {{ siteId: string, assetId: string, contentHash: string, cipherHash: string,
 *           recipientPublicKey: string, wrappedKey: string, can: string[] }} grant
 * @returns {Promise<string>}
 */
export function computeGrantHash(grant) {
    return sha256Hex(
        utf8Bytes(
            canonicalJson({
                siteId: requireUuid(grant.siteId, 'siteId'),
                assetId: requireUuid(grant.assetId, 'assetId'),
                contentHash: requireSha256Hex(grant.contentHash, 'contentHash'),
                cipherHash: requireSha256Hex(grant.cipherHash, 'cipherHash'),
                recipientPublicKey: normalizeRecipientPublicKey(grant.recipientPublicKey),
                wrappedKey: requireHex(grant.wrappedKey, 'wrappedKey', 1024 * 64),
                can: normalizeCapabilities(grant.can)
            })
        )
    );
}

/**
 * @param {unknown} can
 * @returns {string[]}
 */
export function normalizeCapabilities(can) {
    const list = Array.isArray(can) ? can : [];
    const normalized = [...new Set(list.map((entry) => `${entry}`.trim().toLowerCase()))].sort();
    ensure(normalized.length > 0, 'A grant must carry at least one capability.', 'grant-no-capability');
    for (const capability of normalized) {
        ensure(
            capability === PROTECTED_CAPABILITY_DECRYPT,
            `Unsupported capability: ${capability}`,
            'grant-capability-unknown'
        );
    }
    return normalized;
}

/** Where an asset's ciphertext is expected to live. @param {string} assetId */
export function protectedAssetCipherPath(assetId) {
    return `${PROTECTED_ASSET_DIRECTORY}${requireUuid(assetId, 'assetId')}.bin`;
}

// ─── deterministic ordering ──────────────────────────────────────────────

/**
 * Sort assets by id and each asset's grants by recipient, so the signed payload
 * is a function of its contents and not of the order the publisher happened to
 * click in.
 *
 * @template {{ assetId: string, grants: any[] }} T
 * @param {T[]} assets
 * @returns {T[]}
 */
export function sortProtectedAssets(assets) {
    return [...(assets || [])]
        .map((asset) => ({
            ...asset,
            grants: [...(asset.grants || [])].sort((left, right) =>
                `${left.recipientPublicKey}`.localeCompare(`${right.recipientPublicKey}`)
            )
        }))
        .sort((left, right) => `${left.assetId}`.localeCompare(`${right.assetId}`));
}

/**
 * The exact shape that goes into the signed payload. Unknown fields are dropped
 * rather than carried along, so a verifier and a signer always agree on what
 * was covered.
 *
 * @param {any[]} assets
 */
export function canonicalizeProtectedAssets(assets) {
    return sortProtectedAssets(assets).map((asset) => ({
        assetId: requireUuid(asset.assetId, 'assetId'),
        source: {
            path: `${asset.source?.path || ''}`,
            locator: asset.source?.locator ? { ...asset.source.locator } : {}
        },
        contentHash: requireSha256Hex(asset.contentHash, 'contentHash'),
        contentSalt: requireHex(asset.contentSalt, 'contentSalt', 256),
        cipherHash: requireSha256Hex(asset.cipherHash, 'cipherHash'),
        cipherPath: `${asset.cipherPath || ''}`,
        cipher: {
            algorithm: `${asset.cipher?.algorithm || ''}`,
            iv: requireHex(asset.cipher?.iv, 'cipher.iv', 64),
            aad: `${asset.cipher?.aad || ''}`
        },
        grants: [...(asset.grants || [])].map((grant) => ({
            recipientPublicKey: normalizeRecipientPublicKey(grant.recipientPublicKey),
            recipientAddress: `${grant.recipientAddress || ''}`.toLowerCase(),
            can: normalizeCapabilities(grant.can),
            wrappedKey: requireHex(grant.wrappedKey, 'wrappedKey', 1024 * 64),
            grantHash: requireSha256Hex(grant.grantHash, 'grantHash')
        }))
    }));
}

// ─── creation (publisher side) ───────────────────────────────────────────

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length));
}

/** A v4 UUID, from the platform where available. */
export function newUuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Encrypt one fragment and wrap its CEK for every recipient.
 *
 * The fragment is encrypted exactly once — recipients differ only in the ECIES
 * envelope around the same CEK, so adding a recipient never re-encrypts, and
 * never produces a second ciphertext that could drift from the first.
 *
 * @param {{
 *   siteId: string,
 *   plaintext: string,
 *   source: { path: string, locator: Record<string, any> },
 *   recipientPublicKeys: string[],
 *   ecies: { eciesEncrypt: (plaintext: string, publicKey: string) => Promise<string>,
 *            evmAddressFromPublicKey: (publicKey: string) => string,
 *            isValidUncompressedPublicKey?: (publicKey: string) => boolean },
 *   assetId?: string
 * }} input
 * @returns {Promise<{ asset: Record<string, any>, ciphertext: Uint8Array }>}
 */
export async function createProtectedAsset({ siteId, plaintext, source, recipientPublicKeys, ecies, assetId }) {
    const normalizedSiteId = requireUuid(siteId, 'siteId');
    const normalizedAssetId = assetId ? requireUuid(assetId, 'assetId') : newUuid();
    ensure(
        typeof plaintext === 'string' && plaintext.length > 0,
        'A protected fragment cannot be empty.',
        'empty-fragment'
    );

    const recipients = [];
    for (const key of recipientPublicKeys || []) {
        recipients.push(normalizeRecipientPublicKey(key, ecies));
    }
    const uniqueRecipients = [...new Set(recipients)].sort();
    ensure(uniqueRecipients.length > 0, 'A protected asset needs at least one recipient.', 'no-recipients');

    const plaintextBytes = utf8Bytes(plaintext);
    const contentSalt = bytesToHex(randomBytes(SALT_BYTES));
    const contentHash = await computeContentHash(contentSalt, plaintextBytes);

    const aad = buildProtectedAssetAad({ siteId: normalizedSiteId, assetId: normalizedAssetId, contentHash });
    const cek = randomBytes(CEK_BYTES);
    const iv = randomBytes(IV_BYTES);
    const ciphertext = await aesGcmEncrypt(cek, iv, plaintextBytes, utf8Bytes(aad));
    const cipherHash = await computeCipherHash(ciphertext);

    const envelope = canonicalJson({
        schema: PROTECTED_KEY_SCHEMA,
        siteId: normalizedSiteId,
        assetId: normalizedAssetId,
        contentHash,
        cipherHash,
        cek: bytesToBase64(cek)
    });

    const grants = [];
    for (const recipientPublicKey of uniqueRecipients) {
        const wrappedKey = `${await ecies.eciesEncrypt(envelope, recipientPublicKey)}`.toLowerCase();
        const can = [PROTECTED_CAPABILITY_DECRYPT];
        const grantHash = await computeGrantHash({
            siteId: normalizedSiteId,
            assetId: normalizedAssetId,
            contentHash,
            cipherHash,
            recipientPublicKey,
            wrappedKey,
            can
        });
        grants.push({
            recipientPublicKey,
            recipientAddress: `${ecies.evmAddressFromPublicKey(recipientPublicKey)}`.toLowerCase(),
            can,
            wrappedKey,
            grantHash
        });
    }

    cek.fill(0);

    return {
        asset: {
            assetId: normalizedAssetId,
            source: { path: `${source?.path || ''}`, locator: source?.locator ? { ...source.locator } : {} },
            contentHash,
            contentSalt,
            cipherHash,
            cipherPath: protectedAssetCipherPath(normalizedAssetId),
            cipher: { algorithm: PROTECTED_CIPHER_ALGORITHM, iv: bytesToHex(iv), aad },
            grants
        },
        ciphertext
    };
}

// ─── verification (loader side) ──────────────────────────────────────────

/**
 * Structural validation of the `protectedAssets` array as it appears in a
 * verified manifest payload. Anything ambiguous is rejected rather than
 * guessed: duplicate asset ids, duplicate recipients within one asset, an AAD
 * that does not match its own binding, or a grant whose hash does not match its
 * contents.
 *
 * @param {any} protectedAssets
 * @param {{ siteId: string }} context
 * @returns {Promise<Record<string, any>[]>} the canonical asset list
 */
export async function validateProtectedAssets(protectedAssets, { siteId }) {
    if (protectedAssets === undefined || protectedAssets === null) return [];
    ensure(Array.isArray(protectedAssets), 'protectedAssets must be an array.', 'protected-assets-malformed');
    const normalizedSiteId = requireUuid(siteId, 'siteId');

    const canonical = canonicalizeProtectedAssets(protectedAssets);
    const seenAssetIds = new Set();

    for (const asset of canonical) {
        ensure(!seenAssetIds.has(asset.assetId), `Duplicate protected assetId: ${asset.assetId}`, 'duplicate-asset-id');
        seenAssetIds.add(asset.assetId);

        ensure(
            asset.cipher.algorithm === PROTECTED_CIPHER_ALGORITHM,
            `Unsupported protected-asset cipher: ${asset.cipher.algorithm}`,
            'cipher-unsupported'
        );
        ensure(asset.cipher.iv.length === IV_BYTES * 2, 'Protected asset IV must be 12 bytes.', 'cipher-iv-length');
        ensure(
            asset.cipherPath === protectedAssetCipherPath(asset.assetId),
            `Protected asset ${asset.assetId} declares an unexpected cipherPath.`,
            'cipher-path-mismatch'
        );

        const expectedAad = buildProtectedAssetAad({
            siteId: normalizedSiteId,
            assetId: asset.assetId,
            contentHash: asset.contentHash
        });
        ensure(
            asset.cipher.aad === expectedAad,
            `Protected asset ${asset.assetId} has a mismatched AAD.`,
            'aad-mismatch'
        );

        const seenRecipients = new Set();
        ensure(asset.grants.length > 0, `Protected asset ${asset.assetId} carries no grants.`, 'asset-no-grants');
        for (const grant of asset.grants) {
            ensure(
                !seenRecipients.has(grant.recipientPublicKey),
                `Conflicting grants for the same recipient on asset ${asset.assetId}.`,
                'duplicate-grant'
            );
            seenRecipients.add(grant.recipientPublicKey);

            const expectedHash = await computeGrantHash({
                siteId: normalizedSiteId,
                assetId: asset.assetId,
                contentHash: asset.contentHash,
                cipherHash: asset.cipherHash,
                recipientPublicKey: grant.recipientPublicKey,
                wrappedKey: grant.wrappedKey,
                can: grant.can
            });
            ensure(
                timingSafeEqualHex(expectedHash, grant.grantHash),
                `Grant hash mismatch on asset ${asset.assetId}.`,
                'grant-hash-mismatch'
            );
        }
    }

    return canonical;
}

/**
 * Verify that the ciphertext actually shipped in the bundle is the ciphertext
 * the signed manifest describes. Runs before anything is rendered, and long
 * before any key is touched.
 *
 * @param {Record<string, any>} asset
 * @param {Uint8Array | null | undefined} ciphertext
 */
export async function verifyProtectedAssetCiphertext(asset, ciphertext) {
    ensure(
        ciphertext && ciphertext.length > 0,
        `Protected asset ${asset.assetId} is missing its ciphertext.`,
        'ciphertext-missing'
    );
    const actual = await computeCipherHash(/** @type {Uint8Array} */ (ciphertext));
    ensure(
        timingSafeEqualHex(actual, asset.cipherHash),
        `Ciphertext hash mismatch for protected asset ${asset.assetId}.`,
        'cipher-hash-mismatch'
    );
    return true;
}

/**
 * Find the grant that matches a viewer's public key, or `null`. Never throws
 * for "no access": the caller distinguishes a locked wallet from an
 * unauthorised one, and only one of those is the viewer's problem to fix.
 *
 * @param {Record<string, any>} asset
 * @param {string} viewerPublicKey
 */
export function findGrantForPublicKey(asset, viewerPublicKey) {
    let normalized;
    try {
        normalized = normalizeRecipientPublicKey(viewerPublicKey);
    } catch (_) {
        return null;
    }
    return (asset?.grants || []).find((grant) => grant.recipientPublicKey === normalized) || null;
}

// ─── AES-GCM ─────────────────────────────────────────────────────────────

/**
 * @param {Uint8Array} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} aad
 * @returns {Promise<Uint8Array>}
 */
export async function aesGcmEncrypt(key, iv, plaintext, aad) {
    const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plaintext);
    return new Uint8Array(encrypted);
}

/**
 * @param {Uint8Array} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} aad
 * @returns {Promise<Uint8Array>}
 */
export async function aesGcmDecrypt(key, iv, ciphertext, aad) {
    const aesKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, ciphertext);
    return new Uint8Array(decrypted);
}

// ─── unwrapping (wallet worker side) ─────────────────────────────────────

/**
 * Unwrap a CEK and decrypt one protected fragment.
 *
 * This is the routine the dedicated wallet worker runs. It re-derives every
 * binding from the caller-supplied values and checks them against the envelope
 * that only the recipient's private key could open, so a caller cannot talk the
 * worker into decrypting an asset it does not hold a grant for:
 *
 *  1. the ciphertext must hash to the `cipherHash` from the signed manifest;
 *  2. the envelope must name this site, this asset and both content digests;
 *  3. the GCM tag must verify against an AAD the worker recomputes itself;
 *  4. the recovered plaintext must hash back to the signed `contentHash`.
 *
 * @param {{
 *   siteId: string, assetId: string, contentHash: string, cipherHash: string,
 *   contentSalt: string, iv: string, algorithm: string, wrappedKey: string,
 *   ciphertext: Uint8Array,
 *   eciesDecrypt: (wrapped: string) => Promise<string>
 * }} input
 * @returns {Promise<{ plaintext: string, assetId: string }>}
 */
export async function unwrapAndDecryptProtectedAsset(input) {
    const siteId = requireUuid(input.siteId, 'siteId');
    const assetId = requireUuid(input.assetId, 'assetId');
    const contentHash = requireSha256Hex(input.contentHash, 'contentHash');
    const cipherHash = requireSha256Hex(input.cipherHash, 'cipherHash');
    const contentSalt = requireHex(input.contentSalt, 'contentSalt', 256);
    const iv = hexToBytes(requireHex(input.iv, 'cipher.iv', 64));
    ensure(
        input.algorithm === PROTECTED_CIPHER_ALGORITHM,
        `Unsupported cipher: ${input.algorithm}`,
        'cipher-unsupported'
    );
    ensure(iv.length === IV_BYTES, 'Protected asset IV must be 12 bytes.', 'cipher-iv-length');

    const ciphertext =
        input.ciphertext instanceof Uint8Array ? input.ciphertext : new Uint8Array(input.ciphertext || []);
    const actualCipherHash = await computeCipherHash(ciphertext);
    ensure(
        timingSafeEqualHex(actualCipherHash, cipherHash),
        'Ciphertext does not match the hash in the signed manifest.',
        'cipher-hash-mismatch'
    );

    let envelope;
    try {
        envelope = JSON.parse(await input.eciesDecrypt(requireHex(input.wrappedKey, 'wrappedKey', 1024 * 64)));
    } catch (_) {
        throw new ProtectedAssetError(
            'The wrapped key could not be opened with this wallet.',
            'wrapped-key-unopenable'
        );
    }

    ensure(envelope?.schema === PROTECTED_KEY_SCHEMA, 'Wrapped key envelope has an unknown schema.', 'envelope-schema');
    ensure(envelope.siteId === siteId, 'Wrapped key belongs to a different site.', 'envelope-site-mismatch');
    ensure(
        envelope.assetId === assetId,
        'Wrapped key belongs to a different protected asset.',
        'envelope-asset-mismatch'
    );
    ensure(
        timingSafeEqualHex(`${envelope.contentHash}`, contentHash),
        'Wrapped key names a different content hash.',
        'envelope-content-mismatch'
    );
    ensure(
        timingSafeEqualHex(`${envelope.cipherHash}`, cipherHash),
        'Wrapped key names a different ciphertext.',
        'envelope-cipher-mismatch'
    );

    const cek = base64ToBytes(`${envelope.cek || ''}`);
    ensure(cek.length === CEK_BYTES, 'Wrapped key envelope carries a malformed content key.', 'envelope-cek-malformed');

    const aad = utf8Bytes(buildProtectedAssetAad({ siteId, assetId, contentHash }));
    let plaintextBytes;
    try {
        plaintextBytes = await aesGcmDecrypt(cek, iv, ciphertext, aad);
    } catch (_) {
        throw new ProtectedAssetError('Protected content failed authenticated decryption.', 'aead-failed');
    } finally {
        cek.fill(0);
    }

    const recomputed = await computeContentHash(contentSalt, plaintextBytes);
    ensure(
        timingSafeEqualHex(recomputed, contentHash),
        'Decrypted content does not match the signed content hash.',
        'content-hash-mismatch'
    );

    return { plaintext: utf8Text(plaintextBytes), assetId };
}
