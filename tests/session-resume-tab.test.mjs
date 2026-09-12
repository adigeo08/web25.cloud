/**
 * Unlocking puts you back where you were.
 *
 * That is the whole job of the session breadcrumb: the wall says you have been
 * signed out, the button says unlocking will resume, and this is the part that
 * has to make that true. A remembered tab that this load cannot show — Pages or
 * Chat with the wallet still locked — is skipped rather than forced open, and
 * says so, so the caller can fall back to somewhere that exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { location: { hostname: 'localhost' } };

const KEY = 'web25.session.tab.v1';

function installStorage() {
    const data = new Map();
    globalThis.localStorage = {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => data.set(key, `${value}`),
        removeItem: (key) => data.delete(key)
    };
    return data;
}

/** Just the tab strip, and only the parts `applyResumeHint` touches. */
function installTabs(tabs) {
    const clicks = [];
    const buttons = new Map(
        Object.entries(tabs).map(([name, { hidden = false, active = false }]) => [
            name,
            {
                style: { display: hidden ? 'none' : '' },
                classList: {
                    contains: (className) => className === 'active' && active
                },
                click: () => clicks.push(name)
            }
        ])
    );

    globalThis.document = {
        querySelector: (selector) => {
            const match = /data-tab="([^"]+)"/.exec(selector);
            return match ? buttons.get(match[1]) || null : null;
        },
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener() {}
    };
    return clicks;
}

test('unlocking goes back to the remembered tab', async () => {
    installStorage();
    const { rememberTab } = await import('../src/auth/SessionResumeHint.js');
    const { applyResumeHint } = await import('../src/core/bootstrap/Lifecycle.js');

    rememberTab('channels');
    const clicks = installTabs({ browse: { active: true }, channels: {} });

    const result = applyResumeHint.call({});

    assert.deepEqual(clicks, ['channels']);
    assert.equal(result.restored, true);
    assert.equal(result.tab, 'channels');
});

test('a tab this load cannot show is not forced open', async () => {
    installStorage();
    const { rememberTab } = await import('../src/auth/SessionResumeHint.js');
    const { applyResumeHint } = await import('../src/core/bootstrap/Lifecycle.js');

    rememberTab('pages');
    // Pages is hidden until the wallet is unlocked and a session exists.
    const clicks = installTabs({ browse: { active: true }, pages: { hidden: true } });

    const result = applyResumeHint.call({});

    assert.deepEqual(clicks, [], 'nothing is clicked');
    assert.equal(result.restored, false, 'and the caller is told, so it can land somewhere real');
});

test('already being on the remembered tab counts as restored', async () => {
    installStorage();
    const { rememberTab } = await import('../src/auth/SessionResumeHint.js');
    const { applyResumeHint } = await import('../src/core/bootstrap/Lifecycle.js');

    rememberTab('publish');
    const clicks = installTabs({ publish: { active: true } });

    const result = applyResumeHint.call({});

    assert.deepEqual(clicks, [], 'no pointless re-click');
    assert.equal(result.restored, true);
});

test('with nothing remembered there is nowhere to go back to', async () => {
    installStorage();
    const { applyResumeHint } = await import('../src/core/bootstrap/Lifecycle.js');
    installTabs({ browse: { active: true } });

    assert.equal(applyResumeHint.call({}), null);
});

test('a tab name this build does not have is ignored', async () => {
    const data = installStorage();
    const { applyResumeHint } = await import('../src/core/bootstrap/Lifecycle.js');

    data.set(KEY, JSON.stringify({ tab: 'nope', tabSavedAt: Date.now(), wasUnlocked: true, sessionAt: Date.now() }));
    const clicks = installTabs({ browse: { active: true } });

    assert.equal(applyResumeHint.call({}), null);
    assert.deepEqual(clicks, []);
});
