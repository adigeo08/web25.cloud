/**
 * The mobile model and memory profile, and batched streaming.
 *
 * A phone or tablet runs SmolLM2 360M with a 2048-token context and 256-token
 * replies; a desktop or laptop keeps Llama 3.2 1B and exactly what it had. The
 * reply is drawn in batches instead of once per token. The override that
 * switches profiles for testing works on development hosts only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WEBLLM_CHAT_OPTIONS,
    WEBLLM_CONTEXT_WINDOW,
    WEBLLM_PROFILES,
    WEBLLM_PROMPT_TOKEN_BUDGET,
    WEBLLM_MODELS,
    chatOptionsFor,
    createAppConfig,
    getWebLLMModel,
    isDevelopmentHost,
    otherWebLLMModels,
    replacedWebLLMModels,
    isMobileDevice,
    resolveWebLLMProfile
} from '../src/webllm/webllmConfig.js';
import { createEngineHost, sanitizeProfile } from '../src/webllm/webllmEngineHost.js';
import { STREAM_FLUSH_INTERVAL_MS, createStreamBatcher } from '../src/ui/webllm/streamBatcher.js';

const UA = {
    iPhone15:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    galaxyS22:
        'Mozilla/5.0 (Linux; Android 14; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    iPadDesktopMode:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    macChrome:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    windowsEdge:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'
};

const at = (hostname, search = '') => ({ hostname, search });

// ── the profiles ────────────────────────────────────────────────────────────

test('desktop keeps Llama and the configuration it had; mobile runs SmolLM2, halves the context and caps replies', () => {
    assert.deepEqual(
        { ...WEBLLM_PROFILES.desktop },
        {
            id: 'desktop',
            model: 'llama',
            contextWindow: 4096,
            maxTokens: null,
            promptTokenBudget: WEBLLM_PROMPT_TOKEN_BUDGET
        }
    );
    assert.equal(WEBLLM_PROMPT_TOKEN_BUDGET, 3072);
    assert.equal(WEBLLM_CONTEXT_WINDOW, 4096);
    assert.deepEqual(
        { ...WEBLLM_PROFILES.mobile },
        { id: 'mobile', model: 'smollm', contextWindow: 2048, maxTokens: 256, promptTokenBudget: 1664 }
    );
    // The prompt, the reply and a margin fit in the mobile window.
    const mobile = WEBLLM_PROFILES.mobile;
    assert.ok(mobile.promptTokenBudget + mobile.maxTokens + 128 <= mobile.contextWindow);
    // Sampling is shared, except where a model's own recommendation differs.
    assert.deepEqual(
        { ...WEBLLM_CHAT_OPTIONS },
        { temperature: 0.6, top_p: 0.9, presence_penalty: 0, frequency_penalty: 0, context_window_size: 4096 }
    );
    assert.deepEqual(chatOptionsFor(WEBLLM_MODELS.llama), { ...WEBLLM_CHAT_OPTIONS });
    assert.deepEqual(chatOptionsFor(WEBLLM_MODELS.smollm), { ...WEBLLM_CHAT_OPTIONS, temperature: 0.2 });
    assert.deepEqual(createAppConfig().model_list[0].overrides, { context_window_size: 4096 });
    assert.deepEqual(createAppConfig(2048).model_list[0].overrides, { context_window_size: 2048 });
    assert.equal(createAppConfig().model_list[0].model_id, 'Llama-3.2-1B-Instruct-q4f32_1-MLC');
});

test('the two models: Llama 3.2 1B for desktops, SmolLM2 360M q4f32_1 for phones', () => {
    const smol = createAppConfig(2048, WEBLLM_MODELS.smollm).model_list[0];
    assert.deepEqual(smol, {
        model: 'https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f32_1-MLC/resolve/main/',
        model_id: 'SmolLM2-360M-Instruct-q4f32_1-MLC',
        model_lib:
            'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/SmolLM2-360M-Instruct-q4f32_1_cs1k-webgpu.wasm',
        vram_required_MB: 579.61,
        low_resource_required: true,
        overrides: { context_window_size: 2048 }
    });
    // q4f32_1, like Llama: no shader-f16 needed.
    assert.match(WEBLLM_MODELS.smollm.modelId, /q4f32_1/);
    assert.equal(WEBLLM_MODELS.smollm.chatTemplate, 'chatml');
    assert.equal(WEBLLM_MODELS.llama.chatTemplate, 'llama3');
    assert.ok(WEBLLM_MODELS.smollm.downloadBytes < WEBLLM_MODELS.llama.downloadBytes);

    assert.equal(getWebLLMModel('smollm'), WEBLLM_MODELS.smollm);
    for (const key of ['llama', undefined, null, '', 'gpt', '__proto__', 'toString', 42]) {
        assert.equal(getWebLLMModel(key), WEBLLM_MODELS.llama, `${key}`);
    }

    // Each page counts the other device's model among the builds it does not load.
    const ids = (model) => otherWebLLMModels(model).map((entry) => entry.modelId);
    assert.deepEqual(ids(WEBLLM_MODELS.llama), [
        'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        'SmolLM2-360M-Instruct-q4f32_1-MLC'
    ]);
    assert.deepEqual(ids(WEBLLM_MODELS.smollm), [
        'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        'Llama-3.2-1B-Instruct-q4f32_1-MLC'
    ]);
});

test('phones and tablets get the mobile profile; desktops do not', () => {
    const profile = (nav) => resolveWebLLMProfile({ navigator: nav, location: at('web25.cloud') });
    assert.equal(profile({ userAgent: UA.iPhone15, maxTouchPoints: 5 }).id, 'mobile');
    assert.equal(profile({ userAgent: UA.iPhone15, maxTouchPoints: 5 }).model, 'smollm');
    assert.equal(profile({ userAgent: UA.windowsEdge }).model, 'llama');
    assert.equal(profile({ userAgent: UA.galaxyS22, userAgentData: { mobile: true } }).id, 'mobile');
    assert.equal(profile({ userAgent: UA.iPadDesktopMode, maxTouchPoints: 5 }).id, 'mobile', 'iPadOS poses as a Mac');
    assert.equal(profile({ userAgent: UA.macChrome, maxTouchPoints: 0 }).id, 'desktop');
    assert.equal(profile({ userAgent: UA.windowsEdge, userAgentData: { mobile: false } }).id, 'desktop');
    assert.equal(profile(undefined).id, 'desktop');
    assert.equal(profile({ userAgent: UA.iPhone15 }).overridden, false);

    assert.equal(isMobileDevice({ userAgentData: { mobile: true }, userAgent: '' }), true);
});

test('the dev override switches profiles on development hosts only', () => {
    const desktop = { userAgent: UA.macChrome };
    const phone = { userAgent: UA.iPhone15 };

    const forced = resolveWebLLMProfile({ navigator: desktop, location: at('localhost', '?webllm-profile=mobile') });
    assert.equal(forced.id, 'mobile');
    assert.equal(forced.overridden, true);
    // A phone testing against a dev server on the LAN.
    assert.equal(
        resolveWebLLMProfile({ navigator: phone, location: at('192.168.1.20', '?webllm-profile=desktop') }).id,
        'desktop'
    );
    // Production ignores it.
    const prod = resolveWebLLMProfile({ navigator: desktop, location: at('web25.cloud', '?webllm-profile=mobile') });
    assert.equal(prod.id, 'desktop');
    assert.equal(prod.overridden, false);
    // Unknown values fall back to detection.
    for (const value of ['tablet', '__proto__', 'toString', '']) {
        const result = resolveWebLLMProfile({
            navigator: desktop,
            location: at('localhost', `?webllm-profile=${value}`)
        });
        assert.equal(result.id, 'desktop', value);
        assert.equal(result.overridden, false, value);
    }

    for (const host of [
        'localhost',
        '127.0.0.1',
        'dev.local',
        '10.0.0.4',
        '192.168.0.2',
        '172.20.1.1',
        'app.localhost'
    ]) {
        assert.equal(isDevelopmentHost(host), true, host);
    }
    for (const host of ['web25.cloud', 'www.web25.cloud', '172.32.0.1', '8.8.8.8', '', undefined]) {
        assert.equal(isDevelopmentHost(host), false, `${host}`);
    }
});

// ── the engine host ─────────────────────────────────────────────────────────

test('a profile from the page is reduced to safe values; anything odd is the desktop one', () => {
    const llama = (contextWindow, maxTokens) => ({ model: 'llama', contextWindow, maxTokens });
    assert.deepEqual(sanitizeProfile({ contextWindow: 2048, maxTokens: 256 }), llama(2048, 256));
    assert.deepEqual(sanitizeProfile(undefined), llama(4096, null));
    assert.deepEqual(sanitizeProfile({ contextWindow: 999999, maxTokens: 256 }), llama(4096, 256));
    assert.deepEqual(sanitizeProfile({ contextWindow: 100 }), llama(4096, null));
    assert.deepEqual(sanitizeProfile({ contextWindow: '2048', maxTokens: '256' }), llama(2048, 256));
    // A reply limit as large as the window is no limit at all.
    assert.deepEqual(sanitizeProfile({ contextWindow: 2048, maxTokens: 4096 }), llama(2048, null));
    assert.deepEqual(sanitizeProfile({ contextWindow: 2048, maxTokens: -1 }), llama(2048, null));
    // The model: only one WEB25 knows, else Llama.
    assert.deepEqual(sanitizeProfile({ ...WEBLLM_PROFILES.mobile }), {
        model: 'smollm',
        contextWindow: 2048,
        maxTokens: 256
    });
    for (const model of ['gpt', '__proto__', 'Llama-3.2-1B-Instruct-q4f32_1-MLC', 7, null]) {
        assert.equal(sanitizeProfile({ model, contextWindow: 2048 }).model, 'llama', `${model}`);
    }
});

test('the engine keeps the profile it was first loaded with', async () => {
    const reloads = [];
    class MLCEngine {
        constructor(config) {
            this.config = config;
        }
        async reload(modelId, chatOpts) {
            reloads.push({ modelId, chatOpts, overrides: this.config.appConfig.model_list[0].overrides });
        }
        async unload() {}
    }
    const posted = [];
    const host = createEngineHost({
        post: (message) => posted.push(message),
        loadLibrary: async () => ({ MLCEngine })
    });
    await host.handle({ type: 'load', requestId: 1, profile: { ...WEBLLM_PROFILES.mobile } });
    await host.handle({ type: 'load', requestId: 2, profile: { ...WEBLLM_PROFILES.desktop } });

    assert.equal(reloads.length, 1);
    assert.equal(reloads[0].modelId, 'SmolLM2-360M-Instruct-q4f32_1-MLC');
    assert.equal(reloads[0].chatOpts.context_window_size, 2048);
    assert.deepEqual(reloads[0].overrides, { context_window_size: 2048 });
    const results = posted.filter((message) => message.type === 'result').map((message) => message.value);
    assert.deepEqual(results, [
        { alreadyLoaded: false, model: 'smollm', contextWindow: 2048, maxTokens: 256 },
        { alreadyLoaded: true, model: 'smollm', contextWindow: 2048, maxTokens: 256 }
    ]);
});

// ── batched rendering ───────────────────────────────────────────────────────

/** A fake clock with frames and timers that tests advance by hand. */
function fakeTime() {
    let now = 0;
    const timers = [];
    const frames = [];
    return {
        now: () => now,
        setTimer: (callback, ms) => {
            const timer = { at: now + ms, callback };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => timers.splice(timers.indexOf(timer) >>> 0, timers.includes(timer) ? 1 : 0),
        requestFrame: (callback) => {
            frames.push(callback);
            return callback;
        },
        cancelFrame: (callback) => frames.splice(frames.indexOf(callback) >>> 0, frames.includes(callback) ? 1 : 0),
        /** Move time forward, firing due timers, then run one animation frame. */
        advance(ms) {
            now += ms;
            for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
                if (timer.at <= now) {
                    timers.splice(timers.indexOf(timer), 1);
                    timer.callback();
                }
            }
            const due = frames.splice(0);
            due.forEach((callback) => callback());
        },
        get pendingFrames() {
            return frames.length;
        }
    };
}

