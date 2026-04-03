// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import { readSignedTorrentMetadata } from '../../torrent/SignedTorrentProtocol.js';
import { verifyTorrentChainManifest } from '../../torrent/TorrentChainProtocol.js';
import { decodeSiteBundleGzip, SITE_BUNDLE_FILE_NAME } from '../../torrent/SiteBundleCodec.js';
import { SIGNATURE_STATE_VERIFICATION_VERSION } from '../cache/SignatureStateVersion.js';
import { evaluateRenderGate } from '../../torrent/RenderGate.js';

/** Maximum number of retry attempts per site load triggered by noPeers or torrent error. */
const LOAD_RETRY_MAX = 5;
/** Base delay (ms) for exponential-backoff retry of site loads. */
const LOAD_RETRY_BASE_MS = 2000;

/**
 * Exponential backoff with jitter, capped at 30 s.
 * @param {number} attempt - zero-based attempt index
 * @param {number} baseMs
 */
function calcRetryDelay(attempt, baseMs) {
    return Math.min(30000, baseMs * Math.pow(2, attempt) + Math.random() * 1000);
}

export async function loadSite(hash, _retryAttempt = 0) {
    // Sanitize hash first to prevent XSS
    const sanitizedHash = this.sanitizeHash(hash);
    this.log(`Loading site with hash: ${sanitizedHash}`);

    if (!this.serviceWorkerReady) {
        this.log('Service worker not ready, waiting...');
        setTimeout(() => this.loadSite(sanitizedHash), PEERWEB_CONFIG.READY_CHECK_INTERVAL);
        return;
    }

    if (!this.clientReady || !this.client) {
        this.log('WebTorrent client not ready, waiting...');
        setTimeout(() => this.loadSite(sanitizedHash), PEERWEB_CONFIG.READY_CHECK_INTERVAL);
        return;
    }

    // Validate hash format
    if (!this.isValidTorrentHash(sanitizedHash)) {
        alert(
            '❌ Invalid Hash Format\n\nThe torrent hash must be a 40-character hexadecimal string.\n\n🔧 Format Requirements:\n• Exactly 40 characters long\n• Only contains numbers 0-9 and letters A-F\n\nExample: d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3'
        );
        return;
    }

    this.currentHash = sanitizedHash;
    const knownSignature = this.signedTorrentMetadata.get(sanitizedHash);
    this.currentSiteSignatureStatus = knownSignature
        ? this.buildSignatureState({
              label: knownSignature.verified
                  ? `Verified publisher: ${knownSignature.publisher.slice(0, 10)}...`
                  : `Unverified publisher: ${knownSignature.publisher.slice(0, 10)}...`,
              verified: Boolean(knownSignature.verified),
              source: 'legacy',
              publisher: knownSignature.publisher,
              torrentHash: sanitizedHash
          })
        : this.buildSignatureState({
              label: 'Publisher signature pending (.torrentchain)',
              verified: false,
              source: 'legacy',
              torrentHash: sanitizedHash
          });

    // Check cache first
    const cachedEntry = await this.cache.getEntry(sanitizedHash);
    if (cachedEntry?.data) {
        this.log('Loading from cache...');
        this.applyCachedSignatureState(cachedEntry.signatureState, sanitizedHash);
        this.displayCachedSite(cachedEntry.data, sanitizedHash);
        return;
    }

    this.showLoadingOverlay();

    const trackerList = (this.trackers || [])
        .filter((trackerUrl) => this.isBrowserSupportedTracker(trackerUrl))
        .map((trackerUrl) => encodeURIComponent(trackerUrl));
    if (trackerList.length === 0) {
        this.log('[TorrentLoader] WARN: No browser-friendly trackers in magnet URI; fallback will rely on DHT/local peers');
    }
    const trackerQuery = trackerList.length > 0 ? `&tr=${trackerList.join('&tr=')}` : '';
    const magnetURI = `magnet:?xt=urn:btih:${sanitizedHash}${trackerQuery}`;
    const loadId = `load_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sendToServiceWorker('SITE_LOADING', {
        hash: sanitizedHash,
        state: 'start',
        loadId,
        magnetURI,
        expectedSize: null
    });
    this.log(`Magnet URI: ${magnetURI}`);

    try {
        this.client.add(magnetURI, async (torrent) => {
            this.log(`Torrent added: ${torrent.name || 'Unknown'}`);
            this.log(`Signature status: ${this.currentSiteSignatureStatus.label}`);

            // Verify embedded signed metadata when available from torrent payload.
            try {
                const rawTorrent = torrent.torrentFile || torrent._torrentFile || null;
                if (rawTorrent) {
                    const signedMeta = await readSignedTorrentMetadata(rawTorrent);
                    if (signedMeta && signedMeta.torrentHash === sanitizedHash) {
                        this.signedTorrentMetadata.set(sanitizedHash, signedMeta);
                        this.currentSiteSignatureStatus = this.buildSignatureState({
                            label: signedMeta.verified
                                ? `Verified publisher: ${signedMeta.publisher.slice(0, 10)}...`
                                : `Unverified publisher: ${signedMeta.publisher.slice(0, 10)}...`,
                            verified: Boolean(signedMeta.verified),
                            source: 'legacy',
                            publisher: signedMeta.publisher,
                            torrentHash: sanitizedHash
                        });
                        this.log(`Verified signed metadata at load: ${this.currentSiteSignatureStatus.label}`);
                    }
                }
            } catch (metadataError) {
                this.log(`Signed metadata verification skipped: ${metadataError.message}`);
            }

            const chainGate = await this.verifyTorrentChainBeforeDownload(torrent, sanitizedHash);
            if (!chainGate.ok) {
                this.sendToServiceWorker('SITE_LOADING', {
                    hash: sanitizedHash,
                    state: 'stop',
                    loadId,
                    magnetURI,
                    expectedSize: torrent.length || null
                });
                return;
            }

            this.updatePeerStats(torrent);

            torrent.on('download', () => {
                this.updateProgress(torrent);
                this.updatePeerStats(torrent);

                // Check if we have enough data to process the site
                if (!this.processingInProgress && this.shouldProcessSiteEarly(torrent)) {
                    this.log('Sufficient data downloaded, processing site early...');
                    this.processingInProgress = true;

                    // Clear any existing timeout
                    if (this.processingTimeout) {
                        clearTimeout(this.processingTimeout);
                        this.processingTimeout = null;
                    }

                    this.processTorrentEarly(torrent, sanitizedHash);
                }
            });

            torrent.on('done', async () => {
                this.log('Download completed (100%)!');
                this.sendToServiceWorker('SITE_LOADING', {
                    hash: sanitizedHash,
                    state: 'stop',
                    loadId,
                    magnetURI,
                    expectedSize: torrent.length || null
                });
                if (!this.processingInProgress) {
                    this.processingInProgress = true;
                    if (this.processingTimeout) {
                        clearTimeout(this.processingTimeout);
                        this.processingTimeout = null;
                    }
                    await this.processTorrent(torrent, sanitizedHash);
                }
            });

            torrent.on('error', (error) => {
                this.log(`Torrent error: ${error.message}`);
                this.sendToServiceWorker('SITE_LOADING', {
                    hash: sanitizedHash,
                    state: 'stop',
                    loadId,
                    magnetURI,
                    expectedSize: torrent.length || null
                });
                if (!this.processingInProgress && this.currentHash === sanitizedHash && _retryAttempt < LOAD_RETRY_MAX) {
                    const delay = calcRetryDelay(_retryAttempt, LOAD_RETRY_BASE_MS);
                    this.log(`Torrent error, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${_retryAttempt + 1}/${LOAD_RETRY_MAX})`);
                    if (this.processingTimeout) {
                        clearTimeout(this.processingTimeout);
                        this.processingTimeout = null;
                    }
                    setTimeout(() => {
                        if (this.currentHash !== sanitizedHash) return;
                        this.loadSite(sanitizedHash, _retryAttempt + 1);
                    }, delay);
                } else if (!this.processingInProgress) {
                    this.hideLoadingOverlay();
                    alert(
                        '❌ Torrent Load Error\n\n' +
                            error.message +
                            '\n\n🔧 Troubleshooting:\n• Check your internet connection\n• Verify the hash is correct\n• Ensure the torrent has active seeders\n• Try again in a few moments'
                    );
                }
            });

            torrent.on('noPeers', () => {
                if (this.processingInProgress) return;
                if (this.currentHash !== sanitizedHash) return;
                if (_retryAttempt >= LOAD_RETRY_MAX) {
                    this.log(`No peers found after ${LOAD_RETRY_MAX} retries, giving up`);
                    return;
                }
                const delay = calcRetryDelay(_retryAttempt, LOAD_RETRY_BASE_MS);
                this.log(`No peers found, retrying in ${(delay / 1000).toFixed(1)}s (attempt ${_retryAttempt + 1}/${LOAD_RETRY_MAX})`);
                if (this.processingTimeout) {
                    clearTimeout(this.processingTimeout);
                    this.processingTimeout = null;
                }
                setTimeout(() => {
                    if (this.currentHash !== sanitizedHash) return;
                    torrent.destroy(() => {
                        if (this.currentHash !== sanitizedHash) return;
                        this.loadSite(sanitizedHash, _retryAttempt + 1);
                    });
                }, delay);
            });

            // Select all files for download after .torrentchain verification.
            torrent.files.forEach((file) => file.select());
            this.log(`Selected ${torrent.files.length} files for download`);

            // Calculate torrent characteristics for dynamic timeouts
            this.currentTorrentSize = torrent.length;
            this.currentFileCount = torrent.files.length;
            const torrentSizeMB = this.currentTorrentSize / (1024 * 1024);
            
            this.log(`Torrent size: ${this.formatBytes(this.currentTorrentSize)} (${torrentSizeMB.toFixed(2)} MB)`);
            this.log(`File count: ${this.currentFileCount}`);
            
            if (PEERWEB_CONFIG.SITE_BUNDLE_MODE !== 'gzip') {
                // Find entry file (wait briefly for metadata/file list stabilization)
                const indexFile = await this.waitForEntryFile(torrent);
                if (!indexFile) {
                    this.log('No index.html found!');
                    this.hideLoadingOverlay();
                    alert(
                        "❌ Missing index.html\n\nThis torrent doesn't contain an index.html file.\n\n🔧 Requirements:\n• Every PeerWeb site must have an index.html file\n• Make sure your website folder includes this file\n• Re-create the torrent with a proper website structure"
                    );
                    return;
                }
                this.log(`Found index file: ${indexFile.name}`);

                if (chainGate.manifest) {
                    const entryVerified = await this.verifyEntryFileIntegrity(indexFile, chainGate.manifest);
                    if (!entryVerified.ok) {
                        this.currentSiteSignatureStatus = this.buildSignatureState({
                            label: '❌ Integrity failed: entry file not in .torrentchain or hash mismatch',
                            verified: false,
                            source: 'torrentchain',
                            publisher: entryVerified.publisher,
                            torrentHash: sanitizedHash
                        });
                        this.notifySignatureAbort(sanitizedHash, entryVerified.publisher || 'unknown', entryVerified.reason);
                        this.hideLoadingOverlay();
                        this.sendToServiceWorker('SITE_LOADING', {
                            hash: sanitizedHash,
                            state: 'stop',
                            loadId,
                            magnetURI,
                            expectedSize: torrent.length || null
                        });
                        try {
                            torrent.destroy();
                        } catch (_) {}
                        return;
                    }
                }
            }

            // Calculate dynamic timeout based on torrent size and file count
            const dynamicTimeout = this.calculateProcessingTimeout(torrent);
            this.log(`Dynamic processing timeout set to: ${(dynamicTimeout / 1000).toFixed(1)} seconds`);
            
            // Set a timeout to process the site even if it doesn't reach 100%
            this.processingTimeout = setTimeout(() => {
                if (!this.processingInProgress && PEERWEB_CONFIG.SITE_BUNDLE_MODE !== 'gzip' && torrent.progress > 0.8) {
                    this.log('Processing site due to timeout (80%+ downloaded)');
                    this.processingInProgress = true;
                    this.processTorrentEarly(torrent, sanitizedHash);
                }
            }, dynamicTimeout);
        });
    } catch (error) {
        this.log(`Error adding torrent: ${error.message}`);
        this.hideLoadingOverlay();
        alert(
            '❌ Failed to Add Torrent\n\n' +
                error.message +
                "\n\n🔧 Troubleshooting:\n• Verify the hash format is correct (40 hex characters)\n• Check that seeders are available\n• Ensure your firewall isn't blocking WebRTC connections\n• Try loading the torrent again"
        );
    }
}

export async function verifyTorrentChainBeforeDownload(torrent, hash) {
    const chainFile = torrent.files.find((file) => {
        const name = (file.name || '').toLowerCase();
        return name === '.torrentchain' || name.endsWith('/.torrentchain');
    });

    if (!chainFile) {
        const orphanStatus = '⚠️ Orphan site: no .torrentchain manifest (signature not verifiable)';
        const signatureState = this.buildSignatureState({
            verified: false,
            label: orphanStatus,
            source: 'orphan',
            torrentHash: hash
        });
        this.currentSiteSignatureStatus = signatureState;
        this.log('Missing .torrentchain in bundle.');
        if (PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN) {
            this.log('Strict mode enabled: aborting load because .torrentchain is required.');
            this.hideLoadingOverlay();
            alert('❌ Missing .torrentchain signature manifest. Download aborted (strict mode).');
            try {
                torrent.destroy();
            } catch (_) {}
            return { ok: false, manifest: null, legacy: true, signatureState };
        }
        return { ok: true, manifest: null, legacy: true, signatureState };
    }

    try {
        const buffer = await this.readFileBuffer(chainFile);
        const manifestText = new TextDecoder().decode(buffer);
        const manifest = JSON.parse(manifestText);
        const verification = await verifyTorrentChainManifest(manifest);
        const bundleHash = manifest?.payload?.bundle?.sha256 || null;

        if (!verification.verified) {
            const signatureState = this.buildSignatureState({
                label: 'Invalid .torrentchain signature',
                verified: false,
                source: 'torrentchain',
                publisher: verification.publisher || manifest?.payload?.publisher,
                torrentHash: hash,
                bundleHash
            });
            this.currentSiteSignatureStatus = signatureState;
            this.log(`Invalid .torrentchain signature for hash ${hash}.`);
            this.notifySignatureAbort(hash, verification.publisher || manifest?.payload?.publisher || 'unknown', 'signature-invalid');
            this.hideLoadingOverlay();
            alert('❌ Signature validation failed. Download stopped.');
            try {
                torrent.destroy();
            } catch (_) {}
            return { ok: false, manifest: null, legacy: false, signatureState };
        }

        const signatureState = this.buildSignatureState({
            label: `Verified publisher: ${verification.publisher.slice(0, 10)}...`,
            verified: true,
            source: 'torrentchain',
            publisher: verification.publisher,
            torrentHash: hash,
            bundleHash
        });
        this.currentSiteSignatureStatus = signatureState;
        this.log(`Verified .torrentchain signature for ${hash}.`);
        return { ok: true, manifest, legacy: false, signatureState };
    } catch (error) {
        const signatureState = this.buildSignatureState({
            label: 'Failed to parse .torrentchain',
            verified: false,
            source: 'torrentchain',
            torrentHash: hash
        });
        this.currentSiteSignatureStatus = signatureState;
        this.log(`Failed to verify .torrentchain: ${error.message}`);
        this.hideLoadingOverlay();
        alert('❌ Could not read .torrentchain signature manifest. Download stopped.');
        try {
            torrent.destroy();
        } catch (_) {}
        return { ok: false, manifest: null, legacy: false, signatureState };
    }
}

export async function verifyEntryFileIntegrity(indexFile, manifest) {
    const manifestFiles = Array.isArray(manifest?.files) ? manifest.files : [];
    const entryPath = `${indexFile.path || indexFile.name || ''}`.replace(/\\/g, '/').replace(/^\/+/, '');
    const manifestRecord =
        manifestFiles.find((item) => item.path === entryPath) ||
        manifestFiles.find((item) => item.path === (indexFile.name || ''));
    if (!manifestRecord) {
        return { ok: false, reason: 'entry-not-listed', publisher: manifest?.payload?.publisher };
    }

    const entryBuffer = await this.readFileBuffer(indexFile);
    const digest = await crypto.subtle.digest('SHA-256', entryBuffer);
    const digestHex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    if (digestHex !== manifestRecord.sha256) {
        return { ok: false, reason: 'entry-hash-mismatch', publisher: manifest?.payload?.publisher };
    }
    return { ok: true, reason: 'ok', publisher: manifest?.payload?.publisher };
}

export function notifySignatureAbort(hash, publisher, reason = 'receiver-signature-validation-failed') {
    const payload = {
        hash,
        publisher,
        reason,
        at: new Date().toISOString()
    };
    this.log(`Notifying publisher channel about signature abort: ${JSON.stringify(payload)}`);
    try {
        this.channelsService?.sendSystemMessage?.('signature-abort', payload);
    } catch (error) {
        this.log(`Signature abort notification skipped: ${error.message}`);
    }
}

export function readFileBuffer(file) {
    return new Promise((resolve, reject) => {
        file.getBuffer((error, buffer) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(buffer);
        });
    });
}

export function shouldProcessSiteEarly(torrent) {
    if (PEERWEB_CONFIG.SITE_BUNDLE_MODE === 'gzip') {
        return false;
    }

    // Process if we have threshold or more
    if (torrent.progress >= PEERWEB_CONFIG.EARLY_PROCESS_THRESHOLD) {
        this.log(`Progress at ${Math.round(torrent.progress * 100)}%, processing early`);
        return true;
    }

    // Or if we have the essential files (index.html and most others)
    const indexFile = this.findIndexFile(torrent.files);
    if (indexFile && this.hasEssentialFiles(torrent)) {
        this.log('Essential files available, processing early');
        return true;
    }

    return false;
}

export function hasEssentialFiles(torrent) {
    let availableFiles = 0;
    const totalFiles = torrent.files.length;

    // Check how many files have been downloaded
    torrent.files.forEach((file) => {
        if (file.progress >= 0.9) {
            // File is 90%+ downloaded
            availableFiles++;
        }
    });

    const availabilityRatio = availableFiles / totalFiles;
    this.log(`File availability: ${availableFiles}/${totalFiles} (${Math.round(availabilityRatio * 100)}%)`);

    // If we have threshold of files at 90%+ completion, that's good enough
    return availabilityRatio >= PEERWEB_CONFIG.ESSENTIAL_FILES_THRESHOLD;
}

export async function processTorrentEarly(torrent, hash) {
    this.log('Processing torrent early (before 100% completion)');

    const siteData = {};
    const files = torrent.files;
    let processedFiles = 0;
    let failedFiles = 0;

    // Sort files by priority (media files last, essential files first)
    const sortedFiles = files.sort((a, b) => {
        const aIsMedia = this.isMediaFile(a.name);
        const bIsMedia = this.isMediaFile(b.name);
        const aIsEssential =
            a.name.toLowerCase().includes('index.html') ||
            a.name.toLowerCase().endsWith('.css') ||
            a.name.toLowerCase().endsWith('.js');
        const bIsEssential =
            b.name.toLowerCase().includes('index.html') ||
            b.name.toLowerCase().endsWith('.css') ||
            b.name.toLowerCase().endsWith('.js');

        // Essential files first
        if (aIsEssential && !bIsEssential) {
            return -1;
        }
        if (!aIsEssential && bIsEssential) {
            return 1;
        }

        // Media files last
        if (aIsMedia && !bIsMedia) {
            return 1;
        }
        if (!aIsMedia && bIsMedia) {
            return -1;
        }

        return 0;
    });

    this.log(`Processing ${sortedFiles.length} files (early processing)...`);

    // Process files with different thresholds based on type
    for (const file of sortedFiles) {
        try {
            const isMedia = this.isMediaFile(file.name);
            const isEssential =
                file.name.toLowerCase().includes('index.html') || file.name.toLowerCase().endsWith('.css');

            // Different download thresholds for different file types
            let requiredProgress = PEERWEB_CONFIG.FILE_PROGRESS_THRESHOLD_REGULAR;
            if (isEssential) {
                requiredProgress = PEERWEB_CONFIG.FILE_PROGRESS_THRESHOLD_ESSENTIAL;
            } else if (isMedia) {
                requiredProgress = PEERWEB_CONFIG.FILE_PROGRESS_THRESHOLD_MEDIA;
            }

            this.log(
                `Processing file: ${file.name} (${Math.round(file.progress * 100)}% complete, need ${Math.round(requiredProgress * 100)}%)`
            );

            if (file.progress < requiredProgress) {
                if (isMedia) {
                    // For media files, we'll process them even if not fully downloaded
                    this.log(`Processing media file early: ${file.name}`);
                } else {
                    this.log(`Skipping ${file.name} - only ${Math.round(file.progress * 100)}% downloaded`);
                    continue;
                }
            }

            // Calculate dynamic timeout based on file size
            const dynamicTimeout = this.calculateFileTimeout(file);
            this.log(`File timeout for ${file.name}: ${(dynamicTimeout / 1000).toFixed(1)} seconds (${this.formatBytes(file.length)})`);
            const buffer = await this.getFileBufferWithTimeout(file, dynamicTimeout);

            siteData[file.name] = {
                content: buffer,
                type: this.getContentType(file.name),
                isText: this.isTextFile(file.name),
                isMedia: isMedia,
                size: buffer.length
            };

            processedFiles++;
            this.log(`Processed ${file.name} (${buffer.length} bytes, ${siteData[file.name].type})`);
        } catch (error) {
            failedFiles++;
            this.log(`Failed to process file ${file.name}: ${error.message}`);

            // For critical files, retry
            if (file.name.toLowerCase().includes('index.html')) {
                try {
                    this.log(`Retrying critical file: ${file.name}`);
                    await new Promise((resolve) => setTimeout(resolve, PEERWEB_CONFIG.FILE_RETRY_DELAY));
                    const buffer = await this.getFileBufferWithTimeout(file, PEERWEB_CONFIG.FILE_RETRY_TIMEOUT);

                    siteData[file.name] = {
                        content: buffer,
                        type: this.getContentType(file.name),
                        isText: this.isTextFile(file.name),
                        isMedia: false,
                        size: buffer.length
                    };

                    processedFiles++;
                    this.log(`Successfully processed ${file.name} on retry`);
                } catch (retryError) {
                    this.log(`Failed to process critical file ${file.name} even on retry: ${retryError.message}`);
                }
            }
        }
    }

    this.log(`Processing complete: ${processedFiles} files processed, ${failedFiles} files failed`);

    // Check if we have enough files to display the site
    if (processedFiles === 0) {
        this.log('No files were processed successfully, waiting for more download progress...');
        return;
    }

    // Check if we have an index file
    const hasIndex = Object.keys(siteData).some((name) => name.toLowerCase().includes('index.html'));

    if (!hasIndex) {
        this.log('No index.html found in processed files, waiting for more download progress...');
        return;
    }

    this.log(`Successfully processed ${Object.keys(siteData).length} files with index.html present`);

    this.attachSignatureManifest(siteData, hash);
    this.validateReceivedManifest(siteData, hash);

    // Cache the site (even if incomplete)
    await this.cache.set(hash, siteData, { signatureState: this.currentSiteSignatureStatus });

    // Display the site
    this.displaySite(siteData, hash);
    this.hideLoadingOverlay();

    // Reset processing flag
    this.processingInProgress = false;
}

export function findFileInSiteData(requestedPath) {
    if (!this.currentSiteData) {
        return null;
    }

    this.log(`Searching for: "${requestedPath}"`);

    // Clean the requested path
    let cleanPath = requestedPath;
    if (cleanPath.startsWith('./')) {
        cleanPath = cleanPath.substring(2);
    }
    if (cleanPath.startsWith('/')) {
        cleanPath = cleanPath.substring(1);
    }

    // Try exact matches first
    const exactMatches = [requestedPath, cleanPath];
    for (const path of exactMatches) {
        if (this.currentSiteData[path]) {
            this.log(`Exact match: ${path}`);
            return this.currentSiteData[path];
        }
    }

    // Try all file keys for partial matches
    const allKeys = Object.keys(this.currentSiteData);
    this.log(`All available files: ${allKeys.join(', ')}`);

    // Try matching by filename
    const fileName = cleanPath.split('/').pop();
    for (const key of allKeys) {
        const keyFileName = key.split('/').pop();
        if (keyFileName === fileName) {
            this.log(`Filename match: ${key}`);
            return this.currentSiteData[key];
        }
    }

    // Try matching by ending
    for (const key of allKeys) {
        if (key.endsWith(cleanPath) || cleanPath.endsWith(key)) {
            this.log(`Partial match: ${key}`);
            return this.currentSiteData[key];
        }
    }

    return null;
}

export async function processTorrent(torrent, hash) {
    if (PEERWEB_CONFIG.SITE_BUNDLE_MODE === 'gzip') {
        return this.processTorrentGzipBundle(torrent, hash);
    }

    const siteData = {};
    const files = torrent.files;

    this.log(`Processing ${files.length} files...`);

    // Process all files
    for (const file of files) {
        try {
            this.log(`Processing file: ${file.name}`);
            const buffer = await this.getFileBuffer(file);

            siteData[file.name] = {
                content: buffer,
                type: this.getContentType(file.name),
                isText: this.isTextFile(file.name),
                size: buffer.length
            };

            this.log(`Processed ${file.name} (${buffer.length} bytes, ${siteData[file.name].type})`);
        } catch (error) {
            this.log(`Error processing file ${file.name}: ${error.message}`);
        }
    }

    this.log(`Successfully processed ${Object.keys(siteData).length} files`);
    this.log(`File list: ${Object.keys(siteData).join(', ')}`);

    this.attachSignatureManifest(siteData, hash);
    this.validateReceivedManifest(siteData, hash);

    // Cache the site
    await this.cache.set(hash, siteData, { signatureState: this.currentSiteSignatureStatus });

    // Display the site
    this.displaySite(siteData, hash);
    this.hideLoadingOverlay();

    // Reset processing flag
    this.processingInProgress = false;
}

export async function processTorrentGzipBundle(torrent, hash) {
    try {
        const bundleFile = torrent.files.find((file) => {
            const normalized = (file.path || file.name || '').replace(/\\/g, '/');
            return normalized === SITE_BUNDLE_FILE_NAME || normalized.endsWith(`/${SITE_BUNDLE_FILE_NAME}`);
        });
        if (!bundleFile) {
            throw new Error(`Missing ${SITE_BUNDLE_FILE_NAME}`);
        }

        const bundleBytes = await this.readFileBuffer(bundleFile);
        const decoded = await decodeSiteBundleGzip(bundleBytes);
        const manifestBundleSha = this.currentSiteSignatureStatus?.bundleHash || null;
        const gate = evaluateRenderGate({
            signatureVerified: Boolean(this.currentSiteSignatureStatus?.verified),
            strictMode: PEERWEB_CONFIG.REQUIRE_TORRENTCHAIN,
            hasTorrentChain: this.currentSiteSignatureStatus?.source === 'torrentchain',
            bundleHashExpected: manifestBundleSha,
            bundleHashActual: decoded.sha256
        });
        if (!gate.allowed) {
            this.currentSiteSignatureStatus = this.buildSignatureState({
                label: gate.reason === 'bundle-hash-mismatch' ? '❌ Bundle hash mismatch against .torrentchain' : '❌ Signature validation gate blocked render',
                verified: false,
                source: 'torrentchain',
                publisher: this.currentSiteSignatureStatus?.publisher,
                torrentHash: hash,
                bundleHash: manifestBundleSha
            });
            this.hideLoadingOverlay();
            alert(`❌ Render blocked (${gate.reason}).`);
            this.processingInProgress = false;
            return;
        }

        const siteData = {};
        for (const file of decoded.files) {
            siteData[file.path] = {
                content: file.bytes,
                type: file.contentType || this.getContentType(file.path),
                isText: this.isTextFile(file.path),
                size: file.bytes.length
            };
        }

        const entryPath = decoded.entryPath || '';
        if (entryPath && !siteData[entryPath]) {
            throw new Error(`Invalid bundle entryPath: ${entryPath}`);
        }
        if (!Object.keys(siteData).some((name) => name.toLowerCase() === 'index.html' || name.toLowerCase().endsWith('/index.html'))) {
            throw new Error('Bundle is missing index.html');
        }

        this.currentSiteSignatureStatus = this.buildSignatureState({
            ...this.currentSiteSignatureStatus,
            bundleHash: decoded.sha256,
            torrentHash: hash
        });

        this.attachSignatureManifest(siteData, hash);
        this.validateReceivedManifest(siteData, hash);
        await this.cache.set(hash, siteData, { signatureState: this.currentSiteSignatureStatus });
        this.displaySite(siteData, hash);
        this.hideLoadingOverlay();
    } catch (error) {
        this.log(`Failed to process gzip bundle: ${error.message}`);
        this.hideLoadingOverlay();
        alert(`❌ Failed to decode site bundle: ${error.message}`);
    } finally {
        this.processingInProgress = false;
    }
}

export function findIndexFile(files) {
    return files.find((file) => {
        const name = file.name.toLowerCase();
        return name === 'index.html' || name.endsWith('/index.html');
    });
}

export function attachSignatureManifest(siteData, hash) {
    const signedMeta = this.signedTorrentMetadata.get(hash);
    const existingManifest = siteData['manifest.web25.json'];

    let parsedManifest = null;
    if (existingManifest && existingManifest.content) {
        try {
            parsedManifest = JSON.parse(new TextDecoder().decode(existingManifest.content));
        } catch (_) {}
    }

    const enrichedManifest = {
        schema: 'web25-signature-manifest-v1',
        ...(parsedManifest || {}),
        torrentHash: hash,
        signatureSource: 'torrent-root-metadata',
        signature: signedMeta
            ? {
                  publisher: signedMeta.publisher,
                  signature: signedMeta.signature,
                  signatureAlgorithm: signedMeta.signatureAlgorithm,
                  signedAt: signedMeta.signedAt,
                  chainDigest: signedMeta.digestHex,
                  verified: Boolean(signedMeta.verified)
              }
            : null
    };

    const content = new TextEncoder().encode(JSON.stringify(enrichedManifest, null, 2));
    siteData['manifest.web25.json'] = {
        content,
        type: 'application/json',
        isText: true,
        size: content.length
    };
}

export function validateReceivedManifest(siteData, hash) {
    const signedMeta = this.signedTorrentMetadata.get(hash);
    const manifestEntry = siteData['manifest.web25.json'];
    if (!signedMeta || !manifestEntry?.content) {
        return;
    }

    try {
        const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.content));
        const manifestSignature = manifest?.signature || null;

        if (!manifestSignature) {
            this.log('Manifest signature missing; root metadata signature remains source of truth.');
            return;
        }

        const consistent =
            manifestSignature.publisher === signedMeta.publisher &&
            manifestSignature.signature === signedMeta.signature &&
            manifest.torrentHash === hash;

        if (!consistent) {
            this.currentSiteSignatureStatus = {
                label: 'Signature manifest mismatch detected',
                verified: false
            };
            this.log('Manifest signature mismatch with torrent root metadata');
        } else {
            this.log('Manifest signature matches torrent root metadata');
        }
    } catch (error) {
        this.log(`Manifest verification skipped: ${error.message}`);
    }
}

export async function waitForEntryFile(torrent, timeoutMs = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const files = Array.isArray(torrent.files) ? torrent.files : [];
        if (files.length > 0) {
            const indexFile = this.findIndexFile(files);
            if (indexFile) {
                return indexFile;
            }

            // Fallback: accept any .html file if index.html is missing.
            // This avoids hard-failing on torrents that have a valid single-page entry
            // but use a non-standard filename.
            const htmlFallback = files.find((file) => file.name.toLowerCase().endsWith('.html'));
            if (htmlFallback) {
                this.log(`No index.html found, using HTML fallback entry: ${htmlFallback.name}`);
                return htmlFallback;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
}

export function buildSignatureState(nextState = {}) {
    return {
        verified: Boolean(nextState.verified),
        label: nextState.label || 'Publisher signature pending (.torrentchain)',
        publisher: nextState.publisher,
        verifiedAt: nextState.verifiedAt || (nextState.verified ? new Date().toISOString() : undefined),
        verificationVersion: SIGNATURE_STATE_VERIFICATION_VERSION,
        source: nextState.source || 'legacy',
        torrentHash: nextState.torrentHash || this.currentHash || '',
        bundleHash: nextState.bundleHash
    };
}

export function applyCachedSignatureState(signatureState, hash) {
    if (!signatureState) return;
    if (signatureState.verificationVersion !== SIGNATURE_STATE_VERIFICATION_VERSION) {
        this.currentSiteSignatureStatus = this.buildSignatureState({
            verified: false,
            label: '⚠️ Stale signature state in cache (revalidation recommended)',
            source: signatureState.source || 'legacy',
            torrentHash: hash
        });
        return;
    }
    this.currentSiteSignatureStatus = this.buildSignatureState({
        ...signatureState,
        torrentHash: hash
    });
}

export async function displayCachedSite(siteData, hash) {
    this.displaySite(siteData, hash, true);
}

export function displaySite(siteData, hash, fromCache = false) {
    this.log(`Displaying site with ${Object.keys(siteData).length} files`);
    this.log(`Files: ${Object.keys(siteData).join(', ')}`);

    // Store site data for service worker
    this.currentSiteData = siteData;
    this.currentHash = hash;

    // Find index.html
    let indexFileName = Object.keys(siteData).find((name) => {
        const lowerName = name.toLowerCase();
        return lowerName === 'index.html' || lowerName.endsWith('/index.html');
    });

    if (!indexFileName) {
        indexFileName = Object.keys(siteData).find((name) => name.toLowerCase().endsWith('.html'));
        if (indexFileName) {
            this.log(`No index.html in site data, using HTML fallback entry: ${indexFileName}`);
        }
    }

    if (!indexFileName) {
        alert(
            "❌ No index.html Found\n\nThe site data doesn't contain an index.html file.\n\n🔧 This usually means:\n• The torrent is incomplete or corrupted\n• The website wasn't structured correctly\n• The download was interrupted\n\nTry reloading the site or creating a new torrent."
        );
        return;
    }

    this.log(`Found index file: ${indexFileName}`);

    // Alias: if entry is nested (e.g. site/index.html), ensure bare 'index.html' also resolves.
    // This prevents 404s when the SW normalises the root request to 'index.html'.
    if (indexFileName !== 'index.html') {
        siteData['index.html'] = siteData[indexFileName];
        this.log(`Aliased 'index.html' -> '${indexFileName}'`);
    }

    // Get and process the HTML content
    const indexFile = siteData[indexFileName];
    let htmlContent = new TextDecoder().decode(indexFile.content);

    this.log('Processing HTML content...');

    // Process the HTML to update only internal resource URLs
    htmlContent = this.processHtmlForPeerWeb(htmlContent, siteData, indexFileName, hash);

    // Sanitize HTML content but preserve external links
    htmlContent = this.sanitizeHtml(htmlContent);

    this.log('HTML content processed and sanitized');
    // Note: htmlContent is processed for validation but Service Worker serves content directly
    void htmlContent; // Mark as intentionally unused

    // Create a virtual URL for the site (this is what we'll actually use)
    const siteUrl = `${window.location.origin}/peerweb-site/${hash}/`;

    this.log(`Site URL: ${siteUrl}`);

    // Wait for service worker to be fully ready, then send SITE_READY message
    // This ensures the SW is active and can receive the message
    const sendSiteReadyAndLoad = async () => {
        // Ensure SW controller is available and active
        await this.waitForController();
        
        // Notify service worker that site is ready BEFORE loading the iframe
        // This ensures the SW has the site data before any fetch requests arrive
        await this.sendToServiceWorker('SITE_READY', {
            hash,
            fileCount: Object.keys(siteData).length,
            fileList: Object.keys(siteData), // Send the list of available files
            entryFile: indexFileName          // Tell SW the canonical entry path
        });
        
        // Small delay to ensure the service worker receives the message before iframe loads
        setTimeout(() => {
            this.showSiteViewer(siteUrl, hash, fromCache);
        }, PEERWEB_CONFIG.INIT_DELAY);
    };
    
    sendSiteReadyAndLoad();
}
