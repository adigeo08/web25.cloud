// @ts-check

const BUNDLE_SCHEMA = 'web25-sitebundle-v1';

function toHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToBytes(base64) {
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(base64, 'base64'));
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * @param {ArrayBufferLike|Uint8Array} input
 */
function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    return new Uint8Array(input);
}

async function gzipBytes(data) {
    if (typeof CompressionStream !== 'undefined') {
        const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
        const compressed = await new Response(stream).arrayBuffer();
        return new Uint8Array(compressed);
    }
    throw new Error('CompressionStream(gzip) is not supported in this browser runtime');
}

async function gunzipBytes(data) {
    if (typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
        const decompressed = await new Response(stream).arrayBuffer();
        return new Uint8Array(decompressed);
    }
    throw new Error('DecompressionStream(gzip) is not supported in this browser runtime');
}

/**
 * @param {{path:string, contentType:string, bytes:Uint8Array}[]} files
 */
export function buildDeterministicBundleObject(files) {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    return {
        schema: BUNDLE_SCHEMA,
        files: sorted.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            encoding: 'base64',
            bytesBase64: bytesToBase64(file.bytes)
        }))
    };
}

export function canonicalizeBundle(bundle) {
    const canonical = {
        schema: bundle.schema,
        files: bundle.files.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            encoding: file.encoding,
            bytesBase64: file.bytesBase64
        }))
    };
    if (bundle.entryPath) canonical.entryPath = bundle.entryPath;
    return JSON.stringify(canonical);
}

export async function sha256Hex(canonicalBytes) {
    const digest = await crypto.subtle.digest('SHA-256', canonicalBytes);
    return toHex(new Uint8Array(digest));
}

export async function encodeSiteBundleGzip(files, options = {}) {
    const bundle = buildDeterministicBundleObject(files);
    if (options.entryPath) {
        bundle.entryPath = options.entryPath;
    }
    const canonicalJson = canonicalizeBundle(bundle);
    const canonicalBytes = new TextEncoder().encode(canonicalJson);
    const sha256 = await sha256Hex(canonicalBytes);
    const gzipEncoded = await gzipBytes(canonicalBytes);

    return {
        schema: BUNDLE_SCHEMA,
        canonicalJson,
        canonicalBytes,
        sha256,
        gzipBytes: gzipEncoded,
        bundle
    };
}

export async function decodeSiteBundleGzip(gzipEncodedBytes) {
    const canonicalBytes = await gunzipBytes(toUint8Array(gzipEncodedBytes));
    const canonicalJson = new TextDecoder().decode(canonicalBytes);
    const parsed = JSON.parse(canonicalJson);

    if (parsed?.schema !== BUNDLE_SCHEMA || !Array.isArray(parsed.files)) {
        throw new Error('Invalid site bundle schema');
    }

    const files = parsed.files.map((file) => {
        if (file.encoding !== 'base64') {
            throw new Error(`Unsupported bundle file encoding: ${file.encoding}`);
        }
        return {
            path: file.path,
            contentType: file.contentType,
            bytes: base64ToBytes(file.bytesBase64)
        };
    });

    const sha256 = await sha256Hex(canonicalBytes);

    return {
        schema: parsed.schema,
        files,
        entryPath: parsed.entryPath,
        canonicalBytes,
        canonicalJson,
        sha256
    };
}

export const SITE_BUNDLE_SCHEMA = BUNDLE_SCHEMA;
export const SITE_BUNDLE_FILE_NAME = 'site.bundle.json.gz';
export const supportsNativeGzipStreams =
    typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
