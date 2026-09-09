// @ts-check

/**
 * gofile-cf-downloader — a Cloudflare Worker that reads GoFile content on
 * behalf of a browser.
 *
 * WHY THIS EXISTS
 *
 * A page cannot read GoFile from JavaScript, for three independent reasons:
 *
 *   1. GoFile's storage servers send no `Access-Control-Allow-Origin`, and an
 *      unauthenticated request to one is redirected to the human download
 *      page, which sends none either.
 *   2. The byte download is authenticated by a `Cookie: accountToken=…`, and a
 *      browser forbids JavaScript from setting `Cookie`.
 *   3. Listing content requires the `X-Website-Token` header, which is a custom
 *      header and so triggers a CORS preflight nothing answers.
 *
 * None of those apply to a Worker. It speaks to GoFile as an ordinary HTTP
 * client and answers the browser with the CORS headers GoFile omits.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 * Not an open proxy. It accepts a GoFile content UUID, never an arbitrary URL,
 * and it refuses to stream from any host outside gofile.io. Widening either of
 * those turns this into free bandwidth for anyone who finds the hostname.
 *
 * CONFIGURATION (Worker environment variables / secrets)
 *
 *   GF_TOKEN          Account token. Strongly recommended: GoFile's own advice
 *                     is to create one account and reuse it rather than mint
 *                     one per operation. Without it, this mints a guest account
 *                     per isolate. Set it as a SECRET, never a plain var.
 *   GF_WT_SALT        Salt for the website-token derivation. Defaults below;
 *                     kept configurable because it is not part of GoFile's
 *                     documented API and can change without notice.
 *   GF_USER_AGENT     User-Agent sent to GoFile. Must be the same string the
 *                     token is derived from, so it lives in one place.
 *   ALLOWED_ORIGINS   Comma-separated origin allowlist, e.g.
 *                     "https://web25.cloud,http://localhost:8000".
 *                     Unset means "*", which is fine for public content but
 *                     means anyone may call this Worker.
 *   MAX_BYTES         Refuse files larger than this. Default 64 MiB.
 *
 * ENDPOINTS
 *
 *   GET /health
 *   GET /contents/:uuid            → the listing JSON, verbatim from GoFile
 *   GET /file/:uuid/:filename      → the file's bytes, streamed
 *
 * `/file` accepts and forwards `Range`, so resumable and partial reads work.
 */

const GOFILE_API = 'https://api.gofile.io';
const DEFAULT_WT_SALT = '12af056dacea0b';
const DEFAULT_USER_AGENT = 'Mozilla/5.0';
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** The website token is bucketed into four-hour slots. */
const WT_SLOT_SECONDS = 14400;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME = /^[A-Za-z0-9_.-]{1,255}$/;

/**
 * One account token per isolate. GoFile asks that a token be reused rather
 * than an account minted per operation, and an isolate is the longest-lived
 * thing a Worker has. Set GF_TOKEN and this is never used.
 */
let mintedToken = null;

export default {
    /**
     * @param {Request} request
     * @param {Record<string, string | undefined>} env
     */
    async fetch(request, env) {
        const cors = corsHeaders(request, env);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return problem(405, 'method_not_allowed', 'Only GET and HEAD are served.', cors);
        }

        const { pathname } = new URL(request.url);
        const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);

        try {
            if (segments.length === 1 && segments[0] === 'health') {
                return json({ status: 'ok', tokenSource: env.GF_TOKEN ? 'configured' : 'guest' }, 200, cors);
            }
            if (segments.length === 2 && segments[0] === 'contents') {
                return await serveListing(segments[1], env, cors);
            }
            if (segments.length === 3 && segments[0] === 'file') {
                return await serveFile(segments[1], segments[2], request, env, cors);
            }
            return problem(404, 'not_found', 'Try /health, /contents/:uuid or /file/:uuid/:filename.', cors);
        } catch (error) {
            // Never leak a token or an internal stack to the caller.
            const code = error?.code || 'upstream_error';
            const status = error?.status || 502;
            return problem(status, code, error?.publicMessage || 'GoFile could not be reached.', cors);
        }
    }
};

// ── GoFile protocol ─────────────────────────────────────────────────────────

/**
 * The header GoFile's own web client sends alongside the account token. It is
 * a SHA-256 over the user agent, the locale, the account token, the current
 * four-hour slot and a salt — so it rotates on its own and has to be recomputed
 * rather than cached for long.
 */
