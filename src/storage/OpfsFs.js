// @ts-check
/**
 * A small `fs.promises` over the Origin Private File System.
 *
 * isomorphic-git does not touch storage itself: it is handed an object with
 * Node's promise-style file functions (`readFile`, `writeFile`, `mkdir`,
 * `rmdir`, `unlink`, `stat`, `lstat`, `readdir`, `readlink`, `symlink`) and
 * does everything through it. This is that object, written against OPFS
 * directly — `navigator.storage.getDirectory()` and the handles under it — so
 * the repositories and trees Web25 keeps are real directories in the origin's
 * private file system rather than rows in IndexedDB.
 *
 * Paths are POSIX and absolute (`/web25/pages/<hash>/.git/HEAD`). Errors carry
 * Node's `code` (`ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`, `ENOTEMPTY`), which is
 * what isomorphic-git branches on. OPFS has no symlinks, so `readlink` and
 * `symlink` refuse, and no permissions, so every file is `0o100644`.
 *
 * Nothing here is reached on the main thread's hot path: writes go through
 * `createWritable()`, which every engine with OPFS on the main thread offers.
 * A browser without it is reported as unsupported by `isOpfsWritable` and the
 * callers keep their data where they always did.
 */

const FILE_MODE = 0o100644;
const DIR_MODE = 0o040000;

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [path]
 */
function fsError(code, message, path = '') {
    const error = /** @type {Error & { code: string, path?: string }} */ (
        new Error(`${code}: ${message}${path ? `, '${path}'` : ''}`)
    );
    error.code = code;
    if (path) error.path = path;
    return error;
}

/**
 * Translate a DOMException from an OPFS call into the Node error it means.
 * @param {any} error
 * @param {string} path
 */
function mapError(error, path) {
    if (error?.code && typeof error.code === 'string' && error.code.startsWith('E')) return error;
    switch (error?.name) {
        case 'NotFoundError':
            return fsError('ENOENT', 'no such file or directory', path);
        case 'TypeMismatchError':
            return fsError('ENOTDIR', 'not a directory', path);
        case 'InvalidModificationError':
            return fsError('ENOTEMPTY', 'directory not empty', path);
        case 'NoModificationAllowedError':
            return fsError('EBUSY', 'resource busy or locked', path);
        default:
            return error instanceof Error ? error : new Error(`${error}`);
    }
}

/**
 * The segments of an absolute path. `.` is dropped and `..` refused: nothing
 * stored here is meant to step outside the directory it was written to, and a
 * path from a torrent that tries is a path to reject, not to resolve.
 * @param {string} path
 * @returns {string[]}
 */
export function pathSegments(path) {
    const segments = [];
    for (const segment of `${path || ''}`.replace(/\\/g, '/').split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') throw fsError('EINVAL', 'path escapes its root', path);
        segments.push(segment);
    }
    return segments;
}

/** A stable small number per path, standing in for an inode. @param {string} path */
function inodeOf(path) {
    let hash = 2166136261;
    for (let i = 0; i < path.length; i += 1) {
        hash ^= path.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/**
 * @param {'file'|'dir'} type
 * @param {string} path
 * @param {number} size
 * @param {number} mtimeMs
 */
function makeStats(type, path, size, mtimeMs) {
    const isFile = type === 'file';
    return {
        type,
        mode: isFile ? FILE_MODE : DIR_MODE,
        size,
        ino: inodeOf(path),
        dev: 1,
        uid: 1,
        gid: 1,
        mtimeMs,
        ctimeMs: mtimeMs,
        mtime: new Date(mtimeMs),
        ctime: new Date(mtimeMs),
        isFile: () => isFile,
        isDirectory: () => !isFile,
        isSymbolicLink: () => false
    };
}

/** @param {any} data @param {any} options */
function toWritable(data, options) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data === null || data === undefined) return new Uint8Array(0);
    if (typeof options === 'string' || options?.encoding) return new TextEncoder().encode(`${data}`);
    return data;
}

