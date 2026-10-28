/**
 * Reply modes, the sequence thinker's store, reply formatting, and the
 * GPU-only engine choice.
 *
 * What these pin: Llama's structured answers (the Auto decision, the plan)
 * are read with JSON.parse and nothing else; the thought store keeps
 * durable-thinking's rules (branch-scoped numbers, revisions, branches,
 * idempotent appends) and recalls by similarity, on the CPU; idb-vector runs
 * only after both of its files match their hashes; replies split into text
 * and fenced code exactly; a request can only shorten the profile's reply
 * limit; and a CPU-emulated WebGPU adapter is never used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { formatRecall, parseModeDecision, parsePlan, stepMessage, tailTokens } from '../src/webllm/webllmThinking.js';
import { estimateTokens, classifyError } from '../src/webllm/webllmProgress.js';
import { safeLanguage, splitReply } from '../src/ui/webllm/replyFormat.js';
import { jsonResponseFormat, replyLimit } from '../src/webllm/webllmEngineHost.js';
import { detectWebGPU } from '../src/webllm/webgpuSupport.js';
import { createEngineClient, createWorkerTransport } from '../src/webllm/WebLLMEngineClient.js';
import { embedText, similarity, words } from '../src/webllm/thoughtEmbedding.js';
import { loadIdbVector } from '../src/webllm/idbVectorLoader.js';
import { MAIN_BRANCH_ID, openWebLLMThoughts } from '../src/webllm/webllmThoughtStore.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';

const WALLET = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';

test('Llama’s structured answers are read as JSON, and anything else is no answer', () => {
    assert.equal(parseModeDecision('{"mode":"thinking"}'), 'thinking');
    assert.equal(parseModeDecision(' {"mode": "short"} '), 'short');
    assert.equal(parseModeDecision('{"mode":"long"}'), null);
    assert.equal(parseModeDecision('thinking'), null);

    assert.deepEqual(parsePlan('{"steps":["Create the form","Add  styles\\nnow","create the form",7,"Ship"]}', 3), [
        'Create the form',
        'Add  styles now',
        'Ship'
    ]);
    assert.deepEqual(parsePlan('{"steps":["Only one"]}', 4), [], 'one step is no plan');
    assert.deepEqual(parsePlan('1. Markup\n2. Styles', 4), [], 'prose is not parsed');

    assert.deepEqual(jsonResponseFormat({ type: 'object' }), { type: 'json_object', schema: '{"type":"object"}' });
    assert.equal(jsonResponseFormat(null), null);
    assert.equal(jsonResponseFormat('{"type":"object"}'), null);
});

test('a step sees the task, the plan and the earlier thoughts recalled for it', () => {
    const recalled = formatRecall(
        [
            { label: 'Thought 1', text: 'plan' },
            { label: 'Thought 2', text: `\`\`\`js\n${'line();\n'.repeat(400)}\`\`\`` }
        ],
        120
    );
    assert.ok(estimateTokens(recalled) <= 140);
    assert.match(recalled, /^Thought 1:\nplan\n\nThought 2:\n…\n```/, 'a cut inside a code block reopens it');
    const message = stepMessage({ task: 'Build it', steps: ['One', 'Two'], index: 1, recalled: 'Thought 2:\n"""x"""' });
    assert.match(message, /^Task: Build it\n\nPlan:\n1\. One\n2\. Two\n\nEarlier thoughts:\n"""\nThought 2:\n"x"\n"""/);
    assert.match(message, /Now do step 2 only: Two$/);
    assert.equal(stepMessage({ task: 'Do it', steps: ['Do it'], index: 0, recalled: '' }), 'Do it');
    assert.equal(tailTokens('short', 100), 'short');
    assert.equal(formatRecall([], 100), '');
});

test('thoughts are embedded on the CPU: shared identifiers make them similar', () => {
    assert.deepEqual(words('Add an addEventListener("click") to #save-btn, apoi țară'), [
        'add',
        'an',
        'addeventlistener',
        'click',
        'to',
        'save',
        'btn',
        'apoi',
        'țară'
    ]);
    const form = embedText('Build the login form with an email input and a submit button');
    const validate = embedText('Validate the email input of the login form before submit');
    const unrelated = embedText('Draw a bar chart on a canvas with requestAnimationFrame');
    assert.ok(Array.isArray(form), 'a plain array, as idb-vector expects');
    assert.equal(form.length, 256);
    assert.ok(Math.abs(similarity(form, form) - 1) < 1e-9);
    assert.ok(similarity(form, validate) > similarity(form, unrelated) + 0.2);
    assert.deepEqual(embedText(''), new Array(256).fill(0));
});

/** idb-vector's interface, in memory, with its cosine query. */
function memoryVectors() {
    const rows = new Map();
    let key = 0;
    return {
        rows,
        async insert(object) {
            key += 1;
            rows.set(key, object);
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

async function openStore({ vectors = null } = {}) {
    let now = Date.UTC(2026, 9, 1);
    const store = await openWebLLMThoughts({
        walletAddress: WALLET,
        now: () => now,
        vectors: vectors ? async () => vectors : null
    });
    return { store, advance: (ms) => (now += ms) };
}

test('the thought store keeps durable-thinking’s rules', async () => {
    const fake = installFakeIndexedDb();
    try {
        const { store } = await openStore();
        const first = await store.appendThought({
            conversationId: 'c1',
            sequenceTitle: 'Login form',
            thought: 'Plan: markup, then validation',
            thoughtNumber: 1,
            totalThoughts: 3,
            nextThoughtNeeded: true,
            clientRequestId: 'r1'
        });
        assert.equal(first.ok, true);
        const { sequenceId } = first.value;
        assert.match(sequenceId, /^seq_/);
        assert.equal(first.value.sequence.title, 'Login form');

        // The same request again is the same thought; a different payload under its id is a conflict.
        const again = await store.appendThought({
            conversationId: 'c1',
            sequenceTitle: 'Login form',
            thought: 'Plan: markup, then validation',
            thoughtNumber: 1,
            totalThoughts: 3,
            nextThoughtNeeded: true,
            clientRequestId: 'r1'
        });
        assert.equal(again.value.deduplicated, true);
        assert.equal(again.value.thought.id, first.value.thought.id);
        const clash = await store.appendThought({
            conversationId: 'c1',
            thought: 'something else',
            thoughtNumber: 1,
            totalThoughts: 3,
            nextThoughtNeeded: true,
            clientRequestId: 'r1'
        });
        assert.equal(clash.error.code, 'idempotency_conflict');

        const append = (fields) =>
            store.appendThought({ sequenceId, thoughtNumber: 2, totalThoughts: 3, nextThoughtNeeded: true, ...fields });
        assert.equal((await append({ thought: 'markup' })).ok, true);
        assert.equal((await append({ thought: 'x', isRevision: true })).error.code, 'revision_target_required');
        assert.equal((await append({ thought: 'x', revisesThought: 1 })).error.code, 'invalid_input');
        assert.equal(
            (await append({ thought: 'x', isRevision: true, revisesThought: 9 })).error.code,
            'revision_target_not_found'
        );
        assert.equal((await append({ thought: 'markup, fixed', isRevision: true, revisesThought: 2 })).ok, true);
        assert.equal((await append({ thought: 'x', branchId: 'alt' })).error.code, 'branch_not_found');
        assert.equal((await append({ thought: 'x', branchFromThought: 1 })).error.code, 'branch_id_required');
        assert.equal(
            (await append({ thought: 'x', branchId: 'alt', branchFromThought: 7 })).error.code,
            'branch_point_not_found'
        );
        const branched = await append({ thought: 'another way', branchId: 'alt', branchFromThought: 1 });
        assert.equal(branched.ok, true);
        assert.deepEqual(
            branched.value.sequence.branches.map(({ branchId, parentBranchId, branchFromThought }) => ({
                branchId,
                parentBranchId,
                branchFromThought
            })),
            [{ branchId: 'alt', parentBranchId: MAIN_BRANCH_ID, branchFromThought: 1 }]
        );
        assert.equal(
            (await append({ thought: 'x', branchId: 'alt', branchFromThought: 2 })).error.code,
            'branch_conflict'
        );
        // On the branch, thought 2 is the branch's own; thought 1 is inherited from main.
        assert.equal(
            (await append({ thought: 'revise inherited', branchId: 'alt', isRevision: true, revisesThought: 1 })).ok,
            true
        );

        const done = await append({ thought: 'validation', thoughtNumber: 3, nextThoughtNeeded: false });
        assert.equal(done.value.sequence.completed, true);
        const reopened = await append({ thought: 'one more', thoughtNumber: 4, totalThoughts: 4 });
        assert.equal(reopened.value.reopened, true);

        const state = await store.getSequenceState(sequenceId);
        assert.deepEqual(state.value, {
            sequenceId,
            completed: false,
            thoughtHistoryLength: 7,
            lastThoughtNumber: 4,
            totalThoughts: 4
        });
        const page = await store.getHistory({ sequenceId, limit: 3 });
        assert.deepEqual(
            page.value.thoughts.map((t) => t.thought),
            ['Plan: markup, then validation', 'markup', 'markup, fixed']
        );
        assert.equal(page.value.hasMore, true);
        const next = await store.getHistory({ sequenceId, limit: 50, cursor: page.value.nextCursor, branchId: 'alt' });
        assert.deepEqual(
            next.value.thoughts.map((t) => t.thought),
            ['another way', 'revise inherited']
        );
        const numbered = await store.getThought({ sequenceId, thoughtNumber: 2, branchId: MAIN_BRANCH_ID });
        assert.equal(numbered.value.thoughts.length, 2, 'the thought and its revision');
        assert.equal((await store.getThought({ sequenceId, thoughtNumber: 99 })).error.code, 'thought_not_found');

        const listed = await store.listSequences({ conversationId: 'c1' });
        assert.equal(listed.value.total, 1);
        assert.equal((await store.listSequences({ conversationId: 'c2' })).value.total, 0);

        const removed = await store.deleteConversation('c1');
        assert.deepEqual(removed.value, { conversationId: 'c1', deletedSequences: 1, deletedThoughts: 7 });
        assert.equal((await store.getSequenceState(sequenceId)).error.code, 'sequence_not_found');
        store.close();
    } finally {
        fake.restore?.();
    }
});

test('recall finds the earlier thoughts most like a step, this sequence first, and forgets deleted ones', async () => {
    const fake = installFakeIndexedDb();
    try {
        const vectors = memoryVectors();
        const { store, advance } = await openStore({ vectors });
        const add = async (conversationId, sequenceId, thoughtNumber, thought) => {
            advance(1000);
            const result = await store.appendThought({
                conversationId,
                sequenceId,
                thought,
                thoughtNumber,
                totalThoughts: 9,
                nextThoughtNeeded: true
            });
            return result.value.sequenceId;
        };
        const older = await add('c1', null, 1, 'Earlier answer: a canvas bar chart drawn with requestAnimationFrame');
        const current = await add('c1', null, 1, 'Plan: login form markup, then email validation');
        await add('c1', current, 2, 'The login form: <form id="login"> with an email input and a submit button');
        await add('c1', current, 3, 'Styles for the page header and footer');
        await add('c2', null, 1, 'Another conversation about the login form email input');
        assert.equal(vectors.rows.size, 5, 'every thought is indexed');

        const recalled = await store.recall({
            query: 'Validate the email input of the login form',
            conversationId: 'c1',
            sequenceId: current,
            limit: 2
        });
        assert.deepEqual(
            recalled.map((t) => t.thought),
            [
                'Plan: login form markup, then email validation',
                'The login form: <form id="login"> with an email input and a submit button'
            ],
            'most similar first chosen, then returned in the order they were thought; never another conversation'
        );

        await store.deleteSequence(older);
        assert.equal(vectors.rows.size, 4, 'a deleted thought leaves the vector index too');
        const purged = await store.purge({ keepConversationIds: new Set(['c1']) });
        assert.equal(purged, 1);
        assert.equal(vectors.rows.size, 3);

        // Without idb-vector, the same embedding is compared on the CPU.
        const { store: plain } = await openStore();
        const same = await plain.recall({
            query: 'Validate the email input of the login form',
            conversationId: 'c1',
            sequenceId: current,
            limit: 1
        });
        assert.equal(same[0].thoughtNumber, 2);
        store.close();
        plain.close();
    } finally {
        fake.restore?.();
    }
});

test('idb-vector is imported only after both files match their pinned hashes', async () => {
    const helper = 'export class SortedArray extends Array {}';
    const index =
        'import { SortedArray } from "./utils/sortedarray.js";\nexport class VectorDB { constructor() { this.sorted = SortedArray; } }';
    const sri = (text) => `sha384-${createHash('sha384').update(text).digest('base64')}`;
    const files = {
        index: { url: 'https://cdn.test/index.js', integrity: sri(index) },
        sortedArray: {
            url: 'https://cdn.test/sortedarray.js',
            integrity: sri(helper),
            specifier: './utils/sortedarray.js'
        }
    };
    const requests = [];
    const fetch = async (url, init) => {
        requests.push({ url, init });
        const body = url.endsWith('index.js') ? index : helper;
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
    };
    const imported = [];
    const VectorDB = await loadIdbVector({
        files,
        fetch,
        importer: async (url) => {
            imported.push(url);
            return { VectorDB: class {} };
        }
    });
    assert.equal(typeof VectorDB, 'function');
    assert.equal(imported.length, 1);
    assert.ok(imported[0].startsWith('blob:'));
    assert.ok(requests.every(({ init }) => init.credentials === 'omit'));

    const tampered = { ...files, index: { ...files.index, integrity: sri('something else') } };
    await assert.rejects(
        loadIdbVector({ files: tampered, fetch, importer: async () => assert.fail('imported') }),
        /integrity/
    );
});

test('a reply splits into text and fenced code, an unfinished fence included', () => {
    assert.deepEqual(splitReply('Plain text\nwith lines'), [{ type: 'text', text: 'Plain text\nwith lines' }]);
    assert.deepEqual(splitReply('Before:\n\n```JavaScript\nconst a = 1;\n```\n\nAfter.'), [
        { type: 'text', text: 'Before:' },
        { type: 'code', lang: 'javascript', code: 'const a = 1;', closed: true },
        { type: 'text', text: 'After.' }
    ]);
    assert.deepEqual(splitReply('Streaming:\n```css\n.a {'), [
        { type: 'text', text: 'Streaming:' },
        { type: 'code', lang: 'css', code: '.a {', closed: false }
    ]);
    // A shorter fence inside a longer one is code.
    assert.deepEqual(splitReply('````md\n```js\nx\n```\n````'), [
        { type: 'code', lang: 'md', code: '```js\nx\n```', closed: true }
    ]);
    assert.equal(safeLanguage('js" onload="x'), 'jsonloadx');
});
test('a request can only shorten the profile’s reply limit', () => {
    assert.equal(replyLimit(null, 360), 360);
    assert.equal(replyLimit(256, 360), 256);
    assert.equal(replyLimit(256, 120), 120);
    assert.equal(replyLimit(null, undefined), null);
    assert.equal(replyLimit(256, -5), 256);
});
test('a CPU-emulated WebGPU adapter is reported unsupported, with its own advice', async () => {
    const requested = [];
    const nav = (adapter) => ({
        gpu: {
            requestAdapter: async (options) => {
                requested.push(options);
                return adapter;
            }
        }
    });
    const fallback = await detectWebGPU(nav({ isFallbackAdapter: true, info: {}, limits: {}, features: new Set() }));
    assert.equal(fallback.supported, false);
    assert.equal(fallback.fallbackAdapter, true);
    assert.deepEqual(requested[0], { powerPreference: 'high-performance', forceFallbackAdapter: false });

    const real = await detectWebGPU(nav({ info: { vendor: 'acme' }, limits: {}, features: new Set() }));
    assert.equal(real.supported, true);

    const advice = classifyError({ name: 'WebGPUFallbackAdapterError', message: 'software' });
    assert.equal(advice.kind, 'unsupported');
    assert.match(advice.message, /hardware acceleration/);
});

test('a worker that only has a CPU adapter is dropped, and the page is used from then on', async () => {
    class FakeWorker extends EventTarget {
        constructor(hello) {
            super();
            setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data: hello })), 0);
        }
        postMessage() {}
        terminate() {}
    }
    let noGpu = 0;
    const cpuOnly = { type: 'hello', webgpu: true, adapter: true, fallbackAdapter: true };
    assert.equal(await createWorkerTransport(() => new FakeWorker(cpuOnly), { onNoGpu: () => (noGpu += 1) }), null);
    assert.equal(noGpu, 1);
    const noAdapter = { type: 'hello', webgpu: true, adapter: false, fallbackAdapter: false };
    assert.equal(await createWorkerTransport(() => new FakeWorker(noAdapter)), null);

    const page = () => ({ kind: 'page', post() {}, onMessage() {}, onCrash() {}, terminate() {} });
    const told = await createEngineClient({
        workerTransport: async ({ onNoGpu }) => {
            onNoGpu();
            return null;
        },
        pageTransport: page
    });
    assert.equal(told.kind, 'page');
    assert.equal(told.workerHasNoGpu, true);

    let asked = 0;
    const remembered = await createEngineClient({
        preferred: 'page',
        workerTransport: async () => {
            asked += 1;
            return null;
        },
        pageTransport: page
    });
    assert.equal(remembered.kind, 'page');
    assert.equal(asked, 0, 'the worker is not asked again');
});

