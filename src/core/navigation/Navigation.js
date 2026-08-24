// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import SiteSandbox from '../renderer/SiteSandbox.js';

export function updateSiteSignatureBadge(status) {
    const badge = document.getElementById('site-signature-status');
    if (!badge) return;

    badge.textContent = status.label;
    badge.className = status.verified ? 'status-chip status-success' : 'status-chip status-pending';
}


export function checkURL() {
    const urlParams = new URLSearchParams(window.location.search);
    const orcHash = urlParams.get('orc');
    const debugMode = urlParams.get('debug') === 'true';

    if (debugMode) {
        this.debug = true;
        this.updateDebugToggle();
        this.showDebugPanel();
    }

    if (orcHash) {
        // Wait for all components to be ready before loading
        const checkReady = () => {
            if (this.serviceWorkerReady && this.clientReady && this.librariesLoaded) {
                this.loadSite(orcHash);
            } else {
                setTimeout(checkReady, PEERWEB_CONFIG.READY_CHECK_INTERVAL);
            }
        };
        checkReady();
    }
}

export function sanitizeHash(hash) {
    if (!hash || typeof hash !== 'string') {
        return '';
    }
    // Remove any non-hexadecimal characters
    return hash.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

export function isValidTorrentHash(hash) {
    if (!hash || typeof hash !== 'string') {
        return false;
    }

    // Remove any whitespace
    hash = hash.trim();

    // Should be exactly 40 characters (SHA-1 hash in hex)
    if (hash.length !== 40) {
        this.log(`Invalid hash length: ${hash.length}, expected 40`);
        return false;
    }

    // Should only contain hexadecimal characters
    const hexRegex = /^[a-fA-F0-9]+$/;
    if (!hexRegex.test(hash)) {
        this.log('Hash contains non-hexadecimal characters');
        return false;
    }

    return true;
}

export function isInternalNavigation(href) {
    if (!href) {
        return false;
    }

    // Fragments (anchors) are internal
    if (href.startsWith('#')) {
        return true;
    }

    // External URLs
    if (href.startsWith('http://') || href.startsWith('https://')) {
        return false;
    }

    // Protocol-relative URLs
    if (href.startsWith('//')) {
        return false;
    }

    // Email links
    if (href.startsWith('mailto:')) {
        return false;
    }

    // Phone links
    if (href.startsWith('tel:')) {
        return false;
    }

    // Other protocols
    if (href.includes(':') && !href.startsWith('./') && !href.startsWith('../')) {
        return false;
    }

    // Everything else is internal navigation
    return true;
}

export function convertNavigationToVirtualUrl(href, basePath, hash) {
    // Handle fragment-only links
    if (href.startsWith('#')) {
        return href; // Keep fragments as-is
    }

    return this.convertToVirtualUrl(href, basePath, hash);
}

/**
 * Render a torrent site inside the isolated sandbox frame.
 *
 * The frame gets no `allow-same-origin`, so the site executes in an opaque
 * origin: it cannot read the wallet's IndexedDB, the Web25 localStorage, the
 * signing worker or this document's DOM. Bundle files reach it only through the
 * allowlisted postMessage bridge.
 *
 * @param {{ entryFile: string, entryHtml: string }} site
 * @param {string} hash
 * @param {boolean} fromCache
 */
export function showSiteViewer(site, hash, fromCache) {
    const mainContent = document.getElementById('main-content');
    const siteViewer = document.getElementById('site-viewer');
    const currentHash = document.getElementById('current-hash');
    const cacheStatus = document.getElementById('cache-status');
    const iframe = /** @type {HTMLIFrameElement} */ (document.getElementById('site-frame'));

    if (mainContent) {
        mainContent.classList.add('hidden');
    }
    if (siteViewer) {
        siteViewer.classList.remove('hidden');
    }
    if (currentHash) {
        currentHash.textContent = `Hash: ${hash.substring(0, 16)}...`;
    }
    if (cacheStatus) {
        cacheStatus.textContent = fromCache ? '💾 From Cache' : '🌐 Fresh Download';
    }

    this.updateSiteSignatureBadge(this.currentSiteSignatureStatus || { label: "Publisher: unverified", verified: false });

    if (iframe) {
        iframe.onerror = (e) => {
            this.log('Iframe error: ' + e.message);
        };

        this.teardownSiteSandbox();
        this.siteSandbox = new SiteSandbox({
            iframe,
            hash,
            entryFile: site.entryFile,
            entryHtml: site.entryHtml,
            resolveFile: (path) => this.findFileInSiteData(path),
            onTitle: (title) => this.log(`Sandboxed site title: ${title}`),
            log: (message) => this.log(message)
        });
        this.siteSandbox.start();
    }

    this.log(`Site rendered in sandboxed frame (opaque origin) for hash ${hash}`);
}

/** Tear down any active site sandbox and its bridge. */
export function teardownSiteSandbox() {
    if (this.siteSandbox) {
        this.siteSandbox.destroy();
        this.siteSandbox = null;
    }
}

export function showMainContent() {
    const siteViewer = document.getElementById('site-viewer');
    const mainContent = document.getElementById('main-content');
    const iframe = /** @type {HTMLIFrameElement} */ (document.getElementById('site-frame'));

    if (siteViewer) {
        siteViewer.classList.add('hidden');
    }
    if (mainContent) {
        mainContent.classList.remove('hidden');
    }

    this.teardownSiteSandbox();
    if (iframe) {
        iframe.removeAttribute('srcdoc');
        iframe.src = '';
    }

    // Revoke all object URLs to prevent memory leaks
    this.revokeAllObjectURLs();

    // Clear current site data
    this.currentSiteData = null;
    this.currentHash = null;

    // Notify service worker
    this.sendToServiceWorker('SITE_UNLOADED', {});

    // Update URL
    window.history.pushState({}, '', window.location.pathname);
}
