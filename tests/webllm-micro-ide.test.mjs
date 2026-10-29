/**
 * The pieces of the chat's micro IDE that have no DOM: the draft the Project
 * panel rearranges before Save, the page the canvas previews, the editor's
 * CDN loader and its fallback, the batch Save applies to the repository, and
 * what a canvas save leaves in the thought store for Llama to recall.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as isomorphicGit from 'isomorphic-git';

import { createFakeOpfs } from './helpers/fake-opfs.mjs';
import { OpfsFs } from '../src/storage/OpfsFs.js';
import { GitWorkspace } from '../src/storage/GitWorkspace.js';
import { ProjectDraft, buildTree, validName } from '../src/webllm/projectTree.js';
import { buildPreviewDocument, inlineProjectAssets, resolveProjectPath } from '../src/webllm/canvasPreview.js';
import {
    CODEMIRROR_VERSIONS,
    codeMirrorUrl,
    createCodeMirrorLoader,
    editorLanguage
} from '../src/webllm/codeEditor.js';
import { ChatProjectStore, WebLLMProject, isProjectFileThought } from '../src/webllm/chatProject.js';

const WALLET = '0xabc0000000000000000000000000000000000002';

function workspace() {
    const opfs = createFakeOpfs();
    return new GitWorkspace({
        fs: new OpfsFs({ root: opfs.storage.getDirectory }),
        loadGit: async () => isomorphicGit,
        available: async () => true,
        report: () => {}
    });
}

test('a draft moves, renames and creates without touching anything, and Save gets one batch', () => {
    const draft = new ProjectDraft({ files: ['index.html', 'style.css', 'js/app.js'], dirs: ['js'] });
    assert.equal(draft.dirty, false);

    draft.mkdir('css');
    draft.move('style.css', 'css');
    draft.rename('js', 'scripts');
    draft.createFile('about.html');
    assert.deepEqual(draft.files(), ['about.html', 'css/style.css', 'index.html', 'scripts/app.js']);
    assert.equal(draft.statusOf('css/style.css'), 'moved');
    assert.equal(draft.statusOf('about.html'), 'added');
    assert.equal(draft.statusOf('index.html'), null);

    assert.deepEqual(
        draft.changes().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [
            { op: 'mkdir', path: 'css' },
            { op: 'mkdir', path: 'scripts' },
            { op: 'move', from: 'js/app.js', to: 'scripts/app.js' },
            { op: 'move', from: 'style.css', to: 'css/style.css' },
            { op: 'rmdir', path: 'js' },
            { op: 'write', path: 'about.html', bytes: '' }
        ]
    );
    assert.equal(draft.summary(), 'Organise project: move 2, add 1, create 2 folders, remove 1 folder');

    assert.throws(() => draft.relocate('about.html', 'index.html'), /already exists/);
    assert.throws(() => draft.move('scripts', 'scripts'), /itself/);
    assert.throws(() => draft.rename('index.html', '../x'), /letters/);
    draft.remove('css');
    assert.deepEqual(draft.files(), ['about.html', 'index.html', 'scripts/app.js']);
});

test('the tree lists folders first, then files, each alphabetical', () => {
    const root = buildTree(['b.js', 'a.html', 'css/z.css', 'css/a.css'], ['assets', 'css']);
    assert.deepEqual(
        root.children.map((node) => [node.kind, node.path]),
        [
            ['dir', 'assets'],
            ['dir', 'css'],
            ['file', 'a.html'],
            ['file', 'b.js']
        ]
    );
    assert.deepEqual(
        root.children[1].children.map((node) => node.name),
        ['a.css', 'z.css']
    );
    assert.equal(validName('.git'), null);
    assert.equal(validName('my page.html'), 'my page.html');
});

test('the preview inlines the project’s stylesheets and scripts, and runs a console bridge first', () => {
    const files = new Map([
        [
            'index.html',
            '<html><head><link rel="stylesheet" href="css/site.css"></head><body><script src="./app.js"></script></body></html>'
        ],
        ['css/site.css', 'h1 { color: red; }'],
        ['app.js', 'console.log("</script> is sealed")']
    ]);
    const { html, entry } = buildPreviewDocument({ path: 'index.html', code: files.get('index.html'), files });
    assert.equal(entry, 'index.html');
    assert.match(html, /<style data-file="css\/site.css">\nh1 \{ color: red; \}/);
    assert.match(html, /<script data-file="app.js">\nconsole.log\("<\\\/script> is sealed"\)/);
    assert.ok(html.indexOf('web25-canvas') < html.indexOf('data-file'), 'the bridge runs before the page');

    // A stylesheet the page links is previewed through that page, with the edit.
    const viaPage = buildPreviewDocument({ path: 'css/site.css', code: 'h1 { color: blue; }', files });
    assert.equal(viaPage.entry, 'index.html');
    assert.match(viaPage.html, /color: blue/);

    // A lone snippet gets a page of its own; markup in a text file is shown, not run.
    assert.equal(buildPreviewDocument({ path: 'x.css', code: 'p{}' }).entry, null);
    assert.match(buildPreviewDocument({ path: 'notes.md', code: '<b>hi</b>' }).html, /&lt;b>hi&lt;\/b>/);

    assert.equal(resolveProjectPath('pages', '../css/a.css'), 'css/a.css');
    assert.equal(resolveProjectPath('', 'https://cdn.example/a.js'), null);
    assert.equal(resolveProjectPath('', '../../escape.css'), null);
    assert.equal(
        inlineProjectAssets('<script src="cdn.js"></script>', 'index.html', new Map()),
        '<script src="cdn.js"></script>'
    );
});

test('CodeMirror comes from esm.sh, every package pinned to one shared set of dependencies', async () => {
    const urls = [];
    const load = createCodeMirrorLoader(async (url) => {
        urls.push(url);
        return { EditorView: function EditorView() {}, basicSetup: [] };
    });
    await load();
    await load();
    assert.equal(urls.length, 7, 'imported once per page');
    const deps = new Set(urls.map((url) => new URL(url).searchParams.get('deps')));
    assert.equal(deps.size, 1, 'the same pins for every package');
    assert.ok(urls.includes(codeMirrorUrl('@codemirror/lang-html')));
    assert.match([...deps][0], new RegExp(`@codemirror/state@${CODEMIRROR_VERSIONS['@codemirror/state']}`));

    const slow = createCodeMirrorLoader(() => new Promise(() => {}), { timeoutMs: 10 });
    await assert.rejects(slow(), /took too long/);
    assert.equal(editorLanguage('a/b.css'), 'css');
    assert.equal(editorLanguage('app.mjs'), 'javascript');
    assert.equal(editorLanguage('README'), 'text');
});

test('Save applies the whole batch as one commit, keeping folders and never deleting what it did not plan', async () => {
    const ws = workspace();
    const dir = ws.chatDir(WALLET, 'conv');
    await (
        await ws.snapshot(
            dir,
            [
                { path: 'style.css', bytes: 'a' },
                { path: 'js/app.js', bytes: 'b' }
            ],
            { message: 'Llama', replace: false }
        )
    ).committed;

    const { committed } = await ws.applyChanges(
        dir,
        [
            { op: 'mkdir', path: 'css' },
            { op: 'mkdir', path: 'assets' },
            { op: 'move', from: 'style.css', to: 'css/style.css' },
            { op: 'write', path: 'about.html', bytes: '' },
            { op: 'rmdir', path: 'js' }
        ],
        { message: 'Organise project' }
    );
    await committed;
    const entries = await ws.listEntries(dir);
    assert.deepEqual(entries.files, ['about.html', 'css/style.css', 'js/app.js']);
    assert.deepEqual(entries.dirs, ['assets', 'css', 'js'], 'js still holds a file, so it stays');
    const log = await ws.log(dir);
    assert.deepEqual(
        log.map((entry) => entry.message),
        ['Organise project', 'Llama']
    );
    await assert.rejects(
        ws.applyChanges(dir, [{ op: 'write', path: '.git/config', bytes: 'x' }], { message: 'x' }),
        /cannot be stored/
    );
});

/** A thought store with just what the project uses of it. */
function fakeThoughts() {
    const sequences = [];
    return {
        sequences,
        async listSequences({ conversationId }) {
            return {
                ok: true,
                value: { sequences: sequences.filter((entry) => entry.conversationId === conversationId) }
            };
        },
        async deleteSequence(sequenceId) {
            const index = sequences.findIndex((entry) => entry.sequenceId === sequenceId);
            if (index >= 0) sequences.splice(index, 1);
            return { ok: true };
        },
        async appendThought(command) {
            sequences.push({
                sequenceId: `seq-${sequences.length + Math.random()}`,
                conversationId: command.conversationId,
                title: command.sequenceTitle,
                thought: command.thought,
                clientRequestId: command.clientRequestId
            });
            return { ok: true };
        }
    };
}

