// @ts-check

import { bdecode, bencode, decodeUtf8 } from '../torrent/BencodeCodec.js';

export const GOFILE_MIRROR_SCHEMA = 'web25-gofile-mirror-v1';
export const GOFILE_MIRROR_FILENAME = 'web25-gofile-mirror-v1.json';

const toBase64 = (bytes) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
};
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const normalizePath = (value) => `${value || ''}`.replace(/\\/g, '/').replace(/^\/+/, '');

/** Encode exact metainfo and payload entries into one transport object. */
export async function encodeGoFileMirror({ torrentFile, files }) {
    const torrentBytes = torrentFile instanceof Uint8Array ? torrentFile : new Uint8Array(torrentFile);
    const entries = [];
    for (const file of files) {
        entries.push({
            path: normalizePath(file.path || file.webkitRelativePath || file.name),
            contentType: file.type || 'application/octet-stream',
            bytesBase64: toBase64(new Uint8Array(await file.arrayBuffer()))
        });
    }
    const wire = JSON.stringify({
        schema: GOFILE_MIRROR_SCHEMA,
        torrentBase64: toBase64(torrentBytes),
        files: entries
    });
    return new TextEncoder().encode(wire);
}

export function decodeGoFileMirror(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let value;
    try {
        value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
        throw new Error('GoFile mirror is not valid JSON.');
    }
    if (
        value?.schema !== GOFILE_MIRROR_SCHEMA ||
        typeof value.torrentBase64 !== 'string' ||
        !Array.isArray(value.files)
    ) {
        throw new Error('Unsupported GoFile mirror schema.');
    }
    const seen = new Set();
    const files = value.files.map((file) => {
        const path = normalizePath(file?.path);
        if (!path || path.includes('..') || seen.has(path) || typeof file.bytesBase64 !== 'string') {
            throw new Error('GoFile mirror contains an invalid payload path.');
        }
        seen.add(path);
        return {
            path,
            contentType: `${file.contentType || 'application/octet-stream'}`,
            bytes: fromBase64(file.bytesBase64)
        };
    });
    return { torrentFile: fromBase64(value.torrentBase64), files };
}

/** Verify info-hash and every BitTorrent v1 piece before exposing payload files. */
export async function verifyGoFileMirror(mirror, requestedHash) {
    const metainfo = bdecode(mirror.torrentFile);
    const info = metainfo?.info;
    if (!info) throw new Error('Mirrored torrent metainfo has no info dictionary.');
    const computedHash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', bencode(info))));
    if (computedHash !== `${requestedHash}`.toLowerCase()) throw new Error('GoFile mirror torrent info hash mismatch.');

    const rootName = decodeUtf8(info.name);
    const metadataFiles = Array.isArray(info.files)
        ? info.files.map((item) => ({
              path: item.path.map(decodeUtf8).join('/'),
              length: Number(item.length)
          }))
        : [{ path: rootName, length: Number(info.length) }];
    const byPath = new Map(mirror.files.map((file) => [normalizePath(file.path), file]));
    const ordered = metadataFiles.map((expected) => {
        const file = byPath.get(expected.path) || byPath.get(normalizePath(`${rootName}/${expected.path}`));
        if (!file || file.bytes.length !== expected.length) {
            throw new Error(`GoFile mirror payload mismatch: ${expected.path}`);
        }
        return file;
    });
    if (ordered.length !== mirror.files.length) {
        throw new Error('GoFile mirror contains payload files outside torrent metadata.');
    }

    const payloadLength = ordered.reduce((total, file) => total + file.bytes.length, 0);
    const payload = new Uint8Array(payloadLength);
    let offset = 0;
    for (const file of ordered) {
        payload.set(file.bytes, offset);
        offset += file.bytes.length;
    }
    const pieceLength = Number(info['piece length']);
    const expectedPieces = info.pieces;
    if (!(expectedPieces instanceof Uint8Array) || expectedPieces.length % 20 !== 0 || pieceLength <= 0) {
        throw new Error('Mirrored torrent has invalid piece metadata.');
    }
    const count = Math.ceil(payload.length / pieceLength);
    if (expectedPieces.length !== count * 20) throw new Error('Mirrored torrent piece count mismatch.');
    for (let index = 0; index < count; index += 1) {
        const actual = new Uint8Array(
            await crypto.subtle.digest('SHA-1', payload.slice(index * pieceLength, (index + 1) * pieceLength))
        );
        const expected = expectedPieces.slice(index * 20, index * 20 + 20);
        if (toHex(actual) !== toHex(expected)) {
            throw new Error(`GoFile mirror piece ${index} failed SHA-1 verification.`);
        }
    }
    return { infoHash: computedHash, files: ordered, metainfo };
}

export function createMirrorTorrentAdapter(verified) {
    return {
        files: verified.files.map((entry) => ({
            name: entry.path,
            path: entry.path,
            length: entry.bytes.length,
            progress: 1,
            select() {},
            getBuffer(callback) {
                callback(null, entry.bytes);
            }
        })),
        length: verified.files.reduce((total, entry) => total + entry.bytes.length, 0),
        progress: 1,
        done: true,
        destroy(callback) {
            callback?.();
        }
    };
}
