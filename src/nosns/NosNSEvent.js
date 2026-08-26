// @ts-check
/**
 * NIP-35 torrent events for the NosNS website directory.
 *
 * This module is pure: it builds an unsigned event template from a finished
 * deployment, and parses/validates an event that came back from a relay. It
 * performs no signing, no networking and no wallet access — that belongs to
 * `NosNSService.js`.
 *
 * Trust model, which the whole file is written around:
 *
 *   Nostr signature   → who published this *directory entry*
 *   BitTorrent hash   → which artifact it points at
 *   `.torrentchain`   → what the artifact contains and who published the site
 *   EVM signature     → proof of that publisher
 *
 * The directory mirrors the EVM proof so a browser can show "Verified
 * publisher: 0x…" *before* downloading, but that is only an early signal. The
 * downloaded `.torrentchain` stays authoritative, and a directory entry that
 * disagrees with it is to be treated as untrusted.
 *
 * NosNS identification is the torrent name suffix and nothing else. The
 * mirrored `web25-*` tags are proof metadata, so an entry with the right suffix
 * but no WEB25 proof is still a NosNS website — shown as unverified.
 */

import { NOSNS_CONFIG } from '../config/nostr.config.js';
import {
    NOSNS_EVENT_KIND,
    NOSNS_TORRENT_SUFFIX,
    ensureNosnsTorrentName,
    isNosnsTorrentName,
    isValidDtanCategory,
    normalizeDtanCategory,
    nosnsDisplayName
} from './NosNSProtocol.js';

const { PROOF_TAGS } = NOSNS_CONFIG;

const INFOHASH_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const EVM_SIGNATURE_RE = /^0x[0-9a-f]{130}$/;

