// @ts-check
/**
 * A chat conversation's project: the code it wrote, as files.
 *
 * Every code block in a reply can carry a file name. Blocks that name one —
 * on the fence (```html index.html), as a comment on their first line
 * (<!-- index.html -->, // app.js), or on the line of text just above them
 * (**style.css**:) — are saved into the conversation's tree when the reply
 * finishes; any other block can be added by naming it in the chat. The tree is
 * a git repository in OPFS (`/web25/chats/<wallet>/<conversation>`, see
 * `GitWorkspace`), so each reply that changes files is a commit and an earlier
 * version of a file is still in the history after the model rewrites it.
 *
 * Deploy project exports the tree to the Deploy tab as a folder, the same way
 * a folder picked from the device arrives there, and the deployment that
 * follows is the ordinary one.
 *
 * Model output is untrusted: a name it suggests is reduced to a safe relative
 * path before it touches the file system, and never reaches `.git`.
 */

import { splitReply } from '../ui/webllm/replyFormat.js';
import { getGitWorkspace, safeTreePath } from '../storage/GitWorkspace.js';
import { folderFile, stageDeployFiles } from '../ui/publish/StageDeploy.js';

/** The kinds of file a project is made of, by extension, and their language. */
export const PROJECT_FILE_TYPES = Object.freeze({
    html: { lang: 'html', type: 'text/html' },
    htm: { lang: 'html', type: 'text/html' },
    css: { lang: 'css', type: 'text/css' },
    js: { lang: 'javascript', type: 'text/javascript' },
    mjs: { lang: 'javascript', type: 'text/javascript' },
    cjs: { lang: 'javascript', type: 'text/javascript' },
    jsx: { lang: 'jsx', type: 'text/javascript' },
    ts: { lang: 'typescript', type: 'text/plain' },
    tsx: { lang: 'tsx', type: 'text/plain' },
    json: { lang: 'json', type: 'application/json' },
    webmanifest: { lang: 'json', type: 'application/manifest+json' },
    svg: { lang: 'svg', type: 'image/svg+xml' },
    xml: { lang: 'xml', type: 'application/xml' },
    md: { lang: 'markdown', type: 'text/markdown' },
    txt: { lang: 'text', type: 'text/plain' },
    csv: { lang: 'csv', type: 'text/csv' },
    yml: { lang: 'yaml', type: 'text/yaml' },
    yaml: { lang: 'yaml', type: 'text/yaml' }
});

/** The name offered for a block that names no file, by language. */
const SUGGESTED_NAMES = Object.freeze({
    html: 'index.html',
    css: 'style.css',
    js: 'script.js',
    javascript: 'script.js',
    json: 'data.json',
    svg: 'image.svg'
});

const MAX_NAME_LENGTH = 120;
const EXTENSIONS = Object.keys(PROJECT_FILE_TYPES).join('|');
const NAME = `[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\\.(?:${EXTENSIONS})`;
/** A whole line that is only a file name, possibly as a comment or a label. */
const NAME_LINE = new RegExp(
    `^\\s*(<!--|/\\*|//|#|;)?\\s*(?:file(?:name)?\\s*[:=]\\s*)?(${NAME})\\s*(?:-->|\\*/)?\\s*$`,
    'i'
);
/** A line of text that is a file name as a heading or a label: **index.html**: */
const LABEL_LINE = new RegExp(`^\\s*(?:#{1,4}\\s*)?(?:\\*\\*|\`)?(${NAME})(?:\\*\\*|\`)?\\s*:?\\s*$`, 'i');
const ANY_NAME = new RegExp(`(?:^|[\\s\`*'"(])(${NAME})(?=$|[\\s\`*'"),:.!?])`, 'gi');

/**
 * A file name from a model or a person, as a safe project path, or null.
 * @param {string} name
 */
export function projectPath(name) {
    const raw = `${name || ''}`.trim().replace(/^\.\/+/, '');
    if (!raw || raw.length > MAX_NAME_LENGTH || !/^[A-Za-z0-9_./ -]+$/.test(raw)) return null;
    const path = safeTreePath(raw);
    if (!path || path.split('/').some((segment) => segment.trim() !== segment)) return null;
    return path;
}

/** @param {string} path */
export function fileTypeOf(path) {
    const ext = `${path}`.split('.').pop()?.toLowerCase() || '';
    return /** @type {{ lang: string, type: string }|undefined} */ (PROJECT_FILE_TYPES[ext]) || null;
}

