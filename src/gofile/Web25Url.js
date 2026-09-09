// @ts-check

const HASH_RE = /^[0-9a-f]{40}$/i;
// A locator is `<storage server>~<content uuid>`; "~" is URL-safe and unreserved.
const LOCATOR_RE = /^[A-Za-z0-9_~-]{1,256}$/;

export class Web25UrlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'Web25UrlError';
    }
}

/**
 * Parse a hash, hash+locator, query string, or complete WEB25 URL.
 *
 * Query parameters are read by name, not by position, so a link that carries
 * unrelated parameters ahead of the address (`?debug=true&orc=<hash>`) resolves
 * exactly like the canonical `?orc=<hash>` form. The mirror locator is the one
 * bare segment: a value with no `=` in it.
 */
export function parseWeb25Address(input, base = 'https://web25.cloud/') {
    const raw = `${input || ''}`.trim();
    if (!raw) throw new Web25UrlError('A torrent hash is required.');

    let query;
    if (/^https?:\/\//i.test(raw)) {
        // Validate complete URLs without constraining deployment hostnames.
        query = new URL(raw, base).search.slice(1);
    } else if (raw.startsWith('?')) {
        query = raw.slice(1);
    } else if (/(^|&)orc=/.test(raw)) {
        query = raw;
    } else {
        query = `orc=${raw}`;
    }

    let torrentHash = null;
    let gofileLocator = null;
    for (const segment of query.split('&').filter(Boolean)) {
        if (segment.startsWith('orc=')) {
            if (torrentHash !== null) throw new Web25UrlError('Only one orc= torrent hash is allowed.');
            torrentHash = decode(segment.slice(4), 'Torrent hash is malformed.').trim().toLowerCase();
            continue;
        }
        if (segment.includes('=')) continue;
        if (gofileLocator !== null) throw new Web25UrlError('Only one bare mirror locator is allowed.');
        const decoded = decode(segment, 'GoFile mirror locator is malformed.');
        if (!LOCATOR_RE.test(decoded)) throw new Web25UrlError('GoFile mirror locator is malformed.');
        gofileLocator = decoded;
    }

    if (torrentHash === null) throw new Web25UrlError('The WEB25 address must carry an orc= torrent hash.');
    if (!HASH_RE.test(torrentHash)) throw new Web25UrlError('Torrent hash must be exactly 40 hexadecimal characters.');
    return { torrentHash, gofileLocator };
}

function decode(value, message) {
    try {
        return decodeURIComponent(value);
    } catch (_) {
        throw new Web25UrlError(message);
    }
}

export function formatWeb25Url({ torrentHash, gofileLocator = null, origin, pathname = '/' }) {
    const parsed = parseWeb25Address(`${torrentHash}${gofileLocator ? `&${gofileLocator}` : ''}`);
    const root = `${origin}`.replace(/\/$/, '') + (pathname.startsWith('/') ? pathname : `/${pathname}`);
    return `${root}?orc=${parsed.torrentHash}${parsed.gofileLocator ? `&${encodeURIComponent(parsed.gofileLocator)}` : ''}`;
}
