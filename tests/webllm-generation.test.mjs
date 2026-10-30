/**
 * How a reply is generated, ended and remembered — end to end.
 *
 * The real controller, the real engine client and host, with only the
 * WebLLM module replaced by a scripted one: it streams
 * whatever a test says the model would say and records exactly what it was
 * asked. That makes these tests about the pipeline — the request WebLLM
 * receives, the finish reasons that come back, what is shown, what is passed
 * back as context — and says nothing about how good Llama's own answers are;
 * that depends on weights and a GPU a test run does not have.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WebLLMController, stepIncompleteNotice } from '../src/webllm/WebLLMController.js';
import { similarity } from '../src/webllm/thoughtEmbedding.js';
import { WebLLMEngineClient, createPageTransport } from '../src/webllm/WebLLMEngineClient.js';
import { createEngineHost } from '../src/webllm/webllmEngineHost.js';
import {
    WEBLLM_CHAT_OPTIONS,
    WEBLLM_CONTEXT_WINDOW,
    WEBLLM_MODEL_ID,
    WEBLLM_PROFILES,
    WEBLLM_PROMPT_TOKEN_BUDGET,
    WEBLLM_SYSTEM_PROMPT,
    WEBLLM_THINKING
} from '../src/webllm/webllmConfig.js';
import { MODE_SCHEMA, PLAN_SCHEMA, SHORT_SYSTEM_PROMPT } from '../src/webllm/webllmThinking.js';
import { splitReply } from '../src/ui/webllm/replyFormat.js';
import { openWebLLMHistory } from '../src/webllm/webllmHistoryStore.js';
import { openWebLLMThoughts } from '../src/webllm/webllmThoughtStore.js';
import { installFakeIndexedDb } from './helpers/fake-indexeddb.mjs';
import {
    CONTINUE_EXHAUSTED_NOTICE,
    MDN_UNAVAILABLE_NOTE,
    MESSAGE_TOO_LONG,
    estimateTokens
} from '../src/webllm/webllmProgress.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const rep = (text, times, separator = ' ') => Array(times).fill(text).join(separator);
/** Varied filler of about `chars` characters. */
const filler = (seed, chars) => {
    let text = '';
    for (let i = 0; text.length < chars; i += 1) text += `${seed}${i} `;
    return text.slice(0, chars).trimEnd();
};

/**
 * A stand-in for `@mlc-ai/web-llm` whose model says what `respond` says.
 * `respond(messages, callNumber, request)` returns `{ text, finish?, size? }` or
 * throws. A text completion (Continue) is answered by the same function, with
 * `messages` null and the raw prompt on `request.prompt`. Like the real engine,
 * an interrupt ends the stream with `finish_reason: "abort"`, and `max_tokens`
 * ends it with "length" (one piece stands for one token here).
 */
function scriptedWebLLM(respond) {
    const state = { requests: [], completions: [], emitted: 0, interrupts: 0, reloads: [], engineConfig: null };
    class MLCEngine {
        constructor(engineConfig) {
            state.engineConfig = engineConfig;
            this.interrupted = false;
            const engine = this;
            const stream = (request, plan, chat) => {
                engine.interrupted = false;
                const size = plan.size ?? 5;
                let pieces = [];
                for (let at = 0; at < plan.text.length; at += size) pieces.push(plan.text.slice(at, at + size));
                let finish = plan.finish ?? 'stop';
                if (request.max_tokens && pieces.length >= request.max_tokens) {
                    pieces = pieces.slice(0, request.max_tokens);
                    finish = 'length';
                }
                const chunk = (text, finishReason = null) =>
                    chat
                        ? { choices: [{ delta: text ? { content: text } : {}, finish_reason: finishReason }] }
                        : { choices: [{ text: text || '', finish_reason: finishReason }] };
                return (async function* () {
                    for (const piece of pieces) {
                        await tick();
                        if (engine.interrupted) {
                            yield chunk('', 'abort');
                            return;
                        }
                        state.emitted += 1;
                        yield chunk(piece);
                    }
                    yield { ...chunk('', finish), usage: { prompt_tokens: 10, completion_tokens: pieces.length } };
                })();
            };
            this.chat = {
                completions: {
                    create: async (request) => {
                        state.requests.push(request);
                        return stream(request, respond(request.messages, state.requests.length, request), true);
                    }
                }
            };
            this.completions = {
                create: async (request) => {
                    state.completions.push(request);
                    return stream(request, respond(null, state.completions.length, request), false);
                }
            };
        }
        async reload(modelId, chatOpts) {
            state.reloads.push({ modelId, chatOpts });
        }
        async unload() {}
        interruptGenerate() {
            state.interrupts += 1;
            this.interrupted = true;
        }
    }
    return { module: { MLCEngine }, state };
}

/** The conversation part of a request: everything after the system prompt. */
const turns = (messages) => messages.filter((message) => message.role !== 'system');

