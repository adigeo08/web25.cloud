/**
 * The OPFS workspace, with the real isomorphic-git on top of it.
 *
 * In the browser isomorphic-git comes from the CDN; here the same version comes
 * from node_modules, and runs against an in-memory OPFS that behaves the way
 * the browser's does. What is checked is what the three users of the workspace
 * rely on: files written are files read back, every snapshot of a repository is
 * a commit (and an unchanged one is not), and a payload can never write into
 * the `.git` directory of the repository holding it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as isomorphicGit from 'isomorphic-git';

import { createFakeOpfs } from './helpers/fake-opfs.mjs';
import { OpfsFs, isOpfsWritable, pathSegments } from '../src/storage/OpfsFs.js';
import {
    GitWorkspace,
    ISOMORPHIC_GIT_URL,
    ISOMORPHIC_GIT_VERSION,
    createGitLoader,
    safeTreePath
} from '../src/storage/GitWorkspace.js';

const text = (bytes) => new TextDecoder().decode(bytes);

function workspace({ loadGit = async () => isomorphicGit } = {}) {
    const opfs = createFakeOpfs();
    const ws = new GitWorkspace({
        fs: new OpfsFs({ root: opfs.storage.getDirectory }),
        loadGit,
        available: async () => true,
        report: () => {}
    });
    return { opfs, ws };
}

test('isomorphic-git is pinned and imported from the CDN, once', async () => {
    assert.equal(ISOMORPHIC_GIT_URL, `https://esm.sh/isomorphic-git@${ISOMORPHIC_GIT_VERSION}`);
    const asked = [];
    const load = createGitLoader(async (url) => {
        asked.push(url);
        return { default: isomorphicGit.default || isomorphicGit };
    });
    const [first, second] = await Promise.all([load(), load()]);
    assert.equal(first, second);
    assert.equal(typeof first.commit, 'function');
    assert.deepEqual(asked, [ISOMORPHIC_GIT_URL]);
});

test('a CDN that fails is asked again next time, not remembered as broken', async () => {
    let calls = 0;
    const load = createGitLoader(async () => {
        calls += 1;
        if (calls === 1) throw new Error('offline');
        return isomorphicGit;
    });
    await assert.rejects(load(), /offline/);
    assert.equal(typeof (await load()).commit, 'function');
});

test('a CDN that never answers costs the commit, not the caller', async () => {
    const load = createGitLoader(() => new Promise(() => {}), { timeoutMs: 20 });
    await assert.rejects(load(), /took too long/);
});

test('OPFS support is detected, and its absence is not an error', async () => {
    assert.equal(await isOpfsWritable(undefined), false);
    assert.equal(await isOpfsWritable({}), false);
    assert.equal(await isOpfsWritable(createFakeOpfs().storage), true);
});

test('the fs speaks Node errors, which is what isomorphic-git branches on', async () => {
    const opfs = createFakeOpfs();
    const fs = new OpfsFs({ root: opfs.storage.getDirectory });
    await assert.rejects(fs.readFile('/missing'), { code: 'ENOENT' });
    await fs.mkdir('/a');
    await assert.rejects(fs.mkdir('/a'), { code: 'EEXIST' });
    await assert.rejects(fs.mkdir('/x/y'), { code: 'ENOENT' });
    await fs.writeFile('/a/f.txt', 'hello');
    assert.equal(await fs.readFile('/a/f.txt', 'utf8'), 'hello');
    await assert.rejects(fs.rmdir('/a'), { code: 'ENOTEMPTY' });
    await assert.rejects(fs.readdir('/a/f.txt'), { code: 'ENOTDIR' });
    const stats = await fs.stat('/a/f.txt');
    assert.equal(stats.isFile(), true);
    assert.equal(stats.size, 5);
    assert.equal((await fs.stat('/a')).isDirectory(), true);
    await assert.rejects(fs.readlink('/a/f.txt'), { code: 'ENOENT' });
    assert.throws(() => pathSegments('/a/../b'), { code: 'EINVAL' });
});

test('paths from outside never reach .git and never climb out', () => {
    assert.equal(safeTreePath('site.bundle.json.gz'), 'site.bundle.json.gz');
    assert.equal(safeTreePath('/assets//app.js'), 'assets/app.js');
    assert.equal(safeTreePath('.git/config'), null);
    assert.equal(safeTreePath('sub/.GIT/hooks/x'), null);
    assert.equal(safeTreePath('../escape'), null);
    assert.equal(safeTreePath(''), null);
});

test('a snapshot is a commit; the same tree again is not a second one', async () => {
    const { ws, opfs } = workspace();
    const dir = ws.pageDir('ABCDEF');
    assert.equal(dir, '/web25/pages/abcdef');

    const first = await ws.snapshot(
        dir,
        [
            { path: '.torrentchain', bytes: '{"v":1}' },
            { path: 'site.bundle.json.gz', bytes: new Uint8Array([31, 139, 8]) }
        ],
        { message: 'Deploy demo' }
    );
    assert.deepEqual(first.paths, ['.torrentchain', 'site.bundle.json.gz']);
    // The files are there as soon as the write resolves; the commit follows.
    assert.equal(text(await ws.readFile(dir, '.torrentchain')), '{"v":1}');
    const firstCommit = await first.committed;
    assert.match(firstCommit, /^[0-9a-f]{40}$/);
    assert.equal(await ws.headCommit(dir), firstCommit);
    assert.ok(opfs.list().includes('web25/pages/abcdef/.git/HEAD'));

    const again = await ws.snapshot(
        dir,
        [
            { path: '.torrentchain', bytes: '{"v":1}' },
            { path: 'site.bundle.json.gz', bytes: new Uint8Array([31, 139, 8]) }
        ],
        { message: 'Deploy demo again' }
    );
    assert.equal(await again.committed, firstCommit);

    const changed = await ws.snapshot(dir, [{ path: '.torrentchain', bytes: '{"v":2}' }], {
        message: 'Deploy demo v2'
    });
    assert.notEqual(await changed.committed, firstCommit);
    // Replacing the tree replaced it: the bundle is gone, in the tree and in git.
    assert.deepEqual(await ws.listFiles(dir), ['.torrentchain']);
    const log = await ws.log(dir);
    assert.deepEqual(
        log.map((entry) => entry.message),
        ['Deploy demo v2', 'Deploy demo']
    );
    const status = await isomorphicGit.statusMatrix({ fs: { promises: ws.fs }, dir });
    assert.deepEqual(status, [['.torrentchain', 1, 1, 1]]);
});

test('files are kept even when git cannot be loaded', async () => {
    const { ws } = workspace({
        loadGit: async () => {
            throw new Error('CDN unreachable');
        }
    });
    const dir = ws.chatDir('0xWallet', 'conv-1');
    const result = await ws.snapshot(dir, [{ path: 'index.html', bytes: '<h1>hi</h1>' }], {
        message: 'Save',
        replace: false
    });
    assert.equal(text(await ws.readFile(dir, 'index.html')), '<h1>hi</h1>');
    assert.equal(await result.committed, null);
    assert.equal(await ws.headCommit(dir), null);
});

test('a payload path aimed at .git is refused before anything is written', async () => {
    const { ws, opfs } = workspace();
    const dir = ws.pageDir('beef');
    await assert.rejects(
        ws.snapshot(dir, [{ path: '.git/config', bytes: '[core]' }], { message: 'evil' }),
        /cannot be stored/
    );
    assert.deepEqual(opfs.list(), []);
});

test('writes to one repository run one after another', async () => {
    const { ws } = workspace();
    const dir = ws.chatDir('0xwallet', 'conv');
    const results = await Promise.all(
        ['a.js', 'b.js', 'c.js'].map((path) =>
            ws.snapshot(dir, [{ path, bytes: `// ${path}` }], { message: `Save ${path}`, replace: false })
        )
    );
    const commits = await Promise.all(results.map((result) => result.committed));
    assert.equal(new Set(commits).size, 3);
    assert.deepEqual(await ws.listFiles(dir), ['a.js', 'b.js', 'c.js']);
    assert.equal((await ws.log(dir)).length, 3);
});