test('a burst of deltas is drawn once per frame, no more often than the interval', () => {
    const time = fakeTime();
    const drawn = [];
    const batcher = createStreamBatcher({ flush: (id) => drawn.push([id, time.now()]), ...time });
    assert.ok(STREAM_FLUSH_INTERVAL_MS >= 50 && STREAM_FLUSH_INTERVAL_MS <= 100);

    // 40 tokens arrive within the first frame: one draw.
    for (let i = 0; i < 40; i += 1) batcher.schedule(7);
    time.advance(16);
    assert.deepEqual(drawn, [[7, 16]]);

    // More tokens straight after: held until the interval has passed.
    for (let i = 0; i < 40; i += 1) batcher.schedule(7);
    time.advance(16);
    time.advance(16);
    assert.equal(drawn.length, 1, 'not again within the interval');
    time.advance(STREAM_FLUSH_INTERVAL_MS);
    assert.equal(drawn.length, 2);
    assert.ok(drawn[1][1] - drawn[0][1] >= STREAM_FLUSH_INTERVAL_MS);

    // Nothing new, nothing drawn.
    time.advance(500);
    assert.equal(drawn.length, 2);
});

test('a stream of 1000 tokens over 10 seconds is drawn about 15 times a second, not 100', () => {
    const time = fakeTime();
    let draws = 0;
    const batcher = createStreamBatcher({ flush: () => (draws += 1), ...time });
    for (let i = 0; i < 1000; i += 1) {
        batcher.schedule(1);
        time.advance(10);
    }
    time.advance(200);
    assert.ok(draws > 100 && draws < 200, `${draws} draws`);
    assert.equal(batcher.flushes, draws);
});

