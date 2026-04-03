// @ts-check

import { readSignedTorrentMetadata } from '../../torrent/SignedTorrentProtocol.js';
import { createBep10SignatureExtension } from '../../torrent/Bep10SignatureExtension.js';

export function setupDragAndDrop() {
    const dropZone = document.getElementById('drop-zone');
    const folderInput = document.getElementById('folder-input');
    const torrentInput = document.getElementById('torrent-input');

    if (!dropZone) {
        return;
    } // Exit if drop zone doesn't exist

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    // Highlight drop zone when item is dragged over it
    ['dragenter', 'dragover'].forEach((eventName) => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-over');
        });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-over');
        });
    });

    // Handle dropped files
    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
        this.handleDroppedFiles(files);
    });

    // Folder selection button
    const selectFolder = document.getElementById('select-folder');
    if (selectFolder && folderInput) {
        selectFolder.addEventListener('click', () => {
            folderInput.click();
        });
    }

    // Torrent file selection button
    const selectTorrent = document.getElementById('select-torrent');
    if (selectTorrent && torrentInput) {
        selectTorrent.addEventListener('click', () => {
            torrentInput.click();
        });
    }

    // Handle folder input
    if (folderInput) {
        folderInput.addEventListener('change', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            const files = target.files ? Array.from(target.files) : [];
            this.handleDroppedFiles(files);
        });
    }

    // Handle torrent input
    if (torrentInput) {
        torrentInput.addEventListener('change', (e) => {
            const target = /** @type {HTMLInputElement} */ (e.target);
            const files = target.files ? Array.from(target.files) : [];
            this.handleDroppedFiles(files);
        });
    }
}

export function setupQuickUpload() {
    // Open site button
    const openSite = document.getElementById('open-site');
    if (openSite) {
        openSite.addEventListener('click', () => {
            const hash = document.getElementById('result-hash').textContent;
            const url = `${window.location.origin}${window.location.pathname}?orc=${hash}`;
            window.open(url, '_blank');
        });
    }

    // Copy link button
    const copyLink = document.getElementById('copy-link');
    if (copyLink) {
        copyLink.addEventListener('click', () => {
            const url = document.getElementById('result-url').textContent;
            navigator.clipboard.writeText(url).then(() => {
                const button = document.getElementById('copy-link');
                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                setTimeout(() => {
                    button.textContent = originalText;
                }, 2000);
            });
        });
    }

    // Desktop client links
    document.querySelectorAll('.desktop-link').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = /** @type {HTMLElement} */ (e.target);
            const os = target.dataset.os;
            this.downloadDesktopClient(os);
        });
    });
}