test('a canvas save is a commit, and the one copy of the file Llama recalls', async () => {
    const thoughts = fakeThoughts();
    const controller = {
        walletAddress: WALLET,
        thoughts,
        state: {
            history: 'ready',
            conversations: [{ id: 'c1', title: 'x' }],
            activeConversationId: 'c1',
            messages: [],
            generating: false
        }
    };
    const project = new WebLLMProject({ controller, store: new ChatProjectStore({ workspace: workspace() }) });
    await project.whenIdle();
    project.handle(controller.state, { type: 'messages' });
    await project.whenIdle();

    assert.equal(await project.writeFile('./index.html', '<h1>One</h1>'), 'index.html');
    await project.writeFile('index.html', '<h1>Two</h1>');
    await project.whenIdle();
    assert.equal(await project.readFile('index.html'), '<h1>Two</h1>');
    assert.equal(project.state.commits, 2);
    assert.deepEqual(
        thoughts.sequences.map((entry) => entry.title),
        ['Project file: index.html'],
        'the older version is forgotten'
    );
    assert.match(thoughts.sequences[0].thought, /```html\n<h1>Two<\/h1>\n```/);
    assert.equal(isProjectFileThought(thoughts.sequences[0]), true);

    // Moving the file moves the memory; deleting it forgets it.
    await project.applyChanges([{ op: 'move', from: 'index.html', to: 'pages/index.html' }], 'Organise project');
    await project.whenIdle();
    assert.deepEqual(project.state.files, ['pages/index.html']);
    assert.deepEqual(
        thoughts.sequences.map((entry) => entry.title),
        ['Project file: pages/index.html']
    );
    await project.applyChanges([{ op: 'delete', path: 'pages/index.html' }], 'Organise project');
    await project.whenIdle();
    assert.deepEqual(thoughts.sequences, []);
    await assert.rejects(project.writeFile('../x.html', ''), /file name like/);
});
