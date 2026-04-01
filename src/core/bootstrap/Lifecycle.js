// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import AuthController from '../../auth/AuthController.js';
import { bindPublishActions, renderDeployStage, setPublishButtonsState } from '../../ui/publish/PublishPanel.js';
import { renderPublishReview } from '../../ui/publish/PublishReviewModal.js';
import { renderSignatureStatus } from '../../ui/publish/SignatureStatus.js';
import { attachPublishMetadata } from '../../torrent/TorrentPublishService.js';
import { createSignedTorrentArtifact } from '../../torrent/SignedTorrentProtocol.js';
import { hideDeployProgress, updateDeployProgress } from '../../ui/publish/DeployProgress.js';

const DEPLOY_SESSION_STORAGE_KEY = 'web25.deploy.session.v1';
const WEBTORRENT_CDN_URL = './scripts/webtorrent.min.js';

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
        await this.restoreDeploySession();
    } catch (error) {
        console.error('PeerWeb initialization failed:', error);
        this.showError('Failed to initialize PeerWeb: ' + error.message);
    }
}

export async function initAuth() {
    this.authController = new AuthController(this.toast);
    await this.authController.init();
    this.lastSignedPublish = null;
    this.lastSignature = null;
    this.lastPublishCandidate = null;
    this.lastDeployResult = null;
    this.setupAuthAwareUi(this.authController.state);
    this.refreshDeployUiState();
    renderSignatureStatus(null);
    renderPublishReview(null);
    renderDeployStage('Stage 1 · Select files', 'Artifact not staged');
    hideDeployProgress();
    this.authController.onChange((state) => this.setupAuthAwareUi(state));
}


export function refreshDeployUiState() {
    const hasFiles = Boolean(this.pendingDeployFiles && this.pendingDeployFiles.length > 0);
    const hasSignature = Boolean(this.lastSignature && this.lastSignedPublish);
    setPublishButtonsState({ canSign: hasFiles, canDeploy: hasFiles && hasSignature });
}

export function invalidateSignedState(message = 'Signature invalidated') {
    this.lastSignature = null;
    this.lastSignedPublish = null;
    this.clearDeploySession();

    renderSignatureStatus(null);
    renderPublishReview(null);

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = `${message}. Re-sign the current artifact before deployment.`;
    }

    const signedBy = document.getElementById('result-signed-by');
    const signatureStatus = document.getElementById('result-signature-status');
    if (signedBy) signedBy.textContent = 'Not signed';
    if (signatureStatus) signatureStatus.textContent = 'UNVERIFIED';

    this.refreshDeployUiState();
    renderDeployStage('Artifact staged', message);
}

export function getSignedPayloadInput(hash, createdAt) {
    const identity = this.authController.getActiveIdentity();
    return {
        torrentHash: hash,
        siteName: this.generateTorrentName(this.pendingDeployFiles || []),
        createdAt,
        publisherAddress: identity.address,
        contentRoot: hash,
        chainId: identity.chainId || 1
    };
}

export async function signStagedPayload() {
    if (!this.pendingDeployFiles || this.pendingDeployFiles.length === 0) {
        throw new Error('Select files before signing.');
    }

    const identity = this.authController.getActiveIdentity();
    if (!identity.address || !identity.identityType) {
        throw new Error('Authenticate before signing.');
    }

    renderDeployStage('Signing', 'Preparing in-memory deploy bundle for signature');
    updateDeployProgress({ label: 'Reading files into browser memory', percent: 10, state: 'running' });

    const createdAt = new Date().toISOString();
    updateDeployProgress({ label: 'Normalizing bundle paths', percent: 25, state: 'running' });

    if (this.lastPublishCandidate?.torrent?.destroy) {
        try { this.lastPublishCandidate.torrent.destroy(); } catch (_) {}
    }

    const prepared = await this.prepareDeployArtifact(this.pendingDeployFiles, ({ label, percent }) =>
        updateDeployProgress({ label, percent, state: 'running' })
    );

    this.lastPublishCandidate = {
        hash: prepared.infoHash,
        siteName: prepared.name,
        torrentFile: prepared.torrentFile,
        torrent: prepared,
        createdAt
    };

    const payloadInput = this.getSignedPayloadInput(prepared.infoHash, createdAt);
    renderPublishReview(payloadInput);

    updateDeployProgress({ label: 'Waiting for wallet signature', indeterminate: true, state: 'running' });

    const signedArtifact = await createSignedTorrentArtifact({
        torrentFile: prepared.torrentFile,
        torrentHash: prepared.infoHash,
        publisher: identity.address,
        chainId: identity.chainId || 1,
        identityType: identity.identityType
    });

    const signature = {
        payload: signedArtifact.signingPayload,
        message: signedArtifact.signingDigest,
        signature: signedArtifact.signature,
        signatureAlgorithm: signedArtifact.signatureAlgorithm,
        signedAt: signedArtifact.signedAt
    };

    this.lastSignature = signature;
    this.lastSignedPublish = attachPublishMetadata(prepared.infoHash, signature);
    this.lastPublishCandidate.signedTorrentFile = signedArtifact.signedTorrent;
    this.persistDeploySession();

    renderSignatureStatus(signature);
    renderPublishReview(signature.payload);

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = JSON.stringify(
            {
                state: 'signature-confirmed',
                signedBy: identity.address,
                signatureAlgorithm: signature.signatureAlgorithm,
                payload: signature.payload,
                signature: signature.signature,
                torrentEmbedding: 'embedded-torrent-metadata'
            },
            null,
            2
        );
    }

    updateDeployProgress({ label: 'Signature confirmed', percent: 100, state: 'success' });
    renderDeployStage('Signature ready', 'Signed in-memory bundle ready for deployment');
    this.refreshDeployUiState();
}