async function websiteToken(userAgent, accountToken, salt) {
    const slot = Math.floor(Date.now() / 1000 / WT_SLOT_SECONDS);
    const raw = `${userAgent}::en-US::${accountToken}::${slot}::${salt}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The configured account token, or a guest one minted once per isolate. */
async function accountToken(env) {
    if (env.GF_TOKEN) return env.GF_TOKEN;
    if (mintedToken) return mintedToken;

    const userAgent = env.GF_USER_AGENT || DEFAULT_USER_AGENT;
    const response = await fetch(`${GOFILE_API}/accounts`, {
        method: 'POST',
        headers: {
            'User-Agent': userAgent,
            'X-Website-Token': await websiteToken(userAgent, '', env.GF_WT_SALT || DEFAULT_WT_SALT)
        }
    });
    const body = await readJson(response, 'Creating a GoFile guest account');
    const token = body?.data?.token;
    if (body?.status !== 'ok' || typeof token !== 'string' || token.length === 0) {
        throw upstream(502, 'account_failed', `GoFile refused to create a guest account (${apiStatus(body)}).`);
    }
    mintedToken = token;
    return token;
}

/** Headers every authenticated GoFile API call needs. */
async function apiHeaders(env) {
    const userAgent = env.GF_USER_AGENT || DEFAULT_USER_AGENT;
    const token = await accountToken(env);
    return {
        'User-Agent': userAgent,
        Authorization: `Bearer ${token}`,
        'X-Website-Token': await websiteToken(userAgent, token, env.GF_WT_SALT || DEFAULT_WT_SALT),
        // The storage servers authenticate by cookie rather than by header.
        Cookie: `accountToken=${token}`
    };
}

async function listContents(contentId, env) {
    const url = `${GOFILE_API}/contents/${encodeURIComponent(contentId)}?cache=true&sortField=createTime&sortDirection=1`;
    const response = await fetch(url, { headers: await apiHeaders(env) });
    const body = await readJson(response, 'Listing GoFile content');
    if (body?.status !== 'ok') {
        // error-notPremium and error-token both answer 401, so the status
        // string is the only thing that says which one happened.
        const status = body?.status === 'error-notFound' ? 404 : 502;
        throw upstream(status, 'listing_refused', `GoFile refused the listing (${apiStatus(body)}).`);
    }
    return body;
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function serveListing(contentId, env, cors) {
    if (!UUID.test(contentId)) {
        return problem(400, 'invalid_content_id', 'A GoFile content UUID is required.', cors);
    }
    const body = await listContents(contentId, env);
    return json(body, 200, cors);
}

async function serveFile(contentId, filename, request, env, cors) {
    if (!UUID.test(contentId)) {
        return problem(400, 'invalid_content_id', 'A GoFile content UUID is required.', cors);
    }
    if (!FILENAME.test(filename)) {
        return problem(400, 'invalid_filename', 'That filename is not one this Worker will fetch.', cors);
    }

    const listing = await listContents(contentId, env);
    const file = findFile(listing.data, filename);
    if (!file) {
        return problem(404, 'file_not_found', 'That content holds no file by that name.', cors);
    }

    // The listing names the host to stream from, so it is validated before a
    // single byte is fetched: an upstream response must never be able to point
    // this Worker at somewhere else.
    let link;
    try {
        link = new URL(file.link);
    } catch (_) {
        return problem(502, 'invalid_link', 'GoFile returned an unusable download link.', cors);
    }
    if (link.protocol !== 'https:' || !isGoFileHost(link.hostname)) {
        return problem(502, 'untrusted_link', 'GoFile pointed at a host this Worker will not fetch.', cors);
    }

    const maxBytes = positiveInt(env.MAX_BYTES) || DEFAULT_MAX_BYTES;
    if (Number.isFinite(Number(file.size)) && Number(file.size) > maxBytes) {
        return problem(413, 'too_large', `That file is larger than this Worker will serve (${maxBytes} bytes).`, cors);
    }

    const headers = await apiHeaders(env);
    const range = request.headers.get('Range');
    if (range) headers.Range = range;

    const upstreamResponse = await fetch(link.href, { headers, redirect: 'follow' });
    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        // A redirect to the download page means the storage server did not
        // accept the session — the usual cause is a stale or missing token.
        return problem(502, 'download_refused', `GoFile refused the download (HTTP ${upstreamResponse.status}).`, cors);
    }
    if (looksLikeHtml(upstreamResponse.headers.get('Content-Type'))) {
        return problem(
            502,
            'download_page_returned',
            'GoFile served its download page instead of the file: the session was not accepted.',
            cors
        );
    }

    const passthrough = new Headers(cors);
    for (const header of [
        'Content-Type',
        'Content-Length',
        'Content-Range',
        'Accept-Ranges',
        'ETag',
        'Last-Modified'
    ]) {
        const value = upstreamResponse.headers.get(header);
        if (value) passthrough.set(header, value);
    }
    passthrough.set('Cache-Control', 'public, max-age=300');
    // Streamed, not buffered: a Worker has far less memory than GoFile has
    // file sizes, and the body never needs to be inspected here.
    return new Response(request.method === 'HEAD' ? null : upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: passthrough
    });
}

/** Walk a listing for one file by exact name. */
function findFile(node, filename) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'file' && node.name === filename && typeof node.link === 'string') return node;
    const children = node.children;
    if (children && typeof children === 'object') {
        for (const child of Object.values(children)) {
            const found = findFile(child, filename);
            if (found) return found;
        }
    }
    return null;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

function isGoFileHost(hostname) {
    const host = `${hostname}`.toLowerCase();
    return host === 'gofile.io' || host.endsWith('.gofile.io');
}

function looksLikeHtml(contentType) {
    return `${contentType || ''}`.toLowerCase().includes('text/html');
}

function corsHeaders(request, env) {
    const allowed = `${env.ALLOWED_ORIGINS || ''}`
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    const origin = request.headers.get('Origin');
    const headers = new Headers({
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
    });
    if (allowed.length === 0) headers.set('Access-Control-Allow-Origin', '*');
    else if (origin && allowed.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
    return headers;
}

async function readJson(response, subject) {
    try {
        return await response.json();
    } catch (_) {
        throw upstream(502, 'unreadable_response', `${subject} returned something that is not JSON.`);
    }
}

function apiStatus(body) {
    const status = body?.status;
    return typeof status === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(status) ? status : 'no status';
}

function upstream(status, code, publicMessage) {
    const error = new Error(publicMessage);
    error.status = status;
    error.code = code;
    error.publicMessage = publicMessage;
    return error;
}

function positiveInt(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function json(body, status, cors) {
    const headers = new Headers(cors);
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status, headers });
}

function problem(status, code, message, cors) {
    return json({ error: code, message }, status, cors);
}
