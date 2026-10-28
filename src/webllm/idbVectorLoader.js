// @ts-check
/**
 * Load idb-vector from jsDelivr, verified.
 *
 * The package is two ES modules: `index.js`, which imports
 * `./utils/sortedarray.js`. Both are fetched and checked against their pinned
 * SHA-384 before any of their code runs. They are then imported from blob
 * URLs, with index.js's one relative import pointed at the verified copy of
 * the other file — the exact import string is replaced, nothing else.
 *
 * Without the network, or if a file does not match, this rejects and the
 * thought store recalls by recency instead.
 */

import { IDB_VECTOR_FILES } from './webllmConfig.js';
import { matchesIntegrity } from './webllmEngineHost.js';

/**
 * @param {{ files?: typeof IDB_VECTOR_FILES,
 *           fetch?: typeof fetch,
 *           importer?: (url: string) => Promise<any> }} [options]
 * @returns {Promise<any>} the `VectorDB` class
 */
export async function loadIdbVector({
    files = IDB_VECTOR_FILES,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    importer = (url) => import(/* @vite-ignore */ url)
} = {}) {
    /** @param {{ url: string, integrity: string }} file */
    const fetchVerified = async ({ url, integrity }) => {
        const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error(`idb-vector download failed (status ${response.status})`);
        const bytes = await response.arrayBuffer();
        if (!(await matchesIntegrity(bytes, integrity))) {
            throw new Error('idb-vector did not match its pinned integrity hash and was not loaded.');
        }
        return new TextDecoder().decode(bytes);
    };
    const blobUrl = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

    const [indexSource, sortedSource] = await Promise.all([
        fetchVerified(files.index),
        fetchVerified(files.sortedArray)
    ]);
    const quoted = JSON.stringify(files.sortedArray.specifier);
    const parts = indexSource.split(quoted);
    if (parts.length !== 2) throw new Error('idb-vector does not import its helper the way this version should.');

    const sortedUrl = blobUrl(sortedSource);
    const indexUrl = blobUrl(parts.join(JSON.stringify(sortedUrl)));
    try {
        const module = await importer(indexUrl);
        if (typeof module?.VectorDB !== 'function') throw new Error('idb-vector has no VectorDB export.');
        return module.VectorDB;
    } finally {
        URL.revokeObjectURL(indexUrl);
        URL.revokeObjectURL(sortedUrl);
    }
}
