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
import { openWebLLMHistory } from './webllmHistoryStore.js';
import { openWebLLMThoughts } from './webllmThoughtStore.js';
import { loadIdbVector } from './idbVectorLoader.js';
import { createMcpClient } from './mdnMcpClient.js';
import { WebLLMProject } from './chatProject.js';
import { bindWebLLMPanel } from '../ui/webllm/WebLLMPanel.js';
import { bindWebLLMWorkbench } from '../ui/webllm/WebLLMWorkbench.js';

/** @param {{ log?: (message: string) => void }} [options] */
export function createWebLLMApp({ log = (message) => console.debug(`[WebLLM] ${message}`) } = {}) {
    /** @type {(state: any, change?: any) => void} */
    let render = () => {};
    /** @type {WebLLMProject|null} */
    let project = null;
    const nav = /** @type {any} */ (navigator);

    const controller = new WebLLMController({
        detectWebGPU: () => detectWebGPU(),
        swClient: createWebLLMServiceWorkerClient({ log }),
        // In the worker where it has the GPU, on the page where it does not; remembered.
        createEngine: (options) => createEngineClient(options),
        storage: nav.storage || null,
        locks: nav.locks || null,
        onChange: (state, change) => {
            render(state, change);
            project?.handle(state, change);
        },
        log,
        // Desktop or mobile memory profile, decided once per page.
        profile: resolveWebLLMProfile(),
        // Conversations, saved per wallet in this browser.
        openHistory: (walletAddress) => openWebLLMHistory({ walletAddress }),
        // The sequence thinker's thoughts, per wallet, recalled by similarity
        // through idb-vector (verified from jsDelivr). All on the CPU.
        openThoughts: (walletAddress) =>
            openWebLLMThoughts({
                walletAddress,
                vectors: async (dbName) => {
                    try {
                        const VectorDB = await loadIdbVector();
                        return new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
                    } catch (error) {
                        log(`Thought recall by similarity unavailable: ${error?.message || error}`);
                        return null;
                    }
                }
            }),
        // MDN's public MCP server, contacted only for development questions.
        mdnClient: createMcpClient()
    });

    // The open conversation's code, as files in a git repository in OPFS: the
    // Project panel that organises them and the canvas that previews and
    // edits them (see WebLLMWorkbench.js).
    /** @type {(state: any) => void} */
    let renderProject = () => {};
    let projectAvailable = false;
    project = new WebLLMProject({
        controller,
        log,
        onChange: (state) => {
            renderProject(state);
            // Code blocks get their file controls once OPFS is known to work.
            if (state.available !== projectAvailable) {
                projectAvailable = state.available;
                render(controller.state);
            }
        }
    });

    /** @type {ReturnType<typeof bindWebLLMWorkbench>|null} */
    let workbench = null;
    const panel = bindWebLLMPanel(controller, {
        project,
        onOpenCanvas: (snippet) => void workbench?.openSnippet(snippet)
    });
    render = panel;
    workbench = bindWebLLMWorkbench({ project, controller, sidebar: panel.sidebar });
    renderProject = workbench.renderProject;
    render(controller.state);
    renderProject(project.state);
    // A tab closed mid-reply keeps what was written, marked as interrupted.
    globalThis.addEventListener?.('pagehide', () => controller.saveInterruptedReply());
    return controller;
}
