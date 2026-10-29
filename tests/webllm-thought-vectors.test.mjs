/**
 * The thought store's vector memory, and recall on top of it.
 *
 * idb-vector comes from a CDN, so every way it can turn up is a case: there
 * from the start, late, never, or only in a later session. Indexing must keep
 * up in each — in the background, once per thought, with nothing left behind
 * by thoughts that are deleted — and recall must work the same whether the
 * index has a thought or the CPU compares it. Here idb-vector is an in-memory
 * double with its interface (insert / delete / query by cosine), on the
 * in-memory IndexedDB; the real library runs in webllm-browser.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import {
    CURRENT_SEQUENCE_BONUS,
    RECALL_MIN_SIMILARITY,
    openWebLLMThoughts,
    thoughtsDatabaseName
} from '../src/webllm/webllmThoughtStore.js';
import { similarity } from '../src/webllm/thoughtEmbedding.js';
import { formatRecall } from '../src/webllm/webllmThinking.js';
import { estimateTokens } from '../src/webllm/webllmProgress.js';
import { WEBLLM_THINKING } from '../src/webllm/webllmConfig.js';

const WALLET = '0xaaaa000000000000000000000000000000000001';
const OTHER_WALLET = '0xbbbb000000000000000000000000000000000002';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** idb-vector's interface, in memory. `hold` makes inserts wait for `release()`. */
function memoryVectors({ hold = false } = {}) {
    const rows = new Map();
    let key = 0;
    /** @type {(() => void)[]} */
    const waiting = [];
    return {
        rows,
        inserts: 0,
        release() {
            while (waiting.length) waiting.shift()();
        },
        async insert(object) {
            this.inserts += 1;
            if (hold) await new Promise((resolve) => waiting.push(resolve));
            key += 1;
            rows.set(key, structuredClone(object));
            return key;
        },
        async delete(k) {
            rows.delete(k);
        },
        async query(vector, { limit }) {
            return [...rows.entries()]
                .map(([k, object]) => ({ key: k, object, similarity: similarity(vector, object.embedding) }))
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit);
        }
    };
}

/** @param {{ vectors?: any, wallet?: string, now?: () => number }} [options] */
function open({ vectors = undefined, wallet = WALLET, now } = {}) {
    return openWebLLMThoughts({
        walletAddress: wallet,
        ...(now ? { now } : {}),
        ...(vectors === undefined ? {} : { vectors: typeof vectors === 'function' ? vectors : async () => vectors })
    });
}

/** Append one thought; a new sequence unless `sequenceId` is given. */
async function think(store, { conversationId = 'c1', sequenceId = null, number = 1, text, incomplete = false }) {
    const result = await store.appendThought({
        conversationId,
        sequenceId,
        thought: text,
        thoughtNumber: number,
        totalThoughts: 9,
        nextThoughtNeeded: true,
        ...(incomplete ? { incomplete } : {})
    });
    assert.equal(result.ok, true, result.ok ? '' : result.error.message);
    return result.value;
}

/** Every stored thought, straight from the database. */
const storedThoughts = (store) =>
    store.run(
        ['thoughts'],
        'readonly',
        (tx) =>
            new Promise((resolve) => {
                const request = tx.objectStore('thoughts').getAll();
                request.onsuccess = () => resolve(request.result);
            })
    );

/** Run `body` on a fresh in-memory IndexedDB. */
async function withDb(body) {
    const fake = installFakeIndexedDb();
    try {
        await body(fake);
    } finally {
        fake.restore();
    }
}

test('with idb-vector there from the start, every thought is indexed once, in the background', () =>
    withDb(async () => {
        const vectors = memoryVectors();
        const store = await open({ vectors });
        await store.vectorsReady;
        const first = await think(store, { text: 'The login form markup' });
        assert.equal(first.thought.vectorKey, null, 'the append does not wait for its vector');
        await think(store, { sequenceId: first.sequenceId, number: 2, text: 'The login form validation' });
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 2);
        assert.ok((await storedThoughts(store)).every((t) => t.vectorKey !== null));

        // Indexing again — a backfill, or the same thought queued twice — adds nothing.
        await store.backfill();
        await store.index(first.thought.id);
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 2);
        assert.equal(vectors.inserts, 2);

        // An idempotent append is the same thought, not a second vector.
        const again = {
            conversationId: 'c1',
            thought: 'x',
            thoughtNumber: 1,
            totalThoughts: 2,
            nextThoughtNeeded: true,
            clientRequestId: 'r1'
        };
        await store.appendThought(again);
        await store.appendThought(again);
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 3);
        store.close();
    }));

