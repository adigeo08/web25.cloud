// @ts-check
/**
 * The Web25 workspace: trees of files in OPFS, some of them git repositories.
 *
 * One service, three users, one layout under the origin's private file system:
 *
 *   /web25/pages/<hash>/      a git repository per site this browser hosts —
 *                             the payload exactly as it travels (`.torrentchain`
 *                             and `site.bundle.json.gz`, or the files of a
 *                             files-mode site). A deployment commits here, and
 *                             so does a reseed: anything in Pages is a repo.
 *   /web25/sites/<hash>/      the unpacked files of a site that was loaded and
 *                             cached, one OPFS file per site file. A plain tree,
 *                             not a repository: a site becomes a repository
 *                             here only by being reseeded, like anything else.
 *   /web25/payloads/<hash>/   the payload kept so a cached site can be reseeded.
 *   /web25/chats/<wallet>/<conversation>/
 *                             a git repository per Llama conversation, holding
 *                             the code files that conversation wrote.
 *
 * isomorphic-git is imported from a CDN on first use, never at start-up. Files
 * are written first and committed second, in the background: a write resolves
 * once its files are durable, and the commit follows on its own queue. A CDN
 * that is slow or cannot be reached costs the history, not the data — and
 * never holds up the deployment, reseed or reply that wrote the files.
 *
 * Every tree is serialized on its own queue — OPFS refuses two writers on one
 * file, and git's index is one file. A tree is never rewritten or removed
 * while a commit of it is still reading it.
 */

import { OpfsFs, isOpfsWritable, pathSegments } from './OpfsFs.js';

export const ISOMORPHIC_GIT_VERSION = '1.37.6';
export const ISOMORPHIC_GIT_URL = `https://esm.sh/isomorphic-git@${ISOMORPHIC_GIT_VERSION}`;

export const WORKSPACE_ROOT = '/web25';
export const WORKSPACE_DIRS = Object.freeze({
    pages: `${WORKSPACE_ROOT}/pages`,
    sites: `${WORKSPACE_ROOT}/sites`,
    payloads: `${WORKSPACE_ROOT}/payloads`,
    chats: `${WORKSPACE_ROOT}/chats`
});

const DEFAULT_AUTHOR = Object.freeze({ name: 'WEB25.cloud', email: 'workspace@web25.cloud' });

/**
 * A path from outside (a torrent, a model reply) made safe to write under a
 * tree, or null when it cannot be. Relative, forward slashes, no `.`/`..`, and
 * never inside a `.git` directory: a payload is not allowed to rewrite the
 * repository that holds it.
 * @param {string} path
 * @returns {string|null}
 */
export function safeTreePath(path) {
    let segments;
    try {
        segments = pathSegments(path);
    } catch (_) {
        return null;
    }
    if (segments.length === 0) return null;
    if (segments.some((segment) => segment.toLowerCase() === '.git' || segment.includes('\0'))) return null;
    return segments.join('/');
}

