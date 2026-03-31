// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';

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

export function showSiteViewer(url, hash, fromCache) {
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

    this.updateSiteSignatureBadge(
        this.currentSiteSignatureStatus || { label: 'Publisher: unverified', verified: false }
    );

    if (iframe) {
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');

        // Add error handler for iframe
        iframe.onerror = (e) => {
            this.log('Iframe error: ' + e.message);
        };

        iframe.onload = () => {
            this.log('Iframe loaded successfully');
        };

        iframe.src = url;
    }

    this.log(`Site loaded in iframe: ${url}`);
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

    if (iframe) {
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
