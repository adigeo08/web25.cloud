// @ts-check
/**
 * A project's layout as it is being rearranged, before Save.
 *
 * The Project panel never touches the repository while files are dragged
 * around: every move, rename, new folder or deletion changes this draft, the
 * tree is drawn from it, and Save turns the difference from where the draft
 * started into one batch of changes — one commit. Discard is starting over
 * from the repository.
 *
 * Pure: no DOM, no storage.
 */

/** @param {string} dir @param {string} name */
export function joinPath(dir, name) {
    return dir ? `${dir}/${name}` : name;
}

/** @param {string} path */
export function parentOf(path) {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
}

/** @param {string} path */
export function baseName(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * A single name a file or folder can have, or null.
 * @param {string} name
 */
export function validName(name) {
    const value = `${name || ''}`.trim();
    if (!value || value.length > 80 || value === '.' || value === '..') return null;
    if (!/^[A-Za-z0-9_. -]+$/.test(value) || value.toLowerCase() === '.git') return null;
    return value;
}

/** @param {string} path @param {string} dir */
const isInside = (path, dir) => path === dir || path.startsWith(`${dir}/`);

/** The folders a set of files lives in, parents included. @param {Iterable<string>} files */
function impliedDirs(files) {
    const dirs = new Set();
    for (const file of files) {
        for (let dir = parentOf(file); dir; dir = parentOf(dir)) dirs.add(dir);
    }
    return dirs;
}

/**
 * @typedef {{ op: 'mkdir', path: string } | { op: 'rmdir', path: string } |
 *           { op: 'delete', path: string } | { op: 'move', from: string, to: string } |
 *           { op: 'write', path: string, bytes: string }} ProjectChange
 */

export class ProjectDraft {
    /** @param {{ files?: string[], dirs?: string[] }} [layout] */
    constructor({ files = [], dirs = [] } = {}) {
        /** current path → the path it had in the repository; null for a new file */
        /** @type {Map<string, string|null>} */
        this.entries = new Map(files.map((path) => [path, path]));
        this.originalFiles = new Set(files);
        this.originalDirs = new Set([...dirs, ...impliedDirs(files)]);
        /** @type {Set<string>} */
        this.dirSet = new Set(this.originalDirs);
    }

    files() {
        return [...this.entries.keys()].sort();
    }

    dirs() {
        return [...new Set([...this.dirSet, ...impliedDirs(this.entries.keys())])].sort();
    }

    /** @param {string} path */
    isDir(path) {
        return path === '' || this.dirs().includes(path);
    }

    /** @param {string} path */
    exists(path) {
        return this.entries.has(path) || this.isDir(path);
    }

    /**
     * What a row should be marked with: a new file, one that moved, or none.
     * @param {string} path
     * @returns {'added'|'moved'|null}
     */
    statusOf(path) {
        if (!this.entries.has(path)) return this.originalDirs.has(path) ? null : this.dirSet.has(path) ? 'added' : null;
        const origin = this.entries.get(path);
        if (origin === null) return 'added';
        return origin === path ? null : 'moved';
    }

    /**
     * Move a file or a folder into `destDir` ('' for the top of the project).
     * @param {string} path
     * @param {string} destDir
     */
    move(path, destDir) {
        return this.relocate(path, joinPath(destDir, baseName(path)));
    }

    /** @param {string} path @param {string} name */
    rename(path, name) {
        const valid = validName(name);
        if (!valid) throw new Error('Use letters, digits, dots, dashes or spaces for a name.');
        return this.relocate(path, joinPath(parentOf(path), valid));
    }

    /**
     * @param {string} path
     * @param {string} target
     * @returns {string} the new path
     */
    relocate(path, target) {
        if (path === target) return path;
        if (this.exists(target)) throw new Error(`“${target}” already exists.`);
        if (this.entries.has(path)) {
            const origin = /** @type {string|null} */ (this.entries.get(path));
            this.entries.delete(path);
            this.entries.set(target, origin);
            return target;
        }
        if (!this.isDir(path) || path === '') throw new Error(`“${path}” is not in the project.`);
        if (isInside(target, path)) throw new Error('A folder cannot be moved into itself.');
        const swap = (/** @type {string} */ value) => `${target}${value.slice(path.length)}`;
        for (const [current, origin] of [...this.entries]) {
            if (!isInside(current, path)) continue;
            this.entries.delete(current);
            this.entries.set(swap(current), origin);
        }
        for (const dir of [...this.dirSet]) {
            if (!isInside(dir, path)) continue;
            this.dirSet.delete(dir);
            this.dirSet.add(swap(dir));
        }
        this.dirSet.add(target);
        return target;
    }

    /** @param {string} path */
    mkdir(path) {
        if (this.exists(path)) throw new Error(`“${path}” already exists.`);
        this.dirSet.add(path);
        return path;
    }

    /** @param {string} path */
    createFile(path) {
        if (this.exists(path)) throw new Error(`“${path}” already exists.`);
        this.entries.set(path, null);
        return path;
    }

    /**
     * Take a file that now exists in the repository — saved from the canvas,
     * or written by a reply — as part of where the draft started.
     * @param {string} path
     */
    adopt(path) {
        this.entries.set(path, path);
        this.originalFiles.add(path);
        for (const dir of impliedDirs([path])) {
            this.originalDirs.add(dir);
            this.dirSet.add(dir);
        }
    }

    /** Remove a file, or a folder and everything in it. @param {string} path */
    remove(path) {
        if (this.entries.delete(path)) return;
        for (const current of [...this.entries.keys()]) if (isInside(current, path)) this.entries.delete(current);
        for (const dir of [...this.dirSet]) if (isInside(dir, path)) this.dirSet.delete(dir);
    }

    /**
     * The difference from the repository, as the batch Save applies.
     * @returns {ProjectChange[]}
     */
    changes() {
        /** @type {ProjectChange[]} */
        const changes = [];
        const kept = new Set();
        for (const [path, origin] of this.entries) {
            if (origin === null) changes.push({ op: 'write', path, bytes: '' });
            else {
                kept.add(origin);
                if (origin !== path) changes.push({ op: 'move', from: origin, to: path });
            }
        }
        for (const path of this.originalFiles) if (!kept.has(path)) changes.push({ op: 'delete', path });
        const dirs = new Set(this.dirs());
        for (const dir of dirs) if (!this.originalDirs.has(dir)) changes.push({ op: 'mkdir', path: dir });
        for (const dir of this.originalDirs) if (!dirs.has(dir)) changes.push({ op: 'rmdir', path: dir });
        return changes;
    }

    get dirty() {
        return this.changes().length > 0;
    }

    /** A commit message for the batch. */
    summary() {
        const changes = this.changes();
        const counts = { move: 0, write: 0, delete: 0, mkdir: 0, rmdir: 0 };
        for (const change of changes) counts[change.op] += 1;
        const parts = [
            counts.move && `move ${counts.move}`,
            counts.write && `add ${counts.write}`,
            counts.delete && `delete ${counts.delete}`,
            counts.mkdir && `create ${counts.mkdir} folder${counts.mkdir === 1 ? '' : 's'}`,
            counts.rmdir && `remove ${counts.rmdir} folder${counts.rmdir === 1 ? '' : 's'}`
        ].filter(Boolean);
        return parts.length ? `Organise project: ${parts.join(', ')}` : 'Organise project';
    }
}

/**
 * @typedef {{ name: string, path: string, kind: 'dir'|'file', children: TreeNode[] }} TreeNode
 */

/**
 * The tree the panel draws: folders first, then files, each alphabetical.
 * @param {string[]} files
 * @param {string[]} dirs
 * @returns {TreeNode}
 */
export function buildTree(files, dirs) {
    /** @type {TreeNode} */
    const root = { name: '', path: '', kind: 'dir', children: [] };
    /** @type {Map<string, TreeNode>} */
    const folders = new Map([['', root]]);
    const folder = (/** @type {string} */ path) => {
        const known = folders.get(path);
        if (known) return known;
        /** @type {TreeNode} */
        const node = { name: baseName(path), path, kind: 'dir', children: [] };
        folders.set(path, node);
        folder(parentOf(path)).children.push(node);
        return node;
    };
    for (const dir of [...dirs].sort()) folder(dir);
    for (const file of [...files].sort()) {
        folder(parentOf(file)).children.push({ name: baseName(file), path: file, kind: 'file', children: [] });
    }
    const sort = (/** @type {TreeNode} */ node) => {
        node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
        node.children.forEach(sort);
    };
    sort(root);
    return root;
}