test('flushNow draws immediately, cancel drops what is waiting, and a new reply flushes the old first', () => {
    const time = fakeTime();
    const drawn = [];
    const batcher = createStreamBatcher({ flush: (id) => drawn.push(id), ...time });

    batcher.schedule(1);
    batcher.flushNow();
    assert.deepEqual(drawn, [1]);
    assert.equal(time.pendingFrames, 0);

    batcher.schedule(1);
    batcher.cancel();
    time.advance(1000);
    assert.deepEqual(drawn, [1], 'cancelled: a full render draws the final text instead');
    assert.equal(batcher.pending, null);

    batcher.schedule(2);
    batcher.schedule(3);
    assert.deepEqual(drawn, [1, 2], 'the earlier reply is drawn before switching');
    time.advance(1000);
    assert.deepEqual(drawn, [1, 2, 3]);
});

test('SmolLM2 replaces every Llama build on a phone; Llama replaces nothing on a desktop', () => {
    assert.deepEqual(
        replacedWebLLMModels(WEBLLM_MODELS.smollm).map((entry) => [entry.modelId, entry.label]),
        [
            ['Llama-3.2-1B-Instruct-q4f32_1-MLC', 'Llama 3.2 1B'],
            ['Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Llama 3.2 1B (q4f16)']
        ]
    );
    assert.deepEqual(replacedWebLLMModels(WEBLLM_MODELS.llama), []);
    for (const entry of replacedWebLLMModels(WEBLLM_MODELS.smollm)) {
        assert.ok(
            !WEBLLM_MODELS.smollm.modelUrl.startsWith(entry.modelUrl),
            'never a prefix of what it makes room for'
        );
    }
});
