/**
 * How a reply is generated, ended and remembered — end to end.
 *
 * The real controller, the real engine client and host, and the real loop
 * guard, with only the WebLLM module replaced by a scripted one: it streams
 * whatever a test says the model would say and records exactly what it was
 * asked. That makes these tests about the pipeline — the request WebLLM
 * receives, the finish reasons that come back, what is shown, what is passed
 * back as context — and says nothing about how good Llama's own answers are;
 * that depends on weights and a GPU a test run does not have.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WebLLMController } from '../src/webllm/WebLLMController.js';
import { WebLLMEngineClient, createPageTransport } from '../src/webllm/WebLLMEngineClient.js';
import { createEngineHost, generationParams } from '../src/webllm/webllmEngineHost.js';
import {
    WEBLLM_CONTEXT_WINDOW,
    WEBLLM_GENERATION,
    WEBLLM_PROMPT_TOKEN_BUDGET,
    WEBLLM_SYSTEM_PROMPT
} from '../src/webllm/webllmConfig.js';
import { LENGTH_NOTICE, LOOP_NOTICE, MESSAGE_TOO_LONG, estimateTokens } from '../src/webllm/webllmProgress.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const rep = (text, times, separator = ' ') => Array(times).fill(text).join(separator);
/** Varied filler of about `chars` characters — repetition would (rightly) be stopped as a loop. */
const filler = (seed, chars) => {
    let text = '';
    for (let i = 0; text.length < chars; i += 1) text += `${seed}${i} `;
    return text.slice(0, chars).trimEnd();
};

/**
 * A stand-in for `@mlc-ai/web-llm` whose model says what `respond` says.
 * `respond(messages, callNumber)` returns `{ text, finish?, size? }` or throws.
 * Like the real engine, an interrupt ends the stream with `finish_reason: "abort"`.
 */
function scriptedWebLLM(respond) {
    const state = { requests: [], emitted: 0, interrupts: 0 };
    class MLCEngine {
        constructor() {
            this.interrupted = false;
            this.chat = {
                completions: {
                    create: async (request) => {
                        state.requests.push(request);
                        this.interrupted = false;
                        const plan = respond(request.messages, state.requests.length);
                        const size = plan.size ?? 5;
                        const pieces = [];
                        for (let at = 0; at < plan.text.length; at += size) pieces.push(plan.text.slice(at, at + size));
                        const engine = this;
                        return (async function* () {
                            for (const piece of pieces) {
                                await tick();
                                if (engine.interrupted) {
                                    yield { choices: [{ delta: {}, finish_reason: 'abort' }] };
                                    return;
                                }
                                state.emitted += 1;
                                yield { choices: [{ delta: { content: piece } }] };
                            }
                            yield {
                                choices: [{ delta: {}, finish_reason: plan.finish ?? 'stop' }],
                                usage: { prompt_tokens: 10, completion_tokens: pieces.length }
                            };
                        })();
                    }
                }
            };
        }
        async reload() {}
        async unload() {}
        interruptGenerate() {
            state.interrupts += 1;
            this.interrupted = true;
        }
    }
    return { module: { MLCEngine }, state };
}

/** The controller, wired to the scripted model through the real host and client. */
async function session(respond) {
    const llm = scriptedWebLLM(respond);
    const controller = new WebLLMController({
        detectWebGPU: async () => ({ supported: true, reason: null, vendor: 'test', description: 'gpu' }),
        swClient: {
            status: async () => ({ model: { state: 'absent', bytesCached: 0, bytesTotal: 0 } }),
            prepareLibrary: async () => ({}),
            clearModel: async () => ({})
        },
        createEngine: async () =>
            new WebLLMEngineClient(
                createPageTransport(({ post }) => createEngineHost({ post, loadLibrary: async () => llm.module }))
            )
    });
    controller.setAllowed(true);
    await controller.activate();
    await controller.install();
    assert.equal(controller.state.status, 'ready');
    return { controller, llm };
}

const lastReply = (controller) => controller.state.messages.at(-1);

// ── what is asked of WebLLM ─────────────────────────────────────────────────

