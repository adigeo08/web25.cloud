// @ts-check

export function showLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
    }
}

export function hideLoadingOverlay() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}

export function updateProgress(torrent) {
    const progress = Math.round(torrent.progress * 100);
    const progressBar = document.getElementById('loading-progress-bar');
    const progressText = document.getElementById('loading-progress-text');

    // Show more detailed progress when near completion
    let displayProgress = progress;
    let statusText = `Downloading: ${progress}%`;

    if (progress >= 95 && progress < 100) {
        // Show file-level progress when stuck at high percentage
        const completedFiles = torrent.files.filter((f) => f.progress >= 0.9).length;
        const totalFiles = torrent.files.length;
        statusText = `Processing files: ${completedFiles}/${totalFiles} ready`;

        // Calculate a more realistic progress based on file availability
        // Prevent division by zero
        displayProgress = totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 100;
    } else if (progress === 100) {
        statusText = 'Download complete!';
    }

    if (progressBar) {
        progressBar.style.width = `${displayProgress}%`;
    }
    if (progressText) {
        progressText.textContent = statusText;
    }

    // Debug panel progress
    if (this.debug) {
        const debugProgressBar = document.getElementById('progress-bar');
        const debugProgressText = document.getElementById('progress-text');
        if (debugProgressBar) {
            debugProgressBar.style.width = `${displayProgress}%`;
        }
        if (debugProgressText) {
            debugProgressText.textContent = `Progress: ${statusText}`;
        }
    }
}

export function updatePeerStats(torrent) {
    const peerStats = document.getElementById('peer-stats');

    // Calculate file completion stats
    const completedFiles = torrent.files.filter((f) => f.progress >= 0.9).length;
    const totalFiles = torrent.files.length;

    const stats = `Peers: ${torrent.numPeers} | Files: ${completedFiles}/${totalFiles} ready | Downloaded: ${this.formatBytes(torrent.downloaded)} | Speed: ${this.formatBytes(torrent.downloadSpeed)}/s`;

    if (peerStats) {
        peerStats.textContent = stats;
    }

    this.log(`Peer stats: ${stats}`);
}

export function formatBytes(bytes) {
    if (bytes === 0) {
        return '0 B';
    }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}