// @ts-check
/**
 * What a cached site can be found by.
 *
 * The cache is keyed by info hash, which is the right key and a hopeless way to
 * find anything: nobody remembers that they visited
 * `d4f5e6a7…`. Every site that has ever rendered here is already sitting in
 * this browser, so the only thing missing is a few hundred bytes per site
 * saying what it was.
 *
 * That index is built from what the site itself declares — its `<title>`, its
 * description and keywords meta tags, its file names — plus the publisher the
 * signature layer verified. Nothing here is fetched, nothing is sent anywhere,
 * and the index never leaves this browser: it is a local card catalogue for
 * pages this browser has already loaded, not a search engine.
 */

/** Past this many bytes, an entry document is not going to have a useful head. */
const HEAD_SCAN_BYTES = 16 * 1024;

/** Dotfiles are protocol furniture (`.torrentchain`), not content. */
const isContentPath = (path) => !path.split('/').pop()?.startsWith('.');

/**
 * @param {any} content
 * @returns {string}
 */
function decodeHead(content) {
    try {
        if (typeof content === 'string') {
            return content.slice(0, HEAD_SCAN_BYTES);
        }

        let bytes = null;
        if (content instanceof Uint8Array) {
            bytes = content;
        } else if (content instanceof ArrayBuffer) {
            bytes = new Uint8Array(content);
        } else if (ArrayBuffer.isView(content)) {
            bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        }

        if (!bytes) return '';
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, HEAD_SCAN_BYTES));
    } catch (_) {
        return '';
    }
}

/** The entities that actually turn up in a title or a description. */
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–'
};

/**
 * Turn entity references back into the text the author wrote.
 *
 * A title reading `Mara &amp; Co` is a title about two people, not about an
 * ampersand entity, and the library shows it to a person.
 *
 * @param {string} text
 */
function decodeEntities(text) {
    return `${text}`.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, entity) => {
        const token = `${entity}`.toLowerCase();
        if (token.startsWith('#x')) {
            const code = Number.parseInt(token.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        if (token.startsWith('#')) {
            const code = Number.parseInt(token.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, token) ? NAMED_ENTITIES[token] : match;
    });
}

/** One value, tidied for display and bounded. */
function clean(value) {
    return decodeEntities(`${value || ''}`)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

/**
 * Read a tag's attributes, in whatever order they were written.
 *
 * HTML puts no order on attributes, so `<meta content="…" name="description">`
 * is as valid as the other way round; a single regex expecting `name` before
 * `content` simply misses half the web. `DOMParser` would be the obvious tool
 * and is not used on purpose: this module is exercised in Node, where it does
 * not exist, and parsing attributes is the whole of what is needed.
 *
 * @param {string} tag the full tag, angle brackets included
 * @returns {Record<string, string>}
 */
function tagAttributes(tag) {
    /** @type {Record<string, string>} */
    const attributes = {};
    const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    for (const match of `${tag}`.matchAll(pattern)) {
        attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attributes;
}

/**
 * The `content` of the first `<meta>` whose `name` matches.
 * @param {string} html
 * @param {string} name
 */
function metaContent(html, name) {
    for (const match of `${html}`.matchAll(/<meta\b[^>]*>/gi)) {
        const attributes = tagAttributes(match[0]);
        if ((attributes.name || '').toLowerCase() === name) return clean(attributes.content);
    }
    return '';
}

/** @param {string} html */
function documentTitle(html) {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(`${html}`);
    return match ? clean(match[1]) : '';
}

/**
 * The entry document of a site, by the same rule the renderer uses.
 * @param {Record<string, any>} siteData
 */
export function findEntryPath(siteData) {
    const paths = Object.keys(siteData || {});
    return (
        paths.find((path) => path.toLowerCase() === 'index.html') ||
        paths.find((path) => path.toLowerCase().endsWith('/index.html')) ||
        paths.find((path) => path.toLowerCase().endsWith('.html')) ||
        ''
    );
}

/**
 * Build one library row for a cached site.
 *
 * @param {{ hash: string, siteData: Record<string, any>, signatureState?: any,
 *           timestamp?: number, url?: string }} params
 */
export function buildLibraryEntry({ hash, siteData, signatureState = null, timestamp = Date.now(), url = '' }) {
    const data = siteData || {};
    const paths = Object.keys(data).filter(isContentPath);
    const entryPath = findEntryPath(data);
    const head = entryPath ? decodeHead(data[entryPath]?.content) : '';

    const title = documentTitle(head);
    const description = metaContent(head, 'description');
    const keywords = metaContent(head, 'keywords');

    const size = Object.values(data).reduce((total, file) => total + (Number(file?.size) || 0), 0);

    return {
        hash: `${hash}`.toLowerCase(),
        title,
        description,
        keywords,
        entryPath,
        // Paths are what somebody actually remembers about a site they built:
        // "the one with gallery.html".
        files: paths.slice(0, 200),
        fileCount: paths.length,
        size,
        publisher: signatureState?.publisher || '',
        verified: Boolean(signatureState?.verified),
        signatureLabel: signatureState?.label || '',
        url: url || '',
        savedAt: timestamp
    };
}

/** Everything one row can be matched against, lowercased once. */
function haystack(entry) {
    return [
        entry.title,
        entry.description,
        entry.keywords,
        entry.publisher,
        entry.hash,
        entry.entryPath,
        ...(entry.files || [])
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

/**
 * Score one row against one term. Where a term matches says how much it means:
 * a word in the title is what the page calls itself, a file name is a detail.
 * @param {any} entry
 * @param {string} term
 */
function scoreTerm(entry, term) {
    let score = 0;
    if (`${entry.title}`.toLowerCase().includes(term)) score += 8;
    if (`${entry.description}`.toLowerCase().includes(term)) score += 4;
    if (`${entry.keywords}`.toLowerCase().includes(term)) score += 4;
    if (`${entry.hash}`.startsWith(term)) score += 6;
    if (`${entry.publisher}`.toLowerCase().includes(term)) score += 3;
    if ((entry.files || []).some((path) => `${path}`.toLowerCase().includes(term))) score += 2;
    return score;
}

/**
 * Free-text search over the local library.
 *
 * Every term has to appear somewhere in the row — an extra word narrows the
 * result rather than widening it, which is what a person typing a second word
 * means by it. An empty query is not a search: it lists everything, newest
 * first, which is the useful default for a page that is mostly "what have I
 * looked at".
 *
 * @param {any[]} entries
 * @param {string} query
 */
export function searchLibrary(entries, query) {
    const rows = entries || [];
    const terms = `${query || ''}`
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(Boolean);

    if (terms.length === 0) {
        return [...rows].sort((left, right) => (right.savedAt || 0) - (left.savedAt || 0));
    }

    return rows
        .map((entry) => {
            const text = haystack(entry);
            if (!terms.every((term) => text.includes(term))) return null;
            const score = terms.reduce((total, term) => total + scoreTerm(entry, term), 0);
            return { entry, score };
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || (right.entry.savedAt || 0) - (left.entry.savedAt || 0))
        .map((row) => row.entry);
}