test('the pinned sampling settings are the ones WebLLM accepts', () => {
    assert.deepEqual(
        { ...WEBLLM_GENERATION },
        {
            temperature: 0.6,
            top_p: 0.9,
            repetition_penalty: 1.1,
            frequency_penalty: 0,
            presence_penalty: 0,
            max_tokens: 384
        }
    );
    // The ranges `postInitAndCheckGenerationConfigValues` enforces in
    // @mlc-ai/web-llm@0.2.85; outside them a request throws before generating.
    const g = WEBLLM_GENERATION;
    assert.ok(g.temperature >= 0);
    assert.ok(g.top_p > 0 && g.top_p <= 1);
    assert.ok(g.repetition_penalty > 0);
    assert.ok(g.frequency_penalty >= -2 && g.frequency_penalty <= 2);
    assert.ok(g.presence_penalty >= -2 && g.presence_penalty <= 2);
    assert.ok(Number.isInteger(g.max_tokens) && g.max_tokens > 0);
    // The reply has to fit in what the prompt leaves of the window.
    assert.ok(g.max_tokens < WEBLLM_CONTEXT_WINDOW / 2);
});

test('settings are built from the pinned defaults, and only known numbers get through', () => {
    assert.deepEqual(generationParams(), { ...WEBLLM_GENERATION });
    assert.deepEqual(generationParams({ temperature: 0.2, max_tokens: 64 }), {
        ...WEBLLM_GENERATION,
        temperature: 0.2,
        max_tokens: 64
    });
    // Not numbers, not finite, or not settings: ignored.
    assert.deepEqual(
        generationParams({ temperature: '9', top_p: NaN, max_tokens: Infinity, logit_bias: { 1: 100 }, stop: ['x'] }),
        { ...WEBLLM_GENERATION }
    );
});

test('every request carries the settings, a system prompt first, and asks for a stream with usage', async () => {
    const { controller, llm } = await session(() => ({ text: 'Hey! What can I help you with?' }));
    await controller.send('hey');

    const [request] = llm.state.requests;
    assert.equal(request.stream, true);
    assert.deepEqual(request.stream_options, { include_usage: true });
    for (const [key, value] of Object.entries(WEBLLM_GENERATION)) assert.equal(request[key], value, key);
    assert.deepEqual(request.messages, [
        { role: 'system', content: WEBLLM_SYSTEM_PROMPT },
        { role: 'user', content: 'hey' }
    ]);
});

test('the system prompt asks for short, direct, non-repeating English', () => {
    assert.match(WEBLLM_SYSTEM_PROMPT, /\bEnglish\b/);
    assert.match(WEBLLM_SYSTEM_PROMPT, /greeting/);
    assert.match(WEBLLM_SYSTEM_PROMPT, /short/i);
    assert.match(WEBLLM_SYSTEM_PROMPT, /[Nn]ever repeat/);
    assert.match(WEBLLM_SYSTEM_PROMPT, /filler/);
    // Small models echo what they are shown: no example replies, and not a wall of rules.
    assert.doesNotMatch(WEBLLM_SYSTEM_PROMPT, /e\.g\.|for example|"/);
    assert.ok(WEBLLM_SYSTEM_PROMPT.length < 600);
    assert.ok(estimateTokens(WEBLLM_SYSTEM_PROMPT) < 200);
});

// ── representative conversations, through the whole pipeline ────────────────

test('simple messages: one short reply that ends on its own and is not flagged', async () => {
    const answers = {
        hey: 'Hey! What can I help you with?',
        hello: 'Hello! How can I help today?',
        'What is the capital of France?': 'The capital of France is Paris.'
    };
    const { controller } = await session((messages) => ({ text: answers[messages.at(-1).content] }));

    for (const prompt of Object.keys(answers)) {
        await controller.send(prompt);
        const reply = lastReply(controller);
        assert.equal(reply.content, answers[prompt], prompt);
        assert.equal(reply.finishReason, 'stop', prompt);
        assert.equal(reply.notice, null, prompt);
        assert.equal(reply.error, null, prompt);
        assert.equal(reply.stopped, false, prompt);
        assert.ok(reply.content.length < 80, `a short answer stays short: ${prompt}`);
    }
    assert.equal(controller.state.generating, false);
});

test('multi-turn: each request carries the earlier exchanges, in order, after the system prompt', async () => {
    const { controller, llm } = await session((messages) => ({ text: `Answer ${messages.length / 2}.` }));
    await controller.send('My name is Sam.');
    await controller.send('What is a prime number?');
    await controller.send('And what is my name?');

    assert.deepEqual(
        llm.state.requests.at(-1).messages.map((message) => [message.role, message.content]),
        [
            ['system', WEBLLM_SYSTEM_PROMPT],
            ['user', 'My name is Sam.'],
            ['assistant', 'Answer 1.'],
            ['user', 'What is a prime number?'],
            ['assistant', 'Answer 2.'],
            ['user', 'And what is my name?']
        ]
    );
});

test('a longer explanation cut by the length limit says so and is still remembered', async () => {
    const cut = 'Sure. A neural network is built from layers of simple units, each of which takes numbers in and';
    const { controller, llm } = await session((messages) =>
        messages.at(-1).content.startsWith('Explain') ? { text: cut, finish: 'length' } : { text: 'Yes.' }
    );
    await controller.send('Explain how neural networks work');

    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'length');
    assert.equal(reply.notice, LENGTH_NOTICE);
    assert.equal(reply.content, cut);

    await controller.send('ok');
    assert.equal(llm.state.requests.at(-1).messages[2].content, cut, 'a cut-off answer is still context');
});

