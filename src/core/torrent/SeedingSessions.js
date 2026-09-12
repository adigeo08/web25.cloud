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
 * Three things take a site off the air, and only one of them is permanent: the
 * publisher pressing Stop seeding (paused, and resumable), pressing Delete
 * website (gone, payload and all), and the tab going away — and that last one
 * resumes by itself on the next visit.
 */

import SeedingSessionStore from './SeedingSessionStore.js';
import { bindPagesPanel, confirmSeedingAction, renderPages, updatePagesLiveStats } from '../../ui/pages/PagesPanel.js';

/** How often the Pages cards refresh their live peer/upload counters. */
const SEEDING_STATS_INTERVAL_MS = 5000;

/** How long one resume may take before it is given up on. */
const RESUME_TIMEOUT_MS = 30000;

/**
 * How many sessions are resumed at once.
 *
 * Restoring runs before the first page load is dispatched, so it is on the
 * critical path: one site that never calls back must not hold the other nine —
 * and the whole UI — behind its 30-second timeout. Small enough not to ask the
 * browser to hash ten payloads at once.
 */
const RESUME_CONCURRENCY = 3;

/** Channel name for telling other tabs of this browser what changed. */
const SEEDING_CHANNEL = 'web25-seeding';

/** The session changes worth telling the other tabs about. */
const SEEDING_CHANGES = ['paused', 'resumed', 'deleted'];

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
export async function recordSeedingSession(params) {
    const sanitized = `${params?.hash || ''}`.toLowerCase();
    if (!sanitized) return null;

    // One writer per deployment at a time.
    //
    // A mirrored deploy records itself twice in quick succession — live, then
    // mirror-resolved — and both calls read the stored record before writing
    // it. Run concurrently, both read the same old state and the second write
    // overwrites the first: whichever finishes last wins, which is not the same
    // as the newest metadata winning. Chaining per hash makes the second call
    // read what the first one wrote.
    if (!this._seedingWrites) this._seedingWrites = new Map();
    const queued = (this._seedingWrites.get(sanitized) || Promise.resolve()).then(
        () => writeSeedingSession.call(this, sanitized, params),
        () => writeSeedingSession.call(this, sanitized, params)
    );
    // Never leave a rejected promise as the tail: the next writer chains off it.
    this._seedingWrites.set(
        sanitized,
        queued.catch(() => {})
    );
    try {
        return await queued;
    } finally {
        if (this._seedingWrites.get(sanitized) === queued) this._seedingWrites.delete(sanitized);
    }
}

/**
 * The body of one record, already serialized against its own hash.
 *
 * @param {string} sanitized
 * @param {{ torrent: any, torrentFile: ArrayBuffer|Uint8Array|null, payloadFiles: File[]|null,
 *           siteName?: string, createdAt?: string, deploy: any }} params
 */
async function writeSeedingSession(
    sanitized,
    { torrent, torrentFile, payloadFiles, siteName = '', createdAt = '', deploy }
) {
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
    this.watchSeedingTorrent(sanitized, torrent);
    return torrent;
}

/**
 * Follow an owned torrent to the end of its life.
 *
 * The registry is a map of objects, and an object outlives the thing it
 * represents: a torrent that errors out or is closed by the client leaves its
 * entry sitting there, so Pages goes on showing "Seeding" for a site nobody can
 * download any more. Listening for that is what keeps the card honest.
 *
 * @param {string} hash
 * @param {any} torrent
 */
export function watchSeedingTorrent(hash, torrent) {
    const sanitized = `${hash || ''}`.toLowerCase();
    if (!torrent || typeof torrent.once !== 'function') return;
    if (torrent.__web25SeedingWatched) return;
    try {
        Object.defineProperty(torrent, '__web25SeedingWatched', { value: true, enumerable: false });
    } catch (_) {
        torrent.__web25SeedingWatched = true;
    }

    torrent.once('error', (error) => {
        this.handleSeedingTorrentGone(sanitized, torrent, error?.message || 'the torrent errored out');
    });
    torrent.once('close', () => {
        this.handleSeedingTorrentGone(sanitized, torrent, 'the torrent was closed');
    });
}

/**
 * An owned torrent died on its own. Stop claiming it is seeding.
 *
 * Deliberately a no-op when the registry has already moved on:
 * `releaseSeedingTorrent` removes the entry before destroying the torrent, so
 * the `close` that follows an intentional stop is not reported as a failure.
 *
 * @param {string} hash
 * @param {any} torrent
 * @param {string} reason
 */