/**
 * Whether OPFS is there and can be written from this context.
 * @param {any} [storage] `navigator.storage`, injectable for tests
 */
export async function isOpfsWritable(storage = globalThis.navigator?.storage) {
    if (typeof storage?.getDirectory !== 'function') return false;
    try {
        const root = await storage.getDirectory();
        const probe = await root.getFileHandle('.web25-probe', { create: true });
        const ok = typeof probe.createWritable === 'function';
        await root.removeEntry('.web25-probe').catch?.(() => {});
        return ok;
    } catch (_) {
        return false;
    }
}

export class OpfsFs {
    /**
     * @param {{ root?: () => Promise<any> }} [options] the OPFS root directory
     *   handle, resolved lazily; defaults to `navigator.storage.getDirectory()`
     */
    constructor({ root } = {}) {
        this._rootFactory = root || (() => globalThis.navigator.storage.getDirectory());
        /** @type {Promise<any>|null} */
        this._root = null;
    }

    root() {
        if (!this._root) {
            this._root = Promise.resolve(this._rootFactory()).catch((error) => {
                this._root = null;
                throw error;
            });
        }
        return this._root;
    }

    /**
     * The directory handle at `segments`.
     * @param {string[]} segments
     * @param {{ create?: boolean, path?: string }} [options]
     */
    async _dir(segments, { create = false, path = '' } = {}) {
        let dir = await this.root();
        for (const segment of segments) {
            try {
                dir = await dir.getDirectoryHandle(segment, { create });
            } catch (error) {
                throw mapError(error, path || `/${segments.join('/')}`);
            }
        }
        return dir;
    }

    /**
     * The parent directory handle and the entry name of `path`.
     * @param {string} path
     * @param {{ create?: boolean }} [options]
     */
    async _parent(path, { create = false } = {}) {
        const segments = pathSegments(path);
        if (segments.length === 0) throw fsError('EISDIR', 'is the root directory', path);
        const name = /** @type {string} */ (segments.pop());
        return { dir: await this._dir(segments, { create, path }), name };
    }

    /**
     * The handle at `path`, file or directory, or ENOENT.
     * @param {string} path
     */
    async _entry(path) {
        const segments = pathSegments(path);
        if (segments.length === 0) return { kind: 'directory', handle: await this.root() };
        const { dir, name } = await this._parent(path);
        try {
            return { kind: 'file', handle: await dir.getFileHandle(name) };
        } catch (error) {
            if (error?.name !== 'TypeMismatchError' && error?.name !== 'NotFoundError') throw mapError(error, path);
        }
        try {
            return { kind: 'directory', handle: await dir.getDirectoryHandle(name) };
        } catch (error) {
            throw mapError(error, path);
        }
    }

