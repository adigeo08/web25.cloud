// @ts-check
/**
 * Central Nostr configuration for the browser-only Web25 client.
 *
 * Everything here is used directly from the page: the browser opens plain
 * WebSockets to public relays. There is no relay proxy, no signalling server
 * and no Web25-operated relay anywhere in this project.
 */

/**
 * The rendezvous relay.
 *
 * Two Web25 browsers can only find each other on a relay they both use. A pool
 * spread over several relays looks more robust and behaves worse: a gift wrap
 * accepted by one relay and a subscription that is healthy on another simply do
 * not meet, and an invitation is lost with nothing reporting a failure — every
 * relay involved said OK.
 *
 * So the client uses one relay, and the pool still exists to reconnect, verify
 * and deduplicate. `nos.lol` is the pick: a large, stable public relay that
 * takes NIP-59 gift wraps without an allowlist. Replace this list to move the
 * rendezvous somewhere else — including to a relay of your own — but keep every
 * client that wants to talk to another on the same list.
 */
export const DEFAULT_NOSTR_RELAYS = Object.freeze(['wss://nos.lol']);

/**
 * Relays used for private Direct Messenger traffic (NIP-17/44/59 gift wraps),
 * presence beacons and chat requests. The same rendezvous, for the same reason:
 * a request delivered to a relay the other side does not read is a request that
 * never arrives.
 */
export const DEFAULT_NOSTR_DM_RELAYS = DEFAULT_NOSTR_RELAYS;

export const NOSTR_CONFIG = Object.freeze({
    /** Per-relay socket open timeout. */
    RELAY_CONNECT_TIMEOUT_MS: 8000,
    /** How long `publish()` waits for relay `OK` frames before reporting. */
    RELAY_PUBLISH_TIMEOUT_MS: 8000,
    /** Reconnect backoff bounds for a relay that drops. */
    RELAY_RECONNECT_MIN_MS: 2000,
    RELAY_RECONNECT_MAX_MS: 60000,
    /**
     * Consecutive failed connection attempts before a relay is given up on.
     *
     * A relay that never answers is not going to start answering because we
     * asked a hundredth time, and every attempt is a WebSocket the browser has
     * to open, fail and log. Two tries, then the relay is marked `unavailable`
     * and left alone until something explicitly calls `connect()` again. A
     * socket that opened and later dropped does not count as a failed attempt:
     * that relay has proven reachable, so it keeps its full backoff.
     */
    RELAY_MAX_CONNECT_FAILURES: 2,
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
    WEBRTC_DISCONNECT_GRACE_MS: 12000,

    /**
     * Payload bytes per file chunk when the conversation is on the relay.
     *
     * A chunk is base64'd, signed, ECIES-encrypted and then wrapped twice by
     * NIP-59 — a seal inside a gift wrap — and each of those layers is itself
     * base64 with padding. The stack multiplies the payload by roughly five
     * before it reaches the relay, and NIP-44 refuses a plaintext over 65535
     * bytes, so the DataChannel's 16 KiB chunk would fail at the outer wrap.
     * 8 KiB leaves comfortable headroom at every layer.
     */
    RELAY_FILE_CHUNK_BYTES: 8 * 1024,

    /**
     * How large a file may be before the relay path refuses it outright.
     *
     * Public relays are somebody else's disk and somebody else's bandwidth,
     * donated for messages. A few hundred chunks is a courteous use of that; a
     * video is not. Past this, the honest answer is to say so rather than to
     * spend two minutes being rate-limited into a partial transfer.
     */
    RELAY_FILE_MAX_BYTES: 2 * 1024 * 1024,

    /**
     * Pause between relayed chunks. Relays rate-limit bursts, and a dropped
     * chunk fails the whole transfer, so the slower send is the faster one.
     */
    RELAY_FILE_CHUNK_PAUSE_MS: 120
});
