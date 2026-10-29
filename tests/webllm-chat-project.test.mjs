/**
 * A Llama conversation's code, as a project.
 *
 * Code blocks that name a file are saved into the conversation's git
 * repository when the reply finishes; any other block can be named and saved
 * from the chat; Deploy project hands the tree to the Deploy tab as a folder,
 * which from there is deployed like any folder picked from the device.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as isomorphicGit from 'isomorphic-git';

import { createFakeOpfs } from './helpers/fake-opfs.mjs';
import { OpfsFs } from '../src/storage/OpfsFs.js';
import { GitWorkspace } from '../src/storage/GitWorkspace.js';
import {
    ChatProjectStore,
    WebLLMProject,
    commitAuthor,
    extractCodeFiles,
    projectFolderName,
    projectPath
} from '../src/webllm/chatProject.js';
import { STAGE_DEPLOY_EVENT, folderFile, stageDeployFiles } from '../src/ui/publish/StageDeploy.js';

const WALLET = '0xabc0000000000000000000000000000000000001';
const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxxxxxx';

function store() {
    const opfs = createFakeOpfs();
    const workspace = new GitWorkspace({
        fs: new OpfsFs({ root: opfs.storage.getDirectory }),
        loadGit: async () => isomorphicGit,
        available: async () => true,
        report: () => {}
    });
    return { opfs, workspace, store: new ChatProjectStore({ workspace }) };
}

const fence = '```';

test('a block names its file on the fence, in a comment, or in the line above it', () => {
    const reply = [
        `${fence}html index.html`,
        '<h1>Hello</h1>',
        fence,
        'And the styles:',
        `${fence}css`,
        '/* style.css */',
        'h1 { color: red; }',
        fence,
        '**js/app.js**:',
        `${fence}javascript`,
        'console.log(1);',
        fence,
        `${fence}data.json`,
        '{"a": 1}',
        fence,
        `${fence}js`,
        'alert(1);',
        fence
    ].join('\n');

    const files = extractCodeFiles(reply);
    assert.deepEqual(
        files.map((file) => [file.index, file.filename, file.explicit, file.suggested]),
        [
            [0, 'index.html', true, 'index.html'],
            [1, 'style.css', true, 'style.css'],
            [2, 'js/app.js', true, 'js/app.js'],
            [3, 'data.json', true, 'data.json'],
            [4, null, false, 'script.js']
        ]
    );
    // A name on the fence is a label, not code; a name in a comment is code.
    assert.equal(files[0].code, '<h1>Hello</h1>');
    assert.equal(files[1].code, '/* style.css */\nh1 { color: red; }');
    assert.equal(files[3].lang, 'json');
});

test('a sentence that mentions two files does not name the block', () => {
    const reply = ['Link style.css from index.html like this:', `${fence}html`, '<link rel="stylesheet">', fence].join(
        '\n'
    );
    const [file] = extractCodeFiles(reply);
    assert.equal(file.filename, null);
    assert.equal(file.suggested, 'index.html');
});

test('a block still being written is not a file yet', () => {
    assert.deepEqual(extractCodeFiles(`${fence}html index.html\n<h1>`), []);
});

test('names from the model are made safe or refused', () => {
    assert.equal(projectPath('./index.html'), 'index.html');
    assert.equal(projectPath('js/app.js'), 'js/app.js');
    assert.equal(projectPath('../../etc/passwd'), null);
    assert.equal(projectPath('.git/config'), null);
    assert.equal(projectPath('<script>.html'), null);
    assert.equal(projectPath(''), null);
    assert.equal(projectFolderName('Build me a Landing Page!'), 'build-me-a-landing-page');
    assert.equal(projectFolderName(''), 'llama-project');
});

/** Enough of WebLLMController for the project: its state and its wallet. */
function fakeController() {
    return {
        walletAddress: WALLET,
        npub: NPUB,
        state: {
            history: 'ready',
            conversations: [{ id: 'conv-1', title: 'Landing page' }],
            activeConversationId: null,
            messages: [],
            generating: false
        }
    };
}

async function settle(project) {
    await project.whenIdle();
    return project.state;
}

test('a finished reply saves the files it names, as one commit', async () => {
    const { store: projects, workspace } = store();
    const controller = fakeController();
    const project = new WebLLMProject({ controller, store: projects });
    await settle(project);

    Object.assign(controller.state, { activeConversationId: 'conv-1', generating: true });
    project.handle(controller.state, { type: 'state' });
    controller.state.messages = [
        { id: 1, role: 'user', content: 'Make a page' },
        {
            id: 2,
            role: 'assistant',
            content: `${fence}html index.html\n<h1>Hi</h1>\n${fence}\n${fence}css style.css\nh1{}\n${fence}\n${fence}js\nalert(1)\n${fence}`
        }
    ];
    controller.state.generating = false;
    project.handle(controller.state, { type: 'state' });
    const state = await settle(project);

    assert.deepEqual(state.files, ['index.html', 'style.css']);
    assert.equal(state.commits, 1);
    assert.match(state.commit, /^[0-9a-f]{40}$/);
    const dir = workspace.chatDir(WALLET, 'conv-1');
    const [commit] = await workspace.log(dir);
    // The user's Nostr address is the author; the model is named nowhere in git.
    assert.equal(commit.message, 'Save index.html, style.css');
    assert.equal(commit.author, NPUB);

    // The unnamed block is saved by naming it in the chat.
    assert.equal(await project.saveBlock(2, 2, 'js/main.js'), 'js/main.js');
    assert.deepEqual(project.state.files, ['index.html', 'js/main.js', 'style.css']);
    await settle(project);
    assert.equal(project.state.commits, 2);
    await assert.rejects(project.saveBlock(2, 2, '../x.js'), /file name like/);

    // The same finished reply redrawn is not saved twice.
    project.handle(controller.state, { type: 'state' });
    await settle(project);
    assert.equal(project.state.commits, 2);
});