test('with idb-vector arriving late, the thoughts stored meanwhile are backfilled', () =>
    withDb(async () => {
        const vectors = memoryVectors();
        let arrive;
        const store = await open({ vectors: () => new Promise((resolve) => (arrive = () => resolve(vectors))) });
        await think(store, { text: 'The login form markup' });
        await think(store, { text: 'The login form validation' });
        const before = await store.recall({ query: 'login form', conversationId: 'c1' });
        assert.equal(before.length, 2, 'recall works on the CPU while it loads');
        assert.equal(vectors.rows.size, 0);
        arrive();
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 2);
        assert.ok((await storedThoughts(store)).every((t) => t.vectorKey !== null));
        store.close();
    }));

test('with idb-vector failing, thoughts are kept and recalled on the CPU', () =>
    withDb(async () => {
        const store = await open({ vectors: async () => Promise.reject(new Error('integrity mismatch')) });
        await think(store, { text: 'The login form markup with an email input' });
        await store.whenIndexed();
        assert.equal(store.vectors, null);
        const recalled = await store.recall({ query: 'email input of the login form', conversationId: 'c1' });
        assert.equal(recalled.length, 1);
        assert.equal((await storedThoughts(store))[0].vectorKey, null);
        store.close();
    }));

test('thoughts from a session without idb-vector are indexed by the next session that has it', () =>
    withDb(async () => {
        const offline = await open();
        await think(offline, { text: 'The login form markup' });
        await think(offline, { conversationId: 'c2', text: 'A bar chart on a canvas' });
        offline.close();

        const vectors = memoryVectors();
        const online = await open({ vectors });
        await online.whenIndexed();
        assert.equal(vectors.rows.size, 2);
        assert.deepEqual([...vectors.rows.values()].map((row) => row.conversationId).sort(), ['c1', 'c2']);
        online.close();
    }));

test('deleting thoughts while idb-vector is away leaves tombstones, cleared when it is back', () =>
    withDb(async () => {
        const vectors = memoryVectors();
        const first = await open({ vectors });
        await think(first, { text: 'The login form markup' });
        await think(first, { conversationId: 'c2', text: 'Keep me' });
        await first.whenIndexed();
        first.close();
        assert.equal(vectors.rows.size, 2);

        const away = await open({ vectors: async () => null });
        await away.whenIndexed();
        await away.deleteConversation('c1');
        away.close();
        assert.equal(vectors.rows.size, 2, 'nothing could be deleted from the index yet');

        const back = await open({ vectors });
        await back.whenIndexed();
        assert.deepEqual(
            [...vectors.rows.values()].map((row) => row.conversationId),
            ['c2'],
            'the deleted thought’s vector is gone, the other is kept'
        );
        const tombstones = await back.run(
            ['vectorTombstones'],
            'readonly',
            (tx) =>
                new Promise((resolve) => {
                    const request = tx.objectStore('vectorTombstones').getAll();
                    request.onsuccess = () => resolve(request.result);
                })
        );
        assert.deepEqual(tombstones, []);
        back.close();
    }));

test('a thought deleted while its vector is being written takes the vector with it', () =>
    withDb(async () => {
        const vectors = memoryVectors({ hold: true });
        const store = await open({ vectors });
        await store.vectorsReady;
        const { sequenceId } = await think(store, { text: 'The login form markup' });
        while (vectors.inserts === 0) await tick();
        await store.deleteSequence(sequenceId);
        vectors.release();
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 0, 'no orphaned vector');
        store.close();
    }));

