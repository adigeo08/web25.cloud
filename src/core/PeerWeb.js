// @ts-check

import PeerWebCache from '../cache/PeerWebCache.js';
import ToastNotification from '../ui/ToastNotification.js';
import * as lifecycle from './bootstrap/Lifecycle.js';
import * as navigation from './navigation/Navigation.js';
import * as serviceWorker from './serviceworker/ServiceWorkerBridge.js';
import * as torrentLoader from './torrent/TorrentLoader.js';
import * as preferredSiteLoader from './torrent/PreferredSiteLoader.js';
import * as torrentUploader from './torrent/TorrentUploader.js';
import * as seedingSessions from './torrent/SeedingSessions.js';
import * as torrentCreator from './torrent/TorrentCreator.js';
import * as siteRenderer from './renderer/SiteRenderer.js';
import * as debugPanel from '../ui/DebugPanel.js';
import * as loadingOverlay from '../ui/LoadingOverlay.js';
import * as memoryUtils from '../utils/MemoryUtils.js';
import * as fileUtils from '../utils/FileUtils.js';

class PeerWeb {
    constructor() {
        this.client = null;
        this.debug = false;
        this.cache = new PeerWebCache();
        this.toast = new ToastNotification();
        this.currentSiteData = null;
        this.currentHash = null;
        /** The mirror locator the current site was reached by, if any. */
        this.currentGofileLocator = null;
        /** The `<title>` the sandboxed site reported, for the viewer dialogs. */
        this._currentSiteTitle = '';
        /**
         * The payload of the site on screen, exactly as it travelled.
         *
         * One at a time: this is a whole website in memory, held only so the
         * Reseed button can act without a round trip to the cache — and
         * dropped again the moment the viewer closes.
         * @type {{ hash: string, payload: any }|null}
         */
        this._reseedPayload = null;
        /** @type {import('./renderer/SiteSandbox.js').default | null} */
        this.siteSandbox = null;
        this.serviceWorkerReady = false;
        this.clientReady = false;
        this.librariesLoaded = false;
        this.currentTorrentSize = 0;
        this.currentFileCount = 0;
        this.objectURLs = [];
        this.timeouts = [];
        this.processingInProgress = false;
        this.processingTimeout = null;
        /** @type {{ torrent: any, guard: { stop: () => void } } | null} the torrent the current load owns */
        this._activeLoadTorrent = null;
        /**
         * Sites this browser hosts, by info hash. These outlive signing out and
         * cache clearing on purpose: a visitor pulling a site from here has
         * nothing to do with whether its publisher is signed in.
         * @type {Map<string, any>}
         */
        this._seedingTorrents = new Map();
        /** @type {Map<string, string>} sessions that failed to resume, by hash */
        this._seedingErrors = new Map();
        /**
         * Whether the Pages tab may be shown. Starts closed: sessions are
         * restored before the page knows whether anybody is signed in, and a
         * tab that flashes into view and back out is worse than one that waits.
         */
        this._pagesTabAllowed = false;
        this.signedTorrentMetadata = new Map();
        this.currentSiteSignatureStatus = { label: 'Publisher: unverified', verified: false };
        const overrideTrackers =
            Array.isArray(window.PEERWEB_TRACKERS) && window.PEERWEB_TRACKERS.length > 0
                ? window.PEERWEB_TRACKERS
                : null;
        this.trackers = overrideTrackers || ['wss://tracker.openwebtorrent.com/'];

        this.init();
    }
}

Object.assign(
    PeerWeb.prototype,
    lifecycle,
    navigation,
    serviceWorker,
    torrentLoader,
    // Override TorrentLoader.loadSite only; the rest of the torrent helpers stay
    // on the prototype and are reused by the preferred cache → P2P → GoFile flow.
    preferredSiteLoader,
    torrentUploader,
    seedingSessions,
    torrentCreator,
    siteRenderer,
    debugPanel,
    loadingOverlay,
    memoryUtils,
    fileUtils
);

export default PeerWeb;
