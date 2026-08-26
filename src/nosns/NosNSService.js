// @ts-check
/**
 * NosNS — the WEB25 website directory over DTAN.
 *
 * This is the second, deliberately separate Nostr use case in the app:
 *
 *   Direct Messenger → private signalling and encrypted fallback (NIP-17/44/59)
 *   NosNS            → public website discovery (NIP-35 kind 2003, via DTAN)
 *
 * They share the relay client and the wallet-worker signing operation, and
 * nothing else. No SDP, ICE candidate, ECIES secret or message content ever
 * reaches an event built here — a NosNS event is entirely public metadata.
 *
 * Publication and discovery both go to `wss://relay.dtan.xyz` and nowhere else.
 * NosNS is a convention inside the real DTAN index, so adding generic relays
 * would scatter records outside the directory people actually browse.
 *
 * Responsibilities: build the event, sign it through the existing wallet worker,
 * publish it to DTAN, retry *the same signed event*, query a chosen DTAN
 * category, and verify the mirrored EVM proof.
 */

import { NOSTR_CONFIG, NOSNS_CONFIG } from '../config/nostr.config.js';
import { NostrRelayPool } from '../nostr/NostrRelayPool.js';
import { verifyNostrEvent } from '../nostr/nostr.js';
import { npubEncode } from '../nostr/nip19.js';
import { verifyPublishSignature } from '../auth/SigningService.js';
import {
    NOSNS_EVENT_KIND,
    NOSNS_RELAY,
    NOSNS_RELAYS,
    NOSNS_DEFAULT_CATEGORY,
    isValidDtanCategory
} from './NosNSProtocol.js';
import { buildNosnsEventTemplate, parseNosnsEvent, verifyNosnsProof, WEB25_VERIFICATION } from './NosNSEvent.js';

export class NosNSService {
    /**
     * @param {{
     *   signer: any,
     *   pool?: any,
     *   relays?: string[],
     *   config?: typeof NOSNS_CONFIG,
     *   verifyEvmSignature?: (message: string, signature: string, address: string) => Promise<boolean>,
     *   now?: () => number
     * }} options
     */
    constructor({
        signer,
        pool = null,
        relays = NOSNS_RELAYS,
        config = NOSNS_CONFIG,
        verifyEvmSignature = verifyPublishSignature,
        now = Date.now
    }) {
        if (!signer) throw new Error('NosNSService requires a wallet signing handle.');

        this.signer = signer;
        this.config = config;
        /** The directory relay list, exactly one entry by construction. */
        this.relays = Object.freeze([...relays]);
        this.verifyEvmSignature = verifyEvmSignature;
        this.now = now;

        // A separate pool from the Direct Messenger's, on the NosNS directory
        // relay alone. The pool class itself is reused unchanged.
        this.pool =
            pool ||
            new NostrRelayPool({
                relays,
                verifyEvent: verifyNostrEvent,
                config: NOSTR_CONFIG
            });

        this.connected = false;
    }

    /** Open the DTAN relay. Never throws on an unreachable relay. */
    async connect() {
        const status = await this.pool.connect();
        this.connected = true;
        return status;
    }

