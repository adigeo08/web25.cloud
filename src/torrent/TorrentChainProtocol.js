// @ts-check

import { signPublishPayload, verifyPublishSignature } from '../auth/SigningService.js';

function toHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

async function sha256Bytes(data) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(digest);
}

function hexToBytes(hex) {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    const pairs = normalized.match(/.{1,2}/g) || [];
    return new Uint8Array(pairs.map((pair) => parseInt(pair, 16)));
}

export async function buildTorrentChainDraft(inMemoryFiles) {
    const fileEntries = [];
    let totalBytes = 0;

    for (const file of inMemoryFiles) {
        const path = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!path || path === '.torrentchain') continue;

        const buffer = await file.arrayBuffer();
        const sha256 = toHex(await sha256Bytes(buffer));
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
        level = [await sha256Bytes(new TextEncoder().encode('empty-bundle'))];
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
        merkleRoot: toHex(level[0])
    };
}

export async function createTorrentChainArtifact({
    inMemoryFiles,
    publisher,
    chainId,
    identityType,
    createdAt,
    bundle = null,
    filesSemantics = 'torrent-entries'
}) {
    const draft = await buildTorrentChainDraft(inMemoryFiles);
    const payload = {
        schema: 'web25-torrentchain-v1',
        publisher,
        chainId,
        createdAt,
        fileCount: draft.fileCount,
        totalBytes: draft.totalBytes,
        merkleRoot: draft.merkleRoot,
        filesSemantics,
        ...(bundle ? { bundle } : {})
    };
    const signed = await signPublishPayload(payload, identityType);

    const manifest = {
        schema: payload.schema,
        payload: signed.payload,
        message: signed.message,
        signature: signed.signature,
        signatureAlgorithm: 'EVM_SECP256K1',
        files: draft.fileEntries
    };

    return {
        manifest,
        content: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        signature: signed.signature,
        signatureAlgorithm: 'EVM_SECP256K1',
        payload: signed.payload,
        message: signed.message
    };
}

export async function verifyTorrentChainManifest(manifest) {
    if (!manifest?.payload || !manifest?.signature || !manifest?.payload?.publisher) {
        return { verified: false, reason: 'Missing payload/signature/publisher' };
    }

    const verified = await verifyPublishSignature(
        manifest.message || JSON.stringify(manifest.payload),
        manifest.signature,
        manifest.payload.publisher
    );

    return {
        verified,
        publisher: manifest.payload.publisher,
        payload: manifest.payload
    };
}
