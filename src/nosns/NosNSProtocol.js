// @ts-check
/**
 * NosNS — Nostr Name System.
 *
 * A deliberately tiny convention layered on standard NIP-35 / DTAN torrent
 * events. There is no custom event kind, no custom category and no required
 * custom tag. The whole protocol is:
 *
 *     NIP-35 kind 2003
 *   + one official DTAN category chosen by the publisher
 *   + wss://relay.dtan.xyz as the only directory relay
 *   + a torrent name ending exactly in ".nosns.torrent"
 *
 * That last line is the entire discriminator: a NIP-35 torrent whose title ends
 * with the suffix is a NosNS website, and one that does not is somebody else's
 * torrent. Keeping identification in the name rather than in a bespoke tag is
 * what lets NosNS entries live inside the real DTAN index instead of a private
 * corner of it.
 */

/** The one and only NosNS directory relay. */
export const NOSNS_RELAY = 'wss://relay.dtan.xyz';

/** Relay list form. Exactly one entry — no generic relays are appended. */
export const NOSNS_RELAYS = Object.freeze([NOSNS_RELAY]);

/** The canonical, lowercase torrent-name suffix that identifies NosNS. */
export const NOSNS_TORRENT_SUFFIX = '.nosns.torrent';

/** Standard NIP-35 torrent event. Deliberately not a custom kind. */
export const NOSNS_EVENT_KIND = 2003;

/**
 * DTAN's category taxonomy, mirrored as frontend configuration.
 *
 * A Nostr relay does not expose a category list — DTAN defines it client-side
 * in `src/const.ts` — so this is a local mirror kept deliberately in the same
 * shape and with the same tag values. Category *loading* is therefore local
 * configuration and has nothing to do with relay connectivity.
 */
export const DTAN_CATEGORIES = Object.freeze([
    {
        name: 'Video',
        tag: 'video',
        sub: [
            {
                name: 'Movies',
                tag: 'movie',
                sub: [
                    { name: 'DVDR', tag: 'dvdr' },
                    { name: 'HD', tag: 'hd' },
                    { name: '4k', tag: '4k' }
                ]
            },
            {
                name: 'TV',
                tag: 'tv',
                sub: [
                    { name: 'HD', tag: 'hd' },
                    { name: '4k', tag: '4k' }
                ]
            }
        ]
    },
    {
        name: 'Audio',
        tag: 'audio',
        sub: [
            { name: 'Music', tag: 'music', sub: [{ name: 'FLAC', tag: 'flac' }] },
            { name: 'Audio Books', tag: 'audio-book' }
        ]
    },
    {
        name: 'Applications',
        tag: 'application',
        sub: [
            { name: 'Windows', tag: 'windows' },
            { name: 'Mac', tag: 'mac' },
            { name: 'UNIX', tag: 'unix' },
            { name: 'iOS', tag: 'ios' },
            { name: 'Android', tag: 'android' }
        ]
    },
    {
        name: 'Games',
        tag: 'game',
        sub: [
            { name: 'PC', tag: 'pc' },
            { name: 'Mac', tag: 'mac' },
            { name: 'PSx', tag: 'psx' },
            { name: 'XBOX', tag: 'xbox' },
            { name: 'Wii', tag: 'wii' },
            { name: 'iOS', tag: 'ios' },
            { name: 'Android', tag: 'android' }
        ]
    },
    {
        name: 'Porn',
        tag: 'porn',
        sub: [
            {
                name: 'Movies',
                tag: 'movie',
                sub: [
                    { name: 'DVDR', tag: 'dvdr' },
                    { name: 'HD', tag: 'hd' },
                    { name: '4k', tag: '4k' }
                ]
            },
            { name: 'Pictures', tag: 'picture' },
            { name: 'Games', tag: 'game' }
        ]
    },
    {
        name: 'Other',
        tag: 'other',
        sub: [
            { name: 'Archives', tag: 'archive' },
            { name: 'E-Books', tag: 'e-book' },
            { name: 'Comics', tag: 'comic' },
            { name: 'Pictures', tag: 'picture' }
        ]
    }
]);

/** What a WEB25 static site defaults to: a bundled web application. */
export const NOSNS_DEFAULT_CATEGORY = 'tcat:application';

// ─── torrent naming ──────────────────────────────────────────────────────

/**
 * Normalize any site name into a NosNS torrent name.
 *
 * This value becomes the real BitTorrent `info.name`, not a renamed download,
 * so it has to be idempotent: publishing twice, or re-deriving it from an
 * already-suffixed name, must not stack suffixes.
 *
 * @param {string} name
 * @returns {string} a name ending in exactly one `.nosns.torrent`
 */
