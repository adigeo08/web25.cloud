// @ts-check

/** The only guest operation documented by GoFile. */
export const GOFILE_UPLOAD_ENDPOINT = 'https://upload.gofile.io/uploadfile';
export const GOFILE_ACCOUNTS_ENDPOINT = 'https://api.gofile.io/accounts';

/**
 * WEB25's own Cloudflare Worker, which reads GoFile on a browser's behalf.
 *
 * A page cannot do this itself: GoFile's storage servers send no CORS headers,
 * the byte download is authenticated by a cookie JavaScript may not set, and
 * listing needs a custom header whose preflight nothing answers. The Worker
 * holds no credential of its own — each caller sends theirs per request — so it
 * moves the transport barrier without moving the trust.
 */
export const GOFILE_WORKER_BASE = 'https://gofile-cf-downloader.carlgray.workers.dev';
export const workerFileUrl = (base, contentId, filename) =>
    `${base}/file/${encodeURIComponent(contentId)}/${encodeURIComponent(filename)}`;

export const GOFILE_UPLOAD_TIMEOUT_MS = 30000;
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
const STORAGE_SERVER = /^[A-Za-z0-9-]{1,64}$/;
/** Content ids are UUIDs, per the API's conventions. */
const CONTENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A share code out of a gofile.io/d/<code> link. Case is significant. */
const SHARE_CODE = /^[A-Za-z0-9]{4,32}$/;
const SHARE_LINK = /^https:\/\/gofile\.io\/d\/([A-Za-z0-9]{4,32})$/;

/**
 * A mirror locator addresses one uploaded mirror for the Worker to resolve.
 *
 * A share code is the canonical form and its case is part of it — `1J53t9zb`
 * and `1j53t9zb` are different links — so it is passed through untouched. A
 * UUID is case-insensitive by definition, so it is normalised.
 */
export function formatMirrorLocator(value) {
    const locator = `${value || ''}`.trim();
    return CONTENT_UUID.test(locator) ? locator.toLowerCase() : locator;
}

/** The share code inside a `https://gofile.io/d/<code>` download page. */
export function shareCodeFromDownloadPage(downloadPage) {
    const match = SHARE_LINK.exec(`${downloadPage || ''}`.trim());
    return match ? match[1] : null;
}

/**
 * Read a locator in any form WEB25 has ever published.
 *
 * Share codes are current. UUIDs were published before that, and links minted
 * while reads went straight to storage carry a `<server>~` prefix the Worker no
 * longer needs. All three keep resolving; only the prefix is dropped.
 */
