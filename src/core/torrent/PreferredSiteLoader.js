// @ts-check
/**
 * The one place that decides where a site's bytes come from.
 *
 * Resolution order:
 *   1. local cache
 *   2. WebTorrent / P2P — one attempt, bounded by `P2P_ATTEMPT_TIMEOUT_MS`
 *   3. GoFile mirror, when the WEB25 address carries a locator
 *
 * P2P is first because it is what the deployment *is*: the torrent hash is the
 * identity of the site and the swarm is what keeps it alive. A visitor served
 * from the mirror is not a peer, so a mirror that goes first quietly drains the
 * swarm it is supposed to be insurance for.
 *
 * What P2P is not allowed to be is slow. Peer discovery either works within a
 * few seconds or it is not going to, so the attempt gets one short window and
 * the mirror takes over the moment it closes — the whole fallback lives in
 * `TorrentLoader.handleTerminalP2PFailure`, which is also where a failed
 * announce, a dead tracker set and a torrent error already end up.
 *
 * This module is therefore only the cache half: it answers from the cache
 * before WebTorrent is even ready, and otherwise hands the load straight to the
 * torrent loader with the locator intact.
 */

import { parseWeb25Address } from '../../gofile/Web25Url.js';
import * as torrentLoader from './TorrentLoader.js';

function initializeSignatureState(hash) {
    const knownSignature = this.signedTorrentMetadata.get(hash);
    this.currentSiteSignatureStatus = knownSignature
        ? this.buildSignatureState({
              label: knownSignature.verified
                  ? `Verified publisher: ${knownSignature.publisher.slice(0, 10)}...`
                  : `Unverified publisher: ${knownSignature.publisher.slice(0, 10)}...`,
              verified: Boolean(knownSignature.verified),
              source: 'legacy',
              publisher: knownSignature.publisher,
              torrentHash: hash
          })
        : this.buildSignatureState({
              label: 'Publisher signature pending (.torrentchain)',
              verified: false,
              source: 'legacy',
              torrentHash: hash
          });
}

/**
 * @param {string|{ torrentHash: string, gofileLocator?: string|null }} addressInput
 * @param {string|null} [retryLocator] a mirror locator recovered separately from the address
 */
export async function loadSite(addressInput, retryLocator = null) {
    let address;
    try {
        address =
            typeof addressInput === 'object'
                ? addressInput
                : parseWeb25Address(`${addressInput}${retryLocator ? `&${retryLocator}` : ''}`);
    } catch (error) {
        alert(`❌ Invalid WEB25 Address\n\n${error.message}`);
        return;
    }

    const sanitizedHash = this.sanitizeHash(address.torrentHash);
    const gofileLocator = address.gofileLocator || retryLocator || null;

    if (!this.isValidTorrentHash(sanitizedHash)) {
        alert(
            '❌ Invalid Hash Format\n\nThe torrent hash must be a 40-character hexadecimal string.\n\n🔧 Format Requirements:\n• Exactly 40 characters long\n• Only contains numbers 0-9 and letters A-F'
        );
        return;
    }

    this._loadGeneration = (this._loadGeneration || 0) + 1;
    const loadGeneration = this._loadGeneration;
    this._gofileFallbackController?.abort();
    this._gofileFallbackController = null;
    this.releaseLoadTorrent?.();
    this.currentHash = sanitizedHash;
    initializeSignatureState.call(this, sanitizedHash);

    // Cache is intentionally checked before WebTorrent readiness. A cached site
    // should render even while the P2P client is still booting or unavailable.
    const cachedEntry = await this.cache.getEntry(sanitizedHash);
    if (this._loadGeneration !== loadGeneration) return;
    if (cachedEntry?.data) {
        this.log('Loading from cache...');
        this.applyCachedSignatureState(cachedEntry.signatureState, sanitizedHash);
        this.displayCachedSite(cachedEntry.data, sanitizedHash);
        return;
    }

    // Straight to the swarm. The locator rides along so the torrent loader can
    // fall back to the mirror on its own, once — and only once — the single
    // P2P attempt has genuinely failed or run out of time.
    return torrentLoader.loadSite.call(this, { torrentHash: sanitizedHash, gofileLocator }, 0, null);
}
