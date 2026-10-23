// @ts-check
/**
 * Wires the WebLLM tab together: controller, panel, inference worker and the
 * WebLLM service worker. Loaded on demand by `WebLLMTab.js` the first time the
 * tab is opened, so none of this is fetched or run during start-up.
 */

import { WebLLMController } from './WebLLMController.js';
import { createEngineClient } from './WebLLMEngineClient.js';
import { createWebLLMServiceWorkerClient } from './WebLLMServiceWorkerClient.js';
import { detectWebGPU } from './webgpuSupport.js';
import { resolveWebLLMProfile } from './webllmConfig.js';
import { bindWebLLMPanel } from '../ui/webllm/WebLLMPanel.js';

/** @param {{ log?: (message: string) => void }} [options] */
export function createWebLLMApp({ log = (message) => console.debug(`[WebLLM] ${message}`) } = {}) {
    /** @type {(state: any, change?: any) => void} */
    let render = () => {};
    const nav = /** @type {any} */ (navigator);

    const controller = new WebLLMController({
        detectWebGPU: () => detectWebGPU(),
        swClient: createWebLLMServiceWorkerClient({ log }),
        createEngine: () => createEngineClient(),
        storage: nav.storage || null,
        locks: nav.locks || null,
        onChange: (state, change) => render(state, change),
        log,
        // Desktop or mobile memory profile, decided once per page.
        profile: resolveWebLLMProfile()
    });

    render = bindWebLLMPanel(controller);
    render(controller.state);
    return controller;
}
