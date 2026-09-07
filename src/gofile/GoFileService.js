// @ts-check

/** The only guest operation documented by GoFile. */
export const GOFILE_UPLOAD_ENDPOINT = 'https://upload.gofile.io/uploadfile';
export const GOFILE_CONTENT_ENDPOINT = 'https://api.gofile.io/contents';

/**
 * GoFile is best-effort fallback transport, never the primary one, so every
 * request is bounded. A stalled GoFile call must cost the mirror and nothing
 * else: not the deployment, not the resolver, not the loading overlay.
 */
export const GOFILE_UPLOAD_TIMEOUT_MS = 30000;
export const GOFILE_METADATA_TIMEOUT_MS = 20000;
export const GOFILE_DOWNLOAD_TIMEOUT_MS = 30000;

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
const MIRROR_FILENAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Bound one request by wall clock, keeping any caller cancellation intact. */
function boundedSignal(timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) return timeout;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Caller cancellation wins over the deadline; both stay distinguishable. */
function transportError(cause, signal, timeoutMs, subject) {
    if (signal?.aborted) return new GoFileError('aborted', `${subject} was cancelled.`, { cause });
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
        return new GoFileError('timeout', `${subject} timed out after ${Math.round(timeoutMs / 1000)}s.`, { cause });
    }
    return new GoFileError('network', `${subject} could not be reached.`, { cause });
}

/**
 * Minimal GoFile guest uploader. Public sharing and programmatic byte access
 * are intentionally reported as separate capabilities.
 */
export class GoFileService {
    /**
     * @param {{ fetchImpl?: typeof fetch, endpoint?: string, uploadTimeoutMs?: number,
     *           metadataTimeoutMs?: number, downloadTimeoutMs?: number }} [options]
     */
    constructor({
        fetchImpl = globalThis.fetch,
        endpoint = GOFILE_UPLOAD_ENDPOINT,
        uploadTimeoutMs = GOFILE_UPLOAD_TIMEOUT_MS,
        metadataTimeoutMs = GOFILE_METADATA_TIMEOUT_MS,
        downloadTimeoutMs = GOFILE_DOWNLOAD_TIMEOUT_MS
    } = {}) {
        if (typeof fetchImpl !== 'function') throw new TypeError('GoFileService requires fetch.');
        this.fetchImpl = fetchImpl;
        this.endpoint = endpoint;
        this.uploadTimeoutMs = uploadTimeoutMs;
        this.metadataTimeoutMs = metadataTimeoutMs;
        this.downloadTimeoutMs = downloadTimeoutMs;
    }

