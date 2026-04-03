// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';

export function handleFileSelection(event) {
    const target = /** @type {HTMLInputElement} */ (event.target);
    const files = target.files ? Array.from(target.files) : [];
    const fileList = document.getElementById('file-list');
    const createBtn = /** @type {HTMLButtonElement} */ (document.getElementById('create-torrent-btn'));

    if (fileList) {
        fileList.innerHTML = '<h4>Selected Files:</h4>';
        files.forEach((file) => {
            const div = document.createElement('div');
            div.textContent = file.webkitRelativePath || file.name;
            fileList.appendChild(div);
        });
    }

    if (createBtn) {
        createBtn.disabled = files.length === 0;
    }
}

export function createTorrent() {
    const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
    if (!fileInput || !fileInput.files) {
        this.toast.warning('Please select files first.', '⚠️ No Files Selected');
        return;
    }

    const files = Array.from(fileInput.files);

    if (files.length === 0) {
        this.toast.warning('Please select files first.', '⚠️ No Files Selected');
        return;
    }

    if (!this.clientReady || !this.client) {
        this.toast.warning('WebTorrent client not ready. Please wait a moment and try again.', '⚠️ Client Not Ready');
        return;
    }

    // Check for index.html
    const hasIndex = files.some((file) =>
        (file.webkitRelativePath || file.name).toLowerCase().includes('index.html')
    );

    if (!hasIndex) {
        if (!confirm('No index.html found. Continue anyway? (Site may not load properly)')) {
            return;
        }
    }

    this.log(`Creating torrent with ${files.length} files...`);

    // Show progress
    const createBtn = /** @type {HTMLButtonElement} */ (document.getElementById('create-torrent-btn'));
    const originalText = createBtn ? createBtn.textContent : '';
    if (createBtn) {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating Torrent...';
    }

    try {
        // Create torrent with proper options
        this.client.seed(
            files,
            {
                announce: this.trackers,
                name: this.generateTorrentName(files),
                comment: 'Created with PeerWeb - Decentralized Website Hosting',
                createdBy: 'PeerWeb v1.0',
                private: false, // Make it a public torrent
                pieceLength: this.calculateOptimalPieceLength(files)
            },
            (torrent) => {
                this.log(`Torrent created successfully: ${torrent.infoHash}`);
                this.log(`Torrent name: ${torrent.name}`);
                this.log(`Files: ${torrent.files.length}`);

                // Reset button
                if (createBtn) {
                    createBtn.disabled = false;
                    createBtn.textContent = originalText;
                }

                // Show result in modal
                this.showTorrentCreationResult(torrent);
            }
        );
    } catch (error) {
        this.log(`Error creating torrent: ${error.message}`);
        console.error('Torrent creation error:', error);

        // Reset button
        if (createBtn) {
            createBtn.disabled = false;
            createBtn.textContent = originalText;
        }

        this.toast.error('Error creating torrent: ' + error.message, '❌ Torrent Creation Failed');
    }
}

export function generateTorrentName(files) {
    // Try to determine a good name from the files
    if (files.length === 1) {
        return files[0].name.replace(/\.[^/.]+$/, ''); // Remove extension
    }

    // Look for common base path
    const paths = files.map((f) => f.webkitRelativePath || f.name);
    if (paths.length > 0 && paths[0].includes('/')) {
        const basePath = paths[0].split('/')[0];
        if (paths.every((path) => path.startsWith(basePath))) {
            return basePath;
        }
    }

    return `PeerWeb-Site-${Date.now()}`;
}

export function calculateOptimalPieceLength(files) {
    // Calculate total size
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    // Choose piece length based on total size
    if (totalSize < PEERWEB_CONFIG.PIECE_SIZE_THRESHOLD_16MB) {
        return PEERWEB_CONFIG.PIECE_SIZE_16KB;
    } else if (totalSize < PEERWEB_CONFIG.PIECE_SIZE_THRESHOLD_256MB) {
        return PEERWEB_CONFIG.PIECE_SIZE_32KB;
    } else if (totalSize < PEERWEB_CONFIG.PIECE_SIZE_THRESHOLD_1GB) {
        return PEERWEB_CONFIG.PIECE_SIZE_256KB;
    } else {
        return PEERWEB_CONFIG.PIECE_SIZE_1MB;
    }
}

export function showTorrentCreationResult(torrent) {
    // Show result in the modal
    const resultDiv = document.getElementById('torrent-result');
    const hashSpan = document.getElementById('created-hash');
    const urlSpan = document.getElementById('created-url');
    const downloadLink = document.getElementById('download-torrent');

    // Sanitize hash before displaying
    const sanitizedHash = this.sanitizeHash(torrent.infoHash);
    const url = `${window.location.origin}${window.location.pathname}?orc=${sanitizedHash}`;

    if (hashSpan) {
        hashSpan.textContent = sanitizedHash;
    }
    if (urlSpan) {
        urlSpan.textContent = url;
    }

    // Create proper torrent file download
    const downloadLinkElement = /** @type {HTMLAnchorElement} */ (downloadLink);
    if (downloadLinkElement && torrent.torrentFile) {
        try {
            // Revoke previous URL if exists
            if (downloadLinkElement.href && downloadLinkElement.href.startsWith('blob:')) {
                URL.revokeObjectURL(downloadLinkElement.href);
            }
            const blob = new Blob([torrent.torrentFile], {
                type: 'application/x-bittorrent'
            });
            const downloadUrl = this.createTrackedObjectURL(blob);
            downloadLinkElement.href = downloadUrl;
            downloadLinkElement.download = `${torrent.name || 'website'}.torrent`;
            downloadLinkElement.style.display = 'inline-flex';

            const fileSize =
                torrent.torrentFile instanceof ArrayBuffer
                    ? torrent.torrentFile.byteLength
                    : torrent.torrentFile.length;
            this.log(`Torrent file created: ${fileSize} bytes`);
        } catch (error) {
            this.log(`Error creating torrent file download: ${error.message}`);
            downloadLinkElement.style.display = 'none';
        }
    }

    if (resultDiv) {
        resultDiv.classList.remove('hidden');
    }
}

export function showTorrentModal() {
    const modal = document.getElementById('torrent-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

export function hideTorrentModal() {
    const modal = document.getElementById('torrent-modal');
    if (modal) {
        modal.classList.add('hidden');
    }

    // Reset modal
    const fileInput = /** @type {HTMLInputElement} */ (document.getElementById('file-input'));
    const fileList = document.getElementById('file-list');
    const createBtn = /** @type {HTMLButtonElement} */ (document.getElementById('create-torrent-btn'));
    const result = document.getElementById('torrent-result');

    if (fileInput) {
        fileInput.value = '';
    }
    if (fileList) {
        fileList.innerHTML = '';
    }
    if (createBtn) {
        createBtn.disabled = true;
    }
    if (result) {
        result.classList.add('hidden');
    }
}