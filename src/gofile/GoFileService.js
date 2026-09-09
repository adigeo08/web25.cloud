// @ts-check

/** The only guest operation documented by GoFile. */
export const GOFILE_UPLOAD_ENDPOINT = 'https://upload.gofile.io/uploadfile';
export const GOFILE_CONTENT_ENDPOINT = 'https://api.gofile.io/contents';
export const GOFILE_ACCOUNTS_ENDPOINT = 'https://api.gofile.io/accounts';

/**
 * GoFile is best-effort fallback transport, never the primary one, so every
 * request is bounded. A stalled GoFile call must cost the mirror and nothing
 * else: not the deployment, not the resolver, not the loading overlay.
 */
export const GOFILE_UPLOAD_TIMEOUT_MS = 30000;
export const GOFILE_METADATA_TIMEOUT_MS = 20000;
export const GOFILE_DOWNLOAD_TIMEOUT_MS = 30000;
export const GOFILE_MIRROR_MAX_BYTES = 64 * 1024 * 1024;
export const GOFILE_ACCOUNT_TIMEOUT_MS = 20000;

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
const ACCOUNT_TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

/**
 * The global fetch, bound to the global.
 *
 * A browser refuses a fetch invoked as a method of anything else — "Failed to
 * execute 'fetch' on 'Window': Illegal invocation" — and refuses it *before*
 * issuing the request, so the symptom is a dead network tab rather than a
 * failed call. Node's fetch ignores its receiver, so only a browser sees it.
 */
function globalFetch() {
    const impl = globalThis.fetch;
    return typeof impl === 'function' ? impl.bind(globalThis) : impl;
}

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
        const elapsed = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
        return new GoFileError('timeout', `${subject} timed out after ${elapsed}.`, { cause });
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
        fetchImpl = globalFetch(),
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
     * Create a guest account and return its token.
     *
     * Documented as unauthenticated with an empty body: GoFile mints a guest
     * account on the spot. The token it returns is the same kind of credential
     * a dashboard API key is, so everything downstream treats them alike.
     * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
     */
    async createGuestAccount({ signal, timeoutMs = GOFILE_ACCOUNT_TIMEOUT_MS } = {}) {
        let response;
        try {
            response = await this.fetchImpl(GOFILE_ACCOUNTS_ENDPOINT, {
                method: 'POST',
                signal: boundedSignal(timeoutMs, signal)
            });
        } catch (cause) {
            throw transportError(cause, signal, timeoutMs, 'GoFile guest account');
        }
        if (!response.ok) {
            throw classifyApiFailure(await failureBody(response), response.status, 'Creating a GoFile guest account');
        }
        let body;
        try {
            body = await response.json();
        } catch (cause) {
            if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
                throw transportError(cause, signal, timeoutMs, 'GoFile guest account');
            }
            throw new GoFileError('invalid_response', 'GoFile returned an unreadable account response.', { cause });
        }
        if (body?.status !== 'ok' || !body?.data || typeof body.data !== 'object') {
            throw classifyApiFailure(body, 200, 'Creating a GoFile guest account');
        }
        const token = body.data.token;
        if (typeof token !== 'string' || !ACCOUNT_TOKEN.test(token)) {
            throw new GoFileError('invalid_response', 'GoFile returned an unusable account token.');
        }
        const account = {
            id: optionalId(body.data.id, 'account id'),
            rootFolder: optionalId(body.data.rootFolder, 'root folder id'),
            tier: typeof body.data.tier === 'string' ? body.data.tier : null
        };
        // Same handling as the upload's guest token: usable, but never carried
        // into a JSON projection, a log line, or the UI by accident.
        Object.defineProperty(account, 'token', { value: token, enumerable: false });
        return account;
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
            throw new GoFileError('api', `GoFile rejected the upload (${apiStatus(body)}).`);
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
            token = null,
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

        // GoFile draws no distinction between a token issued from the dashboard
        // and the guest token an upload hands back: both authenticate the same
        // way. The bearer goes only to the content API, whose host is a
        // constant here — never to the storage URL that same API names, which
        // would hand a credential to whatever host the response points at.
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;

        let metadataResponse;
        try {
            metadataResponse = await this.fetchImpl(`${GOFILE_CONTENT_ENDPOINT}/${encodeURIComponent(safeLocator)}`, {
                headers,
                signal: boundedSignal(metadataTimeoutMs, signal)
            });
        } catch (cause) {
            throw transportError(cause, signal, metadataTimeoutMs, 'GoFile mirror metadata');
        }
        if (!metadataResponse.ok) {
            throw classifyApiFailure(
                await failureBody(metadataResponse),
                metadataResponse.status,
                'Resolving the GoFile mirror'
            );
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
        // A 200 can still carry an error status; the same classification applies.
        if (body?.status !== 'ok') throw classifyApiFailure(body, 200, 'Resolving the GoFile mirror');
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
        return readBoundedBytes(bytesResponse, signal, downloadTimeoutMs);
    }
}

