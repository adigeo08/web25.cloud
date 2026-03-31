// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';
import { readSignedTorrentMetadata } from '../../torrent/SignedTorrentProtocol.js';

export async function loadSite(hash) {
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
        ? {
              label: knownSignature.verified
                  ? `Verified publisher: ${knownSignature.publisher.slice(0, 10)}...`
                  : `Unverified publisher: ${knownSignature.publisher.slice(0, 10)}...`,
              verified: Boolean(knownSignature.verified)
          }
        : {
              label: 'Publisher signature unavailable (magnet metadata)',
              verified: false
          };

    // Check cache first
    const cachedSite = await this.cache.get(sanitizedHash);
    if (cachedSite) {
        this.log('Loading from cache...');
        this.displayCachedSite(cachedSite, sanitizedHash);
        return;
    }

    this.showLoadingOverlay();

    const magnetURI = `magnet:?xt=urn:btih:${sanitizedHash}&tr=${this.trackers.join('&tr=')}`;
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
                        this.currentSiteSignatureStatus = {
                            label: signedMeta.verified
                                ? `Verified publisher: ${signedMeta.publisher.slice(0, 10)}...`
                                : `Unverified publisher: ${signedMeta.publisher.slice(0, 10)}...`,
                            verified: Boolean(signedMeta.verified)
                        };
                        this.log(`Verified signed metadata at load: ${this.currentSiteSignatureStatus.label}`);
                    }
                }
            } catch (metadataError) {
                this.log(`Signed metadata verification skipped: ${metadataError.message}`);
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
                this.hideLoadingOverlay();
                alert(
                    '❌ Torrent Load Error\n\n' +
                        error.message +
                        '\n\n🔧 Troubleshooting:\n• Check your internet connection\n• Verify the hash is correct\n• Ensure the torrent has active seeders\n• Try again in a few moments'
                );
            });

            // Select all files for download
            torrent.files.forEach((file) => file.select());
            this.log(`Selected ${torrent.files.length} files for download`);

            // Calculate torrent characteristics for dynamic timeouts
            this.currentTorrentSize = torrent.length;
            this.currentFileCount = torrent.files.length;
            const torrentSizeMB = this.currentTorrentSize / (1024 * 1024);
            
            this.log(`Torrent size: ${this.formatBytes(this.currentTorrentSize)} (${torrentSizeMB.toFixed(2)} MB)`);
            this.log(`File count: ${this.currentFileCount}`);
            
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

            // Calculate dynamic timeout based on torrent size and file count
            const dynamicTimeout = this.calculateProcessingTimeout(torrent);
            this.log(`Dynamic processing timeout set to: ${(dynamicTimeout / 1000).toFixed(1)} seconds`);
            
            // Set a timeout to process the site even if it doesn't reach 100%
            this.processingTimeout = setTimeout(() => {
                if (!this.processingInProgress && torrent.progress > 0.8) {
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

export function shouldProcessSiteEarly(torrent) {
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
    await this.cache.set(hash, siteData);

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
    await this.cache.set(hash, siteData);

    // Display the site
    this.displaySite(siteData, hash);
    this.hideLoadingOverlay();

    // Reset processing flag
    this.processingInProgress = false;
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
            fileList: Object.keys(siteData) // Send the list of available files
        });
        
        // Small delay to ensure the service worker receives the message before iframe loads
        setTimeout(() => {
            this.showSiteViewer(siteUrl, hash, fromCache);
        }, PEERWEB_CONFIG.INIT_DELAY);
    };
    
    sendSiteReadyAndLoad();
}
