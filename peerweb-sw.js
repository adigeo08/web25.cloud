/// <reference path="./types.d.ts" />
// @ts-check

// Service Worker Version
const SW_VERSION = 'v1.0.0';
const CACHE_NAME = `peerweb-cache-${SW_VERSION}`;

console.log(`[PeerWeb SW] Service worker loading... Version: ${SW_VERSION}`);

// Clean up old caches on activation
const cleanupOldCaches = async () => {
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter((name) => name.startsWith('peerweb-cache-') && name !== CACHE_NAME);
    await Promise.all(oldCaches.map((cache) => caches.delete(cache)));
    console.log(`[PeerWeb SW] Cleaned up ${oldCaches.length} old cache(s)`);
};

/** @type {string | null} */
let currentSiteHash = null;
/** @type {string | null} */
let currentEntryFile = null;
/** @type {Set<string>} */
let currentSiteFiles = new Set();
/** @type {Map<string, any>} */
const pendingRequests = new Map();
/** @type {Map<string, {data: Uint8Array, contentType: string, length: number}>} */
const mediaCache = new Map(); // Cache for media files
const MEDIA_CACHE_MAX_BYTES = 300 * 1024 * 1024;
let mediaCacheTotalBytes = 0;

// Listen for messages from main thread
self.addEventListener('message', (event) => {
    const { type, ...data } = event.data;

    console.log('[PeerWeb SW] Received message:', type, data);

    switch (type) {
        case 'SKIP_WAITING':
            /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self)).skipWaiting();
            break;

        case 'SITE_LOADING':
            currentSiteHash = data.hash;
            currentEntryFile = null;
            currentSiteFiles.clear();
            mediaCache.clear(); // Clear media cache when loading new site
            mediaCacheTotalBytes = 0;
            console.log('[PeerWeb SW] Site loading:', currentSiteHash);
            break;

        case 'SITE_READY':
            currentSiteHash = data.hash;
            currentEntryFile = data.entryFile || null;
            if (data.fileList) {
                currentSiteFiles = new Set(data.fileList);
                console.log('[PeerWeb SW] Site ready with files:', data.fileList);
            }
            console.log('[PeerWeb SW] Site ready:', currentSiteHash, 'Files:', data.fileCount);
            break;

        case 'SITE_UNLOADED':
            currentSiteHash = null;
            currentEntryFile = null;
            currentSiteFiles.clear();
            mediaCache.clear();
            mediaCacheTotalBytes = 0;
            pendingRequests.clear();
            console.log('[PeerWeb SW] Site unloaded');
            break;

        case 'RESOURCE_RESPONSE':
            handleResourceResponse(data);
            break;

        case 'MEDIA_CHUNK_RESPONSE':
            handleMediaChunkResponse(data);
            break;
    }

    if (data.__ackId && event.source) {
        event.source.postMessage({ type: 'ACK', ackId: data.__ackId });
    }
});

