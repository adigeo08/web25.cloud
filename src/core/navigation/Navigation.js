// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import SiteSandbox from '../renderer/SiteSandbox.js';
import { parseWeb25Address } from '../../gofile/Web25Url.js';

/**
 * The signature, reduced to a mark.
 *
 * A viewer header is a strip above somebody else's page: the sentence that used
 * to live here ("Verified publisher: 0x1234…") spent the width the visitor
 * needs for the things they can actually do, and said in words what a tick says
 * at a glance. So the mark is the whole chip — and because a mark alone is not
 * self-explanatory, the wording it replaces stays on the element, where a
 * tooltip and a screen reader both find it.
 *
 * Unverified is never silent. It gets its own mark rather than no mark, because
 * "nothing shown" reads as "nothing wrong".
 *
 * @param {{ verified?: boolean, label?: string }} status
 */
export function updateSiteSignatureBadge(status) {
    const badge = document.getElementById('site-signature-status');
    if (!badge) return;

    const verified = Boolean(status?.verified);
    const label = status?.label || (verified ? 'Verified publisher' : 'Publisher: unverified');

    badge.textContent = verified ? '✔' : '⚠';
    badge.className = verified ? 'viewer-verified is-verified' : 'viewer-verified is-unverified';
    badge.setAttribute('role', 'img');
    badge.setAttribute('title', label);
    badge.setAttribute('aria-label', label);
}

/** What the Reseed button says, per state. Disabled states carry the reason. */
const RESEED_STATES = {
    pending: { text: '🌱 Reseed', disabled: true, title: 'Checking whether this site can be seeded from here…' },
    available: { text: '🌱 Reseed', disabled: false, title: 'Serve this site to other visitors from your browser' },
    resume: { text: '▶️ Resume seeding', disabled: false, title: 'This site is stored here. Put it back on the air.' },
    seeding: { text: '🌱 Seeding', disabled: true, title: 'You are already seeding this site from this browser' },
    unavailable: {
        text: '🌱 Reseed',
        disabled: true,
        title: 'This browser does not hold the original payload of this site, so it cannot be seeded from here'
    }
};

/**
 * Work out what the viewer's two buttons should offer for one site.
 *
 * Asked of the store rather than assumed, because every answer here is a claim
 * about what strangers can pull from this browser: a Reseed that is already
 * seeding, or one whose payload was never captured, would promise hosting that
 * does not happen.
 *
 * @param {string} hash
 * @returns {Promise<'pending'|'available'|'resume'|'seeding'|'unavailable'>}
 */
export async function resolveReseedState(hash) {
    const sanitized = `${hash || ''}`.toLowerCase();
    if (!sanitized) return 'unavailable';
    if (this.seedingTorrents?.().has(sanitized)) return 'seeding';

    let record = null;
    try {
        record = await this.seedingStore?.().get(sanitized);
    } catch (error) {
        this.log(`Could not read the seeding store for ${sanitized}: ${error.message}`);
    }
    // Stored but not announcing — paused on purpose, or a resume that failed.
    // Either way the bytes are here, so this is a resume rather than a reseed.
    if (record) return 'resume';

    return (await this.resolveReseedPayload?.(sanitized)) ? 'available' : 'unavailable';
}

/**
 * Put the viewer's actions in the state the site on screen deserves.
 *
 * Runs on every render and after every action, and is generation-guarded: the
 * store lookup is asynchronous, so a visitor who has already moved on to
 * another site must not have the previous site's answer written over their
 * header.
 *
 * @param {string} hash
 */
export async function refreshViewerActions(hash) {
    const reseed = /** @type {HTMLButtonElement|null} */ (document.getElementById('viewer-reseed'));
    const forget = /** @type {HTMLButtonElement|null} */ (document.getElementById('viewer-forget'));
    const sanitized = `${hash || ''}`.toLowerCase();

    if (forget) {
        forget.disabled = !sanitized;
        forget.setAttribute('title', 'Erase everything this browser keeps about this site');
    }
    if (!reseed) return;

    const applyState = (name) => {
        const state = RESEED_STATES[name] || RESEED_STATES.pending;
        reseed.textContent = state.text;
        reseed.disabled = state.disabled;
        reseed.setAttribute('title', state.title);
        reseed.setAttribute('data-reseed-state', name);
    };

    applyState('pending');
    if (!sanitized) return;

    const state = await this.resolveReseedState(sanitized);
    // The visitor has moved on; this answer is about a page that is no longer up.
    if (`${this.currentHash || ''}`.toLowerCase() !== sanitized) return;
    applyState(state);
}

