// @ts-check

/** The only guest operation documented by GoFile. */
export const GOFILE_UPLOAD_ENDPOINT = 'https://upload.gofile.io/uploadfile';
export const GOFILE_ACCOUNTS_ENDPOINT = 'https://api.gofile.io/accounts';

/**
 * The route GoFile's own web client uses to fetch a public file's bytes. It is
 * not part of the API reference — the documented listing and direct-link
 * routes are both Premium — so the shape is pinned here and validated hard.
 */
export const GOFILE_STORAGE_URL = (server, contentId, filename) =>
    `https://${server}.gofile.io/download/web/${contentId}/${encodeURIComponent(filename)}`;

/**
 * GoFile's storage servers send no `Access-Control-Allow-Origin`, and an
 * unauthenticated request to one is redirected to the human download page —
 * which sends none either. A browser therefore cannot read a mirror directly,
 * whatever the URL. Reads go through a CORS proxy instead.
 *
 * Only reads. The upload carries the account credential and always goes
 * straight to GoFile: handing a bearer token to a third party would give away
 * the account, and the upload has no CORS problem to solve in the first place.
 */
export const GOFILE_READ_PROXY = 'https://api.allorigins.win';
export const proxiedRawUrl = (proxy, target) => `${proxy}/raw?url=${encodeURIComponent(target)}`;
export const proxiedEnvelopeUrl = (proxy, target) => `${proxy}/get?url=${encodeURIComponent(target)}`;

/**
 * GoFile is best-effort fallback transport, never the primary one, so every
 * request is bounded. A stalled GoFile call must cost the mirror and nothing
 * else: not the deployment, not the resolver, not the loading overlay.
 */
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

/**
 * A mirror locator names the storage server and the content UUID that together
 * address one uploaded file: `<server>~<uuid>`. Both halves come straight from
 * the upload response, so nothing has to be looked up to read the mirror back.
 */
export function formatMirrorLocator(server, contentId) {
    return `${server}~${`${contentId}`.toLowerCase()}`;
}

export function parseMirrorLocator(locator) {
    const [server, contentId, ...extra] = `${locator || ''}`.split('~');
    if (extra.length > 0 || !STORAGE_SERVER.test(`${server}`) || !CONTENT_UUID.test(`${contentId}`)) {
        throw new GoFileError(
            'invalid_locator',
            'This WEB25 address carries a mirror locator that names no GoFile storage server.'
        );
    }
    return { server, contentId: contentId.toLowerCase() };
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
     * @param {{ fetchImpl?: typeof fetch, endpoint?: string, readProxy?: string,
     *           uploadTimeoutMs?: number, downloadTimeoutMs?: number }} [options]
     */
    constructor({
        fetchImpl = globalFetch(),
        endpoint = GOFILE_UPLOAD_ENDPOINT,
        readProxy = GOFILE_READ_PROXY,
        uploadTimeoutMs = GOFILE_UPLOAD_TIMEOUT_MS,
        downloadTimeoutMs = GOFILE_DOWNLOAD_TIMEOUT_MS
    } = {}) {
        if (typeof fetchImpl !== 'function') throw new TypeError('GoFileService requires fetch.');
        this.fetchImpl = fetchImpl;
        this.endpoint = endpoint;
        this.readProxy = `${readProxy}`.replace(/\/$/, '');
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

        // The locator addresses this one uploaded file on the server holding
        // it, never the folder around it: a folder identifier would grow into a
        // public index of every site this publisher has ever mirrored, and
        // would make each new deployment ambiguous with the ones before it.
        const result = {
            id,
            filename,
            parentFolder,
            parentFolderCode,
            downloadPage,
            servers,
            mirrorLocator: servers.length > 0 ? formatMirrorLocator(servers[0], id) : null,
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
     * Fetch one mirror's bytes straight from the storage server that holds it.
     *
     * There is no lookup step: the locator carries the server and the content
     * id, and the filename is derived from the torrent hash, so the URL is
     * fully determined before the first request. That is also what picks the
     * right mirror — a wrong name is a 404, not a wrong file — and it keeps the
     * account credential away from a host we do not control.
     * @param {string} locator
     * @param {{ expectedFilename: string, signal?: AbortSignal, downloadTimeoutMs?: number }} options
     */
    async downloadPublicMirror(locator, { expectedFilename, signal, downloadTimeoutMs = this.downloadTimeoutMs } = {}) {
        if (typeof expectedFilename !== 'string' || !MIRROR_FILENAME.test(expectedFilename)) {
            throw new GoFileError('invalid_request', 'GoFile mirror filename is invalid.');
        }
        const { server, contentId } = parseMirrorLocator(locator);
        const target = GOFILE_STORAGE_URL(server, contentId, expectedFilename);

        // `/raw` hands back the body untouched, which is what verification
        // needs. `/get` wraps it in a JSON envelope as a string, so it is only
        // a fallback for when `/raw` is unavailable — and only survives here
        // because a mirror is UTF-8 JSON rather than arbitrary bytes.
        const response = await this._fetchThroughProxy(
            proxiedRawUrl(this.readProxy, target),
            signal,
            downloadTimeoutMs
        );
        if (response.ok) return guardMirrorBody(await readBoundedBytes(response, signal, downloadTimeoutMs));
        if (response.status !== 404 && response.status !== 400) {
            throw new GoFileError('http', `GoFile mirror download failed (HTTP ${response.status}).`, {
                status: response.status
            });
        }

        const envelope = await this._fetchThroughProxy(
            proxiedEnvelopeUrl(this.readProxy, target),
            signal,
            downloadTimeoutMs
        );
        if (!envelope.ok) {
            throw new GoFileError('http', `GoFile mirror download failed (HTTP ${envelope.status}).`, {
                status: envelope.status
            });
        }
        const bytes = await readBoundedBytes(envelope, signal, downloadTimeoutMs);
        let contents;
        try {
            contents = JSON.parse(new TextDecoder().decode(bytes))?.contents;
        } catch (cause) {
            throw new GoFileError('invalid_response', 'The CORS proxy returned an unreadable envelope.', { cause });
        }
        if (typeof contents !== 'string') {
            throw new GoFileError('invalid_response', 'The CORS proxy returned no mirror contents.');
        }
        return guardMirrorBody(new TextEncoder().encode(contents));
    }

    async _fetchThroughProxy(url, signal, timeoutMs) {
        try {
            return await this.fetchImpl(url, { signal: boundedSignal(timeoutMs, signal) });
        } catch (cause) {
            throw transportError(cause, signal, timeoutMs, 'GoFile mirror bytes');
        }
    }
}

/**
 * An unauthenticated storage request is redirected to GoFile's download page,
 * and a proxy follows redirects, so the likeliest wrong answer is a page of
 * HTML rather than a mirror. Say that, instead of failing later as bad JSON.
 */
function guardMirrorBody(bytes) {
    const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
        throw new GoFileError(
            'mirror_not_found',
            'GoFile served its download page instead of the mirror: the file is gone, or the storage route now requires a session.'
        );
    }
    return bytes;
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
