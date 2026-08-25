// @ts-check
/**
 * Public WEB25 website registry over Nostr (NIP-35).
 *
 * This is the second, deliberately separate Nostr use case in the app:
 *
 *   Direct Messenger → private signalling and encrypted fallback (NIP-17/44/59)
 *   Registry         → public website discovery (NIP-35 kind 2003)
 *
 * They share the relay client and the wallet-worker signing operation, and
 * nothing else. No SDP, ICE candidate, ECIES secret or message content ever
 * reaches an event built here — a registry event is entirely public metadata.
 *
 * Responsibilities: build the event, sign it through the existing wallet worker,
 * publish it to the registry relays, retry *the same signed event*, query the
 * WEB25 website category, and verify the mirrored EVM proof.
 */

import { DEFAULT_NOSTR_REGISTRY_RELAYS, NOSTR_CONFIG, NOSTR_REGISTRY_CONFIG } from '../config/nostr.config.js';
import { NostrRelayPool } from '../nostr/NostrRelayPool.js';
import { verifyNostrEvent } from '../nostr/nostr.js';
import { npubEncode } from '../nostr/nip19.js';
import { verifyPublishSignature } from '../auth/SigningService.js';
import {
    buildRegistryEventTemplate,
    parseRegistryEvent,
    verifyRegistryProof,
    WEB25_VERIFICATION
} from './Web25RegistryEvent.js';

export class Web25RegistryService {
    /**
     * @param {{
     *   signer: any,
     *   pool?: any,
     *   relays?: string[],
     *   config?: typeof NOSTR_REGISTRY_CONFIG,
     *   verifyEvmSignature?: (message: string, signature: string, address: string) => Promise<boolean>,
     *   now?: () => number
     * }} options
     */
    constructor({
        signer,
        pool = null,
        relays = DEFAULT_NOSTR_REGISTRY_RELAYS,
        config = NOSTR_REGISTRY_CONFIG,
        verifyEvmSignature = verifyPublishSignature,
        now = Date.now
    }) {
        if (!signer) throw new Error('Web25RegistryService requires a wallet signing handle.');

        this.signer = signer;
        this.config = config;
        this.verifyEvmSignature = verifyEvmSignature;
        this.now = now;

        // A separate pool from the Direct Messenger's, on the registry relay
        // list. The class itself is reused unchanged.
        this.pool =
            pool ||
            new NostrRelayPool({
                relays,
                verifyEvent: verifyNostrEvent,
                config: NOSTR_CONFIG
            });

        this.connected = false;
    }

    /** Open the registry relays. Never throws on an unreachable relay. */
    async connect() {
        const status = await this.pool.connect();
        this.connected = true;
        return status;
    }

    /** Per-relay connection state, for the UI. */
    get relayStatus() {
        return this.pool.status;
    }

    /**
     * Build and sign the registry event for a finished deployment.
     *
     * Signing goes through the existing narrowly scoped wallet-worker Nostr
     * operation, so the private key never reaches this module. A locked wallet
     * makes this reject, which is the intended behaviour: a registry entry
     * cannot be created without an unlocked identity.
     *
     * @param {{ torrent: any, chainArtifact: { payload: any, message: string, signature: string },
     *           siteName?: string, trackers?: string[] }} params
     * @returns {Promise<any>} the signed Nostr event
     */
    async createSignedRegistryEvent({ torrent, chainArtifact, siteName = '', trackers = [] }) {
        const identity = await this.signer.getNostrIdentity();
        if (!identity?.nostrPublicKey) {
            throw new Error('Nostr identity is unavailable: unlock your wallet to publish to the registry.');
        }

        const template = buildRegistryEventTemplate({
            torrent,
            chainArtifact,
            siteName,
            trackers,
            createdAtSeconds: Math.floor(this.now() / 1000)
        });

        const event = await this.signer.nostrSignEvent(template);

        // A signature we cannot verify locally is never published.
        if (!verifyNostrEvent(event)) {
            throw new Error('The signed registry event failed local verification.');
        }
        return event;
    }

    /**
     * Publish an already-signed event to every reachable registry relay.
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
        if (!signedEvent?.id || !signedEvent?.sig) throw new Error('A signed registry event is required.');

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
                error: result.accepted.length > 0 ? null : 'No registry relay accepted the event.'
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
    buildRegistryFilter({ since = undefined, limit = undefined } = {}) {
        return {
            kinds: [this.config.TORRENT_EVENT_KIND],
            // Filter on the `t` hashtag rather than the category: `tcat` is now
            // the general DTAN `application` category, shared with every other
            // application torrent, so it cannot select WEB25 entries. Single-
            // letter tags are indexed by every relay, so `#t` is reliable.
            '#t': [this.config.WEB25_PRIMARY_HASHTAG],
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

        const subscription = this.pool.subscribe([this.buildRegistryFilter(options)], (event, relayUrl) => {
            const parsed = parseRegistryEvent(event, { relayUrl, npubEncode });
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
    async query({ since = undefined, limit = undefined, timeoutMs = undefined, verify = true } = {}) {
        if (!this.connected) await this.connect();

        const collected = [];
        const subscription = this.subscribe((result) => collected.push(result), { since, limit });

        await new Promise((resolve) => setTimeout(resolve, timeoutMs ?? this.config.QUERY_TIMEOUT_MS));
        subscription.close();

        const results = verify ? await Promise.all(collected.map((result) => this.verifyResult(result))) : collected;
        return results.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Verify one result's mirrored WEB25/EVM proof.
     *
     * A valid Nostr signature only proves who wrote the registry entry; this is
     * the separate question of whether the publisher proof inside it holds.
     * @param {any} result
     */
    verifyResult(result) {
        return verifyRegistryProof(result, this.verifyEvmSignature);
    }

    /** Close the registry relays. */
    close() {
        this.pool.close();
        this.connected = false;
    }
}

export { WEB25_VERIFICATION };
