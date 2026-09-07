// @ts-check

const HASH_RE = /^[0-9a-f]{40}$/i;
const LOCATOR_RE = /^[A-Za-z0-9_-]{1,256}$/;

export class Web25UrlError extends Error {
    constructor(message) {
        super(message);
        this.name = 'Web25UrlError';
    }
}

/** Parse a hash, hash+locator, query string, or complete WEB25 URL. */
export function parseWeb25Address(input, base = 'https://web25.cloud/') {
    const raw = `${input || ''}`.trim();
    if (!raw) throw new Web25UrlError('A torrent hash is required.');

    let query;
    if (/^https?:\/\//i.test(raw)) {
        query = new URL(raw).search.slice(1);
    } else if (raw.startsWith('?')) {
        query = raw.slice(1);
    } else if (raw.startsWith('orc=')) {
        query = raw;
    } else {
        query = `orc=${raw}`;
    }

    const segments = query.split('&').filter(Boolean);
    const orc = segments.shift();
    if (!orc?.startsWith('orc=')) throw new Web25UrlError('The WEB25 address must begin with orc=.');
    const torrentHash = decodeURIComponent(orc.slice(4)).trim().toLowerCase();
    if (!HASH_RE.test(torrentHash)) throw new Web25UrlError('Torrent hash must be exactly 40 hexadecimal characters.');

    let gofileLocator = null;
    for (const segment of segments) {
        if (segment.includes('=')) continue;
        if (gofileLocator !== null) throw new Web25UrlError('Only one bare mirror locator is allowed.');
        let decoded;
        try {
            decoded = decodeURIComponent(segment);
        } catch (_) {
            throw new Web25UrlError('GoFile mirror locator is malformed.');
        }
        if (!LOCATOR_RE.test(decoded)) throw new Web25UrlError('GoFile mirror locator is malformed.');
        gofileLocator = decoded;
    }

    // Validate complete URLs without constraining deployment hostnames.
    if (/^https?:\/\//i.test(raw)) new URL(raw, base);
    return { torrentHash, gofileLocator };
}

export function formatWeb25Url({ torrentHash, gofileLocator = null, origin, pathname = '/' }) {
    const parsed = parseWeb25Address(`${torrentHash}${gofileLocator ? `&${gofileLocator}` : ''}`);
    const root = `${origin}`.replace(/\/$/, '') + (pathname.startsWith('/') ? pathname : `/${pathname}`);
    return `${root}?orc=${parsed.torrentHash}${parsed.gofileLocator ? `&${encodeURIComponent(parsed.gofileLocator)}` : ''}`;
}