export function handleDroppedFiles(files) {
    if (files.length === 0) {
        return;
    }

    this.log(`Dropped ${files.length} files`);

    // Check if WebTorrent client is ready
    if (!this.clientReady || !this.client) {
        this.log('WebTorrent client not ready, waiting...');
        // Show a user-friendly message
        this.showUploadProgress('WebTorrent client is loading...');
        setTimeout(() => {
            this.hideUploadProgress();
            this.handleDroppedFiles(files);
        }, 1000);
        return;
    }

    // Look for torrent files specifically
    const torrentFiles = files.filter(
        (file) => file.name.toLowerCase().endsWith('.torrent') && file.type === 'application/x-bittorrent'
    );

    // If we don't find files with the right MIME type, check by extension only
    if (torrentFiles.length === 0) {
        const torrentFilesByExt = files.filter((file) => file.name.toLowerCase().endsWith('.torrent'));

        if (torrentFilesByExt.length > 0) {
            this.log(`Found ${torrentFilesByExt.length} .torrent files (by extension)`);
            this.handleTorrentFile(torrentFilesByExt[0]);
            return;
        }
    } else {
        this.log(`Found ${torrentFiles.length} .torrent files (by MIME type)`);
        this.handleTorrentFile(torrentFiles[0]);
        return;
    }

    // Check if files have a common directory structure (folder upload)
    if (files.length > 1) {
        this.handleFolderUpload(files);
        return;
    }

    // Single file - check if it's HTML
    const singleFile = files[0];
    if (singleFile.name.toLowerCase().endsWith('.html')) {
        this.handleFolderUpload(files);
        return;
    }

    // If it's a single file that might be a torrent but doesn't have the right extension
    if (files.length === 1 && singleFile.size < 1024 * 1024) {
        // Less than 1MB
        this.log("Single small file detected, checking if it's a torrent...");
        this.readFileAsArrayBuffer(singleFile)
            .then((buffer) => {
                if (this.isValidTorrentBuffer(buffer)) {
                    this.log('File appears to be a torrent despite extension');
                    this.handleTorrentFile(singleFile);
                } else {
                    this.toast.warning(
                        "This doesn't appear to be a valid torrent file.\n\nPlease drop:\n• A website folder (containing HTML files)\n• A valid .torrent file",
                        'Invalid File'
                    );
                }
            })
            .catch((error) => {
                this.log(`Error checking file: ${error.message}`);
                this.toast.warning(
                    "Couldn't read the dropped file.\n\nPlease try again with:\n• A website folder (containing HTML files)\n• A valid .torrent file",
                    'Unable to Process File'
                );
            });
        return;
    }

    this.toast.warning(
        'Please drop:\n• A website folder (containing HTML files)\n• A .torrent file to load an existing site',
        'Unsupported File Type'
    );
}

export async function handleTorrentFile(torrentFile) {
    this.log(`Loading torrent file: ${torrentFile.name} (${torrentFile.size} bytes)`);

    if (!this.clientReady || !this.client) {
        this.toast.info(
            "The WebTorrent client is initializing.\nPlease wait a moment and try again.\n\nTip: You'll see the interface become active when ready.",
            'PeerWeb is Still Loading'
        );
        return;
    }

    this.showUploadProgress('Reading torrent file...');

    try {
        // Read the torrent file as ArrayBuffer
        const buffer = await this.readFileAsArrayBuffer(torrentFile);
        const bufferSize = buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.length;
        this.log(`Torrent file read: ${bufferSize} bytes`);


        try {
            const signedMeta = await readSignedTorrentMetadata(buffer);
            if (signedMeta) {
                this.signedTorrentMetadata.set(signedMeta.torrentHash, signedMeta);
                this.log(
                    `Signed torrent metadata detected: ${signedMeta.publisher} (${signedMeta.verified ? 'VERIFIED' : 'UNVERIFIED'})`
                );
            }
        } catch (metadataError) {
            this.log(`Signed metadata parse skipped: ${metadataError.message}`);
        }

        // Validate that this looks like a torrent file
        if (!this.isValidTorrentBuffer(buffer)) {
            throw new Error('Invalid torrent file format');
        }

        this.log('Torrent file validation passed, adding to WebTorrent...');

        // Try different approaches to add the torrent
        this.addTorrentWithFallback(buffer, torrentFile);
    } catch (error) {
        this.log(`Error loading torrent: ${error.message}`);
        console.error('Torrent loading error:', error);
        this.hideUploadProgress();

        if (error.message.includes('Invalid torrent identifier')) {
            alert(
                "❌ Invalid Torrent File\n\nThe file appears to be corrupted or incompatible with WebTorrent.\n\n🔧 Troubleshooting:\n• Try creating a new torrent using the Advanced Torrent Creator\n• Verify the .torrent file isn't damaged\n• Make sure it's a BitTorrent v1 torrent (v2 not yet supported)"
            );
        } else if (error.message.includes('Invalid torrent file format')) {
            alert(
                "❌ Not a Valid Torrent\n\nThis file doesn't have a valid torrent file structure.\n\n🔧 Troubleshooting:\n• Ensure the file has a .torrent extension\n• Try re-downloading the torrent file\n• Use the PeerWeb Advanced Torrent Creator to generate a new one"
            );
        } else {
            alert(
                '❌ Torrent Loading Error\n\n' +
                    error.message +
                    "\n\n🔧 Troubleshooting:\n• Create a new torrent using the Advanced Torrent Creator\n• Verify your internet connection is stable\n• Check that the file isn't corrupted\n• Make sure you have enough available memory"
            );
        }
    }
}

