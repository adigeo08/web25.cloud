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
 * WHOSE TOKEN
 *
 * The Worker holds no GoFile credential of its own and creates no accounts.
 * Every caller already has one, and sends it per request as
 * `Authorization: Bearer <token>`; that token — and only that token — is used
 * for the listing, for the website-token derivation, and for the storage
 * cookie, then discarded when the request ends. Nothing is cached across
 * requests, so one caller's token can never serve another's.
 *
 * CONFIGURATION (Worker environment variables)
 *
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
 * `/file` accepts and forwards `Range`, so resumable and partial reads work,
 * and a HEAD reaches GoFile as a HEAD rather than a discarded GET.
 */

const GOFILE_API = 'https://api.gofile.io';
const DEFAULT_WT_SALT = '12af056dacea0b';
const DEFAULT_USER_AGENT = 'Mozilla/5.0';

/** Sent as X-BL and folded into the website token; the two must agree. */
const LANGUAGE = 'en-US';

/** GoFile bounces between storage hosts; a couple of hops is plenty. */
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** The website token is bucketed into four-hour slots. */
const WT_SLOT_SECONDS = 14400;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME = /^[A-Za-z0-9_.-]{1,255}$/;

/** The caller's GoFile token, sent the way the app already sends it. */
function bearerToken(request) {
    const header = request.headers.get('Authorization') || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return match ? match[1] : null;
}

function missingToken(cors) {
    return problem(401, 'missing_token', 'Send your GoFile token as Authorization: Bearer <token>.', cors);
}

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

        try {
            // Decoding lives inside the handler: a malformed percent-escape
            // throws, and that has to become a 400 rather than escape as an
            // opaque runtime error.
            const { pathname } = new URL(request.url);
            let segments;
            try {
                segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
            } catch (_) {
                return problem(400, 'invalid_path', 'That path is not valid percent-encoding.', cors);
            }

            if (segments.length === 1 && segments[0] === 'health') {
                return json({ status: 'ok' }, 200, cors);
            }

            // Every GoFile call is made with the caller's own token, taken from
            // this request and never kept afterwards.
            const token = bearerToken(request);
            if (segments.length === 2 && segments[0] === 'contents') {
                if (!token) return missingToken(cors);
                return await serveListing(segments[1], env, token, cors);
            }
            if (segments.length === 3 && segments[0] === 'file') {
                if (!token) return missingToken(cors);
                return await serveFile(segments[1], segments[2], request, env, token, cors);
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
    const raw = `${userAgent}::${LANGUAGE}::${accountToken}::${slot}::${salt}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Headers every authenticated GoFile API call needs. */
async function apiHeaders(env, token) {
    const userAgent = env.GF_USER_AGENT || DEFAULT_USER_AGENT;
    return {
        'User-Agent': userAgent,
        'X-BL': LANGUAGE,
        Authorization: `Bearer ${token}`,
        'X-Website-Token': await websiteToken(userAgent, token, env.GF_WT_SALT || DEFAULT_WT_SALT),
        // The storage servers authenticate by cookie rather than by header.
        Cookie: `accountToken=${token}`
    };
}

async function listContents(contentId, env, token) {
    const url = `${GOFILE_API}/contents/${encodeURIComponent(contentId)}?cache=true&sortField=createTime&sortDirection=1`;
    const response = await fetch(url, { headers: await apiHeaders(env, token) });
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

async function serveListing(contentId, env, token, cors) {
    if (!UUID.test(contentId)) {
        return problem(400, 'invalid_content_id', 'A GoFile content UUID is required.', cors);
    }
    const body = await listContents(contentId, env, token);
    return json(body, 200, cors);
}

async function serveFile(contentId, filename, request, env, token, cors) {
    if (!UUID.test(contentId)) {
        return problem(400, 'invalid_content_id', 'A GoFile content UUID is required.', cors);
    }
    if (!FILENAME.test(filename)) {
        return problem(400, 'invalid_filename', 'That filename is not one this Worker will fetch.', cors);
    }

    const listing = await listContents(contentId, env, token);
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

    const headers = await apiHeaders(env, token);
    const range = request.headers.get('Range');
    if (range) headers.Range = range;

    // A HEAD reaches GoFile as a HEAD, rather than a GET whose body is fetched
    // and thrown away.
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
    const upstreamResponse = await followWithinGoFile(link.href, { method, headers });
    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
        // The storage server not accepting the session is the usual cause —
        // typically a stale token.
        return problem(502, 'download_refused', `GoFile refused the download (HTTP ${upstreamResponse.status}).`, cors);
    }
    // The listing's size is metadata; this is what the server is about to
    // actually send, and it is checked before any of it is streamed.
    if (upstreamResponse.status !== 206) {
        const declared = Number(upstreamResponse.headers.get('Content-Length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            return problem(
                413,
                'too_large',
                `That file is larger than this Worker will serve (${maxBytes} bytes).`,
                cors
            );
        }
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

/**
 * Follow GoFile's redirects by hand, checking each hop before trusting it.
 *
 * The request carries the caller's token in both a header and a cookie, so an
 * automatic follow would hand that token to wherever GoFile pointed. Each
 * destination is validated first, and a hop that leaves HTTPS or leaves GoFile
 * is refused rather than followed — so nothing sensitive is ever sent to it.
 */
async function followWithinGoFile(url, { method, headers }) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetch(current, { method, headers, redirect: 'manual' });
        if (response.status < 300 || response.status > 399) return response;

        const location = response.headers.get('Location');
        if (!location) throw upstream(502, 'invalid_redirect', 'GoFile redirected without a destination.');
        let next;
        try {
            next = new URL(location, current);
        } catch (_) {
            throw upstream(502, 'invalid_redirect', 'GoFile redirected to an unusable destination.');
        }
        if (next.protocol !== 'https:' || !isGoFileHost(next.hostname)) {
            throw upstream(502, 'untrusted_redirect', 'GoFile redirected to a host this Worker will not follow.');
        }
        current = next.href;
    }
    throw upstream(502, 'too_many_redirects', 'GoFile redirected more times than this Worker will follow.');
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
        // Authorization is what carries the caller's GoFile token, so the
        // preflight has to permit it. It is deliberately absent from
        // Expose-Headers: nothing sends a credential back to the page.
        'Access-Control-Allow-Headers': 'Authorization, Range',
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
