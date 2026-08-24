// @ts-check
/**
 * Bridge protocol between the Web25 application and a sandboxed torrent site.
 *
 * A torrent site is untrusted code. A valid `.torrentchain` signature proves
 * *provenance* — who published the bundle — and grants no privileges at all, so
 * a site signed by a malicious publisher is treated exactly like an unsigned
 * one. The bridge therefore exposes a closed allowlist of operations, all of
 * which are scoped to the site's own bundle: there is no signing operation, no
 * wallet operation, and no way to reach application internals.
 */

/** The only operations a sandboxed site may ask the application to perform. */
export const SANDBOX_BRIDGE_OPS = Object.freeze({
    /** Handshake: fetch the entry document and the manifest of bundled files. */
    READY: 'sandbox.ready',
    /** Read one file out of the site's own torrent bundle. */
    RESOURCE_GET: 'resource.get',
    /** Propagate the site's document title to the viewer chrome. */
    SITE_TITLE: 'site.title',
    /** Forward a diagnostic line to the debug panel. */
    SITE_LOG: 'site.log'
});

const ALLOWED_OPS = /** @type {Set<string>} */ (new Set(Object.values(SANDBOX_BRIDGE_OPS)));

/**
 * Sandbox tokens granted to the site frame.
 *
 * `allow-same-origin` is intentionally absent: together with `allow-scripts` it
 * would give torrent JavaScript the wallet's own origin. `allow-top-navigation`
 * and `allow-popups-to-escape-sandbox` are absent for the same reason — they
 * would let a site escape into a privileged browsing context.
 */
export const SITE_SANDBOX_TOKENS = Object.freeze(['allow-scripts', 'allow-forms', 'allow-modals', 'allow-popups']);

export const SITE_SANDBOX_ATTRIBUTE = SITE_SANDBOX_TOKENS.join(' ');

/** Tokens that must never appear on the site frame. */
export const FORBIDDEN_SANDBOX_TOKENS = Object.freeze([
    'allow-same-origin',
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-popups-to-escape-sandbox',
    'allow-storage-access-by-user-activation'
]);

const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;
const MAX_TITLE_LENGTH = 300;
const MAX_LOG_LENGTH = 2048;

export class SandboxBridgeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SandboxBridgeError';
    }
}

/**
 * Reject anything that could escape the site's own bundle: absolute URLs,
 * protocol-relative URLs, parent traversal, NUL bytes.
 * @param {string} path
 * @returns {string} normalized bundle-relative path
 */
export function normalizeBundlePath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
        throw new SandboxBridgeError('resource.get requires a bundle-relative path.');
    }
    if (path.includes('\0') || path.includes('\\')) {
        throw new SandboxBridgeError('resource.get path contains illegal characters.');
    }
    if (path.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
        throw new SandboxBridgeError('resource.get path must not be an absolute URL.');
    }

    const cleaned = path.replace(/^\/+/, '').split('?')[0].split('#')[0];
    if (cleaned.split('/').some((segment) => segment === '..')) {
        throw new SandboxBridgeError('resource.get path must not traverse outside the bundle.');
    }
    if (!cleaned) {
        throw new SandboxBridgeError('resource.get path resolves to an empty file name.');
    }
    return cleaned;
}

/**
 * Strictly validate a message received from the sandboxed site.
 * @param {unknown} raw
 * @returns {{ id: string, op: string, path?: string, title?: string, message?: string }}
 */
export function validateBridgeRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new SandboxBridgeError('Sandbox bridge message must be an object.');
    }

    const data = /** @type {Record<string, any>} */ (raw);
    if (typeof data.id !== 'string' || data.id.length === 0 || data.id.length > MAX_ID_LENGTH) {
        throw new SandboxBridgeError('Sandbox bridge message is missing a valid id.');
    }
    if (typeof data.op !== 'string' || !ALLOWED_OPS.has(data.op)) {
        throw new SandboxBridgeError(`Sandbox bridge operation is not allowed: ${String(data.op)}`);
    }

    switch (data.op) {
        case SANDBOX_BRIDGE_OPS.READY:
            return { id: data.id, op: data.op };

        case SANDBOX_BRIDGE_OPS.RESOURCE_GET:
            return { id: data.id, op: data.op, path: normalizeBundlePath(data.path) };

        case SANDBOX_BRIDGE_OPS.SITE_TITLE: {
            if (typeof data.title !== 'string') {
                throw new SandboxBridgeError('site.title requires a string title.');
            }
            return { id: data.id, op: data.op, title: data.title.slice(0, MAX_TITLE_LENGTH) };
        }

        case SANDBOX_BRIDGE_OPS.SITE_LOG: {
            if (typeof data.message !== 'string') {
                throw new SandboxBridgeError('site.log requires a string message.');
            }
            return { id: data.id, op: data.op, message: data.message.slice(0, MAX_LOG_LENGTH) };
        }

        default:
            throw new SandboxBridgeError(`Sandbox bridge operation is not allowed: ${data.op}`);
    }
}

/**
 * Validate the initial `window.postMessage` handshake before a MessagePort is
 * handed to the frame. The frame runs in an opaque origin, so its messages
 * always report origin `"null"`; identity is established by matching the exact
 * window object plus the one-time token embedded in the bootstrap document.
 *
 * @param {{ data: any, origin: string, source: unknown }} event
 * @param {{ token: string, frameWindow: unknown }} expected
 * @returns {boolean}
 */
export function isValidSandboxHandshake(event, expected) {
    if (!event || !expected) return false;
    if (!expected.frameWindow || event.source !== expected.frameWindow) return false;
    if (event.origin !== 'null') return false;

    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (data.type !== 'WEB25_SANDBOX_HELLO') return false;
    if (typeof data.token !== 'string' || data.token.length === 0) return false;
    return data.token === expected.token;
}

/**
 * True when a sandbox attribute string grants no privilege-restoring token.
 * @param {string} attribute
 */
export function isSafeSandboxAttribute(attribute) {
    const tokens = `${attribute || ''}`.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    return !tokens.some((token) => FORBIDDEN_SANDBOX_TOKENS.includes(token));
}