    /**
     * @param {string} path
     * @param {any} [options] `'utf8'` or `{ encoding: 'utf8' }` for a string
     */
    async readFile(path, options) {
        const { dir, name } = await this._parent(path);
        let file;
        try {
            const handle = await dir.getFileHandle(name);
            file = await handle.getFile();
        } catch (error) {
            if (error?.name === 'TypeMismatchError') throw fsError('EISDIR', 'illegal operation on a directory', path);
            throw mapError(error, path);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding ? new TextDecoder().decode(bytes) : bytes;
    }

    /**
     * Replace a file's contents. The parent directory must exist, as in Node.
     * @param {string} path
     * @param {any} data
     * @param {any} [options]
     */
    async writeFile(path, data, options) {
        const { dir, name } = await this._parent(path);
        let handle;
        try {
            handle = await dir.getFileHandle(name, { create: true });
        } catch (error) {
            if (error?.name === 'TypeMismatchError') throw fsError('EISDIR', 'illegal operation on a directory', path);
            throw mapError(error, path);
        }
        if (typeof handle.createWritable !== 'function') {
            throw fsError('ENOTSUP', 'this browser cannot write to the origin private file system', path);
        }
        const writable = await handle.createWritable();
        try {
            await writable.write(toWritable(data, options));
            await writable.close();
        } catch (error) {
            await writable.abort?.().catch?.(() => {});
            throw mapError(error, path);
        }
    }

    /** @param {string} path */
    async unlink(path) {
        const { dir, name } = await this._parent(path);
        try {
            await dir.getFileHandle(name);
        } catch (error) {
            if (error?.name === 'TypeMismatchError') throw fsError('EISDIR', 'illegal operation on a directory', path);
            throw mapError(error, path);
        }
        try {
            await dir.removeEntry(name);
        } catch (error) {
            throw mapError(error, path);
        }
    }

    /**
     * Create one directory. `{ recursive: true }` creates the missing parents
     * too and does not mind the directory already existing.
     * @param {string} path
     * @param {any} [options]
     */
    async mkdir(path, options) {
        const recursive = Boolean(options && typeof options === 'object' && options.recursive);
        if (recursive) {
            await this._dir(pathSegments(path), { create: true, path });
            return;
        }
        const { dir, name } = await this._parent(path);
        let exists = false;
        try {
            await dir.getDirectoryHandle(name);
            exists = true;
        } catch (error) {
            if (error?.name === 'TypeMismatchError') exists = true;
            else if (error?.name !== 'NotFoundError') throw mapError(error, path);
        }
        if (exists) throw fsError('EEXIST', 'file already exists', path);
        try {
            await dir.getDirectoryHandle(name, { create: true });
        } catch (error) {
            throw mapError(error, path);
        }
    }

    /**
     * Remove an empty directory.
     * @param {string} path
     */
    async rmdir(path) {
        const { dir, name } = await this._parent(path);
        let handle;
        try {
            handle = await dir.getDirectoryHandle(name);
        } catch (error) {
            throw mapError(error, path);
        }
        const first = await handle.keys().next();
        if (!first.done) throw fsError('ENOTEMPTY', 'directory not empty', path);
        try {
            await dir.removeEntry(name);
        } catch (error) {
            throw mapError(error, path);
        }
    }

    /**
     * Remove a file or a directory. `{ recursive: true }` takes a directory's
     * contents with it; `{ force: true }` makes a missing path a no-op.
     * @param {string} path
     * @param {{ recursive?: boolean, force?: boolean }} [options]
     */
    async rm(path, { recursive = false, force = false } = {}) {
        let parent;
        try {
            parent = await this._parent(path);
        } catch (error) {
            if (force && error?.code === 'ENOENT') return;
            throw error;
        }
        try {
            await parent.dir.removeEntry(parent.name, { recursive });
        } catch (error) {
            const mapped = mapError(error, path);
            if (force && mapped.code === 'ENOENT') return;
            throw mapped;
        }
    }

    /** @param {string} path @returns {Promise<string[]>} */
    async readdir(path) {
        const entry = await this._entry(path);
        if (entry.kind !== 'directory') throw fsError('ENOTDIR', 'not a directory', path);
        const names = [];
        for await (const name of entry.handle.keys()) names.push(name);
        return names.sort();
    }

    /** @param {string} path */
    async stat(path) {
        const entry = await this._entry(path);
        if (entry.kind === 'directory') return makeStats('dir', path, 0, 0);
        const file = await entry.handle.getFile();
        return makeStats('file', path, file.size, Number(file.lastModified) || 0);
    }

    /** OPFS has no links, so lstat is stat. @param {string} path */
    lstat(path) {
        return this.stat(path);
    }

    /** @param {string} path */
    async readlink(path) {
        throw fsError('ENOENT', 'symbolic links are not supported', path);
    }

    /** @param {string} _target @param {string} path */
    async symlink(_target, path) {
        throw fsError('ENOTSUP', 'symbolic links are not supported', path);
    }

    /** Permissions do not exist in OPFS; accepted and ignored. */
    async chmod() {}

    /** @param {string} path */
    async exists(path) {
        try {
            await this._entry(path);
            return true;
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
            throw error;
        }
    }
}

export default OpfsFs;
