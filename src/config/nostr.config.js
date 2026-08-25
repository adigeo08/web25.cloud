// @ts-check
/**
 * Central Nostr configuration for the browser-only Web25 client.
 *
 * Everything here is used directly from the page: the browser opens plain
 * WebSockets to public relays. There is no relay proxy, no signalling server
 * and no Web25-operated relay anywhere in this project.
 */

/**
 * General-purpose public relays. No single relay is required — a pool publishes
 * to and subscribes across all of them, tolerates the ones that are down, and
 * deduplicates whatever comes back.
 */
export const DEFAULT_NOSTR_RELAYS = Object.freeze([
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.snort.social'
]);

/**
 * Relays used for private Direct Messenger traffic (NIP-17/44/59 gift wraps).
 */
export const DEFAULT_NOSTR_DM_RELAYS = DEFAULT_NOSTR_RELAYS;

/**
 * Relays used for the public WEB25 website registry (NIP-35 kind 2003).
 *
 * Deliberately only the specialised torrent-index relay: registry entries are
 * a torrent index, and the general relays in `DEFAULT_NOSTR_RELAYS` carry the
 * private Direct Messenger traffic. Keeping the lists disjoint means a public
 * website listing is never published into the DM relay pool.
 *
 * The trade-off is accepted on purpose: discovery depends on this one relay
 * being reachable. It is only discovery — a site stays live, seeding and
 * loadable by infohash whatever the registry does.
 */
export const DEFAULT_NOSTR_REGISTRY_RELAYS = Object.freeze(['wss://relay.dtan.xyz']);

export const NOSTR_CONFIG = Object.freeze({
    /** Per-relay socket open timeout. */
    RELAY_CONNECT_TIMEOUT_MS: 8000,
    /** How long `publish()` waits for relay `OK` frames before reporting. */
    RELAY_PUBLISH_TIMEOUT_MS: 8000,
    /** Reconnect backoff bounds for a relay that drops. */
    RELAY_RECONNECT_MIN_MS: 2000,
    RELAY_RECONNECT_MAX_MS: 60000,
    /** Hard cap on a single relay frame; anything larger is dropped unparsed. */
    MAX_RELAY_FRAME_BYTES: 512 * 1024,
    /** Bound on a subscription's "already seen" set so a hostile relay cannot grow it without limit. */
    MAX_SEEN_EVENT_IDS: 4096,
    /**
     * How far back the gift-wrap inbox looks. NIP-59 jitters timestamps up to
     * two days into the past, so this is deliberately wider than that.
     */
    INBOX_LOOKBACK_SECONDS: 3 * 24 * 60 * 60,
    /** Reject events whose `created_at` is further ahead than this. */
    MAX_EVENT_FUTURE_SKEW_SECONDS: 15 * 60,

    /** Kind of the NIP-59 rumor carrying a Web25 WebRTC invitation. */
    WEB25_SIGNALING_KIND: 25510,
    /**
     * Kind of the NIP-59 rumor carrying a chat request — "I would like to talk
     * to you". Private and gift-wrapped like everything else in the DM path,
     * and deliberately separate from the invitation: intent carries no SDP.
     */
    WEB25_CHAT_REQUEST_KIND: 25511,

    /**
     * NIP-38 user status, used as a presence beacon. Addressable, so a peer can
     * be asked "are you around?" without both sides being subscribed at the
     * same moment.
     */
    PRESENCE_KIND: 30315,
    /** `d` tag namespacing our presence away from a user's general status. */
    PRESENCE_IDENTIFIER: 'web25-dm',
    /** Presence is republished on this interval while the messenger is open. */
    PRESENCE_REPUBLISH_MS: 60 * 1000,
    /** A presence beacon older than this is treated as offline. */
    PRESENCE_TTL_MS: 3 * 60 * 1000,
    /** A chat request older than this no longer counts towards mutual intent. */
    CHAT_REQUEST_TTL_MS: 30 * 60 * 1000,
    /** NIP-17 private chat message kind, used for the encrypted relay fallback. */
    NIP17_CHAT_KIND: 14,

    /** Lifetime of a Nostr-delivered WebRTC invitation. */
    INVITATION_TTL_MS: 15 * 60 * 1000,
    /**
     * How long a WebRTC connection attempt may run before the transport gives
     * up and falls back to the relay path.
     */
    WEBRTC_CONNECT_TIMEOUT_MS: 25000,
    /**
     * Grace period for a transient `disconnected` ICE state. WebRTC recovers
     * from these routinely, so the fallback is not armed until it elapses.
     */
    WEBRTC_DISCONNECT_GRACE_MS: 12000
});

/**
 * Public WEB25 website registry (NIP-35).
 *
 * This is discovery only. A registry entry tells a browser that a site exists
 * and who claims to have published it; the BitTorrent infohash identifies the
 * artifact, and the `.torrentchain` inside it remains the authority on contents
 * and publisher. Nothing here is ever trusted over a downloaded manifest.
 */
export const NOSTR_REGISTRY_CONFIG = Object.freeze({
    /** NIP-35 torrent event. */
    TORRENT_EVENT_KIND: 2003,

    /**
     * NIP-35 category, as an `i` tag.
     *
     * DTAN resolves categories against a fixed tree — `video`, `audio`,
     * `application`, `game`, `porn`, `other` — so an invented path like
     * `tcat:web25.cloud,websites` matches no filter there and the entry is
     * effectively invisible in the DTAN ecosystem. A WEB25 site is a bundled
     * web application, so `application` is the honest fit among the categories
     * that actually index.
     */
    WEB25_CATEGORY: 'tcat:application',

    /**
     * WEB25-specific marker, kept in the `i` namespace alongside the category.
     * NIP-35 allows several `i` tags (`tcat`, `imdb`, `tmdb`, …), so this
     * identifies a WEB25 entry precisely without displacing the category DTAN
     * needs.
     */
    WEB25_MARKER: 'web25:website',

    /**
     * Hashtags. `web25` is the one discovery filters on — `t` tags are indexed
     * by every relay, so this is what makes WEB25 entries findable without
     * relying on a custom category being understood.
     */
    WEB25_HASHTAGS: Object.freeze(['web25', 'website', 'static-site']),
    /** The hashtag a registry query filters on. */
    WEB25_PRIMARY_HASHTAG: 'web25',

    /** Namespaced tags mirroring the `.torrentchain` proof into the event. */
    PROOF_TAGS: Object.freeze({
        SCHEMA: 'web25-schema',
        PUBLISHER: 'web25-publisher',
        CHAIN_ID: 'web25-chain-id',
        CREATED_AT: 'web25-created-at',
        MERKLE_ROOT: 'web25-merkle-root',
        BUNDLE_SHA256: 'web25-bundle-sha256',
        BUNDLE_NAME: 'web25-bundle-name',
        SIGNATURE: 'web25-signature',
        MESSAGE: 'web25-message'
    }),

    /** How long a discovery query waits for relays before rendering results. */
    QUERY_TIMEOUT_MS: 6000,
    /** Cap on results held from one query. */
    QUERY_LIMIT: 100,
    /** How far back a registry query looks. */
    QUERY_LOOKBACK_SECONDS: 365 * 24 * 60 * 60,
    /** Hard cap on the mirrored signed message, so one event cannot be huge. */
    MAX_PROOF_MESSAGE_BYTES: 8192,
    /** Hard cap on `file` tags advertised for one torrent. */
    MAX_FILE_TAGS: 64
});
