// @ts-check

import { parseWeb25Address } from '../../gofile/Web25Url.js';
import { GoFileService } from '../../gofile/GoFileService.js';
import {
    createMirrorTorrentAdapter,
    decodeGoFileMirror,
    gofileMirrorFilename,
    verifyGoFileMirror
} from '../../gofile/GoFileMirrorCodec.js';
import * as torrentLoader from './TorrentLoader.js';

async function readerCredential(service, store) {
    try {
        const credential = await store?.read();
        if (credential?.token) return credential.token;
    } catch (_) {
        // A visitor does not need an unlocked wallet to resolve a public mirror.
    }
    const account = await service.createGuestAccount();
    return account.token;
}

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

async function tryGoFileMirrorFirst(hash, gofileLocator, loadGeneration) {
    const isActiveLoad = () => this._loadGeneration === loadGeneration && this.currentHash === hash;
    const controller = new AbortController();
    this._gofileFallbackController = controller;

    try {
        this.log(`Cache miss. Trying GoFile mirror before P2P for ${hash}.`);
        this.showLoadingOverlay();

        const service = this.gofileService || new GoFileService();
        const wireBytes = await service.downloadPublicMirror(gofileLocator, {
            token: await readerCredential(service, this.gofileCredentialStore),
            expectedFilename: gofileMirrorFilename(hash),
            signal: controller.signal
        });
        if (!isActiveLoad()) return true;

        const decoded = decodeGoFileMirror(wireBytes);
        const verified = await verifyGoFileMirror(decoded, hash);
        if (!isActiveLoad()) return true;

        const adapter = createMirrorTorrentAdapter(verified);
        const chainGate = await this.verifyTorrentChainBeforeDownload(adapter, hash);
        if (!isActiveLoad()) return true;
        if (!chainGate.ok) throw new Error('GoFile mirror failed TorrentChain verification.');

        this.processingInProgress = true;
        const processed = await this.processTorrent(adapter, hash);
        if (!isActiveLoad()) return true;
        if (processed === false) throw new Error('GoFile mirror failed the WEB25 render verification gate.');

        this.log(`Site loaded through preferred GoFile mirror transport for ${hash}.`);
        return true;
    } catch (error) {
        if (!isActiveLoad()) return true;
        this.processingInProgress = false;
        this.hideLoadingOverlay();
        this.log(`Preferred GoFile mirror unavailable: ${error.message}. Falling back to P2P.`);
        this.toast?.info?.('GoFile mirror unavailable. Falling back to P2P…', 'Fallback transport');
        return false;
    } finally {
        if (this._gofileFallbackController === controller) this._gofileFallbackController = null;
    }
}

/**
 * Preferred website resolution order:
 *   1. local cache
 *   2. GoFile mirror, when the WEB25 address includes a locator
 *   3. WebTorrent / P2P
 *
 * P2P retries delegate straight to the existing TorrentLoader so a failed
 * GoFile mirror is not retried before every torrent retry.
 */
export async function loadSite(addressInput, _retryAttempt = 0, retryLocator = null) {
    if (_retryAttempt > 0) {
        return torrentLoader.loadSite.call(this, addressInput, _retryAttempt, retryLocator);
    }

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
        await this.applyCachedProtectedSite(cachedEntry.protectedSite, sanitizedHash);
        await this.displayCachedSite(cachedEntry.data, sanitizedHash);
        return;
    }

    if (gofileLocator) {
        const loadedFromMirror = await tryGoFileMirrorFirst.call(
            this,
            sanitizedHash,
            gofileLocator,
            loadGeneration
        );
        if (this._loadGeneration !== loadGeneration || loadedFromMirror) return;
    }

    // GoFile was absent or failed. Hand off to the existing P2P loader without
    // the locator so its terminal P2P failure does not loop back to GoFile.
    return torrentLoader.loadSite.call(
        this,
        { torrentHash: sanitizedHash, gofileLocator: null },
        0,
        null
    );
}
