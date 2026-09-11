// @ts-check
/**
 * The live half of the seeding store: what is actually announcing right now.
 *
 * `SeedingSessionStore` keeps the bytes; this module turns those records back
 * into WebTorrent torrents on start-up and owns them for the rest of the page's
 * life. The torrents it owns are deliberately outside the reach of everything
 * that tears down page state — signing out, clearing the site cache, staging a
 * new deployment — because a visitor pulling a site from this browser has
 * nothing to do with whether its owner is signed in.
 *
 * Only two things end a session: the publisher pressing Stop seeding, and the
 * tab going away (and that one resumes by itself on the next visit).
 */

import SeedingSessionStore from './SeedingSessionStore.js';
import { bindPagesPanel, confirmStopSeeding, renderPages, updatePagesLiveStats } from '../../ui/pages/PagesPanel.js';

/** How often the Pages cards refresh their live peer/upload counters. */
const SEEDING_STATS_INTERVAL_MS = 5000;

/**
 * Rebuild a payload file exactly as it was seeded, path and all.
 * @param {{ path: string, type: string, bytes: Uint8Array }} entry
 */
function toSeedFile(entry) {
    const name = entry.path.split('/').pop() || entry.path;
    const file = new File([entry.bytes], name, { type: entry.type || 'application/octet-stream' });
    try {
        Object.defineProperty(file, 'path', { value: entry.path });
    } catch (_) {}
    try {
        Object.defineProperty(file, 'webkitRelativePath', { value: entry.path });
    } catch (_) {}
    return file;
}

/** @param {any} value */
function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

/** The store is created on first use so tests can inject their own. */
export function seedingStore() {
    if (!this._seedingStore) this._seedingStore = new SeedingSessionStore();
    return this._seedingStore;
}

/** @returns {Map<string, any>} hash → live torrent */
export function seedingTorrents() {
    if (!this._seedingTorrents) this._seedingTorrents = new Map();
    return this._seedingTorrents;
}

/**
 * Is this torrent one of the ones we are hosting for good?
 *
 * Everything that destroys a torrent as part of normal page cleanup asks this
 * first: a seeding session must not die because the user signed out, cleared
 * the cache or staged the next deployment.
 *
 * @param {any} torrent
 */
export function isSeedingTorrent(torrent) {
    if (!torrent) return false;
    for (const [, owned] of this.seedingTorrents()) {
        if (owned === torrent) return true;
    }
    return Boolean(torrent.infoHash && this.seedingTorrents().has(`${torrent.infoHash}`.toLowerCase()));
}

/**
 * Persist a completed deployment so it keeps seeding across reloads.
 *
 * Called once the deployment is live. The payload is copied into IndexedDB;
 * the torrent that is already announcing is adopted as the session's live
 * torrent rather than re-created, so nothing is interrupted.
 *
 * @param {{ hash: string, torrent: any, torrentFile: ArrayBuffer|Uint8Array|null,
 *           payloadFiles: File[]|null, siteName?: string, createdAt?: string,
 *           deploy: any }} params
 */