async function readBoundedBytes(response, signal, timeoutMs) {
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > GOFILE_MIRROR_MAX_BYTES) {
        try {
            await response.body?.cancel?.();
        } catch (_) {}
        throw new GoFileError('too_large', 'GoFile mirror exceeds the maximum permitted size.');
    }

    if (!response.body?.getReader) {
        throw new GoFileError('invalid_response', 'GoFile mirror has no readable byte stream.');
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        let done = false;
        while (!done) {
            const result = await reader.read();
            done = result.done;
            if (done) continue;
            const value = result.value;
            const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
            total += chunk.byteLength;
            if (total > GOFILE_MIRROR_MAX_BYTES) {
                await reader.cancel('GoFile mirror exceeds the maximum permitted size.');
                throw new GoFileError('too_large', 'GoFile mirror exceeds the maximum permitted size.');
            }
            chunks.push(chunk);
        }
    } catch (cause) {
        if (cause instanceof GoFileError) throw cause;
        throw transportError(cause, signal, timeoutMs, 'GoFile mirror bytes');
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/** GoFile answers 200 with a status string like "error-notPremium"; keep it. */
function apiStatus(body) {
    const status = body?.status;
    return typeof status === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(status) ? status : 'no status';
}

/**
 * GoFile's own guidance is to branch on the status field rather than the HTTP
 * code, because several statuses share one code: error-token and
 * error-notPremium are both 401, and mean entirely different things to a
 * publisher. Falls back to the code when there is no readable status.
 */
function classifyApiFailure(body, status, subject) {
    switch (body?.status) {
        case 'error-notPremium':
            return new GoFileError(
                'premium_required',
                `${subject} needs a GoFile Premium account: the content API is Premium-only (error-notPremium).`,
                { status }
            );
        case 'error-token':
            return new GoFileError('invalid_token', `GoFile rejected the credential (error-token).`, { status });
        case 'error-rateLimit':
            return new GoFileError('rate_limited', `${subject} was rate limited by GoFile (error-rateLimit).`, {
                status
            });
        case 'error-notFound':
            return new GoFileError('mirror_not_found', `${subject} no longer exists on GoFile (error-notFound).`, {
                status
            });
        case 'error-owner':
        case 'error-notOwner':
            return new GoFileError(
                'invalid_token',
                `The content belongs to another GoFile account (${apiStatus(body)}).`,
                { status }
            );
        default:
            break;
    }
    if (typeof body?.status === 'string') {
        return new GoFileError('api', `${subject} failed (${apiStatus(body)}).`, { status });
    }
    if (status === 401 || status === 403) {
        return new GoFileError('invalid_token', `GoFile refused the credential (HTTP ${status}).`, { status });
    }
    return new GoFileError('http', `${subject} failed (HTTP ${status}).`, { status });
}

/** Read a JSON envelope from a failed response without letting it throw. */
async function failureBody(response) {
    try {
        return await response.json();
    } catch (_) {
        return null;
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