/**
 * The file name a text block announces for the code right after it.
 * @param {string} text
 */
function nameFromText(text) {
    const lines = `${text || ''}`.split('\n').filter((line) => line.trim());
    const last = lines[lines.length - 1] || '';
    const label = last.match(LABEL_LINE);
    if (label) return label[1];
    const names = new Set([...last.matchAll(ANY_NAME)].map((match) => match[1]));
    // "Save this as app.js:" names one file; a sentence naming two is not a label.
    return names.size === 1 ? [...names][0] : null;
}

/**
 * @typedef {{ index: number, lang: string, code: string, filename: string|null,
 *             explicit: boolean, suggested: string|null, complete: boolean }} CodeFile
 *   complete  its fence was closed. A block left open in a finished reply is the
 *             reply's last one, cut by the length limit (common on a phone, with
 *             its 256-token replies) or never closed by the model.
 */

/**
 * The code blocks of a reply as files: the name each one gives itself, or the
 * name it would get. `index` counts code blocks in the reply, in the order they
 * are drawn. A block still open is left out while the reply is being written;
 * once it has `finished`, nothing more will come, so the open block is a file
 * too — one that can be named, previewed, edited and saved, marked incomplete.
 *
 * @param {string} content
 * @param {{ finished?: boolean }} [options]
 * @returns {CodeFile[]}
 */
export function extractCodeFiles(content, { finished = false } = {}) {
    /** @type {CodeFile[]} */
    const files = [];
    const blocks = splitReply(content);
    let index = -1;
    blocks.forEach((block, position) => {
        if (block.type !== 'code') return;
        index += 1;
        if (!block.closed && !finished) return;
        let { lang, code } = block;
        let name = null;

        // ```index.html: the language slot holds a file name.
        if (lang.includes('.') && projectPath(lang) && fileTypeOf(lang)) {
            name = lang;
            lang = fileTypeOf(lang)?.lang || '';
        }

        // The first line names the file — the rest of an ```html index.html
        // fence line, or a comment the code itself carries.
        const lines = code.split('\n');
        const first = lines[0]?.match(NAME_LINE);
        if (first) {
            if (!name) name = first[2];
            // A bare name is a label, not code; a comment is code and stays.
            if (!first[1]) code = lines.slice(1).join('\n');
        }

        if (!name) {
            const before = blocks[position - 1];
            if (before?.type === 'text') name = nameFromText(before.text);
        }

        const filename = name ? projectPath(name) : null;
        files.push({
            index,
            lang,
            code,
            filename,
            explicit: Boolean(filename),
            suggested: filename || SUGGESTED_NAMES[/** @type {keyof typeof SUGGESTED_NAMES} */ (lang)] || null,
            complete: Boolean(block.closed)
        });
    });
    return files;
}

/** A folder name for a conversation's export. @param {string} title */
export function projectFolderName(title) {
    const slug = `${title || ''}`
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '');
    return slug || 'llama-project';
}

/**
 * Who a project commit is by: the signed-in identity, as its Nostr address
 * (npub). The model that wrote the code is never the author — its name is
 * only for the chat to show. Without an npub (Nostr turned off for this
 * wallet), the wallet address stands in.
 * @param {string|null|undefined} npub
 * @param {string|null|undefined} wallet
 * @returns {{ name: string, email: string }}
 */
export function commitAuthor(npub, wallet) {
    return { name: `${npub || wallet || 'WEB25'}`, email: '' };
}

/**
 * The trees of one browser's chat conversations.
 */
export class ChatProjectStore {
    /** @param {{ workspace?: import('../storage/GitWorkspace.js').GitWorkspace }} [options] */
    constructor({ workspace } = {}) {
        this.workspace = workspace || getGitWorkspace();
    }

    available() {
        return this.workspace.isAvailable();
    }

    /** @param {string} wallet @param {string} conversationId */
    dir(wallet, conversationId) {
        return this.workspace.chatDir(wallet, conversationId);
    }

    /** @param {string} wallet @param {string} conversationId */
    async files(wallet, conversationId) {
        const dir = this.dir(wallet, conversationId);
        return this.workspace.read(dir, () => this.workspace.listFiles(dir));
    }

    /** Files and folders, empty folders included. @param {string} wallet @param {string} conversationId */
    async entries(wallet, conversationId) {
        const dir = this.dir(wallet, conversationId);
        return this.workspace.read(dir, () => this.workspace.listEntries(dir));
    }