/** The controller, wired to the scripted model through the real host and client. */
async function session(respond, { profile, mdnClient, replyMode = 'short', wallet = null, vectors = null } = {}) {
    const llm = scriptedWebLLM(respond);
    const controller = new WebLLMController({
        ...(profile ? { profile } : {}),
        ...(mdnClient ? { mdnClient } : {}),
        // With a wallet: the real history and thought stores, on the in-memory IndexedDB.
        ...(wallet
            ? {
                  openHistory: (walletAddress) => openWebLLMHistory({ walletAddress }),
                  openThoughts: (walletAddress) =>
                      openWebLLMThoughts({ walletAddress, ...(vectors ? { vectors: async () => vectors } : {}) })
              }
            : {}),
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
    controller.setAllowed(true, { walletAddress: wallet });
    if (wallet) {
        while (controller.state.history !== 'ready' || !controller.thoughts) await tick();
    }
    // Most tests pin the mode; the Auto tests choose it.
    await controller.setReplyMode(replyMode);
    await controller.activate();
    await controller.install();
    assert.equal(controller.state.status, 'ready');
    return { controller, llm };
}

const lastReply = (controller) => controller.state.messages.at(-1);

// ── what is asked of WebLLM ─────────────────────────────────────────────────

test('the generation settings are the official WebLLM Chat ones for this model', () => {
    // chat.webllm.ai's `recommended_config` for Llama-3.2-1B-Instruct, and the
    // prebuilt record's 4096-token window.
    assert.deepEqual(
        { ...WEBLLM_CHAT_OPTIONS },
        { temperature: 0.6, top_p: 0.9, presence_penalty: 0, frequency_penalty: 0, context_window_size: 4096 }
    );
    assert.equal(WEBLLM_CONTEXT_WINDOW, 4096);
    // The model's own defaults stay: no repetition penalty, no reply cap.
    assert.equal('repetition_penalty' in WEBLLM_CHAT_OPTIONS, false);
    assert.equal('max_tokens' in WEBLLM_CHAT_OPTIONS, false);
});

test('the settings are given to reload() as chat options, with the q4f32 model, as the official client does', async () => {
    const { llm } = await session(() => ({ text: 'Hi!' }));
    assert.deepEqual(llm.state.reloads, [{ modelId: WEBLLM_MODEL_ID, chatOpts: { ...WEBLLM_CHAT_OPTIONS } }]);
    assert.equal(WEBLLM_MODEL_ID, 'Llama-3.2-1B-Instruct-q4f32_1-MLC');
    const [record] = llm.state.engineConfig.appConfig.model_list;
    assert.equal(record.model_id, 'Llama-3.2-1B-Instruct-q4f32_1-MLC');
    assert.match(record.model, /\/mlc-ai\/Llama-3\.2-1B-Instruct-q4f32_1-MLC\//);
    assert.match(record.model_lib, /\/v0_2_84\/base\/Llama-3\.2-1B-Instruct-q4f32_1_cs1k-webgpu\.wasm$/);
    assert.equal(record.vram_required_MB, 1128.82);
    assert.deepEqual(record.overrides, { context_window_size: 4096 });
    assert.equal(llm.state.engineConfig.appConfig.model_list.length, 1);
});

test('a request carries the developer system prompt, the messages and the stream flags — no sampling settings', async () => {
    const { controller, llm } = await session(() => ({ text: 'Hey! What can I help you with?' }));
    await controller.send('hey');

    const [request] = llm.state.requests;
    assert.deepEqual(request, {
        messages: [
            { role: 'system', content: SHORT_SYSTEM_PROMPT },
            { role: 'user', content: 'hey' }
        ],
        stream: true,
        stream_options: { include_usage: true },
        // A short answer is held to its window.
        max_tokens: WEBLLM_THINKING.desktop.shortMaxTokens
    });
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

test('multi-turn: each request carries the recent exchanges, in order', async () => {
    const { controller, llm } = await session((messages) => ({ text: `Answer ${(turns(messages).length + 1) / 2}.` }));
    await controller.send('My name is Sam.');
    await controller.send('What is a prime number?');
    await controller.send('And what is my name?');

    assert.equal(llm.state.requests.at(-1).messages[0].content, SHORT_SYSTEM_PROMPT);
    assert.deepEqual(
        turns(llm.state.requests.at(-1).messages).map((message) => [message.role, message.content]),
        [
            ['user', 'My name is Sam.'],
            ['assistant', 'Answer 1.'],
            ['user', 'What is a prime number?'],
            ['assistant', 'Answer 2.'],
            ['user', 'And what is my name?']
        ]
    );

    // A fourth turn sees the last two exchanges, as chat.webllm.ai sends them.
    await controller.send('Thanks!');
    assert.deepEqual(
        turns(llm.state.requests.at(-1).messages).map((message) => message.content),
        ['What is a prime number?', 'Answer 2.', 'And what is my name?', 'Answer 3.', 'Thanks!']
    );
});

test('a longer explanation cut by the length limit offers Continue and is still remembered', async () => {
    const cut = 'Sure. A neural network is built from layers of simple units, each of which takes numbers in and';
    const { controller, llm } = await session((messages) =>
        messages.at(-1).content.startsWith('Explain') ? { text: cut, finish: 'length' } : { text: 'Yes.' }
    );
    await controller.send('Explain how neural networks work');

    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'length');
    assert.equal(reply.continuable, true);
    assert.equal(reply.notice, null, 'Continue replaces the old "ask it to continue" note');
    assert.equal(reply.content, cut);

    await controller.send('ok');
    assert.equal(turns(llm.state.requests.at(-1).messages)[1].content, cut, 'a cut-off answer is still context');
});

// ── no loop guard ───────────────────────────────────────────────────────────

const LOOPING_HEY =
    "Hey! How's it going? " + rep("Hey! How's it going? I'm here to help you with anything you need.", 40);

test('a reply that repeats itself is never cut: every token is shown, up to the reply limit', async () => {
    const { controller, llm } = await session(() => ({ text: LOOPING_HEY }));
    await controller.send('hey');

    const reply = lastReply(controller);
    // Only the reply limit ends it — as for any long reply — and Continue is offered.
    assert.equal(reply.finishReason, 'length');
    assert.equal(reply.continuable, true);
    assert.equal(reply.notice, null);
    assert.equal(reply.stopped, false);
    assert.equal(llm.state.interrupts, 0, 'the engine is never told to stop');
    assert.equal(llm.state.emitted, WEBLLM_THINKING.desktop.shortMaxTokens);
    assert.equal(reply.content, LOOPING_HEY.slice(0, llm.state.emitted * 5), 'every streamed token is kept');
});

test('a short repeating reply the model ends itself is shown whole', async () => {
    const hellos = rep('Hello world today friend.', 5);
    const { controller, llm } = await session(() => ({ text: hellos }));
    await controller.send('hi');

    assert.equal(lastReply(controller).finishReason, 'stop');
    assert.equal(lastReply(controller).content, hellos);
    assert.equal(llm.state.interrupts, 0);
});

test('the user pressing Stop is "abort", and the stopped reply is not passed back', async () => {
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
        [SHORT_SYSTEM_PROMPT, 'second']
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

// ── context ─────────────────────────────────────────────────────────────────

test('a long conversation is held to the last two exchanges and the token budget', async () => {
    const { controller, llm } = await session((messages) => ({ text: filler(`r${messages.length}x`, 2500) }));

    for (let i = 1; i <= 8; i += 1)
        await controller.send(`question ${String(i).padStart(2, '0')} ${filler('q', 2500)}`);

    const lengths = llm.state.requests.map(({ messages }) => turns(messages).length);
    for (const { messages } of llm.state.requests) {
        const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content) + 5, 24);
        assert.ok(tokens <= WEBLLM_PROMPT_TOKEN_BUDGET, `${tokens} estimated tokens`);
        assert.equal(messages[0].role, 'system');
        assert.equal(turns(messages)[0].role, 'user', 'it starts on a question, never a reply');
        assert.equal(turns(messages).length % 2, 1, 'whole exchanges, then the newest question');
        assert.ok(turns(messages).length <= 5, 'never more than the last four messages and the new one');
    }
    // Long messages: the token budget, not the message count, is what binds here.
    assert.ok(Math.max(...lengths) < 5, `lengths ${lengths}`);
    assert.ok(Math.max(...lengths) > 1, 'but earlier exchanges are still passed back');
    const last = llm.state.requests.at(-1).messages;
    assert.match(last.at(-1).content, /^question 08 /);
    assert.equal(
        last.some((message) => message.content.startsWith('question 01')),
        false
    );
});

test('when the engine says the prompt does not fit, it is asked once more with less history', async () => {
    const overflow = Object.assign(new Error('Prompt tokens exceed context window size'), {
        name: 'ContextWindowSizeExceededError'
    });
    const big = (label) => `${label} ${filler('q', 1500)}`;
    let overflowed = false;
    const { controller, llm } = await session((messages) => {
        if (messages.at(-1).content.startsWith('final') && !overflowed) {
            overflowed = true;
            throw overflow;
        }
        return { text: filler('a', 1500) };
    });
    // Two exchanges plus the new message fill most of the budget: it fits, but only just.
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
    assert.deepEqual(turns(llm.state.requests[0].messages), [{ role: 'user', content: 'hi' }]);
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

// ── the mobile memory profile ───────────────────────────────────────────────

const MOBILE = WEBLLM_PROFILES.mobile;
const DESKTOP = WEBLLM_PROFILES.desktop;

test('mobile: the engine loads SmolLM2 360M with a 2048-token context and its own temperature', async () => {
    const { llm } = await session(() => ({ text: 'Hi!' }), { profile: MOBILE });
    assert.deepEqual(llm.state.reloads, [
        {
            modelId: 'SmolLM2-360M-Instruct-q4f32_1-MLC',
            chatOpts: { ...WEBLLM_CHAT_OPTIONS, temperature: 0.2, context_window_size: 2048 }
        }
    ]);
    const [record] = llm.state.engineConfig.appConfig.model_list;
    assert.deepEqual(record.overrides, { context_window_size: 2048 });
    assert.equal(record.model_id, 'SmolLM2-360M-Instruct-q4f32_1-MLC');
    assert.equal(record.model, 'https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f32_1-MLC/resolve/main/');
    assert.match(record.model_lib, /\/v0_2_84\/base\/SmolLM2-360M-Instruct-q4f32_1_cs1k-webgpu\.wasm$/);
    assert.equal(record.vram_required_MB, 579.61);
});

test('desktop: the engine still loads Llama 3.2 1B with the shared sampling', async () => {
    const { llm } = await session(() => ({ text: 'Hi!' }), { profile: DESKTOP });
    assert.deepEqual(llm.state.reloads, [{ modelId: WEBLLM_MODEL_ID, chatOpts: { ...WEBLLM_CHAT_OPTIONS } }]);
    assert.equal(llm.state.engineConfig.appConfig.model_list[0].model_id, 'Llama-3.2-1B-Instruct-q4f32_1-MLC');
});

test('mobile: a short request carries the shorter of its own limit and 256, and a reply that reaches it can be continued', async () => {
    const long = filler('w', 5 * 400); // 400 pieces: more than the limit
    const { controller, llm } = await session(() => ({ text: long }), { profile: MOBILE });
    await controller.send('Write a long essay about the ocean');

    const cap = Math.min(256, WEBLLM_THINKING.mobile.shortMaxTokens);
    const [request] = llm.state.requests;
    assert.equal(request.max_tokens, cap);
    assert.deepEqual(Object.keys(request).sort(), ['max_tokens', 'messages', 'stream', 'stream_options']);
    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'length');
    assert.equal(reply.continuable, true);
    assert.equal(reply.notice, null);
    assert.equal(reply.content, long.slice(0, cap * 5), 'every streamed token is kept, up to the limit');
    assert.equal(llm.state.emitted, cap);
});

test('mobile: a short reply is untouched by the limit', async () => {
    const { controller } = await session(() => ({ text: 'Hello! How can I help?' }), { profile: MOBILE });
    await controller.send('hey');
    assert.equal(lastReply(controller).finishReason, 'stop');
    assert.equal(lastReply(controller).notice, null);
});

test('desktop: 4096 context at reload, and only the short limit on a reply', async () => {
    const { controller, llm } = await session(() => ({ text: 'cut', finish: 'length' }), { profile: DESKTOP });
    await controller.send('hi');
    assert.deepEqual(llm.state.reloads[0].chatOpts, { ...WEBLLM_CHAT_OPTIONS });
    assert.equal(llm.state.requests[0].max_tokens, WEBLLM_THINKING.desktop.shortMaxTokens);
    assert.equal(lastReply(controller).continuable, true);

    // No profile given is the desktop one.
    const plain = await session(() => ({ text: 'ok' }));
    await plain.controller.send('hi');
    assert.equal(plain.controller.profile.id, 'desktop');
    assert.equal(plain.llm.state.requests[0].max_tokens, WEBLLM_THINKING.desktop.shortMaxTokens);
});

test('mobile: a reply cut short of the limit by a full context can still be continued while there is room', async () => {
    const { controller } = await session(() => ({ text: 'Partial answer', finish: 'length' }), { profile: MOBILE });
    await controller.send('hi');
    assert.equal(lastReply(controller).continuable, true);
});

test('mobile: history is trimmed to the smaller budget, leaving room for the 256-token reply', async () => {
    assert.ok(MOBILE.promptTokenBudget + MOBILE.maxTokens < MOBILE.contextWindow);
    const { controller, llm } = await session((messages) => ({ text: filler(`r${messages.length}x`, 1200) }), {
        profile: MOBILE
    });
    for (let i = 1; i <= 6; i += 1) await controller.send(`question ${i} ${filler('q', 1200)}`);

    for (const { messages } of llm.state.requests) {
        const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content) + 5, 24);
        assert.ok(tokens <= MOBILE.promptTokenBudget, `${tokens} estimated tokens > ${MOBILE.promptTokenBudget}`);
        assert.equal(messages[0].role, 'system');
        assert.equal(turns(messages)[0].role, 'user');
    }
    // The same conversation keeps more history on desktop.
    const desktop = await session((messages) => ({ text: filler(`r${messages.length}x`, 1200) }));
    for (let i = 1; i <= 6; i += 1) await desktop.controller.send(`question ${i} ${filler('q', 1200)}`);
    assert.ok(desktop.llm.state.requests.at(-1).messages.length > llm.state.requests.at(-1).messages.length);
});

test('mobile: Stop and New chat still work under the limit', async () => {
    const { controller, llm } = await session(() => ({ text: filler('s', 5 * 200) }), { profile: MOBILE });
    const sending = controller.send('tell me everything');
    while (llm.state.emitted < 5) await tick();
    controller.stop();
    await sending;
    assert.equal(lastReply(controller).finishReason, 'abort');
    assert.equal(lastReply(controller).stopped, true);
    assert.ok(llm.state.emitted < 200);

    controller.newChat();
    assert.equal(controller.state.messages.length, 0);
    await controller.send('hi');
    assert.deepEqual(turns(llm.state.requests.at(-1).messages), [{ role: 'user', content: 'hi' }]);
});

// ── Continue ────────────────────────────────────────────────────────────────

test('Continue picks the reply up in place: same message, no new question, the prompt ends inside the reply', async () => {
    const first = filler('a', 5 * 300); // more than the 256-token mobile limit
    const { controller, llm } = await session(
        (messages) => (messages ? { text: first } : { text: ' and that is the end.', finish: 'stop' }),
        { profile: MOBILE }
    );
    await controller.send('Explain closures in detail');
    const reply = lastReply(controller);
    const cut = reply.content;
    assert.equal(reply.continuable, true);
    assert.equal(controller.state.messages.length, 2);

    assert.equal(await controller.continueReply(reply.id), true);
    assert.equal(controller.state.messages.length, 2, 'no new user or assistant message');
    assert.equal(lastReply(controller), reply, 'the same message object, extended');
    assert.equal(reply.content, `${cut} and that is the end.`, 'new text appended, nothing repeated');
    assert.equal(reply.finishReason, 'stop');
    assert.equal(reply.continuable, false);

    const [request] = llm.state.completions;
    assert.equal(request.max_tokens, 256, 'the mobile limit applies to each continuation');
    assert.equal(request.stream, true);
    // The mobile model is SmolLM2: its prompt is ChatML, not the Llama 3 format.
    assert.ok(request.prompt.startsWith('<|im_start|>system\n'));
    assert.ok(request.prompt.includes('<|im_start|>user\nExplain closures in detail<|im_end|>\n'));
    assert.ok(!request.prompt.includes('<|start_header_id|>'));
    assert.ok(
        request.prompt.endsWith(`<|im_start|>assistant\n${cut}`),
        'the prompt stops inside the unfinished reply, with no end-of-turn after it'
    );
    assert.equal(llm.state.requests.length, 1, 'Continue is not a chat request');
});

test('Continue keeps the conversation as context, and offers itself again if the limit is hit again', async () => {
    let completions = 0;
    const { controller, llm } = await session(
        (messages) => {
            if (!messages) {
                completions += 1;
                return { text: filler(`c${completions}x`, 5 * 300) };
            }
            return turns(messages).length === 1
                ? { text: 'Closures capture variables.' }
                : { text: filler('b', 5 * 300) };
        },
        { profile: MOBILE }
    );
    await controller.send('What is a closure?');
    await controller.send('Show a long example');
    const reply = lastReply(controller);
    await controller.continueReply(reply.id);

    assert.equal(reply.finishReason, 'length');
    assert.equal(reply.continuable, true, 'cut again: Continue again');
    const prompt = llm.state.completions[0].prompt;
    assert.ok(prompt.includes('What is a closure?'), 'earlier questions are still context');
    assert.ok(prompt.includes('Closures capture variables.'), 'earlier answers too');
});

test('Continue stops offering itself when the reply has filled the context', async () => {
    let n = 0;
    const { controller, llm } = await session(
        (messages) => ({ text: filler(messages ? 'q' : `k${(n += 1)}x`, 5 * 400) }),
        { profile: MOBILE }
    );
    await controller.send('Write everything about CSS grid');
    const reply = lastReply(controller);
    let rounds = 0;
    while (reply.continuable && rounds < 20) {
        await controller.continueReply(reply.id);
        rounds += 1;
    }
    assert.ok(rounds >= 2 && rounds < 20, `${rounds} continuations`);
    assert.equal(reply.continuable, false);
    assert.equal(reply.notice, CONTINUE_EXHAUSTED_NOTICE);
    // Every continuation that was sent fitted the mobile budget, reply room included.
    for (const request of llm.state.completions) {
        assert.ok(estimateTokens(request.prompt) <= MOBILE.contextWindow - MOBILE.maxTokens, 'room for 256 more');
    }
    assert.equal(await controller.continueReply(reply.id), false);
});

test('Continue is refused while generating, and Stop still works during a continuation', async () => {
    const { controller, llm } = await session((messages) => ({ text: filler(messages ? 'x' : 'y', 5 * 300) }), {
        profile: MOBILE
    });
    await controller.send('Long answer please');
    const reply = lastReply(controller);

    const continuing = controller.continueReply(reply.id);
    assert.equal(controller.state.generating, true);
    assert.equal(await controller.continueReply(reply.id), false, 'no second continuation at once');
    while (llm.state.emitted < 256 + 5) await tick();
    controller.stop();
    await continuing;
    assert.equal(reply.finishReason, 'abort');
    assert.equal(reply.stopped, true);
    assert.equal(reply.continuable, false);
    assert.ok(reply.content.length > 256 * 5, 'what was written before and during the continuation stays');
});

test('Continue only extends the latest reply', async () => {
    const { controller } = await session(() => ({ text: filler('z', 5 * 300) }), { profile: MOBILE });
    await controller.send('one');
    const older = lastReply(controller);
    await controller.send('two');
    assert.equal(older.continuable, true);
    assert.equal(await controller.continueReply(older.id), false);
});

// ── MDN documentation ──────────────────────────────────────────────────────

/** A stand-in MCP client with MDN's real output formats; records every call. */
function fakeMdn({ fail = false } = {}) {
    const calls = [];
    const record = (name, arg) => {
        calls.push([name, arg]);
        if (fail)
            throw Object.assign(new Error('MDN could not be reached: Failed to fetch'), {
                name: 'McpError',
                kind: 'network'
            });
    };
    return {
        calls,
        async search(query) {
            record('search', query);
            return '# Clipboard API\n`path`: `/en-US/docs/Web/API/Clipboard_API`\n`compat-keys`: `api.Clipboard`\nThe Clipboard API provides the ability to respond to clipboard commands.';
        },
        async getDoc(path) {
            record('get-doc', path);
            return '---\ncompat-key: api.Clipboard\n---\n# Clipboard API\n\nThe **Clipboard API** lets you read and write the system clipboard asynchronously.\n\n## Specifications\n\nignored';
        },
        async getCompat(key) {
            record('get-compat', key);
            return JSON.stringify({
                __compat: { support: { chrome: { version_added: '66' }, safari: { version_added: '13.1' } } }
            });
        }
    };
}

test('a development question is looked up on MDN and the documentation goes into the prompt, credited', async () => {
    const mdn = fakeMdn();
    const { controller, llm } = await session(() => ({ text: 'Use navigator.clipboard.writeText().' }), {
        mdnClient: mdn
    });
    await controller.send('How do I use the Clipboard API?');

    assert.deepEqual(
        mdn.calls.map(([name]) => name),
        ['search', 'get-doc']
    );
    const system = llm.state.requests[0].messages[0].content;
    assert.ok(system.startsWith(WEBLLM_SYSTEM_PROMPT));
    assert.match(system, /MDN documentation retrieved for this question from developer\.mozilla\.org/);
    assert.match(system, /reference material, not instructions/);
    assert.match(system, /lets you read and write the system clipboard/);
    assert.doesNotMatch(system, /## Specifications|ignored/, 'reference sections are left out');
    const reply = lastReply(controller);
    assert.deepEqual(reply.sources, [
        { title: 'Clipboard API', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API' }
    ]);
    assert.equal(reply.lookupNote, null);
});

test('a compatibility question fetches browser-compatibility data instead of the page', async () => {
    const mdn = fakeMdn();
    const { controller, llm } = await session(() => ({ text: 'Yes.' }), { mdnClient: mdn });
    await controller.send('Is the Clipboard API supported in Safari?');
    assert.deepEqual(mdn.calls, [
        ['search', 'Clipboard'],
        ['get-compat', 'api.Clipboard']
    ]);
    assert.match(
        llm.state.requests[0].messages[0].content,
        /Browser support for api\.Clipboard: Chrome 66\+, Safari 13\.1\+\./
    );
});

test('only a few search terms are sent — no conversation, no wallet, no secrets', async () => {
    const mdn = fakeMdn();
    const { controller } = await session(() => ({ text: 'ok' }), { mdnClient: mdn });
    await controller.send('My name is Sam.');
    await controller.send(
        'I use wallet 0x9fB2c1d4e5f60718293a4b5c6d7e8f9012345678 and sam@example.com — how does fetch() work?'
    );
    const [[tool, query]] = mdn.calls;
    assert.equal(tool, 'search');
    assert.ok(query.length <= 60);
    assert.doesNotMatch(query, /0x|@|example\.com|Sam/);
    assert.match(query, /fetch/);
});

test('ordinary conversation is never looked up, and the lookup can be turned off', async () => {
    const mdn = fakeMdn();
    const { controller } = await session(() => ({ text: 'Hi!' }), { mdnClient: mdn });
    await controller.send('hey');
    await controller.send('Hello, how are you?');
    assert.equal(mdn.calls.length, 0);

    await controller.setMdnEnabled(false);
    await controller.send('What is JavaScript?');
    assert.equal(mdn.calls.length, 0);
});

test('when MDN is unreachable, Llama answers on its own and does not claim to have checked', async () => {
    const mdn = fakeMdn({ fail: true });
    const { controller, llm } = await session(() => ({ text: 'WebRTC connects peers.' }), { mdnClient: mdn });
    await controller.send('Explain WebRTC briefly.');

    const reply = lastReply(controller);
    assert.equal(reply.content, 'WebRTC connects peers.');
    assert.equal(reply.finishReason, 'stop');
    assert.deepEqual(reply.sources, []);
    assert.equal(reply.lookupNote, MDN_UNAVAILABLE_NOTE);
    assert.equal(llm.state.requests[0].messages[0].content, SHORT_SYSTEM_PROMPT, 'no documentation is claimed');
});

test('on a phone the documentation fits the 1664-token budget with the question and the 256-token reply', async () => {
    const huge = fakeMdn();
    huge.getDoc = async (path) => {
        huge.calls.push(['get-doc', path]);
        return `# Clipboard API\n\n${filler('doc', 20000)}`;
    };
    const { controller, llm } = await session(() => ({ text: 'ok' }), { profile: MOBILE, mdnClient: huge });
    await controller.send('How do I use the Clipboard API?');
    const messages = llm.state.requests[0].messages;
    const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content) + 5, 24);
    assert.ok(tokens <= MOBILE.promptTokenBudget, `${tokens} > ${MOBILE.promptTokenBudget}`);
    assert.match(messages[0].content, /MDN documentation retrieved/);
    assert.equal(llm.state.requests[0].max_tokens, Math.min(256, WEBLLM_THINKING.mobile.shortMaxTokens));
});

test('Stop during the MDN lookup ends the turn without generating', async () => {
    let release;
    const slow = fakeMdn();
    slow.search = (query, signal) =>
        new Promise((resolve, reject) => {
            release = resolve;
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { kind: 'aborted' })));
        });
    const { controller, llm } = await session(() => ({ text: 'never' }), { mdnClient: slow });
    const sending = controller.send('How does fetch work?');
    while (!release) await tick();
    assert.equal(controller.state.lookup, 'searching');
    controller.stop();
    await sending;
    assert.equal(llm.state.requests.length, 0);
    assert.equal(lastReply(controller).finishReason, 'abort');
    assert.equal(lastReply(controller).lookupNote, null, 'a cancelled lookup is not an outage');
    assert.equal(controller.state.generating, false);
});

