// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import AuthController from '../../auth/AuthController.js';
import { bindPublishActions } from '../../ui/publish/PublishPanel.js';
import { renderPublishReview } from '../../ui/publish/PublishReviewModal.js';
import { renderSignatureStatus } from '../../ui/publish/SignatureStatus.js';
import { signPublishPayload } from '../../auth/SigningService.js';
import { attachPublishMetadata } from '../../torrent/TorrentPublishService.js';
import { hasWalletConnectProjectId } from '../../web3/walletConnect.js';

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
    this.setupAuthAwareUi(this.authController.state);
    this.setupWalletConnectButton();
    this.authController.onChange((state) => this.setupAuthAwareUi(state));
}

export function setupWalletConnectButton() {
    const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('connect-wallet-btn'));
    if (!button) return;

    const enabled = hasWalletConnectProjectId();
    button.disabled = !enabled;
    if (!enabled) {
        button.title =
            'WalletConnect disabled: set window.WALLETCONNECT_PROJECT_ID or localStorage.walletconnect_project_id.';
    } else {
        button.title = '';
    }
}

export function attachSignatureArtifact(torrentHash, signature) {
    const signatureLink = /** @type {HTMLAnchorElement | null} */ (document.getElementById('download-signature-file'));
    if (!signatureLink) return;

    if (signatureLink.href && signatureLink.href.startsWith('blob:')) {
        URL.revokeObjectURL(signatureLink.href);
    }

    const blob = new Blob(
        [
            JSON.stringify(
                {
                    torrentHash,
                    payload: signature.payload,
                    message: signature.message,
                    signature: signature.signature
                },
                null,
                2
            )
        ],
        { type: 'application/json' }
    );

    signatureLink.href = this.createTrackedObjectURL(blob);
    signatureLink.download = `website-${torrentHash.slice(0, 8)}.sig.json`;
    signatureLink.style.display = 'inline-flex';
}

export function setupAuthAwareUi(state) {
    const identityTabBtn = document.querySelector('[data-tab="auth"]');
    const identityTabPanel = document.getElementById('tab-auth');
    const deployWall = document.getElementById('deploy-auth-wall');
    const deployPanel = document.getElementById('deploy-panel');
    const isAuthenticated = Boolean(state.address && state.identityType);

    if (identityTabBtn) {
        identityTabBtn.style.display = isAuthenticated ? 'inline-flex' : 'none';
    }
    if (identityTabPanel) {
        identityTabPanel.style.display = isAuthenticated ? 'block' : 'none';
    }
    if (deployWall) {
        deployWall.classList.toggle('hidden', isAuthenticated);
    }
    if (deployPanel) {
        deployPanel.classList.toggle('hidden', !isAuthenticated);
    }

    if (!isAuthenticated) {
        const activeTab = document.querySelector('.tab-btn.active');
        if (activeTab && activeTab.getAttribute('data-tab') === 'auth') {
            const browseTab = document.querySelector('[data-tab=\"browse\"]');
            if (browseTab instanceof HTMLElement) browseTab.click();
        }
    }
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
            this.toast.info('Deploy signs automatically during publish.', 'Deploy flow');
        },
        onPublish: async () => {
            if (!this.pendingDeployFiles || this.pendingDeployFiles.length === 0) {
                this.toast.warning('Select files first before deploying.', 'Deploy blocked');
                return;
            }

            const identity = this.authController.getActiveIdentity();
            if (!identity.address || !identity.identityType) {
                this.toast.warning('Authenticate first: connect wallet or create local wallet.', 'Auth required');
                return;
            }

            try {
                const torrent = await this.deploySignedTorrent();

                const payloadInput = {
                    torrentHash: torrent.infoHash,
                    siteName: this.generateTorrentName(this.pendingDeployFiles),
                    createdAt: new Date().toISOString(),
                    publisherAddress: identity.address,
                    contentRoot: torrent.infoHash,
                    chainId: identity.chainId || 1
                };

                const signature = await signPublishPayload(payloadInput, identity.identityType);
                this.lastSignedPublish = attachPublishMetadata(torrent.infoHash, signature);
                renderPublishReview(this.lastSignedPublish.payload);
                renderSignatureStatus(signature);

                this.attachSignatureArtifact(torrent.infoHash, signature);

                const output = document.getElementById('publish-output');
                if (output) {
                    output.textContent = JSON.stringify(
                        {
                            torrentHash: torrent.infoHash,
                            signedPayload: signature.payload,
                            signature: signature.signature,
                            signatureStorage: 'companion-signature-artifact'
                        },
                        null,
                        2
                    );
                }

                this.toast.success('Signed deployment published.', 'Deploy complete');
            } catch (error) {
                this.toast.error(error.message, 'Deploy failed');
            }
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