export function handleSeedingTorrentGone(hash, torrent, reason) {
    const sanitized = `${hash || ''}`.toLowerCase();
    if (this.seedingTorrents().get(sanitized) !== torrent) return;

    this.seedingTorrents().delete(sanitized);
    if (!this._seedingErrors) this._seedingErrors = new Map();
    this._seedingErrors.set(sanitized, `Stopped seeding: ${reason}.`);
    this.log(`Seeding session ${sanitized} ended: ${reason}.`);
    void this.refreshPagesPanel();
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
    if (existing) return this.adoptSeedingTorrent(hash, existing);

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

    // Overridable so a test can exercise the timeout without waiting out the
    // real one; nothing in the application sets it.
    const timeoutMs = Number(this._resumeTimeoutMs) || RESUME_TIMEOUT_MS;
    const torrent = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            reject(new Error('Timed out while resuming the seeding session.'));
        }, timeoutMs);

        try {
            this.client.seed(files, seedOptions, (seeded) => {
                clearTimeout(timer);
                // The timeout only stops this page waiting; WebTorrent keeps
                // hashing and calls back eventually. That torrent belongs to
                // nobody — it is not in the registry, so nothing will ever stop
                // it and Pages will never show it — so it goes now.
                if (settled) {
                    this.log(`Resume of ${hash} timed out; destroying the torrent that arrived late.`);
                    try {
                        seeded?.destroy?.();
                    } catch (_) {}
                    return;
                }
                settled = true;
                resolve(seeded);
            });
        } catch (error) {
            clearTimeout(timer);
            settled = true;
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

    return this.adoptSeedingTorrent(hash, torrent);
}

/**
 * Bring every stored session back on start-up.
 *
 * Runs with whatever the wallet is doing: nothing here needs a key, so a
 * locked wallet resumes hosting exactly like an unlocked one.
 */