export function addTorrentWithFallback(buffer, originalFile) {
    let attempts = 0;
    const maxAttempts = 3;

    const tryAddTorrent = (torrentData, method) => {
        attempts++;
        this.log(`Attempt ${attempts}: Trying to add torrent using ${method}`);

        try {
            this.client.add(
                torrentData,
                {
                    announce: this.trackers,
                    path: '/tmp/webtorrent/' // Temporary download path
                },
                (torrent) => {
                    this.log(`Torrent loaded successfully with ${method}: ${torrent.infoHash}`);
                    this.log(`Torrent name: ${torrent.name || 'Unknown'}`);
                    this.log(`Number of files: ${torrent.files.length}`);

                    // Log file names for debugging
                    torrent.files.forEach((file, index) => {
                        this.log(`File ${index + 1}: ${file.name} (${file.length} bytes)`);
                    });

                    // Show result immediately for existing torrents
                    this.showUploadResult(torrent.infoHash, buffer, torrent);
                    this.hideUploadProgress();

                    // Start downloading the torrent content
                    torrent.files.forEach((file) => file.select());
                    this.log(`Started downloading ${torrent.files.length} files`);
                }
            );
        } catch (error) {
            this.log(`Failed with ${method}: ${error.message}`);

            if (attempts < maxAttempts) {
                // Try next method
                if (attempts === 1) {
                    // Method 2: Try with Uint8Array
                    const uint8Array = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
                    tryAddTorrent(uint8Array, 'Uint8Array');
                } else if (attempts === 2) {
                    // Method 3: Try parsing as blob and reading again
                    this.tryBlobMethod(originalFile);
                }
            } else {
                // All methods failed
                this.hideUploadProgress();
                throw new Error(`All methods failed. Last error: ${error.message}`);
            }
        }
    };

    // Method 1: Try with ArrayBuffer directly
    tryAddTorrent(buffer, 'ArrayBuffer');
}

export async function tryBlobMethod(originalFile) {
    try {
        this.log('Trying blob method...');

        // Create a blob from the file
        const blob = new Blob([originalFile], { type: 'application/x-bittorrent' });

        // Read the blob as ArrayBuffer
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const result = /** @type {FileReader} */ (event.target).result;
                const buffer = /** @type {ArrayBuffer} */ (result);
                const uint8Array = new Uint8Array(buffer);

                this.log(`Blob method: read ${uint8Array.length} bytes`);

                this.client.add(
                    uint8Array,
                    {
                        announce: this.trackers
                    },
                    (torrent) => {
                        this.log(`Torrent loaded successfully with blob method: ${torrent.infoHash}`);
                        this.showUploadResult(torrent.infoHash, buffer, torrent);
                        this.hideUploadProgress();

                        torrent.files.forEach((file) => file.select());
                    }
                );
            } catch (error) {
                this.log(`Blob method failed: ${error.message}`);
                this.hideUploadProgress();
                throw error;
            }
        };

        reader.onerror = () => {
            this.log('Blob method: FileReader error');
            this.hideUploadProgress();
            throw new Error('Failed to read file with blob method');
        };

        reader.readAsArrayBuffer(blob);
    } catch (error) {
        this.log(`Blob method error: ${error.message}`);
        this.hideUploadProgress();
        throw error;
    }
}

