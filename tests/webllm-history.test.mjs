/**
 * Saved WebLLM conversations: per wallet, in IndexedDB, for as long as the
 * user's retention setting says — and never touching the model.
 *
 * The store runs against the in-memory IndexedDB double; the controller tests
 * wire the real store into the real controller with a scripted engine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import {
    WEBLLM_HISTORY_DB_PREFIX,
    conversationTitle,
    historyDatabaseName,
    openWebLLMHistory,
    retentionMs
} from '../src/webllm/webllmHistoryStore.js';
import { WebLLMController } from '../src/webllm/WebLLMController.js';
import { WEBLLM_DEFAULT_RETENTION, WEBLLM_RETENTION_OPTIONS } from '../src/webllm/webllmConfig.js';

const DAY = 24 * 60 * 60 * 1000;
const WALLET_A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const WALLET_B = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let fake;
test.beforeEach(() => {
    fake = installFakeIndexedDb();
});
test.afterEach(() => fake.restore?.());

/** A clock tests can move. */
function clock(start = Date.UTC(2026, 9, 1)) {
    let now = start;
    return { now: () => now, advance: (ms) => (now += ms) };
}

// ── the store ───────────────────────────────────────────────────────────────

test('titles come from the first message: its first line, cut at a word', () => {
    assert.equal(conversationTitle('How do I use fetch?'), 'How do I use fetch?');
    assert.equal(
        conversationTitle('How do I use fetch with async and await to load JSON from an API endpoint?'),
        'How do I use fetch with async and await to load…'
    );
    assert.equal(conversationTitle('```js\nconst a = 1;\n```\nWhy does this fail?'), 'Why does this fail?');
    assert.equal(conversationTitle('   '), 'New chat');
    assert.equal(conversationTitle('**Bold** `code` question'), 'Bold code question');
});