export async function restoreSeedingSessions() {
    if (!this.clientReady || !this.client) return [];

    let stored = [];
    try {
        stored = await this.seedingStore().list();
    } catch (error) {
        this.log(`Seeding sessions could not be read: ${error.message}`);
        return [];
    }
    if (stored.length === 0) {
        this.refreshPagesPanel();
        return [];
    }

    // A paused site is still stored, and still has a card — it just is not
    // announcing. Bringing it back here would undo the publisher's decision on
    // every reload, which is the whole thing pausing was separated out to avoid.
    const records = stored.filter((record) => record.paused !== true);

    this._seedingErrors = new Map();

    // A few at a time, not one after another. This runs before the first site
    // load is dispatched, so a session that never calls back would otherwise
    // hold every other session — and the rest of start-up — behind its own
    // 30-second timeout.
    let next = 0;
    const worker = async () => {
        while (next < records.length) {
            const record = records[next];
            next += 1;
            try {
                await this.resumeSeedingSession(record);
                this.log(`Resumed seeding ${record.hash} (${record.siteName}).`);
            } catch (error) {
                this._seedingErrors.set(`${record.hash}`.toLowerCase(), error.message);
                this.log(`Could not resume seeding ${record.hash}: ${error.message}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(RESUME_CONCURRENCY, records.length) }, worker));

    // No toast for this. Resuming is the normal state of affairs, the Pages tab
    // already shows exactly which sites came back, and an announcement on every
    // single load is noise rather than news.
    this.log(
        `Resumed ${this.seedingTorrents().size} of ${records.length} seeding session(s); ` +
            `${stored.length - records.length} left paused.`
    );
    this.refreshPagesPanel();
    this.startSeedingStatsTimer();
    return records;
}

/**
 * Stop announcing a site, without forgetting it.
 *
 * Stopping and deleting used to be the same button, which made stopping a
 * decision nobody could take back: the only way to pause hosting was to throw
 * the deployment away. They are separate now. This one takes the torrent down
 * and marks the record paused — the card stays, with Resume in place of Stop,
 * and a reload leaves it paused rather than quietly starting it again.
 *
 * @param {string} hash
 */
export async function pauseSeedingSession(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();

    // The durable mark goes first, for the same reason a delete does: reporting
    // "stopped" and then failing to write it would promise a pause that the
    // next reload undoes.
    try {
        const paused = await this.seedingStore().patch(sanitized, { paused: true, pausedAt: Date.now() });
        if (!paused) throw new Error('there is no stored session to pause');
    } catch (error) {
        this.log(`Seeding session ${sanitized} could not be paused: ${error.message}`);
        throw new Error(`This site is still seeding: the change could not be saved (${error.message}).`);
    }

    this.releaseSeedingTorrent(sanitized);
    this.broadcastSeedingChange('paused', sanitized);

    this.log(`Paused seeding ${sanitized}.`);
    await this.refreshPagesPanel();
}

/**
 * Start announcing a paused site again.
 * @param {string} hash
 */
export async function resumePausedSession(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();

    const record = await this.seedingStore().get(sanitized);
    if (!record) throw new Error('That site is no longer stored in this browser.');

    // Seed first, mark second: a record that says it is seeding while nothing
    // is announcing would be the same lie as the other way round.
    await this.resumeSeedingSession({ ...record, paused: false });

    try {
        await this.seedingStore().patch(sanitized, { paused: false, pausedAt: null });
    } catch (error) {
        this.log(`Seeding session ${sanitized} resumed but could not be marked: ${error.message}`);
    }

    this._seedingErrors?.delete(sanitized);
    this.broadcastSeedingChange('resumed', sanitized);
    this.log(`Resumed seeding ${sanitized}.`);
    await this.refreshPagesPanel();
}

/**
 * Forget a site entirely: the torrent goes, and so does its stored copy.
 *
 * This is the irreversible one. The payload is deleted, so the deployment can
 * only come back by being deployed again.
 *
 * @param {string} hash
 */
export async function deleteSeedingSession(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();

    // The durable record goes first. Destroying the torrent and then failing to
    // delete the record would report "deleted" for a site that comes straight
    // back on the next reload — so a delete that fails leaves the session
    // exactly as it was, still live, and says so.
    try {
        await this.seedingStore().remove(sanitized);
    } catch (error) {
        this.log(`Seeding session ${sanitized} could not be deleted: ${error.message}`);
        throw new Error(`This site is still here: its saved session could not be deleted (${error.message}).`);
    }

    this.releaseSeedingTorrent(sanitized);

    // The deploy screen must not keep offering a deployment that is no longer
    // hosted from here.
    if (this.lastDeployResult?.hash === sanitized) {
        this.lastDeployResult = null;
        this.clearDeploySession?.();
    }

    this.broadcastSeedingChange('deleted', sanitized);

    this.log(`Deleted ${sanitized}.`);
    await this.refreshPagesPanel();
}

/**
 * Take one torrent off the air, whatever the reason.
 *
 * The registry entry goes before the torrent does, so the `close` that follows
 * is recognised as intentional rather than reported as a session that died.
 *
 * @param {string} hash
 */
export function releaseSeedingTorrent(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();
    const torrent = this.seedingTorrents().get(sanitized);
    this.seedingTorrents().delete(sanitized);
    this._seedingErrors?.delete(sanitized);
    try {
        torrent?.destroy?.();
    } catch (_) {}
    return Boolean(torrent);
}

/**
 * The local coordination channel between this browser's WEB25 tabs.
 *
 * IndexedDB is shared, the live torrents are not: each tab re-seeds the same
 * records into its own WebTorrent client. Nothing leaves the browser here — a
 * `BroadcastChannel` is same-origin only — and a browser without one simply
 * goes back to the old behaviour, where the other tab catches up on its next
 * reload.
 */
export function initSeedingChannel() {
    if (this._seedingChannel !== undefined) return this._seedingChannel;
    this._seedingChannel = null;
    if (typeof BroadcastChannel !== 'function') return null;

    try {
        const channel = new BroadcastChannel(SEEDING_CHANNEL);
        channel.onmessage = (event) => {
            const message = event?.data;
            if (!message || !SEEDING_CHANGES.includes(message.type)) return;
            void this.applyRemoteSeedingChange(message.type, `${message.hash || ''}`.toLowerCase());
        };
        // Node's BroadcastChannel keeps the event loop alive; a browser's has no
        // `unref` at all. Same reason every timer in this codebase is unref'd:
        // a test process must not be held open by a listener.
        if (typeof (/** @type {any} */ (channel).unref) === 'function') /** @type {any} */ (channel).unref();
        this._seedingChannel = channel;
    } catch (error) {
        this.log(`Seeding sessions are not synchronised between tabs: ${error.message}`);
    }
    return this._seedingChannel;
}

/**
 * @param {'paused'|'resumed'|'deleted'} kind
 * @param {string} hash
 */
export function broadcastSeedingChange(kind, hash) {
    try {
        this.initSeedingChannel()?.postMessage({ type: kind, hash: `${hash || ''}`.toLowerCase() });
    } catch (error) {
        this.log(`Could not tell other tabs that ${hash} was ${kind}: ${error.message}`);
    }
}

/**
 * Another tab changed this session. The stored record is already whatever it
 * is going to be — IndexedDB is shared — so this tab only has to bring its own
 * torrent into line with it.
 *
 * @param {'paused'|'resumed'|'deleted'} kind
 * @param {string} hash
 * @returns {Promise<boolean>} whether anything changed here
 */
export async function applyRemoteSeedingChange(kind, hash) {
    const sanitized = `${hash || ''}`.toLowerCase();

    if (kind === 'resumed') {
        if (this.seedingTorrents().has(sanitized)) return false;
        try {
            const record = await this.seedingStore().get(sanitized);
            if (!record) return false;
            await this.resumeSeedingSession(record);
            this.log(`Another tab resumed seeding ${sanitized}; seeding it here too.`);
            return true;
        } catch (error) {
            this.log(`Another tab resumed ${sanitized}, but it could not be seeded here: ${error.message}`);
            return false;
        } finally {
            void this.refreshPagesPanel();
        }
    }

    const released = this.releaseSeedingTorrent(sanitized);
    if (released) {
        this.log(`Another tab ${kind} ${sanitized}; letting go of it here too.`);
    }
    void this.refreshPagesPanel();
    return released;
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
        const owned = this.seedingTorrents().get(hash) || null;
        // An entry in the map is an object, not a promise that it still works:
        // a destroyed torrent must not keep a card reading "Seeding".
        const torrent = owned && owned.destroyed !== true ? owned : null;
        if (owned && !torrent) this.seedingTorrents().delete(hash);
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
            paused: record.paused === true,
            // Paused is a decision, not a failure: it reads differently on the
            // card and it is the state a reload preserves.
            state: error ? 'error' : torrent ? 'seeding' : record.paused === true ? 'paused' : 'stopped',
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
    this.initSeedingChannel();
    bindPagesPanel({
        onOpen: (hash) => void this.openSeedingSession(hash),
        onCopy: (hash) => void this.copySeedingSessionLink(hash),
        onDownload: (hash) => void this.downloadSeedingSessionTorrent(hash),
        onStop: (hash) => void this.confirmPauseSeedingSession(hash),
        onResume: (hash) => void this.confirmResumeSeedingSession(hash),
        onDelete: (hash) => void this.confirmDeleteSeedingSession(hash)
    });
}

/** Rebuild the Pages tab from the store plus whatever is live. */
export async function refreshPagesPanel() {
    const sessions = await this.listSeedingSessionViews();
    // Seeding is not gated on the wallet, but managing it is: with no identity
    // unlocked the tab is not offered at all, the same way Chat is not.
    renderPages(sessions, { visible: this._pagesTabAllowed === true });
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

/**
 * Ask, then act. One shape for all three card actions.
 *
 * Every one of them changes what the rest of the world can load from this
 * browser, so none of them happens on a single click.
 *
 * @param {'pause'|'resume'|'delete'} action
 * @param {string} hash
 */
async function confirmSeedingChange(action, hash) {
    const sanitized = `${hash || ''}`.toLowerCase();
    const record = await this.seedingStore().get(sanitized);
    const confirmed = await confirmSeedingAction(action, { siteName: record?.siteName || '', hash: sanitized });
    if (!confirmed) return false;

    const run = {
        pause: () => this.pauseSeedingSession(sanitized),
        resume: () => this.resumePausedSession(sanitized),
        delete: () => this.deleteSeedingSession(sanitized)
    }[action];

    try {
        await run();
    } catch (error) {
        this.toast?.error?.(error.message, action === 'resume' ? 'Not seeding' : 'Nothing changed');
        await this.refreshPagesPanel();
        return false;
    }
    return true;
}

/** @param {string} hash */
export async function confirmPauseSeedingSession(hash) {
    if (!(await confirmSeedingChange.call(this, 'pause', hash))) return;
    this.toast?.info?.(
        'This site is no longer seeding from this browser. It is still saved here — resume it whenever you like.',
        'Seeding stopped'
    );
}

/** @param {string} hash */
export async function confirmResumeSeedingSession(hash) {
    if (!(await confirmSeedingChange.call(this, 'resume', hash))) return;
    this.toast?.success?.('This site is seeding from this browser again.', 'Seeding resumed');
}

/** @param {string} hash */
export async function confirmDeleteSeedingSession(hash) {
    if (!(await confirmSeedingChange.call(this, 'delete', hash))) return;
    this.toast?.info?.('The website and its stored copy are gone from this browser.', 'Website deleted');
}
