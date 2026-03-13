// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import AuthController from '../../auth/AuthController.js';
import { bindPublishActions } from '../../ui/publish/PublishPanel.js';
import { renderPublishReview } from '../../ui/publish/PublishReviewModal.js';
import { renderSignatureStatus } from '../../ui/publish/SignatureStatus.js';
import { signPublishPayload } from '../../auth/SigningService.js';
import { attachPublishMetadata } from '../../torrent/TorrentPublishService.js';

export async function init() {
    try {
        await this.loadRequiredLibraries();
        await this.initializeWebTorrent();
        await this.registerServiceWorker();
        this.setupEventListeners();
        this.setupCleanupHandlers();
        this.checkURL();
        this.updateDebugToggle();
        await this.initAuth();
    } catch (error) {
        console.error('PeerWeb initialization failed:', error);
        this.showError('Failed to initialize PeerWeb: ' + error.message);
    }
}

export async function initAuth() {
    this.authController = new AuthController(this.toast);
    await this.authController.init();
    this.lastSignedPublish = null;
}

export async function loadRequiredLibraries() {
    this.log('Loading required libraries...');

    // Load WebTorrent from local scripts folder
    if (typeof WebTorrent === 'undefined') {
        await this.loadScript('scripts/webtorrent.min.js');
        this.log('WebTorrent library loaded');
    }

    // Load DOMPurify from local scripts folder
    if (typeof DOMPurify === 'undefined') {
        await this.loadScript('scripts/purify.min.js');
        this.log('DOMPurify library loaded');
    }

    // Verify libraries are available
    if (typeof WebTorrent === 'undefined') {
        throw new Error('Failed to load WebTorrent library');
    }

    if (typeof DOMPurify === 'undefined') {
        throw new Error('Failed to load DOMPurify library');
    }

    this.librariesLoaded = true;
    this.log('All required libraries loaded successfully');
}

export function loadScript(src, integrity = null, crossorigin = null) {
    return new Promise((resolve, reject) => {
        // Check if script is already loaded
        const existingScript = document.querySelector(`script[src="${src}"]`);
        if (existingScript) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;

        // Add SRI integrity check if provided
        if (integrity) {
            script.integrity = integrity;
            this.log(`Adding integrity check: ${integrity.substring(0, 20)}...`);
        }

        // Add crossorigin attribute if provided
        if (crossorigin) {
            script.crossOrigin = crossorigin;
        }

        script.onload = () => {
            this.log(`Script loaded: ${src}`);
            resolve();
        };

        script.onerror = (_error) => {
            this.log(`Failed to load script: ${src}`);
            if (integrity) {
                this.log('Integrity check may have failed. Trying without integrity...');
                // Fallback: try loading without integrity check
                script.integrity = '';
                script.crossOrigin = '';
            }
            reject(new Error(`Failed to load script: ${src}`));
        };

        // Add to head
        document.head.appendChild(script);

        // Fallback timeout
        let loaded = false;
        const originalOnload = script.onload;
        script.onload = (...args) => {
            loaded = true;
            if (originalOnload) {
                /** @type {Function} */ (originalOnload).apply(script, args);
            }
        };
        setTimeout(() => {
            if (!loaded) {
                reject(new Error(`Script load timeout: ${src}`));
            }
        }, PEERWEB_CONFIG.SCRIPT_LOAD_TIMEOUT);
    });
}

export async function initializeWebTorrent() {
    if (!this.librariesLoaded) {
        throw new Error('Libraries not loaded yet');
    }

    return new Promise((resolve) => {
        try {
            this.client = new WebTorrent();

            this.client.on('error', (err) => {
                this.log('WebTorrent error: ' + err.message);
                console.error('WebTorrent error:', err);
            });

            this.client.on('ready', () => {
                this.clientReady = true;
                this.log('WebTorrent client ready');
                resolve();
            });

            // Fallback in case ready event doesn't fire
            setTimeout(() => {
                if (!this.clientReady) {
                    this.clientReady = true;
                    this.log('WebTorrent client ready (timeout fallback)');
                    resolve();
                }
            }, 2000);
        } catch (error) {
            this.log('Error initializing WebTorrent: ' + error.message);
            console.error('WebTorrent initialization error:', error);
            // Create a mock client to prevent crashes
            this.client = {
                add: () => console.error('WebTorrent not available'),
                seed: () => console.error('WebTorrent not available')
            };
            resolve();
        }
    });
}

