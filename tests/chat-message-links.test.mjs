/**
 * Links in chat messages.
 *
 * Message text is written by the peer, so the rule is not "escape it well" but
 * "never build markup from it": the renderer appends text nodes and real anchor
 * elements, and an anchor only exists when the URL parsed as http or https.
 * These tests pin both halves — that ordinary links become clickable, and that
 * nothing else does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/** The few DOM calls the renderer makes, and nothing else. */
function installDom() {
    const makeNode = (tag) => {
        const node = {
            tagName: tag.toUpperCase(),
            children: [],
            textContent: '',
            href: '',
            target: '',
            rel: '',
            className: '',
            appendChild(child) {
                this.children.push(child);
                return child;
            }
        };
        return node;
    };

    globalThis.document = {
        createElement: (tag) => makeNode(tag),
        createTextNode: (text) => ({ tagName: '#text', textContent: text, children: [] })
    };

    return makeNode('div');
}

/** Everything the row renders, in order, as plain text. */
const flatten = (node) => node.children.map((child) => child.textContent).join('');
const anchors = (node) => node.children.filter((child) => child.tagName === 'A');

test('an http(s) link becomes an anchor that opens in a new tab', async () => {
    const body = installDom();
    const { renderMessageText } = await import('../src/ui/channels/ChannelsPanel.js');

    renderMessageText(body, 'see https://example.com/docs?a=1 for the spec');

    const [link] = anchors(body);
    assert.ok(link, 'the URL is linked');
    assert.equal(link.href, 'https://example.com/docs?a=1');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    // The surrounding sentence survives intact.
    assert.equal(flatten(body), 'see https://example.com/docs?a=1 for the spec');
});

test('a javascript: or data: URL is left as plain text', async () => {
    const body = installDom();
    const { renderMessageText } = await import('../src/ui/channels/ChannelsPanel.js');

    renderMessageText(body, 'try javascript:alert(1) or data:text/html,<script>alert(1)</script>');

    assert.equal(anchors(body).length, 0, 'nothing but http(s) is ever linked');
    assert.equal(flatten(body), 'try javascript:alert(1) or data:text/html,<script>alert(1)</script>');
});

test('trailing punctuation belongs to the sentence, not the link', async () => {
    const body = installDom();
    const { renderMessageText } = await import('../src/ui/channels/ChannelsPanel.js');

    renderMessageText(body, 'read it here: https://example.com/a.');

    const [link] = anchors(body);
    assert.equal(link.href, 'https://example.com/a');
    assert.equal(link.textContent, 'https://example.com/a');
    assert.equal(flatten(body), 'read it here: https://example.com/a.');
});

test('a closing bracket around a link is not swallowed', async () => {
    const body = installDom();
    const { renderMessageText } = await import('../src/ui/channels/ChannelsPanel.js');

    renderMessageText(body, '(see https://example.com/a) done');

    assert.equal(anchors(body)[0].href, 'https://example.com/a');
    assert.equal(flatten(body), '(see https://example.com/a) done');
});

test('several links in one message are all linked', async () => {
    const body = installDom();
    const { renderMessageText } = await import('../src/ui/channels/ChannelsPanel.js');

    renderMessageText(body, 'http://a.example and https://b.example/x');

    assert.deepEqual(
        anchors(body).map((link) => link.href),
        ['http://a.example/', 'https://b.example/x']
    );
});

test('a message with no link renders as one plain text node', async () => {
    const body = installDom();
    const { renderMessageText } = await import('../src/ui/channels/ChannelsPanel.js');

    renderMessageText(body, 'no links here <b>at all</b>');

    assert.equal(anchors(body).length, 0);
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].tagName, '#text');
    assert.equal(flatten(body), 'no links here <b>at all</b>');
});

test('the renderer never touches innerHTML', async () => {
    const source = await import('node:fs').then((fs) =>
        fs.promises.readFile(new URL('../src/ui/channels/ChannelsPanel.js', import.meta.url), 'utf8')
    );
    const renderer = source.slice(source.indexOf('export function renderMessageText'));
    assert.ok(!renderer.includes('innerHTML'), 'peer text is never interpreted as markup');
});
