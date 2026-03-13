// @ts-check

import { PEERWEB_CONFIG } from '../../config/peerweb.config.js';

export async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            // Only unregister PeerWeb-specific service worker if it exists
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (const registration of registrations) {
                // Check if this is our service worker by inspecting the script URL
                if (registration.active && registration.active.scriptURL.includes('peerweb-sw.js')) {
                    await registration.unregister();
                    this.log('Unregistered existing PeerWeb service worker');
                }
            }

            // Register new service worker with specific scope
            const registration = await navigator.serviceWorker.register('./peerweb-sw.js', {
                scope: '/'
            });
            this.log('Service Worker registered successfully');

            // Wait for service worker to be ready
            await navigator.serviceWorker.ready;
            this.serviceWorkerReady = true;
            this.log('Service Worker is ready');

            // Listen for messages from service worker
            // In setupEventListeners, update the service worker message listener:
            navigator.serviceWorker.addEventListener('message', (event) => {
                this.log(`SW Message: ${event.data.type}`);
                if (event.data.type === 'RESOURCE_REQUEST') {
                    this.handleServiceWorkerResourceRequest(
                        event.data.url,
                        event.data.requestId,
                        event.data.filePath // Use the normalized file path from SW
                    );
                }
            });

            // Force activation
            if (registration.waiting) {
                registration.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
        } catch (error) {
            this.log('Service Worker registration failed: ' + error.message);
            console.error('SW Error:', error);
        }
    } else {
        this.log('Service Workers not supported');
    }
}

export function handleServiceWorkerResourceRequest(url, requestId, providedFilePath = null) {
    this.log(`SW requesting: ${url} (ID: ${requestId})`);

    if (!this.currentSiteData) {
        this.log('No site data available');
        this.sendToServiceWorker('RESOURCE_RESPONSE', { requestId, url, data: null });
        return;
    }

    let filePath = providedFilePath;

    if (!filePath) {
        // Extract path from URL (fallback to old method)
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        filePath = pathParts.slice(3).join('/');
        if (!filePath || filePath === '') {
            filePath = 'index.html';
        }
    }

    this.log(`Looking for file: "${filePath}"`);

    const file = this.findFileInSiteData(filePath);
    if (file) {
        this.log(`Found file: ${filePath} (${file.size} bytes, ${file.type})`);

        // Convert ArrayBuffer to Array for structured cloning
        const dataArray = Array.from(new Uint8Array(file.content));

        this.sendToServiceWorker('RESOURCE_RESPONSE', {
            requestId,
            url,
            data: dataArray,
            contentType: file.type
        });
    } else {
        this.log(`File not found: ${filePath}`);
        this.log(`Available files: ${Object.keys(this.currentSiteData).join(', ')}`);
        this.sendToServiceWorker('RESOURCE_RESPONSE', { requestId, url, data: null });
    }
}

export async function sendToServiceWorker(type, data) {
    // Ensure we have a controller
    if (!navigator.serviceWorker.controller) {
        this.log('No SW controller, waiting for controller...');
        // Wait for controller to be available
        await this.waitForController();
    }

    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type, ...data });
        this.log(`Sent to SW: ${type}`);
    } else {
        this.log('ERROR: Still no SW controller available after waiting');
    }
}

export async function waitForController(timeout = null) {
    if (navigator.serviceWorker.controller) {
        return;
    }

    // Use dynamic timeout if not specified
    if (timeout === null) {
        timeout = this.calculateSWWaitTimeout();
        this.log(`Dynamic SW wait timeout: ${(timeout / 1000).toFixed(1)} seconds`);
    }

    return new Promise((resolve) => {
        const startTime = Date.now();
        
        // Listen for controllerchange event
        const handleControllerChange = () => {
            if (navigator.serviceWorker.controller) {
                this.log('SW controller changed and is now available');
                navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
                resolve();
            }
        };
        
        navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
        
        const checkController = () => {
            if (navigator.serviceWorker.controller) {
                this.log('SW controller is now available');
                navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
                resolve();
            } else if (Date.now() - startTime > timeout) {
                this.log('Timeout waiting for SW controller');
                navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
                
                // Check if there's a waiting worker and try to activate it
                navigator.serviceWorker.ready.then(registration => {
                    if (registration.waiting) {
                        this.log('Found waiting service worker, attempting to activate...');
                        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                        // Give it a moment to activate
                        setTimeout(() => {
                            if (navigator.serviceWorker.controller) {
                                this.log('Service worker activated successfully');
                            } else {
                                this.log('Service worker still not active, reloading page...');
                                // Last resort: reload the page
                                window.location.reload();
                            }
                            resolve();
                        }, 1000);
                    } else {
                        resolve(); // Resolve anyway to avoid blocking
                    }
                });
            } else {
                setTimeout(checkController, 100); // Check every 100ms
            }
        };
        checkController();
    });
}

export function calculateSWWaitTimeout() {
    if (this.currentTorrentSize === 0) {
        return PEERWEB_CONFIG.SW_WAIT_TIMEOUT_BASE;
    }
    
    const sizeMB = this.currentTorrentSize / (1024 * 1024);
    
    let timeout = PEERWEB_CONFIG.SW_WAIT_TIMEOUT_BASE;
    timeout += sizeMB * PEERWEB_CONFIG.SW_WAIT_TIMEOUT_PER_MB;
    
    // Clamp to min/max
    timeout = Math.max(PEERWEB_CONFIG.SW_WAIT_TIMEOUT_MIN, timeout);
    timeout = Math.min(PEERWEB_CONFIG.SW_WAIT_TIMEOUT_MAX, timeout);
    
    return Math.floor(timeout);
}