test('recall drops the vectors of thoughts that are gone, and a second vector for one thought', () =>
    withDb(async () => {
        const vectors = memoryVectors();
        const store = await open({ vectors });
        const kept = await think(store, { text: 'The login form markup with an email input' });
        await store.whenIndexed();
        const embedding = [...vectors.rows.values()][0].embedding;
        // A vector for a thought that no longer exists, and a duplicate of the kept one.
        await vectors.insert({ embedding, thoughtId: 'ghost', sequenceId: 's', conversationId: 'c1' });
        await vectors.insert({
            embedding,
            thoughtId: kept.thought.id,
            sequenceId: kept.sequenceId,
            conversationId: 'c1'
        });
        assert.equal(vectors.rows.size, 3);
        const recalled = await store.recall({ query: 'login form email input', conversationId: 'c1' });
        assert.deepEqual(
            recalled.map((t) => t.id),
            [kept.thought.id]
        );
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 1);
        store.close();
    }));

test('a deleted or expired conversation takes its thoughts and their vectors with it', () =>
    withDb(async () => {
        let now = Date.UTC(2026, 9, 1);
        const vectors = memoryVectors();
        const store = await open({ vectors, now: () => now });
        await think(store, { conversationId: 'deleted', text: 'Deleted conversation' });
        await think(store, { conversationId: 'old', text: 'Old conversation' });
        now += 10 * 24 * 60 * 60 * 1000;
        await think(store, { conversationId: 'fresh', text: 'Fresh conversation' });
        await store.whenIndexed();
        assert.equal(vectors.rows.size, 3);

        await store.deleteConversation('deleted');
        const purged = await store.purge({ retentionMs: 7 * 24 * 60 * 60 * 1000 });
        assert.equal(purged, 1);
        assert.deepEqual(
            (await storedThoughts(store)).map((t) => t.conversationId),
            ['fresh']
        );
        assert.deepEqual(
            [...vectors.rows.values()].map((row) => row.conversationId),
            ['fresh']
        );
        store.close();
    }));

test('thoughts stay inside their conversation and their wallet', () =>
    withDb(async () => {
        const vectors = memoryVectors();
        const mine = await open({ vectors });
        await think(mine, { conversationId: 'c1', text: 'The login form markup with an email input' });
        await think(mine, { conversationId: 'c2', text: 'The login form markup with an email input, elsewhere' });
        await mine.whenIndexed();
        const recalled = await mine.recall({ query: 'login form email input', conversationId: 'c1', limit: 5 });
        assert.deepEqual(
            recalled.map((t) => t.conversationId),
            ['c1']
        );

        const theirs = await open({ wallet: OTHER_WALLET, vectors: memoryVectors() });
        assert.deepEqual(await theirs.recall({ query: 'login form email input', conversationId: 'c1' }), []);
        assert.notEqual(await thoughtsDatabaseName(WALLET), await thoughtsDatabaseName(OTHER_WALLET));
        mine.close();
        theirs.close();
    }));

test('recall reads one conversation through its index, not the whole wallet', () =>
    withDb(async () => {
        const store = await open();
        for (let i = 0; i < 5; i += 1)
            await think(store, { conversationId: `other${i}`, text: `Other ${i} login form` });
        await think(store, { conversationId: 'c1', text: 'The login form markup' });
        const reads = [];
        const transaction = store.db.transaction.bind(store.db);
        store.db.transaction = (names, mode) => {
            const tx = transaction(names, mode);
            const objectStore = tx.objectStore;
            tx.objectStore = (name) => {
                const target = objectStore(name);
                return {
                    ...target,
                    getAll: (...args) => (reads.push(`${name}.getAll`), target.getAll(...args)),
                    index: (index) => {
                        const handle = target.index(index);
                        return { getAll: (key) => (reads.push(`${name}.${index}(${key})`), handle.getAll(key)) };
                    }
                };
            };
            return tx;
        };
        const recalled = await store.recall({ query: 'login form', conversationId: 'c1' });
        assert.equal(recalled.length, 1);
        assert.deepEqual(reads, ['thoughts.byConversation(c1)']);
        store.close();
    }));