/** Verification states for the mirrored WEB25/EVM proof. */
export const WEB25_VERIFICATION = /** @type {const} */ ({
    /** EVM signature recovers to the claimed publisher and the tags agree. */
    VERIFIED: 'verified',
    /** WEB25 metadata is present and well-formed, but the signature is wrong. */
    INVALID: 'invalid',
    /** WEB25 metadata is present but structurally broken or self-inconsistent. */
    MALFORMED: 'malformed',
    /** No WEB25 proof to check, or the check has not been run yet. */
    UNVERIFIED: 'unverified'
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the first value of a tag.
 * @param {string[][]} tags
 * @param {string} name
 * @returns {string}
 */
export function firstTagValue(tags, name) {
    const tag = (tags || []).find((entry) => Array.isArray(entry) && entry[0] === name);
    return tag ? text(tag[1]) : '';
}

/**
 * Read every value of a repeated tag.
 * @param {string[][]} tags
 * @param {string} name
 * @returns {string[]}
 */
export function allTagValues(tags, name) {
    return (tags || [])
        .filter((entry) => Array.isArray(entry) && entry[0] === name)
        .map((entry) => text(entry[1]))
        .filter(Boolean);
}

/**
 * Describe the torrent that was actually created, so the event advertises
 * the real torrent entries rather than assumptions about bundle mode.
 *
 * In gzip mode the torrent holds `.torrentchain` + `site.bundle.json.gz`; in
 * files mode it holds the site files. Reading it back off the torrent object
 * means both are correct without the caller having to know which one ran.
 *
 * @param {any} torrent a seeded WebTorrent torrent
 * @param {string[]} [fallbackTrackers] used when the torrent exposes no announce list
 * @returns {{ infoHash: string, name: string, files: {path: string, size: number}[], trackers: string[] }}
 */
export function describeTorrentArtifact(torrent, fallbackTrackers = []) {
    const infoHash = text(torrent?.infoHash).toLowerCase();
    if (!INFOHASH_RE.test(infoHash)) throw new Error('A seeded torrent with a valid infohash is required.');

    const name = text(torrent?.name) || 'web25-site';
    const rawFiles = Array.isArray(torrent?.files) ? torrent.files : [];

    const files = rawFiles.slice(0, NOSNS_CONFIG.MAX_FILE_TAGS).map((file) => {
        const raw = text(file?.path) || text(file?.name);
        // WebTorrent prefixes multi-file paths with the torrent name; the
        // event should advertise the entry, not the container.
        const normalized = raw.replace(/\\/g, '/').replace(new RegExp(`^${escapeRegExp(name)}/`), '');
        return { path: normalized || text(file?.name), size: Number(file?.length) || 0 };
    });

    const announce = Array.isArray(torrent?.announce) ? torrent.announce.map(text).filter(Boolean) : [];
    const trackers = announce.length > 0 ? announce : (fallbackTrackers || []).map(text).filter(Boolean);

    return { infoHash, name, files, trackers: [...new Set(trackers)] };
}

/** @param {string} value */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the unsigned NIP-35 event template for a finished deployment.
 *
 * The WEB25 proof is *mirrored* from the `.torrentchain` artifact created
 * during this same deployment — the signed message and signature are copied
 * verbatim. No second payload is derived and no second EVM signature is
 * produced; the website was already signed when `.torrentchain` was generated.
 *
 * @param {{
 *   torrent: any,
 *   chainArtifact: { payload: any, message: string, signature: string },
 *   siteName?: string,
 *   trackers?: string[],
 *   createdAtSeconds?: number
 * }} params
 * @returns {{ kind: number, created_at: number, tags: string[][], content: string }}
 */
export function buildNosnsEventTemplate({
    torrent,
    chainArtifact,
    siteName = '',
    trackers = [],
    category = '',
    createdAtSeconds = Math.floor(Date.now() / 1000)
}) {
    const artifact = describeTorrentArtifact(torrent, trackers);

    const payload = chainArtifact?.payload;
    const message = text(chainArtifact?.message);
    const signature = text(chainArtifact?.signature);
    if (!payload || !message || !signature) {
        throw new Error('A signed .torrentchain artifact is required to publish a NosNS record.');
    }
    if (new TextEncoder().encode(message).length > NOSNS_CONFIG.MAX_PROOF_MESSAGE_BYTES) {
        throw new Error('The .torrentchain signed message is too large to mirror into a NosNS record.');
    }

    if (!category) {
        // Never defaulted. The category decides where the site appears in DTAN,
        // so filing it under `application` because nobody chose is a decision
        // the publisher did not make and cannot see.
        throw new Error('Select a DTAN category before publishing to NosNS.');
    }
    if (!isValidDtanCategory(category)) {
        // An unknown category is one nobody can browse to — exactly the failure
        // the old custom WEB25 category produced.
        throw new Error(`"${category}" is not an official DTAN category.`);
    }

    // NIP-35 uses the torrent name as the event title, and NosNS identification
    // lives entirely in that name. So the title is the real BitTorrent
    // `info.name` verbatim — never a display name derived alongside it, which
    // could drift from what the torrent actually says and leave the entry
    // unfindable by the name it is distributed under.
    const title = text(artifact.name);
    if (!isNosnsTorrentName(title)) {
        throw new Error(
            `The torrent is named "${title}", which is not a NosNS name. It must be seeded with the ` +
                `${NOSNS_TORRENT_SUFFIX} suffix in its BitTorrent info.name.`
        );
    }
    // `siteName` is an assertion, not an input: if the caller believes the site
    // is called something else, that disagreement is a bug worth failing on.
    if (siteName && ensureNosnsTorrentName(siteName) !== title) {
        throw new Error(`Site name "${siteName}" does not match the torrent name "${title}".`);
    }

    /** @type {string[][]} */
    const tags = [
        ['title', title],
        ['x', artifact.infoHash],
        ['i', category]
    ];

    for (const file of artifact.files) tags.push(['file', file.path, `${file.size}`]);
    for (const tracker of artifact.trackers) tags.push(['tracker', tracker]);

    // ── mirrored .torrentchain proof ──────────────────────────────────────
    // `web25-message` is the exact string the wallet signed and is what a
    // verifier must use; the individual tags below are conveniences that must
    // agree with it, and `parseNosnsEvent` rejects the event if they do not.
    // None of this identifies NosNS — the suffix does.
    tags.push([PROOF_TAGS.SCHEMA, text(payload.schema)]);
    tags.push([PROOF_TAGS.PUBLISHER, text(payload.publisher).toLowerCase()]);
    tags.push([PROOF_TAGS.CHAIN_ID, `${payload.chainId ?? ''}`]);
    tags.push([PROOF_TAGS.CREATED_AT, text(payload.createdAt)]);
    tags.push([PROOF_TAGS.MERKLE_ROOT, text(payload.merkleRoot)]);
    if (payload.bundle?.sha256) {
        tags.push([PROOF_TAGS.BUNDLE_SHA256, text(payload.bundle.sha256)]);
        tags.push([PROOF_TAGS.BUNDLE_NAME, text(payload.bundle.name)]);
    }
    tags.push([PROOF_TAGS.SIGNATURE, signature]);
    tags.push([PROOF_TAGS.MESSAGE, message]);

    return {
        kind: NOSNS_EVENT_KIND,
        created_at: createdAtSeconds,
        tags,
        content: `${nosnsDisplayName(title)}\n\nA NosNS static website. Content is distributed over BitTorrent; this entry is directory metadata only.`
    };
}

/**
 * Is this a NosNS website record?
 *
 * The single protocol check: a NIP-35 torrent whose title ends with the
 * canonical suffix. No custom kind, no custom category, no classifier hashtag —
 * a normal DTAN torrent without the suffix is simply not NosNS.
 *
 * The Nostr signature is *not* checked here: the relay pool has already
 * re-verified it locally before any event reaches this module.
 *
 * @param {any} event
 * @returns {boolean}
 */
export function isNosnsEvent(event) {
    if (!event || event.kind !== NOSNS_EVENT_KIND) return false;
    if (!Array.isArray(event.tags)) return false;
    return isNosnsTorrentName(firstTagValue(event.tags, 'title'));
}

/**
 * Normalize a relay event into a NosNS result.
 *
 * Returns `null` for anything that is not a structurally valid WEB25 website
 * entry, so a relay cannot inject unrelated torrents into the listing.
 *
 * The returned `web25VerificationState` starts at `unverified` or `malformed`;
 * only `verifyNosnsProof()` can promote it to `verified`.
 *
 * @param {any} event a Nostr event whose signature the pool already verified
 * @param {{ relayUrl?: string, npubEncode?: (hex: string) => string }} [options]
 * @returns {object|null}
 */
export function parseNosnsEvent(event, { relayUrl = '', npubEncode = null } = {}) {
    if (!isNosnsEvent(event)) return null;

    const tags = event.tags;
    const infohash = firstTagValue(tags, 'x').toLowerCase();
    if (!INFOHASH_RE.test(infohash)) return null;

    const title = firstTagValue(tags, 'title');
    if (!title) return null;

    const torrentFiles = (tags || [])
        .filter((tag) => Array.isArray(tag) && tag[0] === 'file' && text(tag[1]))
        .slice(0, NOSNS_CONFIG.MAX_FILE_TAGS)
        .map((tag) => ({ path: text(tag[1]), size: Number(tag[2]) || 0 }));

    const proof = readProofTags(tags);

    /** @type {any} */
    const result = {
        eventId: event.id,
        /** The protocol value: the real torrent name, suffix included. */
        title,
        /** Display form only — never used as a protocol value. */
        displayName: nosnsDisplayName(title),
        infohash,

        nostrPubkey: event.pubkey,
        npub: typeof npubEncode === 'function' ? safeNpub(npubEncode, event.pubkey) : '',
        createdAt: event.created_at,

        trackers: allTagValues(tags, 'tracker'),
        torrentFiles,

        category: normalizeDtanCategory(firstTagValue(tags, 'i')),
        web25Schema: proof.schema,
        web25Publisher: proof.publisher,
        web25ChainId: proof.chainId,
        web25CreatedAt: proof.createdAt,
        web25MerkleRoot: proof.merkleRoot,
        web25BundleSha256: proof.bundleSha256,
        web25BundleName: proof.bundleName,
        web25Signature: proof.signature,
        web25Message: proof.message,

        web25VerificationState: proof.state,
        sourceRelays: relayUrl ? [relayUrl] : []
    };

    return result;
}

/**
 * @param {(hex: string) => string} encode
 * @param {string} pubkey
 */
function safeNpub(encode, pubkey) {
    try {
        return encode(pubkey);
    } catch (_) {
        return '';
    }
}

/**
 * Extract and self-check the mirrored proof tags.
 *
 * The convenience tags must agree with the signed message they claim to
 * summarise; if they do not, the entry is `malformed` and never verifiable.
 * That closes the gap where an event could display one publisher while proving
 * another.
 *
 * @param {string[][]} tags
 */
function readProofTags(tags) {
    const schema = firstTagValue(tags, PROOF_TAGS.SCHEMA);
    const publisher = firstTagValue(tags, PROOF_TAGS.PUBLISHER).toLowerCase();
    const chainId = firstTagValue(tags, PROOF_TAGS.CHAIN_ID);
    const createdAt = firstTagValue(tags, PROOF_TAGS.CREATED_AT);
    const merkleRoot = firstTagValue(tags, PROOF_TAGS.MERKLE_ROOT);
    const bundleSha256 = firstTagValue(tags, PROOF_TAGS.BUNDLE_SHA256);
    const bundleName = firstTagValue(tags, PROOF_TAGS.BUNDLE_NAME);
    const signature = firstTagValue(tags, PROOF_TAGS.SIGNATURE);
    const message = firstTagValue(tags, PROOF_TAGS.MESSAGE);

    const base = { schema, publisher, chainId, createdAt, merkleRoot, bundleSha256, bundleName, signature, message };

    // No proof at all: a plain NIP-35 torrent in our category. Listable, never
    // verifiable.
    if (!publisher && !signature && !message) {
        return { ...base, state: WEB25_VERIFICATION.UNVERIFIED };
    }

    if (!EVM_ADDRESS_RE.test(publisher)) return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    if (!EVM_SIGNATURE_RE.test(signature)) return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    if (!message) return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    if (new TextEncoder().encode(message).length > NOSNS_CONFIG.MAX_PROOF_MESSAGE_BYTES) {
        return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    }
    if (merkleRoot && !SHA256_RE.test(merkleRoot)) return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    if (bundleSha256 && !SHA256_RE.test(bundleSha256)) return { ...base, state: WEB25_VERIFICATION.MALFORMED };

    let signedPayload;
    try {
        signedPayload = JSON.parse(message);
    } catch (_) {
        return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    }
    if (!signedPayload || typeof signedPayload !== 'object' || Array.isArray(signedPayload)) {
        return { ...base, state: WEB25_VERIFICATION.MALFORMED };
    }

    const disagreements = [
        [schema, text(signedPayload.schema)],
        [publisher, text(signedPayload.publisher).toLowerCase()],
        [chainId, `${signedPayload.chainId ?? ''}`],
        [createdAt, text(signedPayload.createdAt)],
        [merkleRoot, text(signedPayload.merkleRoot)],
        [bundleSha256, text(signedPayload.bundle?.sha256)],
        [bundleName, text(signedPayload.bundle?.name)]
    ].filter(([claimed, signed]) => claimed !== signed);

    if (disagreements.length > 0) return { ...base, state: WEB25_VERIFICATION.MALFORMED };

    return { ...base, signedPayload, state: WEB25_VERIFICATION.UNVERIFIED };
}

/**
 * Verify the mirrored EVM proof of a parsed NosNS record.
 *
 * A valid Nostr signature says only who wrote the directory entry. This is the
 * separate question of whether the WEB25 publisher proof inside it holds, and
 * only this can move a result to `verified`.
 *
 * @param {any} result from `parseNosnsEvent`
 * @param {(message: string, signature: string, address: string) => Promise<boolean>} verifyEvmSignature
 * @returns {Promise<any>} the result with an updated `web25VerificationState`
 */
export async function verifyNosnsProof(result, verifyEvmSignature) {
    if (!result) return result;
    if (result.web25VerificationState === WEB25_VERIFICATION.MALFORMED) return result;
    if (!result.web25Publisher || !result.web25Signature || !result.web25Message) {
        return { ...result, web25VerificationState: WEB25_VERIFICATION.UNVERIFIED };
    }

    let verified = false;
    try {
        verified = await verifyEvmSignature(result.web25Message, result.web25Signature, result.web25Publisher);
    } catch (_) {
        verified = false;
    }

    return {
        ...result,
        web25VerificationState: verified ? WEB25_VERIFICATION.VERIFIED : WEB25_VERIFICATION.INVALID
    };
}

/**
 * Cross-check a NosNS entry against the `.torrentchain` that was actually
 * downloaded. The manifest wins in every disagreement: directory metadata that
 * does not match it is untrusted, whatever its Nostr signature said.
 *
 * @param {any} result from `parseNosnsEvent`
 * @param {any} manifest the downloaded `.torrentchain` manifest
 * @returns {{ matches: boolean, mismatches: string[] }}
 */
export function matchesDownloadedManifest(result, manifest) {
    const mismatches = [];
    const payload = manifest?.payload || {};

    /** @param {string} field @param {string} claimed @param {string} actual */
    const compare = (field, claimed, actual) => {
        if (!claimed) return;
        if (claimed.toLowerCase() !== `${actual || ''}`.toLowerCase()) mismatches.push(field);
    };

    compare('publisher', result?.web25Publisher, payload.publisher);
    compare('merkleRoot', result?.web25MerkleRoot, payload.merkleRoot);
    compare('bundleSha256', result?.web25BundleSha256, payload.bundle?.sha256);
    compare('signature', result?.web25Signature, manifest?.signature);
    if (result?.web25Message && result.web25Message !== manifest?.message) mismatches.push('message');

    return { matches: mismatches.length === 0, mismatches };
}