export function isValidTorrentBuffer(buffer) {
    try {
        // Convert ArrayBuffer to Uint8Array for checking
        const uint8Array = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;

        this.log(`Validating torrent buffer: ${uint8Array.length} bytes`);

        // Torrent files should be at least 50 bytes
        if (uint8Array.length < 50) {
            this.log('Torrent file too small');
            return false;
        }

        // Check if it starts with 'd' (bencoded dictionary)
        if (uint8Array[0] !== 0x64) {
            // 'd' in ASCII
            this.log(`Invalid start byte: 0x${uint8Array[0].toString(16)} (expected 0x64 for 'd')`);
            return false;
        }

        // Check if it ends with 'e' (end of bencoded dictionary)
        if (uint8Array[uint8Array.length - 1] !== 0x65) {
            // 'e' in ASCII
            this.log(`Invalid end byte: 0x${uint8Array[uint8Array.length - 1].toString(16)} (expected 0x65 for 'e')`);
            // Don't fail on this as some torrents might have padding
        }

        // Try to find key torrent fields in the binary data
        const dataString = new TextDecoder('utf-8', { fatal: false }).decode(uint8Array);

        // Log first 200 characters for debugging
        this.log(`Torrent content preview: ${dataString.substring(0, 200)}`);

        // Check for required fields
        const hasAnnounce = dataString.includes('announce') || this.findBencodedString(uint8Array, 'announce');
        const hasInfo = dataString.includes('info') || this.findBencodedString(uint8Array, 'info');

        this.log(`Torrent validation - announce: ${hasAnnounce}, info: ${hasInfo}`);

        if (!hasAnnounce || !hasInfo) {
            this.log('Missing required torrent fields (announce or info)');
            return false;
        }

        // Additional check: look for piece length and pieces
        const hasPieceLength =
            dataString.includes('piece length') || this.findBencodedString(uint8Array, 'piece length');
        const hasPieces = dataString.includes('pieces') || this.findBencodedString(uint8Array, 'pieces');

        this.log(`Additional validation - piece length: ${hasPieceLength}, pieces: ${hasPieces}`);

        this.log('Torrent file validation passed');
        return true;
    } catch (error) {
        this.log(`Torrent validation error: ${error.message}`);
        return false;
    }
}