export async function recordSeedingSession({
    hash,
    torrent,
    torrentFile,
    payloadFiles,
    siteName = '',
    createdAt = '',
    deploy
}) {
    const sanitized = `${hash || ''}`.toLowerCase();
    if (!sanitized) return null;

    // Two calls land here for a mirrored deployment — once when the site goes
    // live, once when the mirror resolves — and a deployment is its content, so
    // a record that already holds the payload for this hash holds the right
    // bytes by definition. Patching it keeps the second call from copying
    // megabytes into IndexedDB to change one field.
    let stored = null;
    try {
        stored = await this.seedingStore().get(sanitized);
    } catch (_) {
        stored = null;
    }

    // A restored deployment has no payload to copy either: its bytes were never
    // in this page. Same treatment — patch rather than replace the record with
    // one that cannot seed.
    if (stored?.files?.length || !payloadFiles || payloadFiles.length === 0) {
        try {
            const patched = await this.seedingStore().patch(sanitized, { deploy });
            if (patched && torrent) this.adoptSeedingTorrent(sanitized, torrent);
            this.refreshPagesPanel();
            return patched;
        } catch (error) {
            this.log(`Could not update the seeding session for ${sanitized}: ${error.message}`);
            return null;
        }
    }

    try {
        const files = [];
        for (const file of payloadFiles) {
            files.push({
                path: this.getNormalizedDeployPath(file),
                type: file.type || 'application/octet-stream',
                bytes: new Uint8Array(await file.arrayBuffer())
            });
        }

        const record = {
            hash: sanitized,
            siteName: siteName || torrent?.name || 'website',
            torrentName: torrent?.name || siteName || 'website',
            pieceLength: Number(torrent?.pieceLength) || null,
            createdAt: createdAt || new Date().toISOString(),
            savedAt: Date.now(),
            length: Number(torrent?.length) || files.reduce((total, file) => total + file.bytes.length, 0),
            fileCount: files.length,
            torrentFile: toBytes(torrentFile),
            files,
            deploy
        };

        await this.seedingStore().put(record);
        // Adopted only once the record is durable. A torrent in the registry is
        // protected from every teardown path, so adopting one the store never
        // accepted would leave a live torrent with no card in Pages and no way
        // for the user to stop it.
        if (torrent) this.adoptSeedingTorrent(sanitized, torrent);
        this.log(`Seeding session stored for ${sanitized}; it will resume after a reload.`);
        this.refreshPagesPanel();
        return record;
    } catch (error) {
        // Nothing was adopted, so this torrent stays ordinary page state: it
        // seeds while the tab lives and is torn down with everything else.
        this.seedingTorrents().delete(sanitized);
        this.log(`Could not store the seeding session for ${sanitized}: ${error.message}`);
        this.toast?.warning?.(
            'This deployment is live for as long as this tab stays open, but it could not be saved for after a reload.',
            'Seeding not persisted'
        );
        return null;
    }
}

/**
 * Take ownership of a torrent on behalf of a stored session.
 *
 * Ownership and durability go together: everything in this registry is exempt
 * from page teardown, so nothing may enter it that the store has not accepted.
 *
 * @param {string} hash
 * @param {any} torrent
 */
export function adoptSeedingTorrent(hash, torrent) {
    if (!torrent) return null;
    const sanitized = `${hash || ''}`.toLowerCase();
    this.seedingTorrents().set(sanitized, torrent);
    return torrent;
}

/**
 * Re-seed one stored record.
 *
 * The info hash is the deployment's identity, so a re-seed that produces a
 * different one is not the same site: it is dropped rather than announced
 * under a hash whose content it does not match.
 *
 * @param {import('./SeedingSessionStore.js').SeedingSessionRecord} record
 */
export async function resumeSeedingSession(record) {
    const hash = `${record.hash}`.toLowerCase();
    if (this.seedingTorrents().has(hash)) return this.seedingTorrents().get(hash);

    const existing = this.client?.get?.(hash);
    if (existing) {
        this.seedingTorrents().set(hash, existing);
        return existing;
    }

    const files = (record.files || [])
        .map((entry) => ({ ...entry, bytes: toBytes(entry.bytes) }))
        .filter((entry) => entry.bytes)
        .map(toSeedFile);
    if (files.length === 0) throw new Error('The stored payload is empty.');

    const seedOptions = {
        announce: this.trackers,
        name: record.torrentName || record.siteName || 'website',
        comment: 'Web25 Deploy Artifact (in-memory bundle)',
        createdBy: 'WEB25.cloud Deploy',
        private: false
    };
    // The piece length is part of the info dictionary, so the stored one is
    // what makes the resumed torrent hash to the same deployment.
    if (record.pieceLength) seedOptions.pieceLength = record.pieceLength;

    const torrent = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out while resuming the seeding session.')), 30000);
        try {
            this.client.seed(files, seedOptions, (seeded) => {
                clearTimeout(timer);
                resolve(seeded);
            });
        } catch (error) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });

    const seededHash = `${torrent?.infoHash || ''}`.toLowerCase();
    if (seededHash !== hash) {
        try {
            torrent?.destroy?.();
        } catch (_) {}
        throw new Error(`Resumed torrent hashes to ${seededHash || 'nothing'}, not ${hash}.`);
    }

    this.seedingTorrents().set(hash, torrent);
    return torrent;
}