// ── loops ───────────────────────────────────────────────────────────────────

const LOOPING_HEY =
    "Hey! How's it going? " + rep("Hey! How's it going? I'm here to help you with anything you need.", 40);

test('the reported regression: "hey" answered with the same sentence forever is stopped, trimmed and explained', async () => {
    const { controller, llm } = await session(() => ({ text: LOOPING_HEY }));
    const pieces = Math.ceil(LOOPING_HEY.length / 5);

    await controller.send('hey');

    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'loop');
    assert.equal(reply.notice, LOOP_NOTICE);
    assert.equal(reply.stopped, false, 'it was not the user who stopped it');
    assert.equal(reply.pending, false);
    assert.equal(controller.state.generating, false);
    assert.equal(llm.state.interrupts, 1, 'the engine was told to stop');
    assert.ok(llm.state.emitted < pieces / 4, `${llm.state.emitted} of ${pieces} pieces were generated`);
    // One answer is kept; the repeats are not shown.
    assert.equal(
        reply.content,
        "Hey! How's it going? Hey! How's it going? I'm here to help you with anything you need."
    );
});

test('a reply that looped is not passed back, and chat carries on normally', async () => {
    const { controller, llm } = await session((messages) =>
        messages.at(-1).content === 'hey' ? { text: LOOPING_HEY } : { text: 'Paris.' }
    );
    await controller.send('hey');
    await controller.send('What is the capital of France?');

    assert.deepEqual(llm.state.requests.at(-1).messages, [
        { role: 'system', content: WEBLLM_SYSTEM_PROMPT },
        { role: 'user', content: 'What is the capital of France?' }
    ]);
    assert.equal(lastReply(controller).content, 'Paris.');
    assert.equal(lastReply(controller).finishReason, 'stop');
});

test('the user pressing Stop is "abort", never "loop", and is not passed back either', async () => {
    const { controller, llm } = await session((messages) =>
        messages.at(-1).content === 'Tell me about space'
            ? { text: 'Space is vast and mostly empty. '.repeat(40) }
            : { text: 'Hi.' }
    );
    const sending = controller.send('Tell me about space');
    while (llm.state.emitted < 6) await tick();
    controller.stop();
    await sending;

    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'abort');
    assert.equal(reply.stopped, true);
    assert.equal(reply.notice, null);
    assert.ok(reply.content.startsWith('Space is vast'), 'what was written is kept on screen');
    assert.equal(controller.state.generating, false);

    await controller.send('hi');
    assert.deepEqual(
        llm.state.requests.at(-1).messages.map((message) => message.role),
        ['system', 'user']
    );
});

test('New chat during a reply stops it and starts clean', async () => {
    const { controller, llm } = await session((messages) =>
        messages.at(-1).content === 'first'
            ? { text: 'A long and winding answer. '.repeat(30) }
            : { text: 'Fresh start.' }
    );
    const sending = controller.send('first');
    while (llm.state.emitted < 4) await tick();
    controller.newChat();
    await sending;
    assert.equal(controller.state.messages.length, 0);

    await controller.send('second');
    assert.deepEqual(
        llm.state.requests.at(-1).messages.map((message) => message.content),
        [WEBLLM_SYSTEM_PROMPT, 'second']
    );
    assert.equal(lastReply(controller).content, 'Fresh start.');
});

test('streaming still shows text as it arrives, and a healthy reply is never interrupted', async () => {
    const reply = 'WebGPU is a modern graphics API. It lets pages use the GPU. That makes local models practical.';
    const { controller, llm } = await session(() => ({ text: reply, size: 3 }));
    const seen = [];
    controller.onChange = (state, change) => {
        if (change.type === 'delta') seen.push(lastReply(controller).content.length);
    };
    await controller.send('What is WebGPU?');

    assert.ok(seen.length > 10);
    assert.deepEqual(
        seen,
        [...seen].sort((a, b) => a - b),
        'text only ever grows'
    );
    assert.equal(lastReply(controller).content, reply);
    assert.equal(llm.state.interrupts, 0);
});

