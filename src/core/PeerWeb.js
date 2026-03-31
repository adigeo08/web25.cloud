// @ts-check

import PeerWebCache from '../cache/PeerWebCache.js';
import ToastNotification from '../ui/ToastNotification.js';
import * as lifecycle from './bootstrap/Lifecycle.js';
import * as navigation from './navigation/Navigation.js';
import * as serviceWorker from './serviceworker/ServiceWorkerBridge.js';
import * as torrentLoader from './torrent/TorrentLoader.js';
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
        this.serviceWorkerReady = false;
        this.clientReady = false;
        this.librariesLoaded = false;
        this.currentTorrentSize = 0;
        this.currentFileCount = 0;
        this.objectURLs = [];
        this.timeouts = [];
        this.processingInProgress = false;
        this.processingTimeout = null;
        this.signedTorrentMetadata = new Map();
        this.currentSiteSignatureStatus = { label: "Publisher: unverified", verified: false };
        this.trackers = [
            'wss://tracker.btorrent.xyz',
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.webtorrent.dev',
            'wss://tracker.files.fm:7073/announce'
        ];

        this.init();
    }
}

Object.assign(
    PeerWeb.prototype,
    lifecycle,
    navigation,
    serviceWorker,
    torrentLoader,
    torrentUploader,
    torrentCreator,
    siteRenderer,
    debugPanel,
    loadingOverlay,
    memoryUtils,
    fileUtils
);

export default PeerWeb;