test('where the engine ran is remembered with the chat settings and asked for next time', async () => {
    const { WebLLMController } = await import('../src/webllm/WebLLMController.js');
    const saved = new Map();
    const store = {
        async getSettings() {
            return { retention: '7d', mdnEnabled: true, engine: saved.get('engine') ?? null };
        },
        async setSetting(key, value) {
            saved.set(key, value);
        },
        async listConversations() {
            return [];
        },
        close() {}
    };
    const preferredSeen = [];
    const start = async (engineKind, workerHasNoGpu) => {
        const controller = new WebLLMController({
            detectWebGPU: async () => ({ supported: true }),
            swClient: { status: async () => null, prepareLibrary: async () => ({}), clearModel: async () => ({}) },
            createEngine: async ({ preferred }) => {
                preferredSeen.push(preferred);
                return {
                    kind: engineKind,
                    workerHasNoGpu,
                    load: async () => ({}),
                    interrupt() {},
                    dispose() {}
                };
            },
            openHistory: async () => store
        });
        controller.setAllowed(true, { walletAddress: '0xabc' });
        while (controller.state.history !== 'ready') await new Promise((resolve) => setTimeout(resolve, 0));
        await controller.activate();
        await controller.install();
        return controller;
    };

    const first = await start('page', true);
    assert.equal(first.state.engineKind, 'page');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(saved.get('engine'), 'page');

    await start('page', false);
    assert.deepEqual(preferredSeen, [null, 'page']);
});