    /**
     * Probe DTAN reachability for the UI.
     *
     * Deliberately distinct from category loading: categories are local
     * configuration and always available, while this is a network test whose
     * failure must not block a deployment.
     *
     * @returns {Promise<{ relay: string, reachable: boolean, error: string|null }>}
     */
    async probe() {
        try {
            await this.connect();
        } catch (error) {
            return {
                relay: NOSNS_RELAY,
                reachable: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
        const reachable = this.pool.connectedCount > 0;
        return { relay: NOSNS_RELAY, reachable, error: reachable ? null : 'No connection to the directory relay.' };
    }

    /** Per-relay connection state, for the UI. */
    get relayStatus() {
        return this.pool.status;
    }

    /**
     * Build and sign the NosNS event for a finished deployment.
     *
     * Signing goes through the existing narrowly scoped wallet-worker Nostr
     * operation, so the private key never reaches this module. A locked wallet
     * makes this reject, which is the intended behaviour: a directory entry
     * cannot be created without an unlocked identity.
     *
     * @param {{ torrent: any, chainArtifact: { payload: any, message: string, signature: string },
     *           siteName?: string, trackers?: string[] }} params
     * @returns {Promise<any>} the signed Nostr event
     */
    async createSignedNosnsEvent({
        torrent,
        chainArtifact,
        siteName = '',
        trackers = [],
        category = NOSNS_DEFAULT_CATEGORY
    }) {
        const identity = await this.signer.getNostrIdentity();
        if (!identity?.nostrPublicKey) {
            throw new Error('Nostr identity is unavailable: unlock your wallet to publish to NosNS.');
        }

        const template = buildNosnsEventTemplate({
            torrent,
            chainArtifact,
            siteName,
            trackers,
            category,
            createdAtSeconds: Math.floor(this.now() / 1000)
        });

        const event = await this.signer.nostrSignEvent(template);

        // A signature we cannot verify locally is never published.
        if (!verifyNostrEvent(event)) {
            throw new Error('The signed NosNS record failed local verification.');
        }
        return event;
    }

    /**
     * Publish an already-signed event to the NosNS directory relay.
     *
     * This deliberately takes a signed event rather than building one, so a
     * retry is a resubmission of the very same event — same id, same
     * `created_at`, same signature. DTAN and similar indexes can enforce
     * distinct infohashes, so a rebuilt event would look like a second torrent
     * entry for the same site rather than a retry.
     *
     * @param {any} signedEvent
     * @returns {Promise<{ ok: boolean, eventId: string, accepted: string[], rejected: Record<string,string>, attempted: number, error: string|null }>}
     */
    async publishSignedEvent(signedEvent) {
        if (!signedEvent?.id || !signedEvent?.sig) throw new Error('A signed NosNS record is required.');

        if (!this.connected) {
            try {
                await this.connect();
            } catch (error) {
                return this._failure(signedEvent, error);
            }
        }

        try {
            const result = await this.pool.publish(signedEvent);
            return {
                ok: result.accepted.length > 0,
                eventId: signedEvent.id,
                accepted: result.accepted,
                rejected: result.rejected,
                attempted: result.attempted,
                error: result.accepted.length > 0 ? null : `${NOSNS_RELAY} did not accept the record.`
            };
        } catch (error) {
            return this._failure(signedEvent, error);
        }
    }

    /**
     * @param {any} signedEvent
     * @param {unknown} error
     */
    _failure(signedEvent, error) {
        return {
            ok: false,
            eventId: signedEvent.id,
            accepted: [],
            rejected: {},
            attempted: 0,
            error: error instanceof Error ? error.message : String(error)
        };
    }

    /**
     * The NIP-35 filter for WEB25 websites: kind 2003 in this category, and
     * nothing else.
     * @param {{ since?: number, limit?: number }} [options]
     */
    buildNosnsFilter({ category = NOSNS_DEFAULT_CATEGORY, since = undefined, limit = undefined } = {}) {
        if (!isValidDtanCategory(category)) throw new Error(`"${category}" is not an official DTAN category.`);
        return {
            kinds: [NOSNS_EVENT_KIND],
            // Scoped to the chosen DTAN category rather than the whole index:
            // NosNS lives inside DTAN, so browsing means browsing a category.
            '#i': [category],
            since: since ?? Math.floor(this.now() / 1000) - this.config.QUERY_LOOKBACK_SECONDS,
            limit: limit ?? this.config.QUERY_LIMIT
        };
    }

    /**
     * Subscribe to WEB25 website entries.
     *
     * Every event arriving here has already been re-verified and re-matched
     * against the filter by the pool, and deduplicated by event id. This layer
     * adds the WEB25-specific structural validation and merges the relays that
     * carried the same entry.
     *
     * @param {(result: any) => void} onResult
     * @param {{ since?: number, limit?: number }} [options]
     */
    subscribe(onResult, options = {}) {
        /** @type {Map<string, any>} */
        const byEventId = new Map();

        const subscription = this.pool.subscribe([this.buildNosnsFilter(options)], (event, relayUrl) => {
            // Everything in the category that is not a NosNS website — every
            // other DTAN torrent — is discarded here by the suffix check.
            const parsed = parseNosnsEvent(event, { relayUrl, npubEncode });
            if (!parsed) return;

            // The pool dedupes per subscription, but a reconnect or a second
            // pool can still deliver a known id: merge the relay instead of
            // emitting the entry twice.
            const existing = byEventId.get(parsed.eventId);
            if (existing) {
                if (relayUrl && !existing.sourceRelays.includes(relayUrl)) existing.sourceRelays.push(relayUrl);
                return;
            }

            byEventId.set(parsed.eventId, parsed);
            onResult(parsed);
        });

        return {
            id: subscription.id,
            close: () => subscription.close(),
            results: () => [...byEventId.values()]
        };
    }

    /**
     * Run a bounded discovery query and resolve with everything collected.
     *
     * @param {{ since?: number, limit?: number, timeoutMs?: number, verify?: boolean }} [options]
     * @returns {Promise<any[]>} newest first
     */
    async query({
        category = NOSNS_DEFAULT_CATEGORY,
        since = undefined,
        limit = undefined,
        timeoutMs = undefined,
        verify = true
    } = {}) {
        if (!this.connected) await this.connect();

        const collected = [];
        const subscription = this.subscribe((result) => collected.push(result), { category, since, limit });

        await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? this.config.QUERY_TIMEOUT_MS));
        subscription.close();

        const results = verify ? await Promise.all(collected.map((result) => this.verifyResult(result))) : collected;
        return results.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Verify one result's mirrored WEB25/EVM proof.
     *
     * A valid Nostr signature only proves who wrote the directory entry; this is
     * the separate question of whether the publisher proof inside it holds.
     * @param {any} result
     */
    verifyResult(result) {
        return verifyNosnsProof(result, this.verifyEvmSignature);
    }

    /** Close the DTAN relay. */
    close() {
        this.pool.close();
        this.connected = false;
    }
}

export { WEB25_VERIFICATION, NOSNS_RELAY };
