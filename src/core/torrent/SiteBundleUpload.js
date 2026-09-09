// @ts-check

import { decodeSiteBundleGzip, SITE_BUNDLE_SCHEMA } from '../../torrent/SiteBundleCodec.js';
import { handleDroppedFiles as handleDroppedFilesBase } from './TorrentUploader.js';

/**
 * The deploy UI accepts both a normal folder and the portable Web25 site-bundle
 * representation. A bundle must be expanded before Preview & Protect so the
 * sandbox can resolve index.html, stylesheets, scripts and assets exactly as it
 * would for a folder upload.
 */

function isBundleFilename(name) {
    const normalized = `${name || ''}`.trim().toLowerCase();
    return normalized.endsWith('.json') || normalized.endsWith('.json.gz');
}

function normalizeBundlePath(path) {
    const normalized = `${path || ''}`.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/');
    if (!normalized || parts.some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Invalid site-bundle path: ${path || '(empty)'}`);
    }
    return parts.join('/');
}

function base64ToBytes(base64) {
    if (typeof atob === 'function') {
        const binary = atob(`${base64 || ''}`);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(`${base64 || ''}`, 'base64'));
    throw new Error('Base64 decoding is unavailable in this runtime.');
}

function decodePlainBundle(bytes) {
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
        throw new Error('The selected JSON is not a valid Web25 site bundle.');
    }

    if (parsed?.schema !== SITE_BUNDLE_SCHEMA || !Array.isArray(parsed.files)) {
        throw new Error(`Expected ${SITE_BUNDLE_SCHEMA} with a files array.`);
    }

    return {
        schema: parsed.schema,
        entryPath: parsed.entryPath || null,
        files: parsed.files.map((file) => {
            if (file?.encoding !== 'base64') {
                throw new Error(`Unsupported bundle file encoding: ${file?.encoding || '(missing)'}`);
            }
            const bytesBase64 = typeof file.bytesBase64 === 'string' ? file.bytesBase64 : '';
            if (!bytesBase64) {
                throw new Error(`Missing base64 payload for bundle file: ${file?.path || '(unknown)'}`);
            }
            return {
                path: normalizeBundlePath(file.path),
                contentType: `${file.contentType || 'application/octet-stream'}`,
                bytes: base64ToBytes(bytesBase64)
            };
        })
    };
}

/**
 * Decode one dropped portable Web25 bundle into the same in-memory file shape
 * used by folder uploads. Exported for focused tests.
 *
 * @param {{ name?: string, arrayBuffer: () => Promise<ArrayBuffer> }} source
 */
export async function decodeDroppedSiteBundle(source) {
    const name = `${source?.name || ''}`.toLowerCase();
    if (!isBundleFilename(name)) return null;

    const bytes = new Uint8Array(await source.arrayBuffer());
    const decoded = name.endsWith('.gz') ? await decodeSiteBundleGzip(bytes) : decodePlainBundle(bytes);

    const seen = new Set();
    const files = decoded.files.map((file) => {
        const path = normalizeBundlePath(file.path);
        if (seen.has(path)) throw new Error(`Duplicate file in site bundle: ${path}`);
        seen.add(path);
        return {
            path,
            contentType: file.contentType || 'application/octet-stream',
            bytes: file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || [])
        };
    });

    if (files.length === 0) throw new Error('The Web25 site bundle contains no files.');
    return { files, entryPath: decoded.entryPath || null };
}

/**
 * Override the generic drop handler only for one portable site bundle. All
 * other uploads continue through TorrentUploader unchanged.
 */
export async function handleDroppedFiles(files) {
    if (!Array.isArray(files) || files.length !== 1 || !isBundleFilename(files[0]?.name)) {
        return handleDroppedFilesBase.call(this, files);
    }

    // Preserve the existing readiness behavior: TorrentUploader schedules a
    // retry through this same prototype method once WebTorrent is ready.
    if (!this.clientReady || !this.client) {
        return handleDroppedFilesBase.call(this, files);
    }

    try {
        const decoded = await decodeDroppedSiteBundle(files[0]);
        if (!decoded) return handleDroppedFilesBase.call(this, files);

        const virtualFiles = decoded.files.map((file) =>
            this.createVirtualBundleFile(file.path, file.bytes, file.contentType)
        );
        this.log(
            `Expanded ${files[0].name} into ${virtualFiles.length} staged site files before Preview & Protect.`
        );

        return this.handleFolderUpload(virtualFiles);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`Could not expand dropped site bundle: ${message}`);
        this.toast?.error?.(message, 'Invalid site bundle');
        return false;
    }
}