    /**
     * One file's text.
     * @param {string} wallet
     * @param {string} conversationId
     * @param {string} path
     */
    async readText(wallet, conversationId, path) {
        const dir = this.dir(wallet, conversationId);
        const bytes = await this.workspace.read(dir, () => this.workspace.readFile(dir, path));
        return new TextDecoder().decode(bytes);
    }

    /**
     * Every file's text, by path — what the canvas previews a page against.
     * @param {string} wallet
     * @param {string} conversationId
     * @returns {Promise<Map<string, string>>}
     */
    async readAllText(wallet, conversationId) {
        const dir = this.dir(wallet, conversationId);
        const files = await this.workspace.read(dir, () => this.workspace.readTree(dir));
        const decoder = new TextDecoder();
        return new Map(files.map(({ path, bytes }) => [path, decoder.decode(bytes)]));
    }

    /**
     * Apply the Project panel's batch — moves, renames, new files and folders,
     * deletions — as one commit.
     * @param {string} wallet
     * @param {string} conversationId
     * @param {import('./projectTree.js').ProjectChange[]} changes
     * @param {string} message
     * @param {{ name: string, email: string }} [author]
     */
    async apply(wallet, conversationId, changes, message, author = commitAuthor(null, wallet)) {
        for (const change of changes) {
            const paths = change.op === 'move' ? [change.from, change.to] : [change.path];
            for (const path of paths) {
                if (!projectPath(path)) throw new Error(`"${path}" is not a name a project can use.`);
            }
        }
        return this.workspace.applyChanges(this.dir(wallet, conversationId), changes, {
            message,
            author
        });
    }

    /** @param {string} wallet @param {string} conversationId */
    async history(wallet, conversationId) {
        return this.workspace.log(this.dir(wallet, conversationId));
    }

    /**
     * Write files into the tree and commit them. Files already there and not
     * named here are kept: a reply that rewrites style.css leaves index.html.
     *
     * @param {string} wallet
     * @param {string} conversationId
     * @param {{ path: string, code: string }[]} files
     * @param {string} message
     * @param {{ name: string, email: string }} [author]
     * @returns {Promise<{ paths: string[], committed: Promise<string|null> }>}
     */
    async save(wallet, conversationId, files, message, author = commitAuthor(null, wallet)) {
        const entries = [];
        for (const file of files) {
            const path = projectPath(file.path);
            if (!path) throw new Error(`"${file.path}" is not a file name a project can use.`);
            entries.push({ path, bytes: new TextEncoder().encode(file.code) });
        }
        if (entries.length === 0) return { paths: [], committed: Promise.resolve(null) };
        return this.workspace.snapshot(this.dir(wallet, conversationId), entries, {
            message,
            author,
            replace: false
        });
    }

    /**
     * @param {string} wallet @param {string} conversationId @param {string} path
     * @param {{ name: string, email: string }} [author]
     */
    async removeFile(wallet, conversationId, path, author = commitAuthor(null, wallet)) {
        return this.workspace.removeFiles(this.dir(wallet, conversationId), [path], {
            message: `Remove ${path}`,
            author
        });
    }

    /** @param {string} wallet @param {string} conversationId */
    async remove(wallet, conversationId) {
        await this.workspace.remove(this.dir(wallet, conversationId));
    }

    /**
     * The tree as a picked folder: files under `folder/`, typed by extension.
     * @param {string} wallet
     * @param {string} conversationId
     * @param {string} folder
     * @returns {Promise<File[]>}
     */
    async exportFiles(wallet, conversationId, folder) {
        const dir = this.dir(wallet, conversationId);
        const files = await this.workspace.read(dir, () => this.workspace.readTree(dir));
        return files.map(({ path, bytes }) =>
            folderFile(`${folder}/${path}`, /** @type {BlobPart} */ (bytes), fileTypeOf(path)?.type || '')
        );
    }
}

/**
 * @typedef {{ available: boolean, conversationId: string|null, files: string[], dirs: string[],
 *             commit: string|null, commits: number, busy: boolean, notice: string }} ProjectState
 */

/** How a saved file is marked in the thought store, so it can be found again. */
export const PROJECT_FILE_THOUGHT = 'project-file:';
const PROJECT_FILE_TITLE = 'Project file: ';
/** Room left for the code once the thought's own words are counted. */
const MAX_FILE_THOUGHT_CODE = 18000;