/** A directory name for an identifier (hash, wallet, conversation id). @param {string} value */
export function workspaceKey(value) {
    const key = `${value || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .slice(0, 96);
    if (!key) throw new Error('A workspace key cannot be empty.');
    return key;
}

/** @param {any} value @returns {Uint8Array} */
function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Uint8Array.from(value);
    return new Uint8Array(0);
}

/** How long the CDN gets to deliver isomorphic-git before a commit is skipped. */
export const GIT_LOAD_TIMEOUT_MS = 20000;

/**
 * Import isomorphic-git from the CDN once per page. A load that fails or takes
 * longer than `timeoutMs` rejects, and the next commit asks again.
 * @param {(url: string) => Promise<any>} [importer]
 * @param {{ timeoutMs?: number }} [options]
 */
export function createGitLoader(
    importer = (url) => import(/* @vite-ignore */ url),
    { timeoutMs = GIT_LOAD_TIMEOUT_MS } = {}
) {
    /** @type {Promise<any>|null} */
    let loading = null;
    return () => {
        if (!loading) {
            /** @type {any} */
            let timer = null;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('isomorphic-git took too long to load.')), timeoutMs);
            });
            loading = Promise.race([importer(ISOMORPHIC_GIT_URL), timeout])
                .finally(() => clearTimeout(timer))
                .then((module) => {
                    const git =
                        module?.default && typeof module.default.commit === 'function' ? module.default : module;
                    if (typeof git?.commit !== 'function') throw new Error('isomorphic-git did not load.');
                    return git;
                })
                .catch((error) => {
                    loading = null;
                    throw error;
                });
        }
        return loading;
    };
}

export class GitWorkspace {
    /**
     * @param {{ fs?: OpfsFs, loadGit?: () => Promise<any>, available?: () => Promise<boolean>,
     *           report?: (message: string) => void }} [options]
     */
    constructor({ fs, loadGit, available, report } = {}) {
        this.fs = fs || new OpfsFs();
        this.loadGit = loadGit || createGitLoader();
        this._available = available || (() => isOpfsWritable());
        this.report = report || ((message) => console.debug(`[GitWorkspace] ${message}`));
        /** @type {Promise<boolean>|null} */
        this._availability = null;
        /** @type {Map<string, Promise<any>>} */
        this._queues = new Map();
        /** The commit each repository is waiting on or running. @type {Map<string, Promise<any>>} */
        this._commits = new Map();
    }

    /** Whether OPFS can be used here at all. Asked once per page. */
    isAvailable() {
        if (!this._availability) {
            this._availability = Promise.resolve()
                .then(() => this._available())
                .then(Boolean)
                .catch(() => false);
        }
        return this._availability;
    }

    /**
     * Run `work` after everything already queued for `dir`.
     * @template T
     * @param {string} dir
     * @param {() => Promise<T>} work
     * @returns {Promise<T>}
     */
    serialize(dir, work) {
        const tail = this._queues.get(dir) || Promise.resolve();
        const run = tail.then(work, work);
        const settled = run.catch(() => {});
        this._queues.set(dir, settled);
        void settled.then(() => {
            if (this._queues.get(dir) === settled) this._queues.delete(dir);
        });
        return run;
    }

    /** Everything queued against `dir` — writes and commits — has finished. @param {string} dir */
    async settled(dir) {
        await (this._queues.get(dir) || Promise.resolve());
        await (this._commits.get(dir) || Promise.resolve());
    }

    /**
     * Change a tree: serialized like any access, and only once no commit of it
     * is still reading the files about to change.
     * @template T
     * @param {string} dir
     * @param {() => Promise<T>} work
     * @returns {Promise<T>}
     */
    mutate(dir, work) {
        return this.serialize(dir, async () => {
            await (this._commits.get(dir) || Promise.resolve());
            return work();
        });
    }

    /**
     * Commit `dir` once whatever is queued for it has run. Never rejects: a
     * commit that fails is reported and resolves to null.
     * @param {string} dir
     * @param {{ message: string, author?: { name: string, email: string } }} options
     * @returns {Promise<string|null>}
     */
    queueCommit(dir, options) {
        const tail = this._commits.get(dir) || Promise.resolve();
        const run = tail.then(() =>
            this.commitAll(dir, options).catch((error) => {
                this.report(`Files saved in ${dir}, but the git commit failed: ${error?.message || error}`);
                return null;
            })
        );
        this._commits.set(dir, run);
        void run.then(() => {
            if (this._commits.get(dir) === run) this._commits.delete(dir);
        });
        return run;
    }

    /**
     * Replace a plain tree's files (no repository), serialized.
     * @param {string} dir
     * @param {{ path: string, bytes: any }[]} files
     */
    replaceTree(dir, files) {
        return this.mutate(dir, () => this.writeTree(dir, files));
    }

    /** Remove a tree, repository and all, serialized. @param {string} dir */
    remove(dir) {
        return this.mutate(dir, () => this.removeTree(dir));
    }

    /**
     * Read from a tree, serialized against writes to it.
     * @template T
     * @param {string} dir
     * @param {() => Promise<T>} work
     */
    read(dir, work) {
        return this.serialize(dir, work);
    }

    /**
     * Write `files` under `dir`, replacing what was there.
     *
     * The tree ends up holding exactly these files; with `keepGit`, a `.git`
     * directory already in it survives, which is how a repository's working
     * tree is replaced without losing its history.
     *
     * @param {string} dir
     * @param {{ path: string, bytes: any }[]} files
     * @param {{ keepGit?: boolean }} [options]
     * @returns {Promise<string[]>} the paths written, in order
     */
    async writeTree(dir, files, { keepGit = false } = {}) {
        const planned = [];
        for (const file of files) {
            const path = safeTreePath(file.path);
            if (!path) throw new Error(`"${file.path}" cannot be stored in the workspace.`);
            planned.push({ path, bytes: toBytes(file.bytes) });
        }
        await this.clearTree(dir, { keepGit });
        await this.fs.mkdir(dir, { recursive: true });
        for (const file of planned) {
            const slash = file.path.lastIndexOf('/');
            if (slash > 0) await this.fs.mkdir(`${dir}/${file.path.slice(0, slash)}`, { recursive: true });
            await this.fs.writeFile(`${dir}/${file.path}`, file.bytes);
        }
        return planned.map((file) => file.path);
    }

    /**
     * Write some files into a tree, leaving the others where they are.
     * @param {string} dir
     * @param {{ path: string, bytes: any }[]} files
     */
    async writeFiles(dir, files) {
        const written = [];
        await this.fs.mkdir(dir, { recursive: true });
        for (const file of files) {
            const path = safeTreePath(file.path);
            if (!path) throw new Error(`"${file.path}" cannot be stored in the workspace.`);
            const slash = path.lastIndexOf('/');
            if (slash > 0) await this.fs.mkdir(`${dir}/${path.slice(0, slash)}`, { recursive: true });
            await this.fs.writeFile(`${dir}/${path}`, toBytes(file.bytes));
            written.push(path);
        }
        return written;
    }

    /**
     * Remove everything under `dir` (but `.git` with `keepGit`). A missing
     * directory is already clear.
     * @param {string} dir
     * @param {{ keepGit?: boolean }} [options]
     */
    async clearTree(dir, { keepGit = false } = {}) {
        let names;
        try {
            names = await this.fs.readdir(dir);
        } catch (error) {
            if (/** @type {any} */ (error)?.code === 'ENOENT') return;
            throw error;
        }
        for (const name of names) {
            if (keepGit && name === '.git') continue;
            await this.fs.rm(`${dir}/${name}`, { recursive: true, force: true });
        }
    }

    /** Remove a tree, repository and all. @param {string} dir */
    async removeTree(dir) {
        await this.fs.rm(dir, { recursive: true, force: true });
    }

    /**
     * Every file under `dir`, `.git` excluded, as relative paths, sorted.
     * @param {string} dir
     * @returns {Promise<string[]>}
     */
    async listFiles(dir) {
        /** @type {string[]} */
        const out = [];
        /** @param {string} prefix */
        const walk = async (prefix) => {
            let names;
            try {
                names = await this.fs.readdir(prefix ? `${dir}/${prefix}` : dir);
            } catch (error) {
                if (/** @type {any} */ (error)?.code === 'ENOENT' && !prefix) return;
                throw error;
            }
            for (const name of names) {
                if (!prefix && name === '.git') continue;
                const path = prefix ? `${prefix}/${name}` : name;
                const stats = await this.fs.stat(`${dir}/${path}`);
                if (stats.isDirectory()) await walk(path);
                else out.push(path);
            }
        };
        await walk('');
        return out.sort();
    }

    /** @param {string} dir @param {string} path */
    async readFile(dir, path) {
        const safe = safeTreePath(path);
        if (!safe) throw new Error(`"${path}" is not a workspace path.`);
        return /** @type {Uint8Array} */ (await this.fs.readFile(`${dir}/${safe}`));
    }

    /**
     * Read `paths` back from `dir`, in the order asked for.
     * @param {string} dir
     * @param {string[]} [paths] omit for every file in the tree
     * @returns {Promise<{ path: string, bytes: Uint8Array }[]>}
     */
    async readTree(dir, paths) {
        const wanted = paths || (await this.listFiles(dir));
        const files = [];
        for (const path of wanted) files.push({ path, bytes: await this.readFile(dir, path) });
        return files;
    }

    /** @param {string} dir */
    async hasRepository(dir) {
        return this.fs.exists(`${dir}/.git/HEAD`);
    }

    /**
     * Stage the whole working tree of `dir` and commit it.
     *
     * The repository is created on first use. Files that left the tree are
     * removed from the index, so a commit is always a snapshot of the tree as
     * it is. A tree that has not changed since the last commit gets no new
     * commit and returns the current one.
     *
     * @param {string} dir
     * @param {{ message: string, author?: { name: string, email: string } }} options
     * @returns {Promise<string|null>} the commit id, or null with nothing to commit
     */
    async commitAll(dir, { message, author = DEFAULT_AUTHOR }) {
        const git = await this.loadGit();
        const fs = { promises: this.fs };
        if (!(await this.hasRepository(dir))) {
            await git.init({ fs, dir, defaultBranch: 'main' });
        }
        const matrix = await git.statusMatrix({ fs, dir });
        let changed = false;
        for (const [filepath, head, workdir, stage] of matrix) {
            if (workdir === 0) {
                if (head !== 0 || stage !== 0) {
                    await git.remove({ fs, dir, filepath });
                    changed = true;
                }
            } else if (head !== workdir || workdir !== stage) {
                await git.add({ fs, dir, filepath });
                changed = true;
            }
        }
        const head = await this.headCommit(dir);
        if (!changed && head) return head;
        if (!changed && matrix.length === 0) return null;
        return git.commit({ fs, dir, message, author });
    }

    /**
     * The commit `HEAD` points to, or null in a repository with none. Read
     * from `.git` directly, so asking costs no CDN load.
     * @param {string} dir
     * @returns {Promise<string|null>}
     */
    async headCommit(dir) {
        try {
            let ref = `${await this.fs.readFile(`${dir}/.git/HEAD`, 'utf8')}`.trim();
            for (let depth = 0; depth < 4 && ref.startsWith('ref:'); depth += 1) {
                const name = ref.slice(4).trim();
                if (!/^refs\/[A-Za-z0-9._/-]+$/.test(name) || name.includes('..')) return null;
                ref = `${await this.fs.readFile(`${dir}/.git/${name}`, 'utf8')}`.trim();
            }
            return /^[0-9a-f]{40}$/.test(ref) ? ref : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * The repository's history, newest first.
     * @param {string} dir
     * @param {{ depth?: number }} [options]
     * @returns {Promise<{ oid: string, message: string, timestamp: number, author: string }[]>}
     */
    async log(dir, { depth = 20 } = {}) {
        if (!(await this.hasRepository(dir))) return [];
        try {
            const git = await this.loadGit();
            const entries = await git.log({ fs: { promises: this.fs }, dir, depth });
            return entries.map((/** @type {any} */ entry) => ({
                oid: entry.oid,
                message: `${entry.commit?.message || ''}`.trim(),
                timestamp: Number(entry.commit?.author?.timestamp || 0) * 1000,
                author: entry.commit?.author?.name || ''
            }));
        } catch (_) {
            return [];
        }
    }

    /**
     * Write `files` into a repository's working tree and commit the result:
     * the one call a writer of Pages or of a chat project needs.
     *
     * Resolves once the files are durable. The commit is queued behind them
     * and settles on its own — `committed` resolves to the commit id, or to
     * null when there was nothing to commit or git could not run.
     *
     * @param {string} dir
     * @param {{ path: string, bytes: any }[]} files
     * @param {{ message: string, author?: { name: string, email: string }, replace?: boolean }} options
     *   `replace: false` adds and overwrites files, keeping the others
     * @returns {Promise<{ paths: string[], committed: Promise<string|null> }>}
     */
    snapshot(dir, files, { message, author, replace = true }) {
        return this.mutate(dir, async () => {
            const paths = replace
                ? await this.writeTree(dir, files, { keepGit: true })
                : await this.writeFiles(dir, files);
            // Queued inside the write, so the next write to this tree waits
            // for this commit rather than racing it.
            return { paths, committed: this.queueCommit(dir, { message, author }) };
        });
    }

    /**
     * Remove files from a repository's working tree and commit.
     * @param {string} dir
     * @param {string[]} paths
     * @param {{ message: string, author?: { name: string, email: string } }} options
     * @returns {Promise<{ committed: Promise<string|null> }>}
     */
    removeFiles(dir, paths, { message, author }) {
        return this.mutate(dir, async () => {
            for (const path of paths) {
                const safe = safeTreePath(path);
                if (safe) await this.fs.rm(`${dir}/${safe}`, { force: true });
            }
            return { committed: this.queueCommit(dir, { message, author }) };
        });
    }

    /** @param {string} hash */
    pageDir(hash) {
        return `${WORKSPACE_DIRS.pages}/${workspaceKey(hash)}`;
    }

    /** @param {string} hash */
    siteDir(hash) {
        return `${WORKSPACE_DIRS.sites}/${workspaceKey(hash)}`;
    }

    /** @param {string} hash */
    payloadDir(hash) {
        return `${WORKSPACE_DIRS.payloads}/${workspaceKey(hash)}`;
    }

    /** @param {string} wallet @param {string} conversationId */
    chatDir(wallet, conversationId) {
        return `${WORKSPACE_DIRS.chats}/${workspaceKey(wallet || 'local')}/${workspaceKey(conversationId)}`;
    }
}

/** @type {GitWorkspace|null} */
let shared = null;

/** The page's one workspace. */
export function getGitWorkspace() {
    if (!shared) shared = new GitWorkspace();
    return shared;
}

/**
 * Replace the page's workspace — for tests, and for nothing else.
 * @param {GitWorkspace|null} workspace
 */
export function setGitWorkspaceForTests(workspace) {
    shared = workspace;
}
