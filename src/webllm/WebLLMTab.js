// @ts-check
/**
 * The WebLLM tab's gate — the only WebLLM code loaded at start-up, and it
 * loads nothing else.
 *
 * `setupAuthAwareUi` tells it whether a signed-in identity exists; opening the
 * tab while one does imports the app (controller, panel, workers) for the
 * first time. Until then no library is fetched, no service worker registered,
 * no GPU adapter requested and no model touched.
 */

let allowed = false;
/**
 * Whose conversations the chat may open — the unlocked wallet's address — and
 * the Nostr address its project commits are authored by.
 */
let identity = { walletAddress: null, npub: null };
/** @type {Promise<any>|null} */
let app = null;

/** @param {() => Promise<any>} [loadApp] */
function openApp(loadApp = () => import('./WebLLMApp.js').then((module) => module.createWebLLMApp())) {
    if (!app) {
        app = loadApp().catch((error) => {
            app = null;
            throw error;
        });
    }
    return app;
}

/**
 * Hook the tab button. Idempotent.
 * @param {{ loadApp?: () => Promise<any> }} [options]
 */
export function installWebLLMTab({ loadApp } = {}) {
    const button = document.querySelector('.tab-btn[data-tab="webllm"]');
    if (!button || /** @type {any} */ (button).dataset?.webllmBound) return;
    /** @type {any} */ (button).dataset.webllmBound = '1';
    button.addEventListener('click', () => {
        if (!allowed) return;
        void openApp(loadApp)
            .then((controller) => {
                // Re-read: the wallet may have locked while the app loaded.
                controller.setAllowed(allowed, identity);
                return controller.activate();
            })
            .catch((error) => console.error('WebLLM could not start:', error));
    });
}

/**
 * Whether the signed-in-only WebLLM tab may be used, and by which wallet.
 * Turning it off locks the chat: the engine is released and the conversation
 * dropped from memory, while saved conversations and the downloaded model
 * stay for the next session of the same wallet.
 * @param {boolean} isAllowed
 * @param {{ walletAddress?: string|null, npub?: string|null }} [who]
 */
export function setWebLLMAccess(isAllowed, { walletAddress = null, npub = null } = {}) {
    allowed = Boolean(isAllowed);
    identity = { walletAddress: allowed ? walletAddress : null, npub: allowed ? npub : null };
    // Only an app that was already opened has anything to lock or unlock.
    void app?.then((controller) => controller.setAllowed(allowed, identity)).catch(() => {});
}

/** For tests: forget the loaded app and the gate. */
export function resetWebLLMTabForTests() {
    allowed = false;
    identity = { walletAddress: null, npub: null };
    app = null;
}