/** Whether a thought is a project file the user saved. @param {{ clientRequestId?: string|null }} thought */
export function isProjectFileThought(thought) {
    return `${thought?.clientRequestId || ''}`.startsWith(PROJECT_FILE_THOUGHT);
}

/** A short, stable fingerprint of a file's text. @param {string} text */
function fingerprint(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/**
 * Keeps the open conversation's project in step with the chat.
 *
 * Fed every change of `WebLLMController` (it never changes the chat itself):
 * a conversation opened loads its file list; a reply that finished saves the
 * files it named; a conversation that left the list — deleted, or expired by
 * the retention setting — takes its tree with it.
 */
export class WebLLMProject {
    /**
     * @param {{ controller: any, store?: ChatProjectStore, onChange?: (state: ProjectState) => void,
     *           stage?: (files: File[]) => boolean, log?: (message: string) => void }} deps
     */
    constructor({ controller, store, onChange = () => {}, stage, log = () => {} }) {
        this.controller = controller;
        this.store = store || new ChatProjectStore();
        this.onChange = onChange;
        this.stage = stage || ((files) => stageDeployFiles(files, { source: 'webllm' }));
        this.log = log;
        /** @type {ProjectState} */
        this.state = {
            available: false,
            conversationId: null,
            files: [],
            dirs: [],
            commit: null,
            commits: 0,
            busy: false,
            notice: ''
        };
        this._wasGenerating = false;
        /** @type {string|null} */
        this._wallet = null;
        /** @type {Set<string>} */
        this._known = new Set();
        this._historyReady = false;
        /** Replies already saved, so a redraw never saves one twice. @type {Set<string>} */
        this._saved = new Set();
        /** Background work in flight, for `whenIdle`. @type {Set<Promise<any>>} */
        this._pending = new Set();
        this.track(this.store.available().then((available) => this.update({ available })));
    }

    /** @param {Partial<ProjectState>} patch */
    update(patch) {
        Object.assign(this.state, patch);
        this.onChange(this.state);
    }

    wallet() {
        return this.controller.walletAddress || null;
    }

    /** Every commit is the signed-in user's, by their Nostr address. */
    author() {
        return commitAuthor(this.controller.npub, this.wallet());
    }

    /**
     * React to one controller change.
     * @param {any} chat the controller's state
     * @param {{ type: string }} [change]
     */
    handle(chat, change = { type: 'state' }) {
        if (change.type === 'delta' || change.type === 'progress') return;
        const wallet = this.wallet();
        const conversations = new Set((chat.conversations || []).map((/** @type {any} */ entry) => entry.id));
        const ready = chat.history === 'ready';

        // Conversations that left the list while the same wallet was signed in.
        if (wallet && wallet === this._wallet && ready && this._historyReady && change.type === 'messages') {
            for (const id of this._known) {
                if (!conversations.has(id) && id !== chat.activeConversationId) this.track(this.forget(wallet, id));
            }
        }
        this._wallet = wallet;
        this._known = conversations;
        this._historyReady = ready;

        if (chat.activeConversationId !== this.state.conversationId) {
            this.update({
                conversationId: chat.activeConversationId || null,
                files: [],
                commit: null,
                commits: 0,
                notice: ''
            });
            this.track(this.refresh());
        }

        if (this._wasGenerating && !chat.generating) this.track(this.saveFinishedReply(chat));
        this._wasGenerating = Boolean(chat.generating);
    }

    /** Reload the open conversation's file list and history. */
    async refresh() {
        const wallet = this.wallet();
        const conversationId = this.state.conversationId;
        if (!wallet || !conversationId || !this.state.available) return;
        try {
            const [entries, history] = await Promise.all([
                this.store.entries(wallet, conversationId),
                this.store.history(wallet, conversationId)
            ]);
            if (conversationId !== this.state.conversationId) return;
            this.update({
                files: entries.files,
                dirs: entries.dirs,
                commit: history[0]?.oid || null,
                commits: history.length
            });
        } catch (error) {
            this.log(`Project files could not be read: ${error?.message || error}`);
        }
    }

    /** Save the files the reply that just finished named. @param {any} chat */
    async saveFinishedReply(chat) {
        const conversationId = chat.activeConversationId;
        const messages = chat.messages || [];
        const reply = messages[messages.length - 1];
        if (!conversationId || !reply || reply.role !== 'assistant' || reply.error) return;
        // A continued reply is the same message grown longer, and saved again.
        const key = `${conversationId}:${reply.id}:${`${reply.content || ''}`.length}`;
        if (this._saved.has(key)) return;
        this._saved.add(key);
        // A block left open is saved by itself only when the model ended the
        // reply there; one cut by the length limit waits for Continue, or for
        // the user's own Save.
        const named = extractCodeFiles(reply.content, { finished: true }).filter(
            (file) => file.explicit && file.filename && (file.complete || reply.finishReason === 'stop')
        );
        if (named.length === 0) return;
        // The last block for a name is the one that counts.
        const byName = new Map(named.map((file) => [/** @type {string} */ (file.filename), file.code]));
        await this.save(
            conversationId,
            [...byName].map(([path, code]) => ({ path, code })),
            `Save ${[...byName.keys()].join(', ')}`
        );
    }

    /**
     * Save one code block of a reply under a name chosen in the chat.
     * @param {string|number} messageId
     * @param {number} blockIndex
     * @param {string} filename
     */
    async saveBlock(messageId, blockIndex, filename) {
        const chat = this.controller.state;
        const conversationId = chat.activeConversationId;
        if (!conversationId) throw new Error('Send a message first: a project belongs to a saved conversation.');
        const path = projectPath(filename);
        if (!path) throw new Error('Use a file name like index.html, style.css or js/app.js.');
        const message = (chat.messages || []).find((/** @type {any} */ entry) => `${entry.id}` === `${messageId}`);
        const block = message
            ? extractCodeFiles(message.content, { finished: !message.pending }).find(
                  (file) => file.index === blockIndex
              )
            : null;
        if (!block) throw new Error('That code block is no longer in the conversation.');
        await this.save(conversationId, [{ path, code: block.code }], `Save ${path}`);
        return path;
    }

    /**
     * @param {string} conversationId
     * @param {{ path: string, code: string }[]} files
     * @param {string} message
     */
    async save(conversationId, files, message) {
        const wallet = this.wallet();
        if (!wallet || !this.state.available) return null;
        try {
            const result = await this.store.save(wallet, conversationId, files, message, this.author());
            // The files are there now; the commit follows, and the bar's git
            // line with it.
            if (conversationId === this.state.conversationId) await this.refresh();
            this.track(result.committed.then(() => this.refresh()));
            return result;
        } catch (error) {
            this.log(`Project files could not be saved: ${error?.message || error}`);
            throw error;
        }
    }

    /** The open conversation's wallet and id, or an error saying why there is none. */
    target() {
        const wallet = this.wallet();
        const conversationId = this.state.conversationId;
        if (!wallet || !conversationId || !this.state.available) {
            throw new Error('Send a message first: a project belongs to a saved conversation.');
        }
        return { wallet, conversationId };
    }

    /** @param {string} path */
    async readFile(path) {
        const { wallet, conversationId } = this.target();
        return this.store.readText(wallet, conversationId, path);
    }

    /** Every file of the open project, text by path. */
    async readAll() {
        const { wallet, conversationId } = this.target();
        return this.store.readAllText(wallet, conversationId);
    }

    /**
     * Save a file from the canvas: into the project, as a commit, and into the
     * thought store, where the model recalls it — by similarity, through
     * idb-vector — the next time it answers in this conversation.
     *
     * @param {string} path
     * @param {string} code
     * @returns {Promise<string>} the path saved under
     */
    async writeFile(path, code) {
        const { conversationId } = this.target();
        const safe = projectPath(path);
        if (!safe) throw new Error('Use a file name like index.html, style.css or js/app.js.');
        await this.save(conversationId, [{ path: safe, code }], `Edit ${safe}`);
        this.track(this.rememberFile(conversationId, safe, code));
        return safe;
    }

    /**
     * Apply the Project panel's batch, then bring the model's memory of the files
     * in line: a deleted file is forgotten, a moved one remembered under its
     * new name.
     * @param {import('./projectTree.js').ProjectChange[]} changes
     * @param {string} message
     */
    async applyChanges(changes, message) {
        const { wallet, conversationId } = this.target();
        if (changes.length === 0) return;
        const { committed } = await this.store.apply(wallet, conversationId, changes, message, this.author());
        await this.refresh();
        this.track(committed.then(() => this.refresh()));
        for (const change of changes) {
            if (change.op === 'delete') this.track(this.forgetFile(conversationId, change.path));
            if (change.op === 'move') {
                this.track(
                    this.forgetFile(conversationId, change.from).then(async (known) => {
                        if (known) await this.rememberFile(conversationId, change.to, await this.readFile(change.to));
                    })
                );
            }
        }
    }

    /**
     * Drop what the thought store holds about one file.
     * @param {string} conversationId
     * @param {string} path
     * @returns {Promise<boolean>} whether it held anything
     */
    async forgetFile(conversationId, path) {
        const thoughts = this.controller.thoughts;
        if (!thoughts?.listSequences) return false;
        const listed = await thoughts.listSequences({ conversationId, limit: 100 });
        if (!listed?.ok) return false;
        let found = false;
        for (const sequence of listed.value.sequences) {
            if (sequence.title !== `${PROJECT_FILE_TITLE}${path}`) continue;
            found = true;
            await thoughts.deleteSequence(sequence.sequenceId);
        }
        return found;
    }

    /**
     * Keep one file's current text where the model recalls from. One thought per
     * file: the previous version is dropped first, so the model never recalls code
     * the user has since changed.
     * @param {string} conversationId
     * @param {string} path
     * @param {string} code
     */
    async rememberFile(conversationId, path, code) {
        const thoughts = this.controller.thoughts;
        if (!thoughts?.appendThought) return false;
        try {
            await this.forgetFile(conversationId, path);
            const lang = fileTypeOf(path)?.lang || '';
            const body = code.length > MAX_FILE_THOUGHT_CODE ? `${code.slice(0, MAX_FILE_THOUGHT_CODE)}\n…` : code;
            const result = await thoughts.appendThought({
                conversationId,
                sequenceTitle: `${PROJECT_FILE_TITLE}${path}`,
                thought: `The user's project file ${path}, as they last saved it:\n\`\`\`${lang}\n${body}\n\`\`\``,
                thoughtNumber: 1,
                totalThoughts: 1,
                nextThoughtNeeded: false,
                clientRequestId: `${PROJECT_FILE_THOUGHT}${path.slice(0, 80)}:${fingerprint(code)}`
            });
            return Boolean(result?.ok);
        } catch (error) {
            this.log(`The model could not be shown ${path}: ${error?.message || error}`);
            return false;
        }
    }

    /** @param {string} path */
    async removeFile(path) {
        const wallet = this.wallet();
        const conversationId = this.state.conversationId;
        if (!wallet || !conversationId) return;
        const { committed } = await this.store.removeFile(wallet, conversationId, path, this.author());
        await this.refresh();
        this.track(committed.then(() => this.refresh()));
    }

    /**
     * Keep a piece of background work in view until it settles.
     * @param {Promise<any>} work
     */
    track(work) {
        const settled = work.catch(() => {});
        this._pending.add(settled);
        void settled.then(() => this._pending.delete(settled));
        return work;
    }

    /** Resolves once saves, commits and refreshes started so far have settled. */
    async whenIdle() {
        while (this._pending.size > 0) await Promise.all([...this._pending]);
    }

    /** @param {string} wallet @param {string} conversationId */
    async forget(wallet, conversationId) {
        try {
            await this.store.remove(wallet, conversationId);
        } catch (error) {
            this.log(`Project of a deleted conversation could not be removed: ${error?.message || error}`);
        }
    }

    /**
     * Send the open conversation's project to the Deploy tab.
     * @returns {Promise<number>} how many files were handed over
     */
    async deploy() {
        const wallet = this.wallet();
        const conversationId = this.state.conversationId;
        if (!wallet || !conversationId || this.state.files.length === 0) {
            throw new Error('This conversation has no project files yet.');
        }
        this.update({ busy: true, notice: '' });
        try {
            const title =
                (this.controller.state.conversations || []).find(
                    (/** @type {any} */ entry) => entry.id === conversationId
                )?.title || '';
            const files = await this.store.exportFiles(wallet, conversationId, projectFolderName(title));
            if (files.length === 0) throw new Error('This conversation has no project files yet.');
            this.stage(files);
            this.update({
                busy: false,
                notice: `Sent ${files.length} file${files.length === 1 ? '' : 's'} to Deploy.`
            });
            return files.length;
        } catch (error) {
            this.update({ busy: false, notice: `${/** @type {any} */ (error)?.message || error}` });
            throw error;
        }
    }
}