/**
 * Bring every stored session back on start-up.
 *
 * Runs with whatever the wallet is doing: nothing here needs a key, so a
 * locked wallet resumes hosting exactly like an unlocked one.
 */
export async function restoreSeedingSessions() {
    if (!this.clientReady || !this.client) return [];

    let records = [];
    try {
        records = await this.seedingStore().list();
    } catch (error) {
        this.log(`Seeding sessions could not be read: ${error.message}`);
        return [];
    }
    if (records.length === 0) {
        this.refreshPagesPanel();
        return [];
    }

    this._seedingErrors = new Map();
    for (const record of records) {
        try {
            await this.resumeSeedingSession(record);
            this.log(`Resumed seeding ${record.hash} (${record.siteName}).`);
        } catch (error) {
            this._seedingErrors.set(`${record.hash}`.toLowerCase(), error.message);
            this.log(`Could not resume seeding ${record.hash}: ${error.message}`);
        }
    }

    const resumed = this.seedingTorrents().size;
    if (resumed > 0) {
        this.toast?.info?.(
            `${resumed} ${resumed === 1 ? 'site is' : 'sites are'} seeding again from this browser.`,
            'Pages resumed'
        );
    }
    this.refreshPagesPanel();
    this.startSeedingStatsTimer();
    return records;
}

/**
 * Stop one session for good: the torrent is destroyed and the record deleted,
 * so it does not come back on the next load.
 * @param {string} hash
 */
export async function stopSeedingSession(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();

    // The durable record goes first. Destroying the torrent and then failing to
    // delete the record would report "stopped" for a site that comes straight
    // back on the next reload — so a delete that fails leaves the session
    // exactly as it was, still live, and says so.
    try {
        await this.seedingStore().remove(sanitized);
    } catch (error) {
        this.log(`Seeding session ${sanitized} could not be deleted: ${error.message}`);
        throw new Error(`This site is still seeding: its saved session could not be deleted (${error.message}).`);
    }

    const torrent = this.seedingTorrents().get(sanitized);
    this.seedingTorrents().delete(sanitized);
    this._seedingErrors?.delete(sanitized);

    try {
        torrent?.destroy?.();
    } catch (_) {}

    // The deploy screen must not keep offering a deployment that is no longer
    // hosted from here.
    if (this.lastDeployResult?.hash === sanitized) {
        this.lastDeployResult = null;
        this.clearDeploySession?.();
    }

    this.log(`Stopped seeding ${sanitized}.`);
    await this.refreshPagesPanel();
}

/**
 * Everything the Pages tab renders: the stored deployment record plus what the
 * live torrent is doing right now.
 * @returns {Promise<any[]>}
 */
export async function listSeedingSessionViews() {
    let records = [];
    try {
        records = await this.seedingStore().list();
    } catch (error) {
        this.log(`Seeding sessions could not be listed: ${error.message}`);
        return [];
    }

    return records.map((record) => {
        const hash = `${record.hash}`.toLowerCase();
        const torrent = this.seedingTorrents().get(hash) || null;
        const error = this._seedingErrors?.get(hash) || null;
        return {
            hash,
            siteName: record.siteName || 'website',
            createdAt: record.createdAt || null,
            savedAt: record.savedAt || null,
            fileCount: record.fileCount || (record.files || []).length,
            length: record.length || 0,
            url: record.deploy?.url || '',
            signedBy: record.deploy?.signedBy || '',
            signature: record.deploy?.signature || '',
            signatureAlgorithm: record.deploy?.signatureAlgorithm || '',
            signedAt: record.deploy?.signedAt || '',
            signatureStatus: record.deploy?.signatureStatus || 'VERIFIED',
            mirror: record.deploy?.mirror || null,
            mirrorState: record.deploy?.mirrorState || 'disabled',
            hasTorrentFile: Boolean(record.torrentFile),
            state: error ? 'error' : torrent ? 'seeding' : 'stopped',
            error,
            peers: torrent ? Number(torrent.numPeers) || 0 : 0,
            uploaded: torrent ? Number(torrent.uploaded) || 0 : 0
        };
    });
}