test('Continue keeps the documentation the reply was written from', async () => {
    const mdn = fakeMdn();
    const { controller, llm } = await session(
        (messages) => (messages ? { text: filler('d', 5 * 300) } : { text: ' Done.' }),
        { profile: MOBILE, mdnClient: mdn }
    );
    await controller.send('How do I use the Clipboard API?');
    await controller.continueReply(lastReply(controller).id);
    assert.match(llm.state.completions[0].prompt, /lets you read and write the system clipboard/);
    assert.equal(mdn.calls.length, 2, 'no second lookup for a continuation');
});

// ── reply modes: short, thinking, auto ───────────────────────────────────────

/** Whether a request was constrained to a JSON schema, and to which. */
const schemaOf = (request) => (request.response_format ? JSON.parse(request.response_format.schema) : null);

test('Thinking: a JSON-schema plan, then each step with its own MDN lookup', async () => {
    const mdn = fakeMdn();
    const { controller, llm } = await session(
        (messages, call, request) =>
            // Calls count from 1: the plan, then one per step.
            schemaOf(request)
                ? { text: '{"steps": ["Build the HTML form", "Copy the result with the Clipboard API"]}' }
                : { text: `\`\`\`js\nstep${call - 1}();\n\`\`\`` },
        { mdnClient: mdn, replyMode: 'thinking' }
    );
    await controller.send('Make a form that copies its value with navigator.clipboard');

    const reply = lastReply(controller);
    assert.equal(reply.mode, 'thinking');
    assert.equal(reply.autoMode, false);
    assert.equal(reply.steps, 2);
    assert.equal(reply.finishReason, 'stop');
    assert.equal(
        reply.content,
        '**Plan**\n1. Build the HTML form\n2. Copy the result with the Clipboard API' +
            '\n\n### Step 1/2: Build the HTML form\n\n```js\nstep1();\n```' +
            '\n\n### Step 2/2: Copy the result with the Clipboard API\n\n```js\nstep2();\n```'
    );

    // Plan, step 1, step 2 — each a request of its own; the plan is schema-constrained.
    assert.equal(llm.state.requests.length, 3);
    const [plan, first, second] = llm.state.requests;
    assert.deepEqual(plan.response_format, { type: 'json_object', schema: JSON.stringify(PLAN_SCHEMA) });
    assert.match(plan.messages[0].content, /Mode: planning/);
    assert.equal(plan.max_tokens, WEBLLM_THINKING.desktop.planMaxTokens);
    assert.equal(first.max_tokens, WEBLLM_THINKING.desktop.stepMaxTokens);
    assert.equal(first.response_format, undefined, 'the steps are free text');
    assert.match(first.messages[0].content, /step 1 of 2/);
    assert.match(first.messages.at(-1).content, /Now do step 1 only: Build the HTML form/);
    // Without a thought store, the second step is shown what the first one wrote.
    assert.match(second.messages.at(-1).content, /Earlier thoughts:[\s\S]*step1\(\);/);

    // The lookups are per step: searched with each step's own words, not the whole question.
    const searches = mdn.calls.filter(([name]) => name === 'search').map(([, query]) => query);
    assert.equal(searches.length, 2);
    assert.match(searches[0], /Build|HTML|form/);
    assert.match(searches[1], /Clipboard/);
    assert.deepEqual(reply.sources, [
        { title: 'Clipboard API', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API' }
    ]);
    assert.equal(reply.docContext, null, 'a step’s documentation is not carried past it');
});

test('Thinking: a step cut inside its code block gets one continuation, then is closed and marked incomplete', async () => {
    const { controller, llm } = await session(
        (messages, call, request) => {
            if (request.response_format)
                return { text: '{"steps": ["Write the ```html``` markup", "Add the script"]}' };
            // The one continuation step 1 gets (a text completion) runs out too.
            if (messages === null) return { text: '\n  <button>Log in</button>', finish: 'length' };
            // Step 1 runs out of tokens inside its code block; step 2 is whole.
            return call === 2
                ? { text: '```html\n<form id="login">\n  <input type="email">', finish: 'length' }
                : { text: '```js\nconst form = document.querySelector("#login");\n```' };
        },
        { replyMode: 'thinking' }
    );
    await controller.send('Make a login form');
    const reply = lastReply(controller);
    assert.equal(llm.state.completions.length, 1, 'at most one continuation per step');
    assert.match(llm.state.completions[0].prompt, /<input type="email">$/, 'it continues the step in place');
    assert.deepEqual(splitReply(reply.content), [
        {
            type: 'text',
            text: '**Plan**\n1. Write the html markup\n2. Add the script\n\n### Step 1/2: Write the html markup'
        },
        {
            type: 'code',
            lang: 'html',
            code: '<form id="login">\n  <input type="email">\n  <button>Log in</button>',
            closed: true
        },
        {
            type: 'text',
            text:
                '**⚠ Step 1 is incomplete:** it reached the length limit before it finished, so its code may be cut off.\n\n' +
                '### Step 2/2: Add the script'
        },
        { type: 'code', lang: 'js', code: 'const form = document.querySelector("#login");', closed: true }
    ]);
    assert.equal(reply.notice, stepIncompleteNotice([1]));
    // The next step is told not to build on it.
    const step2 = llm.state.requests[2].messages.at(-1).content;
    assert.match(step2, /Note: step 1 did not finish; do not rely on code from them/);
    assert.doesNotMatch(step2, /<form id="login">/, 'its code is not passed on as earlier work');
});

test('Thinking: a truncated step that its continuation finishes counts as complete', async () => {
    const { controller, llm } = await session(
        (messages, call, request) => {
            if (request.response_format) return { text: '{"steps": ["Write the markup", "Add the script"]}' };
            if (messages === null) return { text: '\n</form>\n```' };
            return call === 2
                ? { text: '```html\n<form id="login">\n  <input type="email">', finish: 'length' }
                : { text: '```js\nconst form = document.querySelector("#login");\n```' };
        },
        { replyMode: 'thinking' }
    );
    await controller.send('Make a login form');
    const reply = lastReply(controller);
    assert.equal(llm.state.completions.length, 1);
    assert.doesNotMatch(reply.content, /incomplete/);
    assert.equal(reply.notice ?? null, null);
    assert.match(reply.content, /<input type="email">\n<\/form>\n```\n\n### Step 2\/2/);
    // The completed step is what the next one is shown, as its latest step.
    assert.match(llm.state.requests[2].messages.at(-1).content, /Earlier steps:[\s\S]*<\/form>/);
});

test('Thinking: a step the model ends with its code unfinished is marked, without a continuation', async () => {
    const { controller, llm } = await session(
        (messages, call, request) => {
            if (request.response_format) return { text: '{"steps": ["Write the function", "Use it"]}' };
            return call === 2
                ? { text: '```js\nfunction debounce(fn, ms) {\n  let timer;\n```' }
                : { text: 'Call `debounce(save, 300)`.' };
        },
        { replyMode: 'thinking' }
    );
    await controller.send('Write a debounce function');
    const reply = lastReply(controller);
    assert.equal(llm.state.completions.length, 0, 'only a step cut at the limit is continued');
    assert.match(reply.content, /\*\*⚠ Step 1 is incomplete:\*\* its code does not look finished/);
    assert.equal(reply.notice, stepIncompleteNotice([1]));
});

test('Thinking without a usable plan writes the task in one go', async () => {
    const { controller, llm } = await session(
        (messages, call, request) => ({
            text: schemaOf(request) ? '{"steps": ["only one"]}' : 'function debounce() {}'
        }),
        { replyMode: 'thinking' }
    );
    await controller.send('Write a debounce function in JavaScript');
    const reply = lastReply(controller);
    assert.equal(reply.mode, 'thinking');
    assert.equal(reply.steps, 0);
    assert.equal(reply.content, 'function debounce() {}');
    assert.equal(llm.state.requests.length, 2);
    assert.equal(llm.state.requests[1].messages.at(-1).content, 'Write a debounce function in JavaScript');
    assert.match(llm.state.requests[1].messages[0].content, /Mode: thinking\. Complete the task/);
});

test('Stop during a thinking reply ends it before the next step', async () => {
    let controllerRef = null;
    const { controller, llm } = await session(
        (messages, call, request) => {
            // Stop is pressed as the first step starts.
            if (call === 2) controllerRef.stop();
            return { text: schemaOf(request) ? '{"steps": ["First part", "Second part"]}' : 'partial' };
        },
        { replyMode: 'thinking' }
    );
    controllerRef = controller;
    await controller.send('Build a todo app component with filters');
    const reply = lastReply(controller);
    assert.equal(reply.stopped, true);
    assert.equal(reply.finishReason, 'abort');
    assert.equal(llm.state.requests.length, 2, 'the second step was never asked for');
});

test('Short: one request in the short window, whatever the message', async () => {
    const { controller, llm } = await session(() => ({ text: 'Here you go.' }));
    await controller.send('Write a login form with validation');
    assert.equal(lastReply(controller).mode, 'short');
    assert.equal(llm.state.requests.length, 1);
    assert.equal(llm.state.requests[0].max_tokens, WEBLLM_THINKING.desktop.shortMaxTokens);
    assert.match(llm.state.requests[0].messages[0].content, /Mode: short/);
});

test('Auto: Llama chooses with a schema-constrained answer, and its choice is followed', async () => {
    const { controller, llm } = await session(
        (messages, call, request) => {
            const schema = schemaOf(request);
            if (schema?.properties?.mode) return { text: '{"mode": "thinking"}' };
            if (schema?.properties?.steps) return { text: '{"steps": ["Markup", "Script"]}' };
            return { text: 'code' };
        },
        { replyMode: 'auto' }
    );
    await controller.send('Create a login form with validation');
    const [decision] = llm.state.requests;
    assert.deepEqual(decision.response_format, { type: 'json_object', schema: JSON.stringify(MODE_SCHEMA) });
    assert.equal(decision.max_tokens, WEBLLM_THINKING.desktop.decideMaxTokens);
    assert.match(decision.messages[0].content, /decide how an assistant should answer/);
    const reply = lastReply(controller);
    assert.equal(reply.mode, 'thinking');
    assert.equal(reply.autoMode, true);
    assert.equal(reply.steps, 2);
    assert.equal(llm.state.requests.length, 4, 'decision, plan, two steps');
});

test('Auto: an answer that is not a decision is taken as Short', async () => {
    const { controller, llm } = await session(
        (messages, call, request) => ({ text: schemaOf(request) ? 'not json' : 'A closure keeps its scope.' }),
        { replyMode: 'auto' }
    );
    await controller.send('What is a closure?');
    assert.equal(lastReply(controller).mode, 'short');
    assert.equal(lastReply(controller).content, 'A closure keeps its scope.');
    assert.equal(llm.state.requests.length, 2);
});

// ── Stop, wherever it lands ──────────────────────────────────────────────────
//
// WebLLM clears its interrupt flag when a stream starts, so a Stop pressed
// while nothing is generating has nothing to interrupt. Each case below once
// let the reply carry on.

test('Stop pressed while a request is being set up is not lost: the stream ends at once', async () => {
    let controllerRef = null;
    const long = filler('w', 5 * 300);
    const { controller, llm } = await session(() => {
        // `create()` is still running: the engine has not started streaming.
        controllerRef.stop();
        return { text: long };
    });
    controllerRef = controller;
    await controller.send('Tell me about closures');
    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'abort');
    assert.equal(reply.stopped, true);
    assert.ok(llm.state.emitted <= 1, `${llm.state.emitted} pieces were streamed after Stop`);
});

test('Stop pressed before the first request asks the engine for nothing', async () => {
    const { controller, llm } = await session(() => ({ text: 'never' }), { replyMode: 'auto' });
    const sending = controller.send('Create a login form');
    controller.stop();
    await sending;
    assert.equal(llm.state.requests.length, 0);
    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'abort');
    assert.equal(reply.mode, null, 'a reply never written has no mode');
});

test('Stop during the recall of earlier thoughts writes no further step', async () => {
    const fake = installFakeIndexedDb();
    try {
        const { controller, llm } = await session(
            (messages, call, request) => ({
                text: request.response_format ? '{"steps": ["Markup", "Script"]}' : `step${call - 1}`
            }),
            { replyMode: 'thinking', wallet: '0xabc' }
        );
        // Hold the recall for step 2 until Stop has been pressed.
        let release;
        const recall = controller.thoughts.recall.bind(controller.thoughts);
        controller.thoughts.recall = async (options) => {
            if (llm.state.requests.length >= 2) await new Promise((resolve) => (release = resolve));
            return recall(options);
        };
        const sending = controller.send('Build a page');
        while (!release) await tick();
        assert.equal(controller.state.thinking.phase, 'recall');
        controller.stop();
        release();
        await sending;

        assert.equal(llm.state.requests.length, 2, 'the plan and step 1; step 2 was never asked for');
        const reply = lastReply(controller);
        assert.equal(reply.finishReason, 'abort');
        assert.doesNotMatch(reply.content, /Step 2\/2/, 'no heading for a step that was not written');
        // The thoughts that were thought are kept.
        const history = await controller.thoughts.getHistory({ sequenceId: reply.sequenceId });
        assert.deepEqual(
            history.value.thoughts.map((t) => t.thoughtNumber),
            [1, 2]
        );
    } finally {
        fake.restore?.();
    }
});

test('Stop during a step’s MDN lookup leaves no empty step heading', async () => {
    let release;
    const mdn = fakeMdn();
    const search = mdn.search;
    mdn.search = (query, signal) =>
        query.includes('Clipboard')
            ? new Promise((resolve, reject) => {
                  release = resolve;
                  signal?.addEventListener('abort', () =>
                      reject(Object.assign(new Error('cancelled'), { kind: 'aborted' }))
                  );
              })
            : search(query, signal);
    const { controller, llm } = await session(
        (messages, call, request) => ({
            text: request.response_format ? '{"steps": ["Build the HTML form", "Use the Clipboard API"]}' : 'form'
        }),
        { replyMode: 'thinking', mdnClient: mdn }
    );
    const sending = controller.send('Make a form that copies its value with navigator.clipboard');
    while (!release) await tick();
    controller.stop();
    await sending;
    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'abort');
    assert.match(reply.content, /Step 1\/2/);
    assert.doesNotMatch(reply.content, /Step 2\/2/);
    assert.equal(llm.state.requests.length, 2);
});

// ── memory continuity: recall across steps, budgets, Stop in a continuation ──

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

/** The `Earlier thoughts` block of a step's request, or ''. */
const earlierThoughts = (request) => {
    const text = request.messages.at(-1).content;
    const match = text.match(/Earlier thoughts:\n"""\n([\s\S]*?)\n"""/);
    return match ? match[1] : '';
};

test('Thinking keeps the latest completed step for the next one and recalls relevant work, never the unrelated', async () => {
    const fake = installFakeIndexedDb();
    try {
        const vectors = memoryVectors();
        const answers = {
            chart: 'Bar chart: ```js\nrequestAnimationFrame(drawBars);\n```',
            markup: '```html\n<form id="login"><input type="email" id="email"><button>Log in</button></form>\n```',
            footer: '```css\nfooter { padding: 1rem; color: gray; }\n```',
            validate: '```js\ndocument.querySelector("#login").addEventListener("submit", check);\n```'
        };
        let plan = null;
        const { controller, llm } = await session(
            (messages, call, request) => {
                if (request.response_format) return { text: JSON.stringify({ steps: plan }) };
                const step = messages.at(-1).content.match(/Now do step \d+ only: (.*)$/)?.[1] || '';
                if (/chart/i.test(step)) return { text: answers.chart };
                if (/markup/i.test(step)) return { text: answers.markup };
                if (/footer/i.test(step)) return { text: answers.footer };
                return { text: answers.validate };
            },
            { replyMode: 'thinking', wallet: '0xabc', vectors }
        );
        plan = ['Draw the animated bar chart canvas', 'Label the chart axes with requestAnimationFrame'];
        await controller.send('Draw an animated bar chart');
        plan = [
            'Write the login form markup with an email input',
            'Style the page footer',
            'Add the login form email validation script'
        ];
        const before = llm.state.requests.length;
        await controller.send('Make a login form with email validation');
        await controller.thoughts.whenIndexed();
        const steps = llm.state.requests.slice(before + 1);
        assert.equal(steps.length, 3);

        // Step 2 is shown step 1, the latest completed step, whatever it is about.
        assert.match(earlierThoughts(steps[1]), /Thought 2:\nWrite the login form markup[\s\S]*<form id="login">/);
        // Step 3: the latest completed step (the footer) is always there, and
        // the markup it builds on is recalled by similarity; oldest first.
        const third = earlierThoughts(steps[2]);
        assert.match(third, /Thought 2:\nWrite the login form markup[\s\S]*Thought 3:\nStyle the page footer/);
        assert.equal(third.split('<form id="login">').length, 2, 'recalled once, not twice');
        assert.doesNotMatch(third, /requestAnimationFrame|bar chart/i, 'an unrelated earlier answer is not injected');
        assert.ok(vectors.rows.size >= 6, 'both replies’ thoughts are in the vector index');
    } finally {
        fake.restore?.();
    }
});

test('on a phone the recalled thoughts and the one continuation stay inside the mobile budgets', async () => {
    const fake = installFakeIndexedDb();
    try {
        const long = (word) =>
            `\`\`\`js\n${Array.from({ length: 120 }, (_, i) => `const ${word}${i} = ${i};`).join('\n')}\n\`\`\``;
        const { controller, llm } = await session(
            (messages, call, request) => {
                if (request.response_format) {
                    return {
                        text: '{"steps": ["Write the login values", "Write the login checks", "Write the login form"]}'
                    };
                }
                // Each step is cut at the mobile limit; its continuation finishes it.
                if (messages === null) return { text: '\nconst done = true;\n```' };
                return { text: long(`login${call}x`) };
            },
            { replyMode: 'thinking', wallet: '0xabc', profile: MOBILE }
        );
        await controller.send('Build the login page');
        const limits = WEBLLM_THINKING.mobile;
        assert.equal(llm.state.requests.length, 4, 'the plan and three steps');
        for (const request of llm.state.requests.slice(2)) {
            const recalled = earlierThoughts(request);
            assert.ok(recalled, 'each later step is shown earlier work');
            assert.ok(
                estimateTokens(recalled) <= limits.recallTokens,
                `${estimateTokens(recalled)} > ${limits.recallTokens}`
            );
        }
        assert.ok(llm.state.completions.length >= 1 && llm.state.completions.length <= 3, 'at most one per step');
        for (const completion of llm.state.completions) {
            assert.ok(completion.max_tokens <= limits.stepContinueTokens);
        }
    } finally {
        fake.restore?.();
    }
});

test('Stop during a step’s continuation stops the reply there, without an incomplete-step line', async () => {
    let controllerRef = null;
    const { controller, llm } = await session(
        (messages, call, request) => {
            if (request.response_format) return { text: '{"steps": ["First part", "Second part"]}' };
            if (messages === null) {
                controllerRef.stop();
                return { text: ' and more text that is never shown', size: 2 };
            }
            return { text: '```js\nfunction a() {', finish: 'length' };
        },
        { replyMode: 'thinking' }
    );
    controllerRef = controller;
    await controller.send('Build a todo app');
    const reply = lastReply(controller);
    assert.equal(reply.finishReason, 'abort');
    assert.equal(llm.state.requests.length, 2, 'the plan and step 1 only');
    assert.doesNotMatch(reply.content, /incomplete/);
    assert.doesNotMatch(reply.content, /Step 2\/2/);
});