export function ensureNosnsTorrentName(name) {
    let base = `${name || ''}`.trim();
    if (!base) base = 'website';

    // Strip any number of trailing `.nosns.torrent` / `.torrent` segments so a
    // re-derived name collapses back to its stem.
    let changed = true;
    while (changed) {
        changed = false;
        const lower = base.toLowerCase();
        if (lower.endsWith(NOSNS_TORRENT_SUFFIX)) {
            base = base.slice(0, -NOSNS_TORRENT_SUFFIX.length);
            changed = true;
        } else if (lower.endsWith('.torrent')) {
            base = base.slice(0, -'.torrent'.length);
            changed = true;
        } else if (lower.endsWith('.nosns')) {
            base = base.slice(0, -'.nosns'.length);
            changed = true;
        }
    }

    base = base.replace(/\.+$/, '').trim();
    if (!base) base = 'website';
    return `${base}${NOSNS_TORRENT_SUFFIX}`;
}

/**
 * The single NosNS protocol check.
 * @param {string} title a NIP-35 title / torrent name
 */
export function isNosnsTorrentName(title) {
    // Deliberately strict: no trim, no case folding. The suffix is a protocol
    // token, and `ensureNosnsTorrentName()` is the one place that canonicalises
    // it. Accepting `.NOSNS.TORRENT` here would mean two different byte strings
    // both counted as NosNS, so the same site could be listed twice and a
    // lookup by name would depend on which spelling a client happened to use.
    return `${title || ''}`.endsWith(NOSNS_TORRENT_SUFFIX);
}

/**
 * Human-friendly form of a NosNS name, for display only.
 *
 * The raw title stays the protocol value; this is what a list shows.
 * @param {string} title
 */
export function nosnsDisplayName(title) {
    const raw = `${title || ''}`.trim();
    if (!isNosnsTorrentName(raw)) return raw;
    return raw.slice(0, -NOSNS_TORRENT_SUFFIX.length) || raw;
}

// ─── DTAN categories ─────────────────────────────────────────────────────

/**
 * Every selectable category, flattened, in tree order.
 * @returns {{ tcat: string, path: string[], label: string, depth: number }[]}
 */
export function listDtanCategories() {
    /** @type {{ tcat: string, path: string[], label: string, depth: number }[]} */
    const out = [];

    /**
     * @param {any[]} nodes
     * @param {string[]} parentPath
     * @param {string[]} parentLabels
     */
    const walk = (nodes, parentPath, parentLabels) => {
        for (const node of nodes) {
            const path = [...parentPath, node.tag];
            const labels = [...parentLabels, node.name];
            out.push({ tcat: serializeDtanCategory(path), path, label: labels.join(' / '), depth: path.length - 1 });
            if (Array.isArray(node.sub)) walk(node.sub, path, labels);
        }
    };

    walk(/** @type {any[]} */ (DTAN_CATEGORIES), [], []);
    return out;
}

/**
 * @param {string[]} path e.g. `['application', 'unix']`
 * @returns {string} e.g. `tcat:application,unix`
 */
export function serializeDtanCategory(path) {
    const segments = (path || []).map((segment) => `${segment || ''}`.trim().toLowerCase()).filter(Boolean);
    if (segments.length === 0) throw new Error('A DTAN category path needs at least one segment.');
    return `tcat:${segments.join(',')}`;
}

/**
 * @param {string} tcat
 * @returns {string[]} the path segments, or `[]` when malformed
 */
export function parseDtanCategory(tcat) {
    const value = `${tcat || ''}`.trim().toLowerCase();
    if (!value.startsWith('tcat:')) return [];
    return value
        .slice('tcat:'.length)
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean);
}

/**
 * Is this one of DTAN's real categories?
 *
 * Arbitrary category strings are rejected: a category that DTAN does not know
 * is a category nobody can browse to, which is exactly the failure the old
 * custom `tcat:web25.cloud,websites` produced.
 *
 * @param {string} tcat
 */
export function isValidDtanCategory(tcat) {
    return listDtanCategories().some((entry) => entry.tcat === `${tcat || ''}`.trim().toLowerCase());
}

/**
 * @param {string} tcat
 * @returns {string} e.g. `Applications / UNIX`, or the raw value when unknown
 */
export function dtanCategoryLabel(tcat) {
    const normalized = `${tcat || ''}`.trim().toLowerCase();
    return listDtanCategories().find((entry) => entry.tcat === normalized)?.label || normalized;
}

/**
 * Validate a user-selected category, falling back rather than letting an
 * unknown value reach a published event.
 * @param {string} tcat
 * @param {string} [fallback] what to return when `tcat` is not a real category
 */
export function normalizeDtanCategory(tcat, fallback = NOSNS_DEFAULT_CATEGORY) {
    const normalized = `${tcat || ''}`.trim().toLowerCase();
    if (isValidDtanCategory(normalized)) return normalized;
    // Pass `''` to make the absence of a real choice visible to the caller.
    // Publication uses that: a category is something the publisher picks, not
    // something the app picks for them and files their site under.
    return fallback;
}