test('asking for repetition is respected: five hellos are not a loop', async () => {
    const hellos = rep('Hello world today friend.', 5);
    const { controller, llm } = await session(() => ({ text: hellos }));
    await controller.send('Say hello world today friend five times');

    assert.equal(lastReply(controller).finishReason, 'stop');
    assert.equal(lastReply(controller).content, hellos);
    assert.equal(llm.state.interrupts, 0);
});

// ── context ─────────────────────────────────────────────────────────────────

test('a long conversation is trimmed to the window: oldest exchanges go, the newest and the system prompt stay', async () => {
    const { controller, llm } = await session((messages) => ({ text: filler(`r${messages.length}x`, 1500) }));

    for (let i = 1; i <= 14; i += 1)
        await controller.send(`question ${String(i).padStart(2, '0')} ${filler('q', 1500)}`);

    const lengths = llm.state.requests.map(({ messages }) => messages.length);
    for (const { messages } of llm.state.requests) {
        const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content) + 5, 5);
        assert.ok(tokens <= WEBLLM_PROMPT_TOKEN_BUDGET, `${tokens} estimated tokens`);
        assert.equal(messages[0].role, 'system');
        assert.equal(messages[1].role, 'user', 'it starts on a question, never a reply');
        assert.equal(messages.length % 2, 0, 'whole exchanges, then the newest question');
    }
    // The history grows while it fits, then stops growing as the oldest exchanges are dropped.
    assert.ok(lengths[3] > lengths[1], 'earlier exchanges are passed back');
    assert.ok(Math.max(...lengths) < 2 * 14 + 2, 'but not all of them');
    assert.equal(lengths.at(-1), lengths.at(-2), 'a steady window once full');
    const last = llm.state.requests.at(-1).messages;
    assert.match(last.at(-1).content, /^question 14 /);
    assert.equal(
        last.some((message) => message.content.startsWith('question 01')),
        false
    );
});

test('when the engine says the prompt does not fit, it is asked once more with less history', async () => {
    const overflow = Object.assign(new Error('Prompt tokens exceed context window size'), {
        name: 'ContextWindowSizeExceededError'
    });
    const big = (label) => `${label} ${filler('q', 900)}`;
    let overflowed = false;
    const { controller, llm } = await session((messages) => {
        if (messages.at(-1).content.startsWith('final') && !overflowed) {
            overflowed = true;
            throw overflow;
        }
        return { text: filler('a', 900) };
    });
    // Fills about three quarters of the budget: it fits, but only just.
    for (let i = 1; i <= 4; i += 1) await controller.send(big(`message ${i}`));
    const before = llm.state.requests.length;

    await controller.send(big('final'));
    const [first, second] = llm.state.requests.slice(before);
    assert.ok(second, 'a second attempt was made');
    assert.ok(second.messages.length < first.messages.length, 'with fewer earlier messages');
    assert.ok(second.messages.at(-1).content.startsWith('final'));
    assert.equal(lastReply(controller).error, null);
    assert.equal(lastReply(controller).finishReason, 'stop');
});

test('a message too big for the window is refused up front, with nothing sent', async () => {
    const { controller, llm } = await session(() => ({ text: 'never' }));
    await controller.send('y'.repeat(20000));

    assert.equal(llm.state.requests.length, 0);
    const reply = lastReply(controller);
    assert.equal(reply.error, MESSAGE_TOO_LONG);
    assert.equal(reply.finishReason, 'error');
    assert.equal(controller.state.status, 'ready', 'the chat is still usable');

    await controller.send('hi');
    assert.equal(llm.state.requests.length, 1);
    assert.deepEqual(llm.state.requests[0].messages.map((message) => message.content).slice(1), ['hi']);
});

test('a failed request is shown, kept out of context, and does not poison the next one', async () => {
    const { controller, llm } = await session((messages) => {
        if (messages.at(-1).content === 'boom')
            throw Object.assign(new Error('Failed to fetch'), { name: 'TypeError' });
        return { text: 'fine.' };
    });
    await controller.send('boom');
    assert.equal(lastReply(controller).finishReason, 'error');
    assert.ok(lastReply(controller).error);

    await controller.send('hello');
    assert.deepEqual(
        llm.state.requests.at(-1).messages.map((message) => message.role),
        ['system', 'user']
    );
    assert.equal(lastReply(controller).content, 'fine.');
});
