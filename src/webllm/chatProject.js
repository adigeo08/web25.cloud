// @ts-check
/**
 * A Llama conversation's project: the code it wrote, as files.
 *
 * Every code block in a reply can carry a file name. Blocks that name one —
 * on the fence (```html index.html), as a comment on their first line
 * (<!-- index.html -->, // app.js), or on the line of text just above them
 * (**style.css**:) — are saved into the conversation's tree when the reply
 * finishes; any other block can be added by naming it in the chat. The tree is
 * a git repository in OPFS (`/web25/chats/<wallet>/<conversation>`, see
 * `GitWorkspace`), so each reply that changes files is a commit and an earlier
 * version of a file is still in the history after Llama rewrites it.
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
 *             explicit: boolean, suggested: string|null }} CodeFile
 */

/**
 * The code blocks of a reply as files: the name each one gives itself, or the
 * name it would get. `index` counts code blocks in the reply, in the order they
 * are drawn. Blocks still being streamed are left out.
 *
 * @param {string} content
 * @returns {CodeFile[]}
 */
export function extractCodeFiles(content) {
    /** @type {CodeFile[]} */
    const files = [];
    const blocks = splitReply(content);
    let index = -1;
    blocks.forEach((block, position) => {
        if (block.type !== 'code') return;
        index += 1;
        if (!block.closed) return;
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
            suggested: filename || SUGGESTED_NAMES[/** @type {keyof typeof SUGGESTED_NAMES} */ (lang)] || null
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
 * The trees of one browser's Llama conversations.
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
     * @returns {Promise<{ paths: string[], committed: Promise<string|null> }>}
     */
    async save(wallet, conversationId, files, message) {
        const entries = [];
        for (const file of files) {
            const path = projectPath(file.path);
            if (!path) throw new Error(`"${file.path}" is not a file name a project can use.`);
            entries.push({ path, bytes: new TextEncoder().encode(file.code) });
        }
        if (entries.length === 0) return { paths: [], committed: Promise.resolve(null) };
        return this.workspace.snapshot(this.dir(wallet, conversationId), entries, {
            message,
            author: { name: 'Llama', email: 'llama@web25.cloud' },
            replace: false
        });
    }

    /** @param {string} wallet @param {string} conversationId @param {string} path */
    async removeFile(wallet, conversationId, path) {
        return this.workspace.removeFiles(this.dir(wallet, conversationId), [path], {
            message: `Remove ${path}`,
            author: { name: 'Llama', email: 'llama@web25.cloud' }
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
 * @typedef {{ available: boolean, conversationId: string|null, files: string[],
 *             commit: string|null, commits: number, busy: boolean, notice: string }} ProjectState
 */

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
            const [files, history] = await Promise.all([
                this.store.files(wallet, conversationId),
                this.store.history(wallet, conversationId)
            ]);
            if (conversationId !== this.state.conversationId) return;
            this.update({ files, commit: history[0]?.oid || null, commits: history.length });
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
        const named = extractCodeFiles(reply.content).filter((file) => file.explicit && file.filename);
        if (named.length === 0) return;
        // The last block for a name is the one that counts.
        const byName = new Map(named.map((file) => [/** @type {string} */ (file.filename), file.code]));
        await this.save(
            conversationId,
            [...byName].map(([path, code]) => ({ path, code })),
            `Llama: ${[...byName.keys()].join(', ')}`
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
        const block = message ? extractCodeFiles(message.content).find((file) => file.index === blockIndex) : null;
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
            const result = await this.store.save(wallet, conversationId, files, message);
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

    /** @param {string} path */
    async removeFile(path) {
        const wallet = this.wallet();
        const conversationId = this.state.conversationId;
        if (!wallet || !conversationId) return;
        const { committed } = await this.store.removeFile(wallet, conversationId, path);
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