    /**
     * Upload one mirror. No folder is ever reused: each deployment gets its own
     * upload, so one locator can never expose another deployment's mirror.
     * @param {Blob} file
     * @param {{ token?: string|null, signal?: AbortSignal, filename: string, timeoutMs?: number }} options
     */
    async upload(file, { token = null, signal, filename, timeoutMs = this.uploadTimeoutMs } = {}) {
        if (!(file instanceof Blob)) throw new TypeError('GoFile upload requires a Blob or File.');
        if (typeof filename !== 'string' || !MIRROR_FILENAME.test(filename)) {
            throw new TypeError('GoFile upload requires a deployment-specific mirror filename.');
        }
        const form = new FormData();
        form.append('file', file, filename);

        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        let response;
        try {
            response = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers,
                body: form,
                signal: boundedSignal(timeoutMs, signal)
            });
        } catch (cause) {
            throw transportError(cause, signal, timeoutMs, 'GoFile upload');
        }
        if (!response.ok) {
            const code = response.status === 401 || response.status === 403 ? 'invalid_token' : 'http';
            throw new GoFileError(code, `GoFile upload failed (HTTP ${response.status}).`, { status: response.status });
        }

        let body;
        try {
            body = await response.json();
        } catch (cause) {
            if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
                throw transportError(cause, signal, timeoutMs, 'GoFile upload');
            }
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

        // The locator is the content id of this one uploaded mirror, never the
        // folder holding it: a folder identifier would grow into a public index
        // of every site this publisher has ever mirrored, and would make each
        // new deployment ambiguous with the ones before it.
        const result = {
            id,
            filename,
            parentFolder,
            parentFolderCode,
            downloadPage,
            servers,
            mirrorLocator: id,
            // A share code/page proves that a public share exists, not that an
            // unrelated browser can resolve it through the documented API.
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

    /**
     * Resolve one mirror locator and fetch the named mirror object it holds.
     * `expectedFilename` selects the deployment: hash verification downstream
     * rejects a wrong mirror, but it is not how the right one is chosen.
     * @param {string} locator
     * @param {{ expectedFilename?: string|null, signal?: AbortSignal, metadataTimeoutMs?: number, downloadTimeoutMs?: number }} [options]
     */
    async downloadPublicMirror(
        locator,
        {
            expectedFilename = null,
            signal,
            metadataTimeoutMs = this.metadataTimeoutMs,
            downloadTimeoutMs = this.downloadTimeoutMs
        } = {}
    ) {
        const safeLocator = validId(locator, 'mirror locator');
        if (expectedFilename !== null && !MIRROR_FILENAME.test(`${expectedFilename}`)) {
            throw new GoFileError('invalid_request', 'GoFile mirror filename is invalid.');
        }
        let metadataResponse;
        try {
            metadataResponse = await this.fetchImpl(`${GOFILE_CONTENT_ENDPOINT}/${encodeURIComponent(safeLocator)}`, {
                signal: boundedSignal(metadataTimeoutMs, signal)
            });
        } catch (cause) {
            throw transportError(cause, signal, metadataTimeoutMs, 'GoFile mirror metadata');
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
            if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
                throw transportError(cause, signal, metadataTimeoutMs, 'GoFile mirror metadata');
            }
            throw new GoFileError('invalid_response', 'GoFile mirror metadata is unreadable.', { cause });
        }
        if (body?.status !== 'ok') throw new GoFileError('api', 'GoFile could not resolve the public mirror.');
        const mirror = selectMirror(collectFiles(body.data), expectedFilename);

        let fileUrl;
        try {
            fileUrl = new URL(mirror.link);
            if (fileUrl.protocol !== 'https:') throw new Error('not HTTPS');
        } catch (_) {
            throw new GoFileError('invalid_response', 'GoFile returned an invalid mirror byte URL.');
        }
        let bytesResponse;
        try {
            bytesResponse = await this.fetchImpl(fileUrl.href, { signal: boundedSignal(downloadTimeoutMs, signal) });
        } catch (cause) {
            throw transportError(cause, signal, downloadTimeoutMs, 'GoFile mirror bytes');
        }
        if (!bytesResponse.ok) {
            throw new GoFileError('http', `GoFile mirror download failed (HTTP ${bytesResponse.status}).`, {
                status: bytesResponse.status
            });
        }
        try {
            return new Uint8Array(await bytesResponse.arrayBuffer());
        } catch (cause) {
            throw transportError(cause, signal, downloadTimeoutMs, 'GoFile mirror bytes');
        }
    }
}

/** Pick the one mirror this deployment asked for, or refuse to guess. */
function selectMirror(candidates, expectedFilename) {
    if (expectedFilename) {
        const matches = candidates.filter((file) => file.name === expectedFilename);
        if (matches.length === 0) {
            throw new GoFileError('mirror_not_found', 'The GoFile locator holds no mirror for this deployment.');
        }
        if (matches.length > 1) {
            throw new GoFileError('ambiguous_mirror', 'The GoFile locator holds more than one copy of this mirror.');
        }
        return matches[0];
    }
    if (candidates.length !== 1) {
        throw new GoFileError('ambiguous_mirror', 'The GoFile locator does not identify exactly one mirror.');
    }
    return candidates[0];
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
