import test from 'node:test';
import assert from 'node:assert/strict';

/** A localStorage stand-in, so the hint can be exercised without a browser. */
function installStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    globalThis.localStorage = {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, `${value}`),
        removeItem: (key) => data.delete(key),
        get size() {
            return data.size;
        }
    };
    return data;
}

const KEY = 'web25.session.tab.v1';

test('the hint stores a tab name and a boolean, and nothing else', async () => {
    const data = installStorage();
    const { rememberTab, markSessionUnlocked } = await import('../src/auth/SessionResumeHint.js');

    rememberTab('publish');
    markSessionUnlocked();

    const stored = JSON.parse(data.get(KEY));
    assert.deepEqual(Object.keys(stored).sort(), ['savedAt', 'tab', 'wasUnlocked']);
    assert.equal(stored.tab, 'publish');
    assert.equal(stored.wasUnlocked, true);
    assert.equal(typeof stored.savedAt, 'number');
});

test('an unknown tab name is never written', async () => {
    const data = installStorage();
    const { rememberTab } = await import('../src/auth/SessionResumeHint.js');

    assert.equal(rememberTab('../../etc/passwd'), false);
    assert.equal(rememberTab(''), false);
    assert.equal(data.size, 0);
});

test('locking on purpose keeps the place but drops the "unlock again" flag', async () => {
    installStorage();
    const { rememberTab, markSessionUnlocked, markSessionLocked, readResumeHint } = await import(
        '../src/auth/SessionResumeHint.js'
    );

    rememberTab('channels');
    markSessionUnlocked();
    markSessionLocked();

    const hint = readResumeHint();
    assert.equal(hint.tab, 'channels');
    assert.equal(hint.wasUnlocked, false);
});

test('a stale hint is dropped rather than acted on', async () => {
    const data = installStorage();
    const { readResumeHint, RESUME_HINT_MAX_AGE_MS } = await import('../src/auth/SessionResumeHint.js');

    data.set(
        KEY,
        JSON.stringify({ tab: 'publish', wasUnlocked: true, savedAt: Date.now() - RESUME_HINT_MAX_AGE_MS - 1000 })
    );

    assert.equal(readResumeHint(), null);
    assert.equal(data.has(KEY), false, 'the stale entry is cleared, not left to be re-read');
});

test('a corrupt or foreign value reads as no hint at all', async () => {
    const data = installStorage();
    const { readResumeHint } = await import('../src/auth/SessionResumeHint.js');

    data.set(KEY, 'not json');
    assert.equal(readResumeHint(), null);

    data.set(KEY, JSON.stringify({ tab: 'publish' }));
    assert.equal(readResumeHint(), null, 'a hint with no timestamp means nothing');

    data.set(KEY, JSON.stringify({ tab: 'nope', wasUnlocked: true, savedAt: Date.now() }));
    assert.equal(readResumeHint(), null);
});

test('storage being unavailable is a lost convenience, never a thrown error', async () => {
    globalThis.localStorage = {
        getItem() {
            throw new Error('denied');
        },
        setItem() {
            throw new Error('denied');
        },
        removeItem() {
            throw new Error('denied');
        }
    };
    const { rememberTab, readResumeHint, markSessionUnlocked, clearResumeHint } = await import(
        '../src/auth/SessionResumeHint.js'
    );

    assert.equal(readResumeHint(), null);
    assert.equal(rememberTab('browse'), false);
    assert.equal(markSessionUnlocked(), false);
    assert.equal(clearResumeHint(), false);
});

test('the stored shape carries no identity material', async () => {
    const source = await import('node:fs').then((fs) =>
        fs.promises.readFile(new URL('../src/auth/SessionResumeHint.js', import.meta.url), 'utf8')
    );

    // The breadcrumb must stay a breadcrumb: no address, key, npub or hash may
    // find its way into a value that sits in localStorage unencrypted.
    for (const forbidden of ['address', 'publicKey', 'privateKey', 'npub', 'nostrPublicKey', 'infoHash']) {
        assert.ok(!new RegExp(`${forbidden}\\s*[:=]`).test(source), `${forbidden} must not be stored`);
    }
});
