// @ts-check

import { bdecode, bencode, decodeUtf8 } from './BencodeCodec.js';
import { signPublishPayload, verifyPublishSignature } from '../auth/SigningService.js';

function toHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

export async function buildSignedTorrentPayload(input) {
    const payload = {
        torrentHash: input.torrentHash,
        publisher: input.publisher,
        chainId: input.chainId
    };

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const digestHex = `0x${toHex(new Uint8Array(digest))}`;

    return { payload, digestHex };
}

export async function createSignedTorrentArtifact({ torrentFile, torrentHash, publisher, chainId, identityType }) {
    const { payload, digestHex } = await buildSignedTorrentPayload({ torrentHash, publisher, chainId });
    const signResult = await signPublishPayload(payload, identityType, digestHex);

    const decoded = /** @type {Record<string, any>} */ (bdecode(torrentFile));
    decoded.publisher = publisher;
    decoded.signature = signResult.signature;
    decoded.signature_algorithm = 'EVM_SECP256K1';
    decoded.signed_at = new Date().toISOString();

    const signedTorrent = bencode(decoded);

    return {
        signedTorrent,
        signature: signResult.signature,
        signatureAlgorithm: 'EVM_SECP256K1',
        signedAt: decodeUtf8(decoded.signed_at),
        signingPayload: payload,
        signingDigest: digestHex
    };
}

export async function readSignedTorrentMetadata(torrentBuffer, chainId = 1) {
    const decoded = /** @type {Record<string, any>} */ (bdecode(torrentBuffer));
    const publisher = decodeUtf8(decoded.publisher);
    const signature = decodeUtf8(decoded.signature);
    const signatureAlgorithm = decodeUtf8(decoded.signature_algorithm);
    const signedAt = decodeUtf8(decoded.signed_at);

    const info = decoded.info;
    if (!info || !publisher || !signature) {
        return null;
    }

    const infoEncoded = bencode(info);
    const infoHashBuffer = await crypto.subtle.digest('SHA-1', infoEncoded);
    const torrentHash = toHex(new Uint8Array(infoHashBuffer));

    const { digestHex } = await buildSignedTorrentPayload({ torrentHash, publisher, chainId });
    const verified = await verifyPublishSignature(digestHex, signature, publisher);

    return { publisher, signature, signatureAlgorithm, signedAt, torrentHash, verified, digestHex };
}