test('Deploy project hands the tree to Deploy as a picked folder', async () => {
    const { store: projects } = store();
    const controller = fakeController();
    controller.state.activeConversationId = 'conv-1';
    /** @type {File[]} */
    let staged = [];
    const project = new WebLLMProject({
        controller,
        store: projects,
        stage: (files) => {
            staged = files;
            return true;
        }
    });
    await settle(project);
    project.handle(controller.state, { type: 'messages' });
    await project.save(
        'conv-1',
        [
            { path: 'index.html', code: '<h1>Hi</h1>' },
            { path: 'css/site.css', code: 'h1{}' }
        ],
        'Save'
    );

    assert.equal(await project.deploy(), 2);
    assert.deepEqual(
        staged.map((file) => [file.webkitRelativePath, file.path, file.name, file.type]),
        [
            ['landing-page/css/site.css', 'landing-page/css/site.css', 'site.css', 'text/css'],
            ['landing-page/index.html', 'landing-page/index.html', 'index.html', 'text/html']
        ]
    );
    assert.equal(await staged[1].text(), '<h1>Hi</h1>');
    assert.equal(project.state.notice, 'Sent 2 files to Deploy.');
});

test('a conversation that leaves the list takes its project with it', async () => {
    const { store: projects, workspace } = store();
    const controller = fakeController();
    controller.state.conversations = [
        { id: 'conv-1', title: 'one' },
        { id: 'conv-2', title: 'two' }
    ];
    controller.state.activeConversationId = 'conv-1';
    const project = new WebLLMProject({ controller, store: projects });
    await settle(project);
    project.handle(controller.state, { type: 'messages' });
    await projects.save(WALLET, 'conv-2', [{ path: 'a.js', code: '1' }], 'Save');
    assert.deepEqual(await workspace.listFiles(workspace.chatDir(WALLET, 'conv-2')), ['a.js']);

    // Locking resets the chat state; that is not a deletion.
    project.handle({ ...controller.state, history: 'off', conversations: [] }, { type: 'state' });
    project.handle(controller.state, { type: 'messages' });
    await settle(project);
    assert.deepEqual(await workspace.listFiles(workspace.chatDir(WALLET, 'conv-2')), ['a.js']);

    controller.state.conversations = [{ id: 'conv-1', title: 'one' }];
    project.handle(controller.state, { type: 'messages' });
    await settle(project);
    assert.deepEqual(await workspace.listFiles(workspace.chatDir(WALLET, 'conv-2')), []);
});

test('staging dispatches the files the Deploy tab listens for', () => {
    const target = new EventTarget();
    let received = null;
    target.addEventListener(STAGE_DEPLOY_EVENT, (event) => {
        received = /** @type {CustomEvent} */ (event).detail;
    });
    const file = folderFile('site/index.html', '<p>x</p>', 'text/html');
    assert.equal(stageDeployFiles([file], { source: 'webllm', target }), true);
    assert.equal(received.source, 'webllm');
    assert.equal(received.files[0].webkitRelativePath, 'site/index.html');
    assert.equal(stageDeployFiles([], { target }), false);
});

test('every project commit is authored by the user’s npub, or the wallet without one', async () => {
    assert.deepEqual(commitAuthor(NPUB, WALLET), { name: NPUB, email: '' });
    assert.deepEqual(commitAuthor(null, WALLET), { name: WALLET, email: '' });

    const { store: projects, workspace } = store();
    const controller = fakeController();
    const project = new WebLLMProject({ controller, store: projects });
    await settle(project);
    Object.assign(controller.state, { activeConversationId: 'conv-1' });
    project.handle(controller.state, { type: 'state' });
    await settle(project);

    await project.save('conv-1', [{ path: 'a.html', code: '<p>a</p>' }], 'Save a.html');
    await settle(project);
    await project.applyChanges([{ op: 'move', from: 'a.html', to: 'b.html' }], 'Rename a.html');
    await settle(project);
    await project.removeFile('b.html');
    await settle(project);

    const log = await workspace.log(workspace.chatDir(WALLET, 'conv-1'));
    assert.deepEqual(
        log.map((entry) => entry.author),
        [NPUB, NPUB, NPUB]
    );
    assert.ok(log.every((entry) => !/llama|smollm/i.test(`${entry.author} ${entry.message}`)));
});