function handleResourceResponse(data) {
    const { requestId, url, data: fileData, contentType } = data;

    console.log(
        '[PeerWeb SW] Resource response:',
        requestId,
        url,
        contentType,
        fileData
            ? `${fileData.byteLength || fileData.length || 0} bytes`
            : 'NO DATA'
    );

    const pendingRequest = pendingRequests.get(requestId);
    if (pendingRequest) {
        pendingRequests.delete(requestId);

        if (fileData) {
            let uint8Array = null;
            if (fileData instanceof ArrayBuffer) {
                uint8Array = new Uint8Array(fileData);
            } else if (ArrayBuffer.isView(fileData)) {
                uint8Array = new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength);
            } else if (Array.isArray(fileData)) {
                uint8Array = new Uint8Array(fileData);
            }

            if (!uint8Array) {
                pendingRequest.resolve(new Response('File not found in torrent', { status: 404, statusText: 'Not Found' }));
                return;
            }

            // Compatibility: existing clients may expect 200 for empty files.
            if (uint8Array.length === 0) {
                pendingRequest.resolve(
                    new Response(new Blob([Uint8Array.from(uint8Array)]), {
                        status: 200,
                        statusText: 'OK',
                        headers: {
                            'Content-Type': contentType || 'application/octet-stream',
                            'Content-Length': '0'
                        }
                    })
                );
                return;
            }

            // Check if this is a media file
            if (isMediaFile(contentType) && uint8Array.length > 1024 * 100) {
                // > 100KB
                // Cache media file for range requests
                cacheMediaFile(url, {
                    data: uint8Array,
                    contentType: contentType,
                    length: uint8Array.length
                });
                console.log('[PeerWeb SW] Cached media file:', url, uint8Array.length, 'bytes');
            }

            const response = createMediaResponse(uint8Array, contentType, pendingRequest.range);
            console.log('[PeerWeb SW] Serving file:', uint8Array.length, 'bytes');
            pendingRequest.resolve(response);
        } else {
            // File not found
            console.log('[PeerWeb SW] File not found, returning 404');
            const response = new Response('File not found in torrent', {
                status: 404,
                statusText: 'Not Found',
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
            pendingRequest.resolve(response);
        }
    } else {
        console.log('[PeerWeb SW] No pending request found for:', requestId);
    }
}

function handleMediaChunkResponse(data) {
    const { requestId, chunk, start, end, total } = data;

    const pendingRequest = pendingRequests.get(requestId);
    if (pendingRequest) {
        pendingRequests.delete(requestId);

        if (chunk && chunk.length > 0) {
            const uint8Array = new Uint8Array(chunk);
            const response = new Response(new Blob([Uint8Array.from(uint8Array)]), {
                status: 206,
                statusText: 'Partial Content',
                headers: {
                    'Content-Type': pendingRequest.contentType || 'application/octet-stream',
                    'Content-Length': uint8Array.length.toString(),
                    'Content-Range': `bytes ${start}-${end}/${total}`,
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'public, max-age=31536000'
                }
            });

            console.log('[PeerWeb SW] Serving media chunk:', start, '-', end, '/', total);
            pendingRequest.resolve(response);
        } else {
            pendingRequest.resolve(new Response('Chunk not available', { status: 416 }));
        }
    }
}

function isMediaFile(contentType) {
    if (!contentType) {
        return false;
    }
    return contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType === 'image/gif';
}

function isMediaPath(filePath) {
    if (!filePath) return false;
    const lower = filePath.toLowerCase();
    return (
        lower.endsWith('.mp4') ||
        lower.endsWith('.webm') ||
        lower.endsWith('.mkv') ||
        lower.endsWith('.mp3') ||
        lower.endsWith('.wav') ||
        lower.endsWith('.ogg') ||
        lower.endsWith('.m4a') ||
        lower.endsWith('.gif')
    );
}

function cacheMediaFile(url, entry) {
    const incomingSize = entry.length || 0;
    if (incomingSize <= 0) return;

    if (incomingSize > MEDIA_CACHE_MAX_BYTES) {
        console.warn('[PeerWeb SW] Media caching refused (file exceeds cache max):', url, incomingSize);
        return;
    }

    if (mediaCache.has(url)) {
        const previous = mediaCache.get(url);
        mediaCacheTotalBytes -= previous?.length || 0;
        mediaCache.delete(url);
    }

    while (mediaCacheTotalBytes + incomingSize > MEDIA_CACHE_MAX_BYTES && mediaCache.size > 0) {
        const oldestKey = mediaCache.keys().next().value;
        const oldestEntry = mediaCache.get(oldestKey);
        mediaCache.delete(oldestKey);
        mediaCacheTotalBytes -= oldestEntry?.length || 0;
        console.warn('[PeerWeb SW] Media cache eviction:', oldestKey, oldestEntry?.length || 0);
    }

    if (mediaCacheTotalBytes + incomingSize > MEDIA_CACHE_MAX_BYTES) {
        console.warn('[PeerWeb SW] Media caching refused (insufficient space):', url, incomingSize);
        return;
    }

    mediaCache.set(url, entry);
    mediaCacheTotalBytes += incomingSize;
}

function createMediaResponse(uint8Array, contentType, range) {
    if (!range || !isMediaFile(contentType)) {
        // Regular response for non-media files or no range request
        return new Response(new Blob([Uint8Array.from(uint8Array)]), {
            status: 200,
            statusText: 'OK',
            headers: {
                'Content-Type': contentType || 'application/octet-stream',
                'Content-Length': uint8Array.length.toString(),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=31536000',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }

    // Handle range request for media files
    const { start, end } = range;
    const chunkSize = end - start + 1;
    const chunk = uint8Array.slice(start, end + 1);

    return new Response(new Blob([Uint8Array.from(chunk)]), {
        status: 206,
        statusText: 'Partial Content',
        headers: {
            'Content-Type': contentType,
            'Content-Length': chunkSize.toString(),
            'Content-Range': `bytes ${start}-${end}/${uint8Array.length}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=31536000',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

function parseRangeHeader(rangeHeader, fileSize) {
    if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
        return null;
    }

    const range = rangeHeader.substring(6);
    const parts = range.split('-');

    let start = parseInt(parts[0]) || 0;
    let end = parseInt(parts[1]) || fileSize - 1;

    // Ensure valid range
    start = Math.max(0, Math.min(start, fileSize - 1));
    end = Math.max(start, Math.min(end, fileSize - 1));

    return { start, end };
}

// Helper function to check if URL is external
function isExternalUrl(url) {
    try {
        const urlObj = new URL(url);

        // Check for external protocols
        if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
            // If it has a different origin than the current request, it's external
            return urlObj.origin !== self.location.origin;
        }

        // Other protocols (mailto:, tel:, etc.) are external
        if (urlObj.protocol !== 'blob:' && urlObj.protocol !== 'data:') {
            return true;
        }

        return false;
    } catch (e) {
        // If URL parsing fails, assume it's a relative URL (internal)
        return false;
    }
}

// Helper function to check if this is a PeerWeb internal resource
function isPeerWebInternalResource(url) {
    try {
        const urlObj = new URL(url);

        // Only handle PeerWeb site paths - intercept all /peerweb-site/ URLs
        // We'll check the hash later in handlePeerWebRequest
        return urlObj.pathname.startsWith('/peerweb-site/');
    } catch (e) {
        return false;
    }
}

// Intercept fetch requests
/**
 * @param {FetchEvent} event
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    console.log('[PeerWeb SW] Fetch request:', url.href);

    // Let external URLs pass through without interception
    if (isExternalUrl(event.request.url)) {
        console.log('[PeerWeb SW] External URL, passing through:', event.request.url);
        return; // Don't call event.respondWith(), let it pass through normally
    }

    // Only handle PeerWeb internal resources
    if (isPeerWebInternalResource(event.request.url)) {
        console.log('[PeerWeb SW] Intercepting PeerWeb internal resource:', url.pathname);
        event.respondWith(handlePeerWebRequest(event.request));
        return;
    }

    // Let all other requests pass through normally
    console.log('[PeerWeb SW] Non-PeerWeb request, passing through:', event.request.url);
});

async function handlePeerWebRequest(request) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/').filter((part) => part.length > 0);

    console.log('[PeerWeb SW] Path parts:', pathParts);

    // URL format: /peerweb-site/{hash}/{file-path}
    if (pathParts.length < 2 || pathParts[0] !== 'peerweb-site') {
        console.log('[PeerWeb SW] Invalid PeerWeb URL format');
        return new Response('Invalid PeerWeb URL', { status: 400 });
    }

    const hash = pathParts[1];
    let filePath = pathParts.slice(2).join('/');

    console.log('[PeerWeb SW] Requesting file:', filePath, 'for hash:', hash);
    console.log('[PeerWeb SW] Current site hash:', currentSiteHash);

    // If site is not loaded yet, wait for it
    if (!currentSiteHash) {
        console.log('[PeerWeb SW] Site not ready yet, waiting...');
        
        // Dynamic wait time: start with 30 seconds, can be extended
        // We give more time for larger sites to initialize
        const baseWait = 30000; // 30 seconds base
        const maxWait = 120000; // Maximum 2 minutes
        
        const startTime = Date.now();
        let waitTime = baseWait;
        
        while (!currentSiteHash && (Date.now() - startTime) < maxWait) {
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms
            
            // Log progress every 5 seconds
            const elapsed = Date.now() - startTime;
            if (elapsed % 5000 < 100) {
                console.log(`[PeerWeb SW] Still waiting for site... (${(elapsed / 1000).toFixed(0)}s elapsed)`);
            }
        }
        
        if (!currentSiteHash) {
            console.log('[PeerWeb SW] Timeout waiting for site to load');
            return new Response('Site not loaded - timeout. The site may be too large or downloading slowly.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain' }
            });
        }
        
        console.log('[PeerWeb SW] Site now ready:', currentSiteHash);
    }

    // Check if this is the current site
    if (hash !== currentSiteHash) {
        console.log('[PeerWeb SW] Hash mismatch - wrong site');
        return new Response(`Wrong site loaded. Expected: ${currentSiteHash}, Got: ${hash}`, {
            status: 404,
            headers: { 'Content-Type': 'text/plain' }
        });
    }

    // Handle different navigation scenarios
    filePath = normalizeFilePath(filePath, url);

    console.log('[PeerWeb SW] Normalized file path:', filePath);

    // Check if this is a cached media file and handle range requests
    const cachedMedia = mediaCache.get(request.url);
    if (cachedMedia) {
        console.log('[PeerWeb SW] Found cached media file');
        const rangeHeader = request.headers.get('Range');

        if (rangeHeader) {
            console.log('[PeerWeb SW] Range request for media:', rangeHeader);
            const range = parseRangeHeader(rangeHeader, cachedMedia.length);
            if (range) {
                return createMediaResponse(cachedMedia.data, cachedMedia.contentType, range);
            }
        }

        // Return full media file if no range requested
        return createMediaResponse(cachedMedia.data, cachedMedia.contentType, null);
    }

    // Parse range header for new requests
    const rangeHeader = request.headers.get('Range');
    const range = null;
    if (rangeHeader) {
        console.log('[PeerWeb SW] Range request detected:', rangeHeader);
        // We'll need the file size first, so we'll handle this in the response
    }

    // Request the resource from main thread
    return requestResourceFromMainThread(request.url, filePath, range);
}

function normalizeFilePath(filePath, url) {
    // If no file path or it's empty, use the known entry file (or fall back to index.html)
    if (!filePath || filePath === '') {
        const entry = currentEntryFile || 'index.html';
        console.log('[PeerWeb SW] Empty path, defaulting to', entry);
        return entry;
    }

    // If path ends with /, append index.html
    if (filePath.endsWith('/')) {
        console.log('[PeerWeb SW] Directory path, appending index.html');
        return filePath + 'index.html';
    }

    // If path has no extension and doesn't exist as-is, try common variations
    if (!filePath.includes('.')) {
        console.log('[PeerWeb SW] Path without extension, trying variations');

        // Try as directory first
        const dirPath = filePath + '/index.html';
        if (currentSiteFiles.has(dirPath)) {
            console.log('[PeerWeb SW] Found as directory:', dirPath);
            return dirPath;
        }

        // Try with .html extension
        const htmlPath = filePath + '.html';
        if (currentSiteFiles.has(htmlPath)) {
            console.log('[PeerWeb SW] Found with .html extension:', htmlPath);
            return htmlPath;
        }

        // Try as index in subdirectory
        const indexPath = filePath + '/index.html';
        console.log('[PeerWeb SW] Trying as subdirectory index:', indexPath);
        return indexPath;
    }

    // Handle query parameters and fragments - remove them for file lookup
    if (url.search || url.hash) {
        console.log('[PeerWeb SW] Removing query/fragment from path');
        const cleanPath = filePath.split('?')[0].split('#')[0];
        return cleanPath;
    }

    return filePath;
}

async function requestResourceFromMainThread(requestUrl, filePath, range) {
    const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    console.log('[PeerWeb SW] Creating request:', requestId, 'for file:', filePath);

    return new Promise((resolve) => {
        // Store the resolve function with range info
        pendingRequests.set(requestId, {
            resolve,
            timestamp: Date.now(),
            range: range
        });

        console.log('[PeerWeb SW] Stored pending request:', requestId);

        // Request the resource from the main PeerWeb page (not iframe)
        /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self)).clients
            .matchAll({ type: 'window' })
            .then((clients) => {
                console.log('[PeerWeb SW] Found clients:', clients.length);

                // Filter to find the main PeerWeb page (not an iframe with /peerweb-site/ in URL)
                const mainClients = clients.filter(client => {
                    return client.url && !client.url.includes('/peerweb-site/');
                });
                
                console.log('[PeerWeb SW] Main (non-iframe) clients:', mainClients.length);

                if (mainClients.length > 0) {
                    // Send to the main PeerWeb page
                    mainClients[0].postMessage({
                        type: 'RESOURCE_REQUEST',
                        url: requestUrl,
                        filePath: filePath,
                        requestId: requestId,
                        range: range
                    });
                    console.log('[PeerWeb SW] Sent request to main client for:', filePath);
                } else if (clients.length > 0) {
                    // Fallback: try any client
                    console.log('[PeerWeb SW] No main client found, trying first available client');
                    clients[0].postMessage({
                        type: 'RESOURCE_REQUEST',
                        url: requestUrl,
                        filePath: filePath,
                        requestId: requestId,
                        range: range
                    });
                } else {
                    console.log('[PeerWeb SW] No clients found');
                    pendingRequests.delete(requestId);
                    resolve(createNavigationFallback(filePath));
                }
            })
            .catch((error) => {
                console.error('[PeerWeb SW] Error getting clients:', error);
                pendingRequests.delete(requestId);
                resolve(createNavigationFallback(filePath));
            });

        // Timeout after 30 seconds for media files, 15 for others
        const timeout = isMediaPath(filePath) ? 30000 : 15000;
        setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.delete(requestId);
                console.log('[PeerWeb SW] Request timeout:', requestId);
                resolve(createNavigationFallback(filePath));
            }
        }, timeout);
    });
}

function createNavigationFallback(filePath) {
    console.log('[PeerWeb SW] Creating navigation fallback for:', filePath);

    // For media files, return a more specific error
    if (isMediaFile(filePath)) {
        return new Response('Media file not available', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: {
                'Content-Type': 'text/plain',
                'Retry-After': '5'
            }
        });
    }

    // Create a simple fallback page that tries to redirect to index.html
    const fallbackHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>PeerWeb Navigation</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
            }
            .container {
                text-align: center;
                padding: 2rem;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 15px;
                backdrop-filter: blur(10px);
            }
            .spinner {
                width: 50px;
                height: 50px;
                border: 4px solid rgba(255, 255, 255, 0.3);
                border-top: 4px solid white;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto 1rem;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            .retry-btn {
                background: white;
                color: #667eea;
                border: none;
                padding: 0.75rem 1.5rem;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 500;
                margin-top: 1rem;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="spinner"></div>
            <h2>🪐 PeerWeb Navigation</h2>
            <p>Redirecting to home page...</p>
            <p><small>Requested: ${filePath}</small></p>
            <button class="retry-btn" onclick="goHome()">Go to Home</button>
        </div>
        <script>
            function goHome() {
                const currentPath = window.location.pathname;
                const pathParts = currentPath.split('/');
                if (pathParts.length >= 3) {
                    const baseUrl = '/' + pathParts.slice(1, 3).join('/') + '/';
                    window.location.href = baseUrl;
                } else {
                    window.location.reload();
                }
            }
            
            setTimeout(() => {
                goHome();
            }, 3000);
        </script>
    </body>
    </html>
    `;

    return new Response(fallbackHtml, {
        status: 200,
        statusText: 'OK',
        headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'no-cache'
        }
    });
}

// Service worker installation
/**
 * @param {ExtendableEvent} _event
 */
self.addEventListener('install', (_event) => {
    console.log('[PeerWeb SW] Installing...');
    /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self)).skipWaiting();
});

/**
 * @param {ExtendableEvent} event
 */
self.addEventListener('activate', (event) => {
    console.log('[PeerWeb SW] Activating...');
    event.waitUntil(
        Promise.all([
            /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self)).clients.claim(),
            cleanupOldCaches()
        ]).then(() => {
            console.log('[PeerWeb SW] Claimed all clients and cleaned up old caches');
        })
    );
});

console.log('[PeerWeb SW] Service worker loaded and ready');

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseRangeHeader,
        createMediaResponse,
        isMediaPath
    };
}
