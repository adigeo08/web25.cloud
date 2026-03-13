// @ts-check

export function createTrackedObjectURL(blob) {
    const url = URL.createObjectURL(blob);
    this.objectURLs.push(url);
    this.log(`Created object URL (total: ${this.objectURLs.length})`);
    return url;
}

export function revokeAllObjectURLs() {
    this.objectURLs.forEach((url) => {
        try {
            URL.revokeObjectURL(url);
        } catch (e) {
            this.log(`Error revoking URL: ${e.message}`);
        }
    });
    this.log(`Revoked ${this.objectURLs.length} object URLs`);
    this.objectURLs = [];
}

export function createTimeout(callback, delay) {
    const timeoutId = setTimeout(() => {
        // Remove from tracked timeouts when it executes
        this.timeouts = this.timeouts.filter((id) => id !== timeoutId);
        callback();
    }, delay);
    this.timeouts.push(timeoutId);
    this.log(`Created timeout ${timeoutId} (total: ${this.timeouts.length})`);
    return timeoutId;
}

export function clearTrackedTimeout(timeoutId) {
    if (timeoutId) {
        clearTimeout(timeoutId);
        this.timeouts = this.timeouts.filter((id) => id !== timeoutId);
        this.log(`Cleared timeout ${timeoutId}`);
    }
}

export function clearAllTimeouts() {
    this.timeouts.forEach((timeoutId) => {
        try {
            clearTimeout(timeoutId);
        } catch (e) {
            this.log(`Error clearing timeout ${timeoutId}: ${e.message}`);
        }
    });
    this.log(`Cleared ${this.timeouts.length} timeouts`);
    this.timeouts = [];
}

export function setupCleanupHandlers() {
    window.addEventListener('beforeunload', () => {
        this.cleanup();
    });

    // Also cleanup on visibility change (tab backgrounded)
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            this.log('Page hidden, performing partial cleanup');
            // Don't cleanup everything, just reduce memory usage
        }
    });
}

export function cleanup() {
    this.log('Performing cleanup...');
    this.clearAllTimeouts();
    this.revokeAllObjectURLs();

    // Clear processing timeout specifically
    if (this.processingTimeout) {
        clearTimeout(this.processingTimeout);
        this.processingTimeout = null;
    }

    this.log('Cleanup complete');
}