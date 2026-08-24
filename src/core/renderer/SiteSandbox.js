// @ts-check
/**
 * Parent-side controller for the sandboxed torrent-site frame.
 *
 * The frame runs in an opaque origin and talks to the application through one
 * MessagePort. Every inbound message is validated against the allowlist in
 * `SandboxBridgeProtocol.js` before it reaches any application code, and the
 * only data that ever flows back is the site's own bundle.
 */

import { buildSandboxBootstrapHtml } from './SandboxBootstrap.js';
import {
    isValidSandboxHandshake,
    SANDBOX_BRIDGE_OPS,
    SITE_SANDBOX_ATTRIBUTE,
    validateBridgeRequest
} from './SandboxBridgeProtocol.js';

function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Copy a stored file body into a fresh, transferable ArrayBuffer.
 * @param {any} content
 * @returns {ArrayBuffer | null}
 */
function toTransferableBuffer(content) {
    if (!content) return null;
    if (content instanceof ArrayBuffer) return content.slice(0);
    if (ArrayBuffer.isView(content)) {
        const view = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
        return view.slice().buffer;
    }
    if (Array.isArray(content)) return new Uint8Array(content).buffer;
    return null;
}

export default class SiteSandbox {
    /**
     * @param {{
     *   iframe: HTMLIFrameElement,
     *   hash: string,
     *   entryFile: string,
     *   entryHtml: string,
     *   resolveFile: (path: string) => ({ content: any, type?: string } | null),
     *   onTitle?: (title: string) => void,
     *   log?: (message: string) => void
     * }} options
     */
    constructor({ iframe, hash, entryFile, entryHtml, resolveFile, onTitle = null, log = null }) {
        this.iframe = iframe;
        this.hash = hash;
        this.entryFile = entryFile;
        this.entryHtml = entryHtml;
        this.resolveFile = resolveFile;
        this.onTitle = onTitle;
        this.log = log || (() => {});
        this.prefix = `/peerweb-site/${hash}/`;
        this.token = randomToken();
        /** @type {MessagePort | null} */
        this.port = null;
        this.destroyed = false;
        this._onWindowMessage = this._onWindowMessage.bind(this);
    }

    /** Install the bootstrap document and wait for the frame handshake. */
    start() {
        // Hard requirement of this boundary: no `allow-same-origin`.
        this.iframe.setAttribute('sandbox', SITE_SANDBOX_ATTRIBUTE);
        this.iframe.removeAttribute('src');

        window.addEventListener('message', this._onWindowMessage);

        this.iframe.srcdoc = buildSandboxBootstrapHtml({
            token: this.token,
            parentOrigin: window.location.origin,
            prefix: this.prefix
        });
    }

    destroy() {
        this.destroyed = true;
        window.removeEventListener('message', this._onWindowMessage);
        if (this.port) {
            this.port.onmessage = null;
            this.port.close();
            this.port = null;
        }
        this.iframe.removeAttribute('srcdoc');
        this.iframe.removeAttribute('src');
    }

    /** @param {MessageEvent} event */
    _onWindowMessage(event) {
        if (this.destroyed || this.port) return;
        if (!isValidSandboxHandshake(event, { token: this.token, frameWindow: this.iframe.contentWindow })) {
            return;
        }

        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = (portEvent) => this._onBridgeMessage(portEvent);
        this.port.start();

        // The frame has an opaque origin, so '*' is the only targetOrigin it can
        // be addressed with; the recipient window was verified above.
        this.iframe.contentWindow?.postMessage({ type: 'WEB25_SANDBOX_INIT', token: this.token }, '*', [channel.port2]);
        this.log('[Sandbox] Bridge established for site ' + this.hash);
    }

    /** @param {MessageEvent} event */
    _onBridgeMessage(event) {
        let request;
        try {
            request = validateBridgeRequest(event.data);
        } catch (error) {
            const id = typeof (/** @type {any} */ (event.data)?.id) === 'string' ? event.data.id : null;
            this.log('[Sandbox] Rejected bridge message: ' + (error instanceof Error ? error.message : error));
            if (id) this._reply(id, false, null, 'operation-not-allowed');
            return;
        }

        try {
            this._handle(request);
        } catch (error) {
            this._reply(request.id, false, null, error instanceof Error ? error.message : 'bridge-error');
        }
    }

    /** @param {{ id: string, op: string, path?: string, title?: string, message?: string }} request */
    _handle(request) {
        switch (request.op) {
            case SANDBOX_BRIDGE_OPS.READY:
                this._reply(request.id, true, {
                    hash: this.hash,
                    prefix: this.prefix,
                    entryFile: this.entryFile,
                    entryHtml: this.entryHtml
                });
                return;

            case SANDBOX_BRIDGE_OPS.RESOURCE_GET: {
                const file = this.resolveFile(/** @type {string} */ (request.path));
                const buffer = file ? toTransferableBuffer(file.content) : null;
                if (!buffer) {
                    this._reply(request.id, true, { path: request.path, bytes: null, type: null });
                    return;
                }
                this._reply(
                    request.id,
                    true,
                    { path: request.path, bytes: buffer, type: file?.type || 'application/octet-stream' },
                    null,
                    [buffer]
                );
                return;
            }

            case SANDBOX_BRIDGE_OPS.SITE_TITLE:
                if (this.onTitle) this.onTitle(/** @type {string} */ (request.title));
                this._reply(request.id, true, { ok: true });
                return;

            case SANDBOX_BRIDGE_OPS.SITE_LOG:
                this.log('[Sandboxed site] ' + request.message);
                this._reply(request.id, true, { ok: true });
                return;

            default:
                // Unreachable: validateBridgeRequest rejects unknown ops first.
                this._reply(request.id, false, null, 'operation-not-allowed');
        }
    }

    _reply(id, ok, result, error = null, transfer = []) {
        if (!this.port) return;
        const message = ok ? { id, ok: true, result } : { id, ok: false, error: error || 'bridge-error' };
        try {
            this.port.postMessage(message, transfer);
        } catch (_) {
            // Fallback: retry without a transfer list (structured clone will copy).
            this.port.postMessage(message);
        }
    }
}
