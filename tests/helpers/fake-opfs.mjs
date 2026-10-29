/**
 * An in-memory Origin Private File System, close enough to the spec for the
 * workspace to run against: directory and file handles, `getDirectoryHandle`
 * / `getFileHandle` with `create`, `removeEntry` with `recursive`, async
 * `keys()` / `values()` / `entries()`, `getFile()` and `createWritable()`.
 * Failures are DOMExceptions named the way browsers name them.
 */

const domError = (name, message) => new DOMException(message, name);

class FakeFileHandle {
    constructor(name) {
        this.kind = 'file';
        this.name = name;
        this.bytes = new Uint8Array(0);
        this.lastModified = Date.now();
        this.locked = false;
    }

    async getFile() {
        return new File([this.bytes], this.name, { lastModified: this.lastModified });
    }

    async createWritable() {
        if (this.locked) throw domError('NoModificationAllowedError', 'The file is locked.');
        this.locked = true;
        const chunks = [];
        const handle = this;
        return {
            async write(data) {
                if (data instanceof Blob) chunks.push(new Uint8Array(await data.arrayBuffer()));
                else if (typeof data === 'string') chunks.push(new TextEncoder().encode(data));
                else if (data instanceof ArrayBuffer) chunks.push(new Uint8Array(data));
                else if (ArrayBuffer.isView(data)) {
                    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
                } else throw new TypeError('Unsupported write');
            },
            async close() {
                const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const out = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    out.set(chunk, offset);
                    offset += chunk.length;
                }
                handle.bytes = out;
                handle.lastModified = Date.now();
                handle.locked = false;
            },
            async abort() {
                handle.locked = false;
            }
        };
    }
}

class FakeDirectoryHandle {
    constructor(name = '') {
        this.kind = 'directory';
        this.name = name;
        /** @type {Map<string, FakeDirectoryHandle|FakeFileHandle>} */
        this.children = new Map();
    }

    static checkName(name) {
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
            throw new TypeError(`Name is not allowed: ${name}`);
        }
    }

    async getDirectoryHandle(name, { create = false } = {}) {
        FakeDirectoryHandle.checkName(name);
        const existing = this.children.get(name);
        if (existing) {
            if (existing.kind !== 'directory') throw domError('TypeMismatchError', 'Not a directory.');
            return existing;
        }
        if (!create) throw domError('NotFoundError', `No directory ${name}.`);
        const dir = new FakeDirectoryHandle(name);
        this.children.set(name, dir);
        return dir;
    }

    async getFileHandle(name, { create = false } = {}) {
        FakeDirectoryHandle.checkName(name);
        const existing = this.children.get(name);
        if (existing) {
            if (existing.kind !== 'file') throw domError('TypeMismatchError', 'Not a file.');
            return existing;
        }
        if (!create) throw domError('NotFoundError', `No file ${name}.`);
        const file = new FakeFileHandle(name);
        this.children.set(name, file);
        return file;
    }

    async removeEntry(name, { recursive = false } = {}) {
        const existing = this.children.get(name);
        if (!existing) throw domError('NotFoundError', `No entry ${name}.`);
        if (existing.kind === 'directory' && existing.children.size > 0 && !recursive) {
            throw domError('InvalidModificationError', 'Directory is not empty.');
        }
        this.children.delete(name);
    }

    async *keys() {
        for (const name of [...this.children.keys()]) yield name;
    }

    async *values() {
        for (const handle of [...this.children.values()]) yield handle;
    }

    async *entries() {
        for (const entry of [...this.children.entries()]) yield entry;
    }
}

/** A fresh OPFS root and a `navigator.storage`-shaped object around it. */
export function createFakeOpfs() {
    const root = new FakeDirectoryHandle('');
    return {
        root,
        storage: { getDirectory: async () => root },
        /** Every file path under the root, for assertions. */
        list(dir = root, prefix = '') {
            const out = [];
            for (const [name, handle] of dir.children) {
                const path = prefix ? `${prefix}/${name}` : name;
                if (handle.kind === 'directory') out.push(...this.list(handle, path));
                else out.push(path);
            }
            return out.sort();
        }
    };
}