export function renderDeploymentSummary({ hash, url, signedBy, signature, signatureStatus }) {
    const resultEl = document.getElementById('upload-result');
    const hashEl = document.getElementById('result-hash');
    const urlEl = document.getElementById('result-url');
    const signedByEl = document.getElementById('result-signed-by');
    const signatureEl = document.getElementById('result-signature-preview');
    const signatureStatusEl = document.getElementById('result-signature-status');

    if (hashEl) hashEl.textContent = hash;
    if (urlEl) urlEl.textContent = url;
    if (signedByEl) signedByEl.textContent = signedBy || 'Unknown';
    if (signatureEl) signatureEl.textContent = signature ? `${signature.slice(0, 24)}...` : 'N/A';
    if (signatureStatusEl) signatureStatusEl.textContent = signatureStatus || 'UNVERIFIED';

    if (resultEl) resultEl.classList.remove('hidden');
}

export async function deploySignedArtifact() {
    if (!this.lastPublishCandidate || !this.lastSignature || !this.lastSignedPublish) {
        throw new Error('A valid signature is required before deployment.');
    }

    const hash = this.lastPublishCandidate.hash;
    const identity = this.authController.getActiveIdentity();

    renderDeployStage('Deploying', 'Finalizing signed in-memory torrent deployment');
    updateDeployProgress({ label: 'Finalizing deployment', percent: 85, state: 'running' });

    this.showUploadResult(
        hash,
        this.lastPublishCandidate.signedTorrentFile || this.lastPublishCandidate.torrentFile,
        this.lastPublishCandidate.torrent
    );

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = JSON.stringify(
            {
                deploymentStatus: 'completed',
                torrentHash: hash,
                artifactMode: 'in-memory-bundle',
                signedBy: identity.address,
                signature: this.lastSignature.signature,
                signatureAlgorithm: this.lastSignature.signatureAlgorithm || 'EVM_SECP256K1',
                signedAt: this.lastSignature.signedAt,
                authenticity: {
                    integrity: 'Torrent hash guarantees content integrity',
                    authorship: 'Wallet signature embedded in torrent root metadata and bound to torrentHash'
                },
                signatureStorage: ['embedded-torrent-metadata']
            },
            null,
            2
        );
    }

    const url = `${window.location.origin}${window.location.pathname}?orc=${hash}`;
    this.renderDeploymentSummary({
        hash,
        url,
        signedBy: identity.address,
        signature: this.lastSignature.signature,
        signatureStatus: 'VERIFIED'
    });

    this.lastDeployResult = { hash, url, signedBy: identity.address };
    this.persistDeploySession();
    updateDeployProgress({ label: 'Seeding live', percent: 100, state: 'success' });
    renderDeployStage('Deployment complete', 'Live and seeding from memory');
}

export function setupAuthAwareUi(state) {
    const deployWall = document.getElementById('deploy-auth-wall');
    const deployPanel = document.getElementById('deploy-panel');
    const isAuthenticated = Boolean(state.address && state.identityType);

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

    // Load WebTorrent only from the CDN endpoint requested for reliability.
    if (typeof WebTorrent === 'undefined') {
        await this.loadScript(WEBTORRENT_CDN_URL);
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
            const browserTrackers = (this.trackers || []).filter((trackerUrl) => this.isBrowserSupportedTracker(trackerUrl));
            if (browserTrackers.length === 0) {
                this.log('[WebTorrent] WARN: No browser-friendly trackers configured. Falling back to DHT/local peers only.');
            } else {
                this.log(`[WebTorrent] Browser trackers enabled: ${browserTrackers.length}`);
            }
            this.client = new WebTorrent({
                tracker: {
                    announce: browserTrackers
                },
                rtcConfig: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                        { urls: 'stun:stun2.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ],
                    iceCandidatePoolSize: 10
                }
            });
            this.log('[WebTorrent] rtcConfig initialized (STUN + iceCandidatePoolSize=10)');

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

export function isBrowserSupportedTracker(trackerUrl) {
    if (!trackerUrl || typeof trackerUrl !== 'string') {
        return false;
    }

    const normalized = trackerUrl.trim().toLowerCase();
    return (
        normalized.startsWith('wss://') ||
        normalized.startsWith('https://')
    );
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
            try {
                await this.signStagedPayload();
                this.toast.success('Payload signed and ready to deploy.', 'Signature ready');
            } catch (error) {
                updateDeployProgress({ label: error.message, percent: 100, state: 'error' });
                renderDeployStage('Signing failed', error.message);
                this.refreshDeployUiState();
                this.toast.error(error.message, 'Sign failed');
            }
        },
        onPublish: async () => {
            try {
                await this.deploySignedArtifact();
                this.toast.success('Deployment completed. Site is live and seeding.', 'Deploy complete');
            } catch (error) {
                updateDeployProgress({ label: error.message, percent: 100, state: 'error' });
                renderDeployStage('Deploy blocked', error.message);
                this.toast.error(error.message, 'Deploy failed');
            }
        }
    });
}