test('conversations and messages are saved and read back in order', async () => {
    const time = clock();
    const store = await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    const conversation = await store.createConversation('What is a closure?');
    await store.saveMessage(conversation.id, { id: 'u1', role: 'user', content: 'What is a closure?' });
    await store.saveMessage(conversation.id, {
        id: 'a1',
        role: 'assistant',
        content: 'A function with its scope.',
        finishReason: 'stop',
        sources: [
            { title: 'Closures', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures', extra: 'x' }
        ]
    });
    // Updating a message keeps its place.
    await store.saveMessage(conversation.id, { id: 'u1', role: 'user', content: 'What is a closure, exactly?' });

    const messages = await store.getMessages(conversation.id);
    assert.deepEqual(
        messages.map((message) => [message.seq, message.role, message.content]),
        [
            [0, 'user', 'What is a closure, exactly?'],
            [1, 'assistant', 'A function with its scope.']
        ]
    );
    assert.deepEqual(messages[1].sources, [
        { title: 'Closures', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Closures' }
    ]);
    const [listed] = await store.listConversations();
    assert.equal(listed.title, 'What is a closure?');
});

test('the list is ordered by last activity', async () => {
    const time = clock();
    const store = await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    const older = await store.createConversation('Older');
    time.advance(1000);
    const newer = await store.createConversation('Newer');
    time.advance(1000);
    await store.saveMessage(older.id, { id: 'm', role: 'user', content: 'back to this one' });
    assert.deepEqual(
        (await store.listConversations()).map((entry) => entry.id),
        [older.id, newer.id]
    );
});

test('each wallet has its own database, named by a hash and not by the address', async () => {
    const nameA = await historyDatabaseName(WALLET_A);
    assert.ok(nameA.startsWith(WEBLLM_HISTORY_DB_PREFIX));
    assert.equal(nameA, await historyDatabaseName(WALLET_A.toLowerCase()), 'case does not matter');
    assert.notEqual(nameA, await historyDatabaseName(WALLET_B));
    assert.doesNotMatch(nameA, /aaaa/i);
    await assert.rejects(historyDatabaseName(''), /wallet address is required/);

    const a = await openWebLLMHistory({ walletAddress: WALLET_A });
    const b = await openWebLLMHistory({ walletAddress: WALLET_B });
    const conversation = await a.createConversation('Private to A');
    await a.saveMessage(conversation.id, { id: 'secret', role: 'user', content: 'A only' });

    assert.equal((await b.listConversations()).length, 0, "B cannot see A's conversations");
    assert.deepEqual(await b.getMessages(conversation.id), [], "B cannot read A's messages by id");
    await assert.rejects(b.saveMessage(conversation.id, { id: 'x', role: 'user', content: 'B' }), /no longer exists/);
    assert.equal((await a.getMessages(conversation.id)).length, 1);
});

test('retention: 7 days by default, counted from last activity', async () => {
    assert.equal(WEBLLM_DEFAULT_RETENTION, '7d');
    assert.deepEqual(
        WEBLLM_RETENTION_OPTIONS.map((option) => [option.id, option.label]),
        [
            ['1d', '1 day'],
            ['7d', '7 days'],
            ['30d', '30 days'],
            ['forever', 'Until manually deleted']
        ]
    );
    assert.equal(retentionMs('1d'), DAY);
    assert.equal(retentionMs('forever'), null);
    assert.equal(retentionMs('nonsense'), 7 * DAY);

    const time = clock();
    const store = await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    assert.equal((await store.getSettings()).retention, '7d');
    const old = await store.createConversation('Old');
    time.advance(5 * DAY);
    const recent = await store.createConversation('Recent');
    time.advance(2 * DAY + 1);
    // 7 days and a moment since Old was last used, 2 days since Recent.
    assert.deepEqual(
        (await store.listConversations()).map((entry) => entry.title),
        ['Recent']
    );
    assert.deepEqual(await store.getMessages(old.id), []);
    time.advance(4 * DAY);
    await store.saveMessage(recent.id, { id: 'keepalive', role: 'user', content: 'still here' });
    time.advance(6 * DAY);
    assert.equal((await store.listConversations()).length, 1, 'activity restarts the clock');
});

test('retention choices are saved, applied at once, and "until deleted" keeps everything', async () => {
    const time = clock();
    const store = await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    await store.createConversation('Three days old');
    time.advance(3 * DAY);
    await store.setSetting('retention', '30d');
    assert.equal((await store.listConversations()).length, 1);
    await store.setSetting('retention', '1d');
    assert.equal((await store.listConversations()).length, 0, 'shortening retention purges right away');

    await store.setSetting('retention', 'forever');
    await store.createConversation('Kept');
    time.advance(400 * DAY);
    assert.equal((await store.listConversations()).length, 1);
    await assert.rejects(store.setSetting('retention', '2y'), /Unknown retention/);

    // The choice survives closing and reopening.
    store.close();
    const again = await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    assert.equal((await again.getSettings()).retention, 'forever');
});

test('expired conversations are cleaned up as soon as the history is opened', async () => {
    const time = clock();
    const first = await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    const conversation = await first.createConversation('Will expire');
    await first.saveMessage(conversation.id, { id: 'm1', role: 'user', content: 'hello' });
    first.close();
    time.advance(8 * DAY);
    await openWebLLMHistory({ walletAddress: WALLET_A, now: time.now });
    const database = fake.databases.get(await historyDatabaseName(WALLET_A));
    assert.equal(database.stores.get('conversations').rows.size, 0);
    assert.equal(database.stores.get('messages').rows.size, 0, 'messages go with their conversation');
});

test('deleting a conversation removes only it and its messages', async () => {
    const store = await openWebLLMHistory({ walletAddress: WALLET_A });
    const keep = await store.createConversation('Keep');
    const remove = await store.createConversation('Remove');
    await store.saveMessage(keep.id, { id: 'k', role: 'user', content: 'k' });
    await store.saveMessage(remove.id, { id: 'r', role: 'user', content: 'r' });
    await store.deleteConversation(remove.id);
    assert.deepEqual(
        (await store.listConversations()).map((entry) => entry.title),
        ['Keep']
    );
    assert.equal((await store.getMessages(keep.id)).length, 1);
    assert.equal((await store.getMessages(remove.id)).length, 0);
});

test('the MDN lookup preference is saved per wallet, on by default', async () => {
    const a = await openWebLLMHistory({ walletAddress: WALLET_A });
    const b = await openWebLLMHistory({ walletAddress: WALLET_B });
    assert.equal((await a.getSettings()).mdnEnabled, true);
    await a.setSetting('mdnEnabled', false);
    assert.equal((await a.getSettings()).mdnEnabled, false);
    assert.equal((await b.getSettings()).mdnEnabled, true);
});

// ── the controller, with the real store ─────────────────────────────────────

function fakeEngine(reply = 'Here you go.') {
    const engine = {
        kind: 'worker',
        chats: [],
        disposed: 0,
        async load() {
            return {};
        },
        async chat(messages, onDelta) {
            engine.chats.push(messages);
            for (const piece of reply.match(/.{1,4}/g)) {
                await flush();
                if (engine.interrupted) return { finishReason: 'abort' };
                onDelta(piece);
            }
            return { finishReason: 'stop' };
        },
        interrupt() {
            engine.interrupted = true;
        },
        dispose() {
            engine.disposed += 1;
        }
    };
    return engine;
}

function controllerWithHistory({ engine = fakeEngine(), now } = {}) {
    let clearedModel = 0;
    const controller = new WebLLMController({
        detectWebGPU: async () => ({ supported: true }),
        swClient: {
            status: async () => ({ model: { state: 'installed', bytesCached: 1, bytesTotal: 1 } }),
            prepareLibrary: async () => ({}),
            clearModel: async () => {
                clearedModel += 1;
            }
        },
        createEngine: async () => {
            engine.interrupted = false;
            return engine;
        },
        openHistory: (walletAddress) => openWebLLMHistory({ walletAddress, ...(now ? { now } : {}) })
    });
    return { controller, engine, clearedModel: () => clearedModel };
}

async function unlock(controller, walletAddress) {
    controller.setAllowed(true, { walletAddress });
    await controller.activate();
    for (let i = 0; i < 10 && controller.state.history === 'loading'; i += 1) await flush();
}

test('a conversation is saved as it happens and restored when the same wallet unlocks again', async () => {
    const { controller } = controllerWithHistory();
    await unlock(controller, WALLET_A);
    assert.equal(controller.state.history, 'ready');
    await controller.send('How do I debounce an input?');
    await controller.send('And throttle?');
    const id = controller.state.activeConversationId;
    assert.ok(id);
    assert.equal(controller.state.conversations[0].title, 'How do I debounce an input?');

    controller.setAllowed(false);
    assert.deepEqual(controller.state.messages, [], 'nothing stays in memory after locking');
    assert.deepEqual(controller.state.conversations, []);

    await unlock(controller, WALLET_A);
    await flush();
    assert.equal(controller.state.activeConversationId, id, 'the most recent conversation is reopened');
    assert.deepEqual(
        controller.state.messages.map((message) => [message.role, message.content]),
        [
            ['user', 'How do I debounce an input?'],
            ['assistant', 'Here you go.'],
            ['user', 'And throttle?'],
            ['assistant', 'Here you go.']
        ]
    );
    // Restored replies are context for the next message.
    await controller.send('Thanks');
    const sent = controller.engine.chats.at(-1);
    assert.ok(sent.some((message) => message.content === 'And throttle?'));
});

test('another wallet sees none of it', async () => {
    const { controller } = controllerWithHistory();
    await unlock(controller, WALLET_A);
    await controller.send('Wallet A question');
    controller.setAllowed(false);

    await unlock(controller, WALLET_B);
    assert.deepEqual(controller.state.conversations, []);
    assert.deepEqual(controller.state.messages, []);
    await controller.send('Wallet B question');
    assert.deepEqual(
        controller.state.conversations.map((entry) => entry.title),
        ['Wallet B question']
    );

    // Switching wallets without a lock in between still closes the first.
    controller.setAllowed(true, { walletAddress: WALLET_A });
    for (let i = 0; i < 10 && controller.state.history !== 'ready'; i += 1) await flush();
    await flush();
    assert.deepEqual(
        controller.state.conversations.map((entry) => entry.title),
        ['Wallet A question']
    );
});

test('new chat, open, switch and delete', async () => {
    const { controller, clearedModel } = controllerWithHistory();
    await unlock(controller, WALLET_A);
    await controller.send('First topic');
    const first = controller.state.activeConversationId;

    controller.newChat();
    assert.equal(controller.state.activeConversationId, null);
    assert.deepEqual(controller.state.messages, []);
    assert.equal(controller.state.conversations.length, 1, 'an empty new chat is not saved');

    await controller.send('Second topic');
    const second = controller.state.activeConversationId;
    assert.notEqual(second, first);
    assert.deepEqual(
        controller.state.conversations.map((entry) => entry.id),
        [second, first]
    );

    await controller.openConversation(first);
    assert.equal(controller.state.messages[0].content, 'First topic');

    await controller.deleteConversation();
    assert.deepEqual(
        controller.state.conversations.map((entry) => entry.id),
        [second]
    );
    assert.equal(controller.state.activeConversationId, second, 'the next conversation opens');
    assert.equal(controller.state.messages[0].content, 'Second topic');
    assert.equal(clearedModel(), 0, 'deleting chats never deletes the model');
    assert.equal(controller.state.status, 'ready');
});

test('switching conversations while a reply is streaming stops it, and the reply is saved where it belongs', async () => {
    const engine = fakeEngine('A long reply about closures that streams for a while.');
    const { controller } = controllerWithHistory({ engine });
    await unlock(controller, WALLET_A);
    await controller.send('Old');
    const old = controller.state.activeConversationId;
    controller.newChat();
    const sending = controller.send('Closures?');
    while (!controller.state.messages[1]?.content) await flush();
    const current = controller.state.activeConversationId;
    await controller.openConversation(old);
    await sending;

    assert.equal(controller.state.activeConversationId, old);
    await controller.openConversation(current);
    const reply = controller.state.messages[1];
    assert.equal(reply.finishReason, 'abort');
    assert.equal(reply.stopped, true);
    assert.ok(reply.content.length > 0);
});

test('a reply interrupted by locking the wallet is saved as interrupted', async () => {
    const engine = fakeEngine('Streaming text that the lock cuts off part of the way.');
    const { controller } = controllerWithHistory({ engine });
    await unlock(controller, WALLET_A);
    const sending = controller.send('Tell me about service workers');
    while ((controller.state.messages[1]?.content || '').length < 8) await flush();
    const id = controller.state.activeConversationId;
    controller.setAllowed(false);
    await sending;
    await flush();
    await flush();

    await unlock(controller, WALLET_A);
    await flush();
    assert.equal(controller.state.activeConversationId, id);
    const reply = controller.state.messages[1];
    assert.equal(reply.role, 'assistant');
    assert.ok(reply.content.length >= 8, 'what was written is kept');
    assert.equal(reply.stopped, true);
    assert.equal(reply.finishReason, 'abort');
    assert.equal(reply.continuable, false);
    assert.equal(reply.pending, false);
});

test('a reply still being written when the page goes away is saved as interrupted', async () => {
    const engine = fakeEngine('A long reply that the closing tab interrupts somewhere in the middle.');
    const { controller } = controllerWithHistory({ engine });
    await unlock(controller, WALLET_A);
    void controller.send('What is a Web Worker?');
    while ((controller.state.messages[1]?.content || '').length < 8) await flush();
    const id = controller.state.activeConversationId;
    // What pagehide does; the page is gone after this, so nothing else runs.
    controller.saveInterruptedReply();
    await flush();
    await flush();

    const store = await openWebLLMHistory({ walletAddress: WALLET_A });
    const saved = await store.getMessages(id);
    assert.deepEqual(
        saved.map((message) => message.role),
        ['user', 'assistant']
    );
    assert.ok(saved[1].content.length >= 8);
    assert.equal(saved[1].stopped, true);
    assert.equal(saved[1].finishReason, 'abort');
});

test('changing retention in the chat removes expired conversations from the list', async () => {
    const time = clock();
    const { controller } = controllerWithHistory({ now: time.now });
    await unlock(controller, WALLET_A);
    await controller.send('Two days ago');
    controller.newChat();
    time.advance(2 * DAY);
    await controller.send('Today');
    assert.equal(controller.state.conversations.length, 2);

    await controller.setRetention('1d');
    assert.equal(controller.state.settings.retention, '1d');
    assert.deepEqual(
        controller.state.conversations.map((entry) => entry.title),
        ['Today']
    );
});

test('without IndexedDB the chat still works, it just is not saved', async () => {
    const { controller } = controllerWithHistory();
    const previous = globalThis.indexedDB;
    globalThis.indexedDB = undefined;
    try {
        await unlock(controller, WALLET_A);
        assert.equal(controller.state.history, 'unavailable');
        await controller.send('Still works?');
        assert.equal(controller.state.messages[1].content, 'Here you go.');
        assert.equal(controller.state.activeConversationId, null);
    } finally {
        globalThis.indexedDB = previous;
    }
});
