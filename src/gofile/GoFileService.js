// @ts-check

/** The only guest operation documented by GoFile. */
export const GOFILE_UPLOAD_ENDPOINT = 'https://upload.gofile.io/uploadfile';
export const GOFILE_CONTENT_ENDPOINT = 'https://api.gofile.io/contents';

/** A transport/protocol error which is safe to show to a user. */
export class GoFileError extends Error {
    /** @param {string} code @param {string} message @param {{ status?: number, cause?: unknown }} [details] */
    constructor(code, message, details = {}) {
        super(message, details.cause ? { cause: details.cause } : undefined);
        this.name = 'GoFileError';
        this.code = code;
        this.status = details.status || null;
    }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Minimal GoFile guest uploader. Public sharing and programmatic byte access
 * are intentionally reported as separate capabilities.
 */
export class GoFileService {
    /** @param {{ fetchImpl?: typeof fetch, endpoint?: string }} [options] */
    constructor({ fetchImpl = globalThis.fetch, endpoint = GOFILE_UPLOAD_ENDPOINT } = {}) {
        if (typeof fetchImpl !== 'function') throw new TypeError('GoFileService requires fetch.');
        this.fetchImpl = fetchImpl;
        this.endpoint = endpoint;
    }

    /**
     * @param {Blob} file
     * @param {{ token?: string|null, folderId?: string|null, signal?: AbortSignal, filename?: string }} [options]
     */
    async upload(file, { token = null, folderId = null, signal, filename = 'web25-gofile-mirror-v1' } = {}) {
        if (!(file instanceof Blob)) throw new TypeError('GoFile upload requires a Blob or File.');
        const form = new FormData();
        form.append('file', file, filename);
        if (folderId) form.append('folderId', validId(folderId, 'folder id'));

        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        let response;
        try {
            response = await this.fetchImpl(this.endpoint, { method: 'POST', headers, body: form, signal });
        } catch (cause) {
            if (signal?.aborted) throw new GoFileError('aborted', 'GoFile upload was cancelled.', { cause });
            throw new GoFileError('network', 'GoFile upload could not be reached.', { cause });
        }
        if (!response.ok) {
            const code = response.status === 401 || response.status === 403 ? 'invalid_token' : 'http';
            throw new GoFileError(code, `GoFile upload failed (HTTP ${response.status}).`, { status: response.status });
        }

        let body;
        try {
            body = await response.json();
        } catch (cause) {
            throw new GoFileError('invalid_response', 'GoFile returned an unreadable upload response.', { cause });
        }
        if (body?.status !== 'ok' || !body?.data || typeof body.data !== 'object') {
            throw new GoFileError('api', 'GoFile rejected the upload.');
        }

        const data = body.data;
        const id = validId(data.id, 'file id');
        const parentFolder = optionalId(data.parentFolder, 'parent folder id');
        const parentFolderCode = optionalId(data.parentFolderCode, 'parent folder code');
        const downloadPage = optionalHttpsUrl(data.downloadPage);
        const servers = Array.isArray(data.servers)
            ? data.servers.filter((server) => typeof server === 'string' && SAFE_ID.test(server)).slice(0, 20)
            : [];

        // The documented contents route is keyed by content/folder id. Keep
        // the shorter share code separately for the human download page.
        const mirrorLocator = parentFolder;
        const result = {
            id,
            parentFolder,
            parentFolderCode,
            downloadPage,
            servers,
            // A share code/page proves that a public share exists, not that an
            // unrelated browser can resolve it through the documented API.
            mirrorLocator,
            publicShareAvailable: Boolean(parentFolderCode && downloadPage),
            programmaticReadVerified: false
        };
        if (typeof data.guestToken === 'string' && data.guestToken.length > 0) {
            // Keep credentials out of JSON/log/UI projection while allowing the
            // deploy coordinator to persist the newly issued secret immediately.
            Object.defineProperty(result, 'guestToken', { value: data.guestToken, enumerable: false });
        }
        return result;
    }

    /** Resolve a public share and fetch its single WEB25 mirror object. */
    async downloadPublicMirror(locator, { signal } = {}) {
        const safeLocator = validId(locator, 'mirror locator');
        let metadataResponse;
        try {
            metadataResponse = await this.fetchImpl(`${GOFILE_CONTENT_ENDPOINT}/${encodeURIComponent(safeLocator)}`, {
                signal
            });
        } catch (cause) {
            throw new GoFileError(signal?.aborted ? 'aborted' : 'network', 'GoFile mirror metadata is unavailable.', {
                cause
            });
        }
        if (!metadataResponse.ok) {
            throw new GoFileError('http', `GoFile mirror metadata failed (HTTP ${metadataResponse.status}).`, {
                status: metadataResponse.status
            });
        }
        let body;
        try {
            body = await metadataResponse.json();
        } catch (cause) {
            throw new GoFileError('invalid_response', 'GoFile mirror metadata is unreadable.', { cause });
        }
        if (body?.status !== 'ok') throw new GoFileError('api', 'GoFile could not resolve the public mirror.');
        const candidates = collectFiles(body.data);
        const mirror = candidates.find((file) => file.name === 'web25-gofile-mirror-v1.json') || candidates[0];
        if (!mirror?.link) throw new GoFileError('invalid_response', 'GoFile public share contains no mirror file.');

        let fileUrl;
        try {
            fileUrl = new URL(mirror.link);
            if (fileUrl.protocol !== 'https:') throw new Error('not HTTPS');
        } catch (_) {
            throw new GoFileError('invalid_response', 'GoFile returned an invalid mirror byte URL.');
        }
        let bytesResponse;
        try {
            bytesResponse = await this.fetchImpl(fileUrl.href, { signal });
        } catch (cause) {
            throw new GoFileError(signal?.aborted ? 'aborted' : 'network', 'GoFile mirror bytes are unavailable.', {
                cause
            });
        }
        if (!bytesResponse.ok) {
            throw new GoFileError('http', `GoFile mirror download failed (HTTP ${bytesResponse.status}).`, {
                status: bytesResponse.status
            });
        }
        return new Uint8Array(await bytesResponse.arrayBuffer());
    }
}

function collectFiles(node, output = []) {
    if (!node || typeof node !== 'object') return output;
    if (node.type === 'file' && typeof node.link === 'string') output.push(node);
    const children = node.children;
    if (children && typeof children === 'object') {
        Object.values(children).forEach((child) => collectFiles(child, output));
    }
    return output;
}

function validId(value, label) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
        throw new GoFileError('invalid_response', `GoFile returned an invalid ${label}.`);
    }
    return value;
}

function optionalId(value, label) {
    return value === null || value === undefined ? null : validId(value, label);
}

function optionalHttpsUrl(value) {
    if (value === null || value === undefined) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'gofile.io') throw new Error('not a GoFile HTTPS URL');
        return url.href;
    } catch (_) {
        throw new GoFileError('invalid_response', 'GoFile returned an invalid download page.');
    }
}
