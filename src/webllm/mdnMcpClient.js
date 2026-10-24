// @ts-check
/**
 * A browser-side client for Mozilla's MDN MCP server, over the Model Context
 * Protocol's Streamable HTTP transport.
 *
 * Every message is a JSON-RPC 2.0 POST to the one endpoint, accepting either a
 * JSON body or an SSE stream in reply. The session starts with `initialize`
 * and `notifications/initialized`; later requests carry the negotiated
 * `MCP-Protocol-Version`, and an `Mcp-Session-Id` if the server issued one (the
 * MDN server is stateless and does not). Tools are called with `tools/call`.
 *
 * Privacy: requests carry no cookies, no referrer and MDN's analytics opt-out
 * header, and nothing but what a caller passes as tool arguments — in WEB25,
 * a few search terms, a documentation path or a compatibility key.
 */

import { MDN_MCP_ENDPOINT, MDN_MCP_PROTOCOL_VERSION } from './webllmConfig.js';

const CLIENT_INFO = Object.freeze({ name: 'web25-webllm', version: '1.0.0' });

export class McpError extends Error {
    /**
     * @param {string} message
     * @param {{ code?: number|string, kind?: 'network'|'http'|'protocol'|'tool'|'timeout'|'aborted' }} [details]
     */
    constructor(message, { code, kind = 'protocol' } = {}) {
        super(message);
        this.name = 'McpError';
        this.code = code;
        this.kind = kind;
    }
}

/**
 * Pull the JSON-RPC message answering `id` out of an SSE body.
 * @param {string} body
 * @param {number} id
 */
export function parseSseResponse(body, id) {
    // Events are separated by a blank line; an event's data may span several `data:` lines.
    for (const block of `${body}`.split(/\r?\n\r?\n/)) {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data) continue;
        let message;
        try {
            message = JSON.parse(data);
        } catch (_) {
            continue;
        }
        if (message && message.id === id) return message;
    }
    return null;
}

/**
 * @param {{ endpoint?: string, fetch?: typeof fetch, timeoutMs?: number,
 *           protocolVersion?: string }} [options]
 */
export function createMcpClient({
    endpoint = MDN_MCP_ENDPOINT,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = 8000,
    protocolVersion = MDN_MCP_PROTOCOL_VERSION
} = {}) {
    let nextId = 1;
    /** @type {string|null} */
    let sessionId = null;
    /** @type {string|null} */
    let negotiatedVersion = null;
    /** @type {Promise<any>|null} */
    let initializing = null;
    /** @type {any} */
    let serverInfo = null;

    function headers() {
        /** @type {Record<string, string>} */
        const result = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            // MDN's documented opt-out of first-party analytics.
            'X-Moz-1st-Party-Data-Opt-Out': '1'
        };
        if (negotiatedVersion) result['MCP-Protocol-Version'] = negotiatedVersion;
        if (sessionId) result['Mcp-Session-Id'] = sessionId;
        return result;
    }

    /**
     * POST one JSON-RPC message.
     * @param {any} message
     * @param {AbortSignal} [signal]
     */
    async function post(message, signal) {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new McpError('MDN did not answer in time.', { kind: 'timeout' })),
            timeoutMs
        );
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (signal?.aborted) controller.abort(signal.reason);
        try {
            return await fetchImpl(endpoint, {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify(message),
                mode: 'cors',
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                cache: 'no-store',
                signal: controller.signal
            });
        } catch (error) {
            if (controller.signal.aborted) {
                const reason = controller.signal.reason;
                if (reason instanceof McpError) throw reason;
                throw new McpError('The MDN lookup was cancelled.', { kind: 'aborted' });
            }
            throw new McpError(`MDN could not be reached: ${error?.message || error}`, { kind: 'network' });
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
        }
    }

    /**
     * Send a request and return its `result`.
     * @param {string} method
     * @param {any} params
     * @param {AbortSignal} [signal]
     */
    async function request(method, params, signal) {
        const id = nextId++;
        const response = await post({ jsonrpc: '2.0', id, method, params }, signal);
        if (!response.ok) {
            throw new McpError(`MDN answered HTTP ${response.status}.`, { kind: 'http', code: response.status });
        }
        const issued = response.headers?.get?.('Mcp-Session-Id');
        if (issued) sessionId = issued;

        const type = `${response.headers?.get?.('Content-Type') || ''}`.toLowerCase();
        const body = await response.text();
        let message;
        if (type.includes('text/event-stream')) {
            message = parseSseResponse(body, id);
        } else {
            try {
                message = JSON.parse(body);
            } catch (_) {
                message = null;
            }
        }
        if (!message || message.jsonrpc !== '2.0' || message.id !== id) {
            throw new McpError('MDN sent a reply that is not valid MCP.');
        }
        if (message.error) {
            throw new McpError(`MDN error: ${message.error.message || 'unknown'}`, { code: message.error.code });
        }
        return message.result;
    }

    /** Open the session once; later calls reuse it. */
    function initialize(signal) {
        if (!initializing) {
            initializing = (async () => {
                const result = await request(
                    'initialize',
                    { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO },
                    signal
                );
                if (!result || typeof result.protocolVersion !== 'string') {
                    throw new McpError('MDN did not complete the MCP handshake.');
                }
                negotiatedVersion = result.protocolVersion;
                serverInfo = result.serverInfo || null;
                // A notification has no reply body; the server answers 202 Accepted.
                const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
                if (!ack.ok) throw new McpError(`MDN answered HTTP ${ack.status}.`, { kind: 'http', code: ack.status });
                return result;
            })().catch((error) => {
                initializing = null;
                negotiatedVersion = null;
                sessionId = null;
                throw error;
            });
        }
        return initializing;
    }

    /**
     * Call a tool and return its text content.
     * @param {string} name
     * @param {Record<string, string>} args
     * @param {AbortSignal} [signal]
     */
    async function callTool(name, args, signal) {
        await initialize(signal);
        const result = await request('tools/call', { name, arguments: args }, signal);
        const text = (Array.isArray(result?.content) ? result.content : [])
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n');
        if (result?.isError) throw new McpError(text || `MDN could not run ${name}.`, { kind: 'tool' });
        return text;
    }

    return {
        initialize,
        callTool,
        listTools: async (signal) => {
            await initialize(signal);
            return (await request('tools/list', {}, signal))?.tools || [];
        },
        /** Search MDN; returns the server's text listing of results. */
        search: (query, signal) => callTool('search', { query }, signal),
        /** One MDN page as Markdown. */
        getDoc: (path, signal) => callTool('get-doc', { path }, signal),
        /** Browser Compatibility Data for a key, as JSON text. */
        getCompat: (key, signal) => callTool('get-compat', { key }, signal),
        get serverInfo() {
            return serverInfo;
        }
    };
}