/**
 * Host the site on screen from this browser.
 *
 * The site does not have to be anyone's in particular — that is the point. It
 * keeps its author, its signature and its link; this browser joins the swarm
 * that serves it, and the card that appears in Pages says so.
 */
export async function handleViewerReseed() {
    const hash = `${this.currentHash || ''}`.toLowerCase();
    if (!hash) return;
    await this.confirmReseedSite(hash, { siteName: this.currentSiteTitle?.() || '' });
    await this.refreshViewerActions(hash);
}

/**
 * Forget the site on screen.
 *
 * On confirmation the viewer closes, because it has to: the bytes it is
 * rendering from are exactly what was just deleted, and a page still on screen
 * after its data is gone is a page that cannot be reloaded, searched for or
 * navigated within.
 */
export async function handleViewerForget() {
    const hash = `${this.currentHash || ''}`.toLowerCase();
    if (!hash) return;
    const done = await this.confirmForgetSiteData(hash, { siteName: this.currentSiteTitle?.() || '' });
    if (done) {
        this.showMainContent();
        return;
    }
    await this.refreshViewerActions(hash);
}

/**
 * What to call the site on screen in a dialog.
 *
 * The sandboxed page reports its own `<title>` over the bridge, which is the
 * name its author gave it and the one a visitor recognises. It may not have
 * arrived yet — the dialogs fall back to the short hash when it has not.
 */
export function currentSiteTitle() {
    return `${this._currentSiteTitle || ''}`;
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
        // A malformed mirror locator must never cost the user the site itself:
        // fall back to the plain hash and let the P2P path do its normal work.
        let address;
        try {
            address = parseWeb25Address(window.location.href);
        } catch (error) {
            this.log(`Ignoring unusable WEB25 mirror locator: ${error.message}`);
            this.toast?.warning?.(error.message, 'Loading without the mirror');
            address = { torrentHash: orcHash, gofileLocator: null };
        }
        // Wait for all components to be ready before loading
        const checkReady = () => {
            if (this.serviceWorkerReady && this.clientReady && this.librariesLoaded) {
                this.loadSite(address);
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
 * @param {boolean} fromCache only logged now — see `refreshViewerActions`
 */
export function showSiteViewer(site, hash, fromCache) {
    const mainContent = document.getElementById('main-content');
    const siteViewer = document.getElementById('site-viewer');
    const currentHash = document.getElementById('current-hash');
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
    // Where the bytes came from is a fact about the load, not about the site:
    // it is logged, and the space it used to occupy belongs to the two actions.
    this.log(`Rendering ${hash} from ${fromCache ? 'the local cache' : 'a fresh download'}.`);

    this.updateSiteSignatureBadge(
        this.currentSiteSignatureStatus || { label: 'Publisher: unverified', verified: false }
    );
    void this.refreshViewerActions(hash);

    if (iframe) {
        iframe.onerror = (e) => {
            this.log('Iframe error: ' + e.message);
        };

        this.teardownSiteSandbox();
        this._currentSiteTitle = '';
        this.siteSandbox = new SiteSandbox({
            iframe,
            hash,
            entryFile: site.entryFile,
            entryHtml: site.entryHtml,
            resolveFile: (path) => this.findFileInSiteData(path),
            onTitle: (title) => {
                // Kept for the Reseed and Delete data dialogs, which have to
                // name the site they are asking about. Bounded and only ever
                // written with `textContent`: this string comes from somebody
                // else's page.
                this._currentSiteTitle = `${title || ''}`.slice(0, 120);
                this.log(`Sandboxed site title: ${title}`);
            },
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
    this._currentSiteTitle = '';
    this.currentGofileLocator = null;
    // The captured payload is a whole site in memory and the viewer is the only
    // place that offers to reseed it. The cached copy is what a later visit
    // reseeds from, so letting this go costs nothing and keeps a browsing
    // session from accumulating sites it is no longer looking at.
    this.rememberReseedPayload?.('', null);

    // Notify service worker
    this.sendToServiceWorker('SITE_UNLOADED', {});

    // Update URL
    window.history.pushState({}, '', window.location.pathname);

    // Coming back from a site is exactly when the local index has something new
    // in it: the site just rendered was cached on the way in. This repeats the
    // query that is open, if any — with no search running it renders nothing.
    void this.refreshLibrary?.();
}