test('an older, clearly more relevant thought is not pushed out by the sequence being written', () =>
    withDb(async () => {
        let now = 1;
        const store = await open({ now: () => (now += 1000) });
        const older = await think(store, {
            text: 'Email validation for the login form: a regular expression checks the email input on submit'
        });
        const current = await think(store, { text: 'Plan: build the page' });
        await think(store, {
            sequenceId: current.sequenceId,
            number: 2,
            text: 'The page header and footer styles for the login page'
        });
        const recalled = await store.recall({
            query: 'Validate the email input of the login form on submit',
            conversationId: 'c1',
            sequenceId: current.sequenceId,
            limit: 1
        });
        assert.deepEqual(
            recalled.map((t) => t.id),
            [older.thought.id]
        );
        assert.ok(CURRENT_SEQUENCE_BONUS < 0.1, 'a small preference, not a trump card');
        store.close();
    }));

test('recall leaves out the unrelated, duplicates and incomplete steps, keeps pinned ones, in thinking order', () =>
    withDb(async () => {
        let now = 1;
        const store = await open({ now: () => (now += 1000) });
        const plan = await think(store, { text: 'Plan: 1. login form markup 2. styles 3. validation' });
        const seq = plan.sequenceId;
        const markup = await think(store, {
            sequenceId: seq,
            number: 2,
            text: 'The login form markup: <form id="login"> with an email input'
        });
        await think(store, {
            sequenceId: seq,
            number: 3,
            text: 'The login form markup: <form id="login"> with an email input'
        });
        const styles = await think(store, { sequenceId: seq, number: 4, text: 'Footer padding and colours' });
        await think(store, {
            sequenceId: seq,
            number: 5,
            text: 'The login form email validation, cut off: function check(',
            incomplete: true
        });
        await think(store, { conversationId: 'c1', text: 'Une recette de crêpes bretonnes' });

        const recalled = await store.recall({
            query: 'Validate the email input of the login form',
            conversationId: 'c1',
            sequenceId: seq,
            limit: 4,
            exclude: new Set([plan.thought.id]),
            pinned: [styles.thought.id]
        });
        const texts = recalled.map((t) => t.thought);
        assert.equal(texts.filter((text) => text.startsWith('The login form markup')).length, 1, 'one copy');
        assert.ok(texts.includes('Footer padding and colours'), 'the pinned step is in, unrelated or not');
        assert.ok(!texts.some((text) => text.includes('cut off')), 'an incomplete step is not earlier work');
        assert.ok(!texts.some((text) => text.includes('crêpes')), 'below the similarity floor');
        const ordinals = recalled.map((t) => t.ordinal);
        assert.deepEqual(
            ordinals,
            [...ordinals].sort((a, b) => a - b),
            'in the order they were thought'
        );
        // Of two identical thoughts the later is kept.
        assert.ok(recalled.some((t) => t.thoughtNumber === 3));
        assert.ok(!recalled.some((t) => t.id === markup.thought.id));

        const withIncomplete = await store.recall({
            query: 'login form email validation function check',
            conversationId: 'c1',
            includeIncomplete: true
        });
        assert.ok(withIncomplete.some((t) => t.incomplete === true));
        assert.equal(RECALL_MIN_SIMILARITY, WEBLLM_THINKING.desktop.recallMinSimilarity);
        store.close();
    }));

test('the recall budget holds with the latest step weighted, on both profiles', () => {
    const long = (word) => `${word} `.repeat(4000);
    for (const profile of ['desktop', 'mobile']) {
        const { recallTokens } = WEBLLM_THINKING[profile];
        const text = formatRecall(
            [
                { label: 'Thought 2', text: long('markup') },
                { label: 'From an earlier answer in this conversation', text: long('earlier') },
                { label: 'Thought 3', text: long('latest'), weight: 2 }
            ],
            recallTokens
        );
        assert.ok(estimateTokens(text) <= recallTokens, `${profile}: ${estimateTokens(text)} > ${recallTokens}`);
        const latest = text.slice(text.indexOf('Thought 3:'));
        const markup = text.slice(0, text.indexOf('From an earlier'));
        assert.ok(estimateTokens(latest) > estimateTokens(markup), 'the latest step has the larger share');
    }
});