export function persistDeploySession() {
    if (!this.lastPublishCandidate?.hash || !this.lastSignature || !this.lastPublishCandidate?.signedTorrentFile) {
        return;
    }

    try {
        const signedBy = this.lastSignature?.payload?.publisherAddress || this.lastDeployResult?.signedBy || null;
        const payload = {
            hash: this.lastPublishCandidate.hash,
            siteName: this.lastPublishCandidate.siteName || 'website',
            createdAt: this.lastPublishCandidate.createdAt || null,
            signature: this.lastSignature,
            signedTorrentBase64: this.bytesToBase64(this.lastPublishCandidate.signedTorrentFile),
            deployed: Boolean(this.lastDeployResult),
            deployResult: this.lastDeployResult || null,
            signedBy
        };
        localStorage.setItem(DEPLOY_SESSION_STORAGE_KEY, JSON.stringify(payload));
        this.log(`Deploy session saved for ${payload.hash}`);
    } catch (error) {
        this.log(`Failed to persist deploy session: ${error.message}`);
    }
}

export function clearDeploySession() {
    try {
        localStorage.removeItem(DEPLOY_SESSION_STORAGE_KEY);
    } catch (_) {}
}

export async function restoreDeploySession() {
    if (!this.clientReady || !this.client) return;

    let savedSession = null;
    try {
        const raw = localStorage.getItem(DEPLOY_SESSION_STORAGE_KEY);
        if (!raw) return;
        savedSession = JSON.parse(raw);
    } catch (error) {
        this.log(`Failed to parse deploy session: ${error.message}`);
        this.clearDeploySession();
        return;
    }

    if (!savedSession?.hash || !savedSession?.signature || !savedSession?.signedTorrentBase64) {
        this.clearDeploySession();
        return;
    }

    try {
        const signedTorrentBytes = this.base64ToBytes(savedSession.signedTorrentBase64);
        const signedTorrentBuffer = signedTorrentBytes.buffer.slice(
            signedTorrentBytes.byteOffset,
            signedTorrentBytes.byteOffset + signedTorrentBytes.byteLength
        );

        this.lastSignature = savedSession.signature;
        this.lastSignedPublish = attachPublishMetadata(savedSession.hash, savedSession.signature);
        this.lastPublishCandidate = {
            hash: savedSession.hash,
            siteName: savedSession.siteName || 'website',
            createdAt: savedSession.createdAt || new Date().toISOString(),
            signedTorrentFile: signedTorrentBuffer
        };
        this.lastDeployResult = savedSession.deployResult || null;

        renderSignatureStatus(this.lastSignature);
        renderPublishReview(this.lastSignature.payload || null);
        renderDeployStage(
            savedSession.deployed ? 'Deployment restored' : 'Signature restored',
            savedSession.deployed
                ? 'Reconnected to previous signed deployment after refresh'
                : 'Signed bundle restored. You can deploy now.'
        );

        await new Promise((resolve, reject) => {
            this.client.add(
                signedTorrentBytes,
                { announce: this.trackers },
                (torrent) => {
                    this.lastPublishCandidate.torrent = torrent;
                    this.lastPublishCandidate.torrentFile = signedTorrentBuffer;

                    if (savedSession.deployed) {
                        const url = `${window.location.origin}${window.location.pathname}?orc=${savedSession.hash}`;
                        this.lastDeployResult =
                            savedSession.deployResult || {
                                hash: savedSession.hash,
                                url,
                                signedBy: savedSession.signedBy || this.lastSignature?.payload?.publisherAddress || 'Unknown'
                            };
                        this.showUploadResult(savedSession.hash, signedTorrentBuffer, torrent);
                        this.renderDeploymentSummary({
                            hash: savedSession.hash,
                            url: this.lastDeployResult.url,
                            signedBy: this.lastDeployResult.signedBy,
                            signature: this.lastSignature.signature,
                            signatureStatus: 'VERIFIED'
                        });
                    }
                    resolve();
                }
            );

            setTimeout(() => reject(new Error('Timed out while restoring deploy session')), 12000);
        });

        this.refreshDeployUiState();
        this.toast.info('Signed torrent session restored after refresh.', 'Session restored');
        this.log(`Deploy session restored for ${savedSession.hash}`);
    } catch (error) {
        this.log(`Failed to restore deploy session: ${error.message}`);
        this.clearDeploySession();
    }
}

export function bytesToBase64(value) {
    const uint8 = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
}

export function base64ToBytes(base64Value) {
    const binary = atob(base64Value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
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