export function setupEventListeners() {
    // Debug toggle
    const debugToggle = document.getElementById('debug-toggle');
    if (debugToggle) {
        debugToggle.addEventListener('click', () => {
            this.toggleDebug();
        });
    }

    // Clear cache
    const clearCache = document.getElementById('clear-cache');
    if (clearCache) {
        clearCache.addEventListener('click', () => {
            this.clearCache();
        });
    }

    // Create torrent
    const createTorrent = document.getElementById('create-torrent');
    if (createTorrent) {
        createTorrent.addEventListener('click', () => {
            this.showTorrentModal();
        });
    }

    // Load site
    const loadSite = document.getElementById('load-site');
    if (loadSite) {
        loadSite.addEventListener('click', () => {
            const hashInput = /** @type {HTMLInputElement} */ (document.getElementById('hash-input'));
            const hash = hashInput.value.trim();
            if (hash) {
                this.loadSite(hash);
            }
        });
    }

    // Hash input enter key
    const hashInput = /** @type {HTMLInputElement} */ (document.getElementById('hash-input'));
    if (hashInput) {
        hashInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const target = /** @type {HTMLInputElement} */ (e.target);
                const hash = target.value.trim();
                if (hash) {
                    this.loadSite(hash);
                }
            }
        });
    }

    // Back to PeerWeb
    const backButton = document.getElementById('back-to-peerweb');
    if (backButton) {
        backButton.addEventListener('click', () => {
            this.showMainContent();
        });
    }

    // Close debug panel
    const closeDebug = document.getElementById('close-debug');
    if (closeDebug) {
        closeDebug.addEventListener('click', () => {
            document.getElementById('debug-panel').classList.add('hidden');
        });
    }

    // Modal controls
    const closeModal = document.getElementById('close-modal');
    if (closeModal) {
        closeModal.addEventListener('click', () => {
            this.hideTorrentModal();
        });
    }

    // File input
    const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            this.handleFileSelection(e);
        });
    }

    // Create torrent button
    const createTorrentBtn = document.getElementById('create-torrent-btn');
    if (createTorrentBtn) {
        createTorrentBtn.addEventListener('click', () => {
            this.createTorrent();
        });
    }

    // Copy URL
    const copyUrl = document.getElementById('copy-url');
    if (copyUrl) {
        copyUrl.addEventListener('click', () => {
            const url = document.getElementById('created-url').textContent;
            navigator.clipboard.writeText(url);
            this.toast.success('You can now share this link with others!', 'URL Copied to Clipboard');
        });
    }

    // Setup drag and drop and quick upload
    this.setupDragAndDrop();
    this.setupQuickUpload();

    bindPublishActions({
        onSign: async () => {
            if (!this.lastPublishCandidate) {
                this.toast.warning('Create or load a torrent first.', 'Publish');
                return;
            }

            const identity = this.authController.getActiveIdentity();
            if (!identity.address || !identity.identityType) {
                this.toast.warning('Connect or unlock a wallet before signing.', 'Identity required');
                return;
            }

            const signature = await signPublishPayload(
                {
                    torrentHash: this.lastPublishCandidate.hash,
                    siteName: this.lastPublishCandidate.siteName,
                    createdAt: new Date().toISOString(),
                    publisherAddress: identity.address,
                    contentRoot: this.lastPublishCandidate.hash,
                    chainId: identity.chainId || 1
                },
                identity.identityType
            );

            this.lastSignedPublish = attachPublishMetadata(this.lastPublishCandidate.hash, signature);
            renderPublishReview(this.lastSignedPublish.payload);
            renderSignatureStatus(signature);
        },
        onPublish: async () => {
            if (!this.lastSignedPublish) {
                this.toast.warning('Please sign publish payload first.', 'Publish blocked');
                return;
            }

            const output = document.getElementById('publish-output');
            if (output) {
                output.textContent = JSON.stringify(this.lastSignedPublish, null, 2);
            }
            this.toast.success('Signed publish payload prepared in browser.', 'Publish ready');
        }
    });
}

export function calculateProcessingTimeout(torrent) {
    const sizeMB = torrent.length / (1024 * 1024);
    const fileCount = torrent.files.length;
    
    // Base timeout + additional time based on size and file count
    let timeout = PEERWEB_CONFIG.PROCESSING_TIMEOUT_BASE;
    timeout += sizeMB * PEERWEB_CONFIG.PROCESSING_TIMEOUT_PER_MB;
    timeout += fileCount * PEERWEB_CONFIG.PROCESSING_TIMEOUT_PER_FILE;
    
    // Clamp to min/max
    timeout = Math.max(PEERWEB_CONFIG.PROCESSING_TIMEOUT_MIN, timeout);
    timeout = Math.min(PEERWEB_CONFIG.PROCESSING_TIMEOUT_MAX, timeout);
    
    return Math.floor(timeout);
}

export function calculateFileTimeout(file) {
    const sizeMB = file.length / (1024 * 1024);
    
    let timeout = PEERWEB_CONFIG.FILE_TIMEOUT_BASE;
    timeout += sizeMB * PEERWEB_CONFIG.FILE_TIMEOUT_PER_MB;
    
    // Clamp to min/max
    timeout = Math.max(PEERWEB_CONFIG.FILE_TIMEOUT_MIN, timeout);
    timeout = Math.min(PEERWEB_CONFIG.FILE_TIMEOUT_MAX, timeout);
    
    return Math.floor(timeout);
}

export async function clearCache() {
    await this.cache.clear();
    this.log('Cache cleared');
    this.toast.success('All cached sites have been removed.', 'Cache Cleared Successfully');
}