export function findBencodedString(uint8Array, searchString) {
    try {
        // In bencoded format, strings are prefixed with their length
        // e.g., "announce" would be "8:announce"
        const searchBytes = new TextEncoder().encode(`${searchString.length}:${searchString}`);

        // Simple search for the byte pattern
        for (let i = 0; i <= uint8Array.length - searchBytes.length; i++) {
            let match = true;
            for (let j = 0; j < searchBytes.length; j++) {
                if (uint8Array[i + j] !== searchBytes[j]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                return true;
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

export function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        if (!file || !(file instanceof File)) {
            reject(new Error('Invalid file object'));
            return;
        }

        this.log(`Reading file: ${file.name}, size: ${file.size}, type: ${file.type}`);

        const reader = new FileReader();

        reader.onload = (event) => {
            const target = /** @type {FileReader} */ (event.target);
            const result = /** @type {ArrayBuffer} */ (target.result);
            if (result && result.byteLength > 0) {
                this.log(`File read successfully: ${result.byteLength} bytes`);
                resolve(result);
            } else {
                reject(new Error('File reading returned empty result'));
            }
        };

        reader.onerror = () => {
            const error = reader.error || new Error('Unknown FileReader error');
            this.log(`FileReader error: ${error.message}`);
            reject(new Error('File reading failed: ' + error.message));
        };

        reader.onabort = () => {
            this.log('FileReader aborted');
            reject(new Error('File reading was aborted'));
        };

        // Add progress tracking for large files
        reader.onprogress = (event) => {
            if (event.lengthComputable) {
                const progress = Math.round((event.loaded / event.total) * 100);
                this.log(`Reading file: ${progress}%`);
            }
        };

        try {
            reader.readAsArrayBuffer(file);
        } catch (error) {
            this.log(`Failed to start file reading: ${error.message}`);
            reject(new Error('Failed to start file reading: ' + error.message));
        }
    });
}

export async function handleFolderUpload(files) {
    this.log(`Processing ${files.length} files for deployment`);

    // Check for index.html in normalized deploy paths
    const hasIndex = files.some((file) => {
        const normalizedPath = this.getNormalizedDeployPath(file).toLowerCase();
        return normalizedPath === 'index.html' || normalizedPath.endsWith('/index.html');
    });

    if (!hasIndex) {
        if (!confirm('No index.html found. Continue anyway? (Site may not load properly)')) {
            return;
        }
    }

    this.pendingDeployFiles = files;
    this.lastPublishCandidate = null;
    this.lastSignedPublish = null;
    this.lastSignature = null;
    this.lastDeployResult = null;
    this.clearDeploySession?.();
    this.invalidateSignedState?.('Artifact updated. Previous signature invalidated.');

    const output = document.getElementById('publish-output');
    if (output) {
        output.textContent = `Artifact staged with ${files.length} files. Deploy uses an in-memory bundle (no direct local-directory seeding). Sign the payload to continue.`;
    }

    const resultEl = document.getElementById('upload-result');
    if (resultEl) {
        resultEl.classList.add('hidden');
    }

    this.toast.success('Artifact staged in memory. Sign payload to continue deployment.', 'Stage 1 complete');
}

export async function prepareDeployArtifact(files, onProgress) {
    if (!files || files.length === 0) {
        throw new Error('No files selected for deployment');
    }

    if (!this.clientReady || !this.client) {
        throw new Error('WebTorrent client is not ready');
    }

    let timeoutId = null;

    try {
        onProgress?.({ label: 'Bundling files in memory', percent: 35 });
        const inMemoryFiles = await this.buildInMemoryDeployBundle(files, onProgress);
        onProgress?.({ label: 'Creating torrent from memory bundle', percent: 55 });
        const createdTorrent = await new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Timed out while creating torrent')), 30000);

            this.client.seed(
                inMemoryFiles,
                {
                    announce: this.trackers,
                    name: this.generateTorrentName(files),
                    comment: 'Web25 Deploy Artifact (in-memory bundle)',
                    createdBy: 'Web25.Cloud Deploy',
                    private: false,
                    pieceLength: this.calculateOptimalPieceLength(inMemoryFiles)
                },
                (torrent) => {
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                        timeoutId = null;
                    }
                    resolve(torrent);
                }
            );
        });
        return createdTorrent;
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

export function getNormalizedDeployPath(file) {
    const rawPath = (file.webkitRelativePath || file.path || file.name || '').replace(/\\/g, '/').trim();
    const sanitized = rawPath.replace(/^\/+/, '');
    return sanitized || file.name || 'unnamed-file';
}

export async function buildInMemoryDeployBundle(files, onProgress) {
    const total = files.length;
    const inMemoryFiles = [];

    for (let i = 0; i < total; i++) {
        const sourceFile = files[i];
        const normalizedPath = this.getNormalizedDeployPath(sourceFile);
        const buffer = await sourceFile.arrayBuffer();
        const virtualFile = new File([buffer], sourceFile.name, {
            type: sourceFile.type || 'application/octet-stream',
            lastModified: sourceFile.lastModified || Date.now()
        });

        try {
            Object.defineProperty(virtualFile, 'path', { value: normalizedPath });
        } catch (_) {}

        try {
            Object.defineProperty(virtualFile, 'webkitRelativePath', { value: normalizedPath });
        } catch (_) {}

        inMemoryFiles.push(virtualFile);

        const percent = 35 + Math.round(((i + 1) / total) * 15);
        onProgress?.({ label: `Bundling files in memory (${i + 1}/${total})`, percent });
    }

    this.log(`Prepared in-memory deploy bundle with ${inMemoryFiles.length} files`);
    return inMemoryFiles;
}

export function showUploadProgress(message) {
    const progressEl = document.getElementById('upload-progress');
    const textEl = document.getElementById('upload-progress-text');
    const resultEl = document.getElementById('upload-result');

    if (progressEl) {
        progressEl.classList.remove('hidden');
    }
    if (textEl) {
        textEl.textContent = message;
    }
    if (resultEl) {
        resultEl.classList.add('hidden');
    }
}

export function attachSignatureExtensionToTorrent(torrent, signedMeta) {
    if (!torrent || !signedMeta || !signedMeta.signature) return

    const SignatureExt = createBep10SignatureExtension(signedMeta, (receivedMeta) => {
        this.log(`[BEP10/sig] Received sig_announce from peer: publisher=${receivedMeta.publisher}, verified=pending`)
    })

    torrent.on('wire', (wire) => {
        wire.use(SignatureExt)
    })

    // Aplică și pe wire-urile deja existente (dacă torrentul e deja seeded)
    if (Array.isArray(torrent.wires)) {
        torrent.wires.forEach((wire) => {
            try { wire.use(SignatureExt) } catch (_) {}
        })
    }

    this.log(`[BEP10/sig] Signature extension attached to torrent ${signedMeta.torrentHash?.slice(0, 8)}`)
}

export function hideUploadProgress() {
    const progressEl = document.getElementById('upload-progress');
    if (progressEl) {
        progressEl.classList.add('hidden');
    }
}

export function showUploadResult(hash, torrentFile, torrent) {
    // Sanitize hash before displaying
    const sanitizedHash = this.sanitizeHash(hash);
    const url = `${window.location.origin}${window.location.pathname}?orc=${sanitizedHash}`;
    this.lastPublishCandidate = {
        hash: sanitizedHash,
        siteName: torrent?.name || 'website'
    };

    const hashEl = document.getElementById('result-hash');
    const urlEl = document.getElementById('result-url');
    const resultEl = document.getElementById('upload-result');

    if (hashEl) {
        hashEl.textContent = sanitizedHash;
    }
    if (urlEl) {
        urlEl.textContent = url;
    }

    if (torrentFile) {
        const downloadLink = /** @type {HTMLAnchorElement} */ (document.getElementById('download-torrent-file'));
        if (downloadLink) {
            // Revoke previous URL if exists
            if (downloadLink.href && downloadLink.href.startsWith('blob:')) {
                URL.revokeObjectURL(downloadLink.href);
            }
            downloadLink.href = this.createTrackedObjectURL(new Blob([torrentFile]));
            downloadLink.download = `website-${sanitizedHash.substring(0, 8)}.torrent`;
            downloadLink.style.display = 'inline-flex';
        }
    } else {
        const downloadLink = document.getElementById('download-torrent-file');
        if (downloadLink) {
            downloadLink.style.display = 'none';
        }
    }

    if (resultEl) {
        resultEl.classList.remove('hidden');
    }

    // Update seeding stats if available
    if (torrent) {
        this.updateSeedingStats(torrent);
    }
}

export function updateSeedingStats(torrent) {
    torrent.on('upload', () => {
        this.log(`Uploaded: ${this.formatBytes(torrent.uploaded)} to ${torrent.numPeers} peers`);
    });
}

export function downloadDesktopClient(os) {
    // Desktop clients are under development
    // TODO: Update URLs when desktop clients are released
    const osNames = {
        windows: 'Windows',
        mac: 'macOS',
        linux: 'Linux'
    };

    const osName = osNames[os] || os;
    this.log(`Desktop client requested for ${osName}`);
    alert(
        `🚀 PeerWeb Desktop for ${osName} - Coming Soon!\n\nDesktop clients are currently under development.\n\n💡 In the meantime:\n• Keep this browser tab open to continue hosting\n• Bookmark this page for easy access\n• Your site will remain active as long as this tab is open`
    );
}
