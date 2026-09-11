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
    // The tab and the session flag age separately, so each carries its own
    // timestamp; nothing else is stored.
    assert.deepEqual(Object.keys(stored).sort(), ['sessionAt', 'tab', 'tabSavedAt', 'wasUnlocked']);
    assert.equal(stored.tab, 'publish');
    assert.equal(stored.wasUnlocked, true);
    assert.equal(typeof stored.sessionAt, 'number');
    assert.equal(typeof stored.tabSavedAt, 'number');
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
    const { rememberTab, markSessionUnlocked, markSessionLocked, readResumeHint } =
        await import('../src/auth/SessionResumeHint.js');

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

    // A tab name this build does not have is simply not restorable; the live
    // session it also recorded is still worth saying out loud.
    data.set(KEY, JSON.stringify({ tab: 'nope', wasUnlocked: true, savedAt: Date.now() }));
    const hint = readResumeHint();
    assert.equal(hint.tab, '', 'nothing is restored from an unknown tab name');
    assert.equal(hint.wasUnlocked, true);

    data.set(KEY, JSON.stringify({ tab: 'nope', wasUnlocked: false, savedAt: Date.now() }));
    assert.equal(readResumeHint(), null, 'with nothing usable left, the entry goes');
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
    const { rememberTab, readResumeHint, markSessionUnlocked, clearResumeHint } =
        await import('../src/auth/SessionResumeHint.js');

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

test('putting the user back on their tab does not renew the interruption', async () => {
    const data = installStorage();
    const { rememberTab, markSessionUnlocked, readResumeHint } = await import('../src/auth/SessionResumeHint.js');

    markSessionUnlocked();
    const before = JSON.parse(data.get(KEY)).sessionAt;

    // Restoring a tab drives the real tab button, which persists the tab again.
    // That is navigation, not news about the wallet.
    await new Promise((resolve) => setTimeout(resolve, 5));
    rememberTab('channels');

    const after = JSON.parse(data.get(KEY));
    assert.equal(after.sessionAt, before, 'the session timestamp is not renewed by a tab change');
    assert.equal(after.tab, 'channels', 'but the tab is remembered');
    assert.ok(after.tabSavedAt > before, 'the tab has its own, newer timestamp');
    assert.equal(readResumeHint().wasUnlocked, true, 'and the pending notice still stands');
});

test('the interrupted-session flag is one-time information', async () => {
    installStorage();
    const { rememberTab, markSessionUnlocked, readResumeHint, consumeInterruptedSession } =
        await import('../src/auth/SessionResumeHint.js');

    rememberTab('publish');
    markSessionUnlocked();

    // The load that follows the interruption is told about it, once.
    assert.equal(readResumeHint().wasUnlocked, true);
    assert.equal(consumeInterruptedSession(), true);

    // Every load after that is an ordinary visit to a locked wallet.
    assert.equal(readResumeHint().wasUnlocked, false);
    assert.equal(consumeInterruptedSession(), false);
    assert.equal(readResumeHint().tab, 'publish', 'where they were is still remembered');
});

test('an old tab memory does not keep a stale interruption alive', async () => {
    const data = installStorage();
    const { readResumeHint, RESUME_HINT_MAX_AGE_MS } = await import('../src/auth/SessionResumeHint.js');

    data.set(
        KEY,
        JSON.stringify({
            tab: 'publish',
            tabSavedAt: Date.now(),
            wasUnlocked: true,
            sessionAt: Date.now() - RESUME_HINT_MAX_AGE_MS - 1000
        })
    );

    const hint = readResumeHint();
    assert.equal(hint.tab, 'publish');
    assert.equal(hint.wasUnlocked, false, 'a day-old session is not something to announce now');
});

test('a record written before the timestamps were split still reads', async () => {
    const data = installStorage();
    const { readResumeHint } = await import('../src/auth/SessionResumeHint.js');

    data.set(KEY, JSON.stringify({ tab: 'channels', wasUnlocked: true, savedAt: Date.now() - 1000 }));

    const hint = readResumeHint();
    assert.equal(hint.tab, 'channels');
    assert.equal(hint.wasUnlocked, true);
});
