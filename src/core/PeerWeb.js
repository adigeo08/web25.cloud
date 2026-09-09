// @ts-check

import PeerWebCache from '../cache/PeerWebCache.js';
import ToastNotification from '../ui/ToastNotification.js';
import * as lifecycle from './bootstrap/Lifecycle.js';
import * as navigation from './navigation/Navigation.js';
import * as serviceWorker from './serviceworker/ServiceWorkerBridge.js';
import * as torrentLoader from './torrent/TorrentLoader.js';
import * as preferredSiteLoader from './torrent/PreferredSiteLoader.js';
import * as torrentUploader from './torrent/TorrentUploader.js';
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
        this.signedTorrentMetadata = new Map();
        /**
         * Ownership, protected assets and decrypt grants for the site being
         * viewed — populated only from a `.torrentchain` manifest that verified,
         * and dropped as soon as the site is unloaded.
         * @type {{ siteId: string | null, owner: any, protectedAssets: any[], assets: Map<string, any> } | null}
         */
        this.currentProtectedSite = null;
        // ── Step 2 · Preview & protect (publisher side) ──────────────────
        /** @type {{ id: string, locator: any, containerPath: string, recipientPublicKeys: string[] }[]} */
        this.protectSelections = [];
        /** @type {{ publicKey: string, address: string }[]} */
        this.protectRecipients = [];
        /** Staged files as chosen, and their authoring documents. */
        this.protectStagedFiles = null;
        this.protectDocuments = null;
        this.protectActivePath = null;
        this.protectPendingSelection = null;
        this.protectWorkspaceBound = false;
        this.protectPreviewHash = null;
        /** @type {import('./renderer/SiteSandbox.js').default | null} */
        this.protectSandbox = null;
        this.inProtectStep = false;
        /** The encrypted build that signing and seeding actually use. */
        this.protectedStagedFiles = null;
        /** @type {{ siteId: string, protectedAssets: any[] } | null} */
        this.protectedSiteContext = null;
        this.currentSiteSignatureStatus = { label: "Publisher: unverified", verified: false };
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
    // on the prototype and are reused by the preferred cache → GoFile → P2P flow.
    preferredSiteLoader,
    torrentUploader,
    torrentCreator,
    siteRenderer,
    debugPanel,
    loadingOverlay,
    memoryUtils,
    fileUtils
);

export default PeerWeb;