export function parseMirrorLocator(locator) {
    const parts = `${locator || ''}`.trim().split('~');
    const candidate = parts.length === 2 && STORAGE_SERVER.test(parts[0]) ? parts[1] : parts[0];
    if (parts.length > 2 || !(CONTENT_UUID.test(candidate) || SHARE_CODE.test(candidate))) {
        throw new GoFileError(
            'invalid_locator',
            'This WEB25 address carries a mirror locator that is neither a GoFile share code nor a content id.'
        );
    }
    return { locator: formatMirrorLocator(candidate) };
}

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
     * @param {{ fetchImpl?: typeof fetch, endpoint?: string, workerBase?: string,
     *           uploadTimeoutMs?: number, downloadTimeoutMs?: number }} [options]
     */
    constructor({
        fetchImpl = globalFetch(),
        endpoint = GOFILE_UPLOAD_ENDPOINT,
        workerBase = GOFILE_WORKER_BASE,
        uploadTimeoutMs = GOFILE_UPLOAD_TIMEOUT_MS,
        downloadTimeoutMs = GOFILE_DOWNLOAD_TIMEOUT_MS
    } = {}) {
        if (typeof fetchImpl !== 'function') throw new TypeError('GoFileService requires fetch.');
        this.fetchImpl = fetchImpl;
        this.endpoint = endpoint;
        this.workerBase = `${workerBase}`.replace(/\/$/, '');
        this.uploadTimeoutMs = uploadTimeoutMs;
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
            throw classifyApiFailure(await failureBody(response), response.status, 'The GoFile upload');
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
            throw classifyApiFailure(body, 200, 'The GoFile upload');
        }

        const data = body.data;
        const id = validId(data.id, 'file id');
        const parentFolder = optionalId(data.parentFolder, 'parent folder id');
        const parentFolderCode = optionalId(data.parentFolderCode, 'parent folder code');
        const downloadPage = optionalHttpsUrl(data.downloadPage);
        const servers = Array.isArray(data.servers)
            ? data.servers.filter((server) => typeof server === 'string' && SAFE_ID.test(server)).slice(0, 20)
            : [];

        // The share code is what GoFile itself hands out for this upload, and
        // it addresses the folder this one mirror was uploaded into — a fresh
        // one every time, since no folder is ever reused, so it still names a
        // single deployment. The file UUID stands in only when GoFile returned
        // no code at all.
        const shareCode = parentFolderCode || shareCodeFromDownloadPage(downloadPage);
        const result = {
            id,
            filename,
            parentFolder,
            parentFolderCode,
            downloadPage,
            servers,
            shareCode,
            mirrorLocator: formatMirrorLocator(shareCode || id),
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
     * Fetch one mirror's bytes through the WEB25 Worker.
     *
     * One request: the locator names the content and the filename comes from
     * the torrent hash, so the URL is settled before anything is sent. That is
     * also what picks the deployment — a wrong name is a 404 from the Worker,
     * never the wrong bytes.
     *
     * The token is the caller's own GoFile credential, which the Worker needs
     * because it deliberately holds none.
     * @param {string} locator
     * @param {{ token: string, expectedFilename: string, signal?: AbortSignal,
     *           downloadTimeoutMs?: number }} options
     */
    async downloadPublicMirror(
        locator,
        { token, expectedFilename, signal, downloadTimeoutMs = this.downloadTimeoutMs } = {}
    ) {
        if (typeof expectedFilename !== 'string' || !MIRROR_FILENAME.test(expectedFilename)) {
            throw new GoFileError('invalid_request', 'GoFile mirror filename is invalid.');
        }
        if (typeof token !== 'string' || token.length === 0) {
            throw new GoFileError('invalid_token', 'Reading a GoFile mirror needs a GoFile credential.');
        }
        const { locator: workerLocator } = parseMirrorLocator(locator);

        let response;
        try {
            response = await this.fetchImpl(workerFileUrl(this.workerBase, workerLocator, expectedFilename), {
                headers: { Authorization: `Bearer ${token}` },
                signal: boundedSignal(downloadTimeoutMs, signal)
            });
        } catch (cause) {
            throw transportError(cause, signal, downloadTimeoutMs, 'The GoFile mirror service');
        }
        if (!response.ok) throw classifyWorkerFailure(await failureBody(response), response.status);
        return readBoundedBytes(response, signal, downloadTimeoutMs);
    }
}

/**
 * The Worker answers every failure as {"error", "message"}. It has already
 * translated GoFile's own statuses and made its own integrity judgements, so
 * this maps its vocabulary rather than re-reading anything underneath.
 *
 * Every branch throws. There is no code path here that returns bytes the
 * Worker would not vouch for, so a refusal always aborts the mirror rather
 * than degrading into something rendered unverified.
 */
function classifyWorkerFailure(body, status) {
    const code = typeof body?.error === 'string' ? body.error : null;
    const detail = typeof body?.message === 'string' ? body.message : `HTTP ${status}`;
    switch (code) {
        case 'missing_token':
        case 'listing_refused':
            return new GoFileError('invalid_token', `The GoFile mirror service refused the credential: ${detail}`, {
                status
            });
        case 'file_not_found':
        case 'not_found':
            return new GoFileError('mirror_not_found', `This deployment has no mirror to read: ${detail}`, { status });

        // The Worker judges a download by where the bytes came from and how
        // many there are. Each of these means it could not vouch for them, so
        // none of them may end in a render.
        case 'download_page_returned':
        case 'size_mismatch':
        case 'untrusted_link':
        case 'untrusted_redirect':
        case 'too_many_redirects':
        case 'invalid_link':
        case 'invalid_redirect':
        case 'unreadable_response':
            return new GoFileError('mirror_untrusted', `The GoFile mirror did not verify: ${detail}`, { status });

        case 'download_refused':
            return new GoFileError('mirror_unavailable', `GoFile would not serve the mirror: ${detail}`, { status });
        case 'too_large':
            return new GoFileError('too_large', detail, { status });
        case 'invalid_content_id':
        case 'invalid_filename':
        case 'invalid_path':
            return new GoFileError('invalid_request', detail, { status });
        default:
            return new GoFileError('http', `The GoFile mirror service failed (${code || `HTTP ${status}`}).`, {
                status
            });
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