/** The `.torrent` file of a stored session, for the download button. */
export async function seedingSessionTorrentFile(hash) {
    const record = await this.seedingStore().get(`${hash || ''}`.toLowerCase());
    return toBytes(record?.torrentFile);
}

/** Live counters tick while at least one session is up. */
export function startSeedingStatsTimer() {
    if (this._seedingStatsTimer) return;
    this._seedingStatsTimer = setInterval(() => {
        if (this.seedingTorrents().size === 0) {
            this.stopSeedingStatsTimer();
            return;
        }
        this.refreshPagesLiveStats();
    }, SEEDING_STATS_INTERVAL_MS);
    if (typeof (/** @type {any} */ (this._seedingStatsTimer)?.unref) === 'function') {
        /** @type {any} */ (this._seedingStatsTimer).unref();
    }
}

export function stopSeedingStatsTimer() {
    if (!this._seedingStatsTimer) return;
    clearInterval(this._seedingStatsTimer);
    this._seedingStatsTimer = null;
}

/** Wire the Pages tab's card actions. Safe to call more than once. */
export function initPagesPanel() {
    bindPagesPanel({
        onOpen: (hash) => void this.openSeedingSession(hash),
        onCopy: (hash) => void this.copySeedingSessionLink(hash),
        onDownload: (hash) => void this.downloadSeedingSessionTorrent(hash),
        onStop: (hash) => void this.confirmStopSeedingSession(hash)
    });
}

/** Rebuild the Pages tab from the store plus whatever is live. */
export async function refreshPagesPanel() {
    const sessions = await this.listSeedingSessionViews();
    renderPages(sessions);
    if (sessions.some((session) => session.state === 'seeding')) this.startSeedingStatsTimer();
    return sessions;
}

/** Tick the live counters without rebuilding the cards. */
export async function refreshPagesLiveStats() {
    updatePagesLiveStats(await this.listSeedingSessionViews());
}

/** @param {string} hash */
export async function openSeedingSession(hash) {
    const record = await this.seedingStore().get(`${hash || ''}`.toLowerCase());
    if (!record) return;
    // The stored link carries the mirror locator when the deployment has one,
    // so opening from here resolves exactly like the shared link does.
    this.loadSite(record.deploy?.url || record.hash);
}

/** @param {string} hash */
export async function copySeedingSessionLink(hash) {
    const record = await this.seedingStore().get(`${hash || ''}`.toLowerCase());
    const url = record?.deploy?.url;
    if (!url) {
        this.toast?.warning?.('This session has no shareable link stored.', 'Nothing to copy');
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        this.toast?.success?.('WEB25 link copied to clipboard.', 'Link copied');
    } catch (error) {
        this.toast?.error?.(error.message, 'Clipboard unavailable');
    }
}

/** @param {string} hash */
export async function downloadSeedingSessionTorrent(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();
    const bytes = await this.seedingSessionTorrentFile(sanitized);
    if (!bytes) {
        this.toast?.warning?.('No .torrent file was stored for this session.', 'Nothing to download');
        return;
    }
    const url = this.createTrackedObjectURL(new Blob([bytes], { type: 'application/x-bittorrent' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `website-${sanitized.slice(0, 8)}.torrent`;
    link.click();
}

/** @param {string} hash */
export async function confirmStopSeedingSession(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();
    const record = await this.seedingStore().get(sanitized);
    const confirmed = await confirmStopSeeding({ siteName: record?.siteName || '', hash: sanitized });
    if (!confirmed) return;
    try {
        await this.stopSeedingSession(sanitized);
    } catch (error) {
        this.toast?.error?.(error.message, 'Still seeding');
        await this.refreshPagesPanel();
        return;
    }
    this.toast?.info?.('This site is no longer seeding from this browser.', 'Seeding stopped');
}
