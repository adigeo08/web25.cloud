// @ts-check
/**
 * What it takes to put somebody else's site back on the air.
 *
 * Reseeding is not "upload these files again": the info hash *is* the site's
 * address, so a re-seed that hashes to anything else is a different site under
 * a link nobody shared. The info dictionary is what has to be reproduced
 * exactly — the torrent name, the piece length, and the payload files with
 * their paths, sizes and order — and all four of those live in the `.torrent`
 * that came down with the site.
 *
 * So this module reads the metainfo rather than guessing from what rendered.
 * The rendered site is not the payload: in bundle mode a deployment is two
 * files on the wire (`.torrentchain` and one gzip bundle) that unpack into the
 * dozens of files the visitor sees, and re-gzipping those would not give the
 * same bytes back. The metainfo names the real entries, in the real order, and
 * everything here is checked against it before a single byte is announced.
 */

import { bdecode, bencode, decodeUtf8 } from '../../torrent/BencodeCodec.js';

const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** @param {any} value */
export function toPayloadBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return new Uint8Array(value);
    return null;
}

/** One spelling for a path, whatever platform or transport wrote it. */
export const normalizePayloadPath = (value) => `${value || ''}`.replace(/\\/g, '/').replace(/^\/+/, '');

/**
 * The info dictionary, read for the four things that decide the info hash.
 *
 * @param {Uint8Array|ArrayBuffer} torrentFile
 * @returns {{ name: string, pieceLength: number, entries: { path: string, length: number }[] }}
 */
export function readMetainfo(torrentFile) {
    const bytes = toPayloadBytes(torrentFile);
    if (!bytes || bytes.length === 0) throw new Error('This site arrived without its .torrent metadata.');

    const metainfo = bdecode(bytes);
    const info = metainfo?.info;
    if (!info) throw new Error('The .torrent metadata has no info dictionary.');

    const name = decodeUtf8(info.name);
    const pieceLength = Number(info['piece length']) || 0;
    if (!name || pieceLength <= 0) throw new Error('The .torrent metadata is missing its name or piece length.');

    const entries = Array.isArray(info.files)
        ? info.files.map((item) => ({
              path: normalizePayloadPath((item?.path || []).map(decodeUtf8).join('/')),
              length: Number(item?.length) || 0
          }))
        : [{ path: normalizePayloadPath(name), length: Number(info.length) || 0 }];

    if (entries.some((entry) => !entry.path)) throw new Error('The .torrent metadata names an empty path.');
    return { name, pieceLength, entries };
}

/**
 * The info hash the metainfo claims to be, computed rather than trusted.
 * @param {Uint8Array|ArrayBuffer} torrentFile
 * @returns {Promise<string>}
 */
export async function infoHashOfMetainfo(torrentFile) {
    const bytes = toPayloadBytes(torrentFile);
    if (!bytes) throw new Error('This site arrived without its .torrent metadata.');
    const info = bdecode(bytes)?.info;
    if (!info) throw new Error('The .torrent metadata has no info dictionary.');
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', bencode(info))));
}

/**
 * Line the bytes we hold up against the entries the metainfo lists.
 *
 * Transports disagree about the root folder: WebTorrent reports
 * `sitename/index.html` where the metainfo says `index.html`, and the GoFile
 * mirror stores the bare relative path. Both are accepted, nothing else is —
 * and a file whose length does not match the metainfo is a different file, so
 * it is refused rather than seeded under a hash it will not produce.
 *
 * @param {{ torrentFile: Uint8Array|ArrayBuffer, files: { path: string, type?: string, bytes: Uint8Array }[] }} source
 * @returns {{ torrentFile: Uint8Array, name: string, pieceLength: number, length: number,
 *            files: { path: string, type: string, bytes: Uint8Array }[] }}
 */
export function buildReseedPayload({ torrentFile, files }) {
    const metainfoBytes = toPayloadBytes(torrentFile);
    if (!metainfoBytes) throw new Error('This site arrived without its .torrent metadata.');
    const { name, pieceLength, entries } = readMetainfo(metainfoBytes);

    /** @type {Map<string, { path: string, type?: string, bytes: Uint8Array }>} */
    const byPath = new Map();
    for (const file of files || []) {
        const bytes = toPayloadBytes(file?.bytes);
        if (!bytes) continue;
        byPath.set(normalizePayloadPath(file.path), { ...file, bytes });
    }

    const ordered = entries.map((entry) => {
        const held = byPath.get(entry.path) || byPath.get(normalizePayloadPath(`${name}/${entry.path}`));
        if (!held) throw new Error(`The payload of this site is incomplete: ${entry.path} is missing.`);
        if (held.bytes.length !== entry.length) {
            throw new Error(`The payload of this site does not match its .torrent: ${entry.path}.`);
        }
        // The metainfo's spelling is the one that reproduces the info hash.
        return { path: entry.path, type: held.type || 'application/octet-stream', bytes: held.bytes };
    });

    return {
        torrentFile: metainfoBytes,
        name,
        pieceLength,
        length: ordered.reduce((total, file) => total + file.bytes.length, 0),
        files: ordered
    };
}

/**
 * Who published this site, read from the payload's own signature manifest.
 *
 * A reseeded site is somebody else's work and its card has to say so, which
 * means the publisher on it cannot come from whoever is signed in here. The
 * `.torrentchain` travelled inside the payload and was verified before the
 * site was allowed to render, so it is the honest source for the attribution.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @returns {{ publisher: string, signature: string, signatureAlgorithm: string, signedAt: string }}
 */
export function readPublisherFromPayload(files) {
    const blank = { publisher: '', signature: '', signatureAlgorithm: '', signedAt: '' };
    const chain = (files || []).find((file) => {
        const path = normalizePayloadPath(file?.path).toLowerCase();
        return path === '.torrentchain' || path.endsWith('/.torrentchain');
    });
    if (!chain?.bytes) return blank;

    try {
        const manifest = JSON.parse(new TextDecoder().decode(chain.bytes));
        return {
            publisher: `${manifest?.payload?.publisher || ''}`,
            signature: `${manifest?.signature || ''}`,
            signatureAlgorithm: `${manifest?.signatureAlgorithm || ''}`,
            signedAt: `${manifest?.payload?.createdAt || ''}`
        };
    } catch (_) {
        // An unreadable manifest costs the attribution, never the reseed: the
        // bytes are the same bytes either way.
        return blank;
    }
}
