// @ts-check
/**
 * How a reply is written: short, or thinking in steps.
 *
 * The mode is a chat setting (see WEBLLM_REPLY_MODES): the user picks Short
 * or Thinking, or leaves it on Auto and Llama picks per message. Nothing here
 * guesses from keywords. Where Llama decides, it answers in a JSON schema, so
 * the answer is read with `JSON.parse` rather than parsed out of prose:
 *
 *   Auto      {"mode": "short"|"thinking"}  — a few tokens, before the reply
 *   Thinking  {"steps": ["…", "…"]}          — the plan
 *
 *   Short     one answer in a small token window. MDN may be looked up once.
 *   Thinking  a sequence of thoughts: the plan is thought 1, each step is the
 *             next thought, written in its own request with its own MDN
 *             lookup and the earlier thoughts it needs recalled from the
 *             thought store (see webllmThoughtStore.js). The token window is
 *             large in total, but each step stays inside the context window.
 *             The steps are always found locally by `splitIntoSteps`, from
 *             Llama's plan when it is usable and from the request otherwise,
 *             so a Thinking reply is always written in steps.
 *
 * Pure functions; the controller runs the flow.
 */

import { WEBLLM_SYSTEM_PROMPT } from './webllmConfig.js';
import { estimateTokens } from './webllmProgress.js';
import { splitReply } from '../ui/webllm/replyFormat.js';

/** @typedef {'short'|'thinking'} ReplyMode */

/** Added to the system prompt for a short answer. */
export const SHORT_INSTRUCTION =
    'Mode: short. Answer briefly: at most three short sentences or a few bullet points. ' +
    'Include a code snippet only if it is essential, at most six lines, in a fenced block labelled with its language. ' +
    'No introduction and no summary.';

/** The system prompt a short answer is written under. */
export const SHORT_SYSTEM_PROMPT = `${WEBLLM_SYSTEM_PROMPT}\n\n${SHORT_INSTRUCTION}`;

/** Auto: the shape of Llama's decision. */
export const MODE_SCHEMA = Object.freeze({
    type: 'object',
    properties: { mode: { type: 'string', enum: ['short', 'thinking'] } },
    required: ['mode'],
    additionalProperties: false
});

/** Auto: the system prompt for the decision. */
export const MODE_SYSTEM_PROMPT =
    'You decide how an assistant should answer the last user message. ' +
    'Choose "thinking" when the user wants code or something built, fixed, refactored or changed, ' +
    'work that takes several parts. Choose "short" for questions, explanations, definitions and conversation. ' +
    'Reply with JSON only.';

/** The plan's shape. */
export const PLAN_SCHEMA = Object.freeze({
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'string' } } },
    required: ['steps'],
    additionalProperties: false
});

/** @param {number} maxSteps */
export function planInstruction(maxSteps) {
    return (
        `Mode: planning. Break the user's task into 2 to ${maxSteps} concrete implementation steps, in order. ` +
        'Each step is one short line (under 15 words). No code. Reply with JSON only.'
    );
}

/**
 * Read a JSON answer; null when it is not JSON or not an object.
 * @param {string} text
 */
function readJson(text) {
    try {
        const value = JSON.parse(`${text || ''}`.trim());
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_) {
        return null;
    }
}

/**
 * Auto's decision, or null when the answer is not one.
 * @param {string} text
 * @returns {ReplyMode|null}
 */
export function parseModeDecision(text) {
    const mode = readJson(text)?.mode;
    return mode === 'short' || mode === 'thinking' ? mode : null;
}

/**
 * One step as it goes into the plan, the heading and the prompt: one line,
 * at most 140 characters, without a fence (which would open a code block in
 * the plan and the heading). Empty when there is nothing left of it.
 * @param {any} value
 */
function cleanStep(value) {
    if (typeof value !== 'string') return '';
    return value.split('\n').join(' ').split('```').join('').trim().slice(0, 140);
}

/**
 * Distinct, non-trivial steps, at most `maxSteps`.
 * @param {any[]} candidates
 * @param {number} maxSteps
 */
function distinctSteps(candidates, maxSteps) {
    /** @type {string[]} */
    const steps = [];
    for (const candidate of candidates) {
        const step = cleanStep(candidate);
        if (step.length < 3 || steps.some((existing) => existing.toLowerCase() === step.toLowerCase())) continue;
        steps.push(step);
        if (steps.length >= maxSteps) break;
    }
    return steps;
}

/**
 * The plan's steps from Llama's JSON answer: strings only, trimmed,
 * distinct, at most `maxSteps`. Fewer than two is no plan.
 *
 * @param {string} text
 * @param {number} maxSteps
 * @returns {string[]}
 */
export function parsePlan(text, maxSteps) {
    const raw = readJson(text)?.steps;
    if (!Array.isArray(raw)) return [];
    const steps = distinctSteps(raw, maxSteps);
    return steps.length >= 2 ? steps : [];
}

/** A list marker at the start of a line: "1.", "2)", "-", "*", "•". */
const LIST_MARKER = /^\s*(?:\d{1,2}[.)]|[-*•])\s+/;

/**
 * The lines of a plan Llama wrote as prose instead of JSON, without their
 * list markers. Fewer than two is no plan.
 * @param {string} text
 * @param {number} maxSteps
 */
export function planLines(text, maxSteps) {
    const lines = `${text || ''}`
        .split('\n')
        .filter((line) => LIST_MARKER.test(line))
        .map((line) => line.replace(LIST_MARKER, ''));
    const steps = distinctSteps(lines, maxSteps);
    return steps.length >= 2 ? steps : [];
}

/**
 * The parts of the user's own request: its lines, and its sentences. A
 * request longer than `maxSteps` parts keeps the rest in its last step.
 * @param {string} task
 * @param {number} maxSteps
 */
export function taskParts(task, maxSteps) {
    /** @type {string[]} */
    const parts = [];
    for (const line of `${task || ''}`.split('\n')) {
        let current = '';
        for (let i = 0; i < line.length; i += 1) {
            current += line[i];
            // A sentence ends at . ? ! or ; followed by a space.
            if ('.?!;'.includes(line[i]) && (line[i + 1] === ' ' || line[i + 1] === '\t')) {
                parts.push(current);
                current = '';
            }
        }
        parts.push(current);
    }
    const pieces = parts.map((part) => part.trim()).filter((part) => part.length >= 3);
    if (pieces.length > maxSteps) pieces.splice(maxSteps - 1, pieces.length, pieces.slice(maxSteps - 1).join(' '));
    const steps = distinctSteps(pieces, maxSteps);
    return steps.length >= 2 ? steps : [];
}

/**
 * Two steps any task can be written in, when nothing better is known.
 * @param {string} task
 */
export function defaultSteps(task) {
    const subject = cleanStep(task).slice(0, 80) || 'the task';
    return [`Write the main code for: ${subject}`, 'Complete the remaining parts and show how to use it'];
}

/**
 * The steps of a Thinking reply, found locally, on the CPU, every time:
 *
 *   plan     Llama's JSON plan, when it has two steps or more
 *   lines    the list Llama wrote instead, when it did not answer in JSON
 *   task     the lines and sentences of the user's own request
 *   default  two general steps, so a Thinking reply always has steps
 *
 * @param {{ answer: string, task: string, maxSteps: number }} options
 * @returns {{ steps: string[], source: 'plan'|'lines'|'task'|'default' }}
 */
export function splitIntoSteps({ answer, task, maxSteps }) {
    const limit = Math.max(2, maxSteps);
    const plan = parsePlan(answer, limit);
    if (plan.length > 0) return { steps: plan, source: 'plan' };
    const lines = planLines(answer, limit);
    if (lines.length > 0) return { steps: lines, source: 'lines' };
    const parts = taskParts(task, limit);
    if (parts.length > 0) return { steps: parts, source: 'task' };
    return { steps: defaultSteps(task), source: 'default' };
}

/** @param {number} index zero-based @param {number} total */
export function stepInstruction(index, total) {
    if (total <= 1) {
        return (
            'Mode: thinking. Complete the task. Write complete, working code in fenced blocks labelled with the ' +
            'language (for example ```js). Keep the prose short: one or two sentences around each block.'
        );
    }
    return (
        `Mode: thinking, step ${index + 1} of ${total}. You are writing one step of a larger task. ` +
        'Do only this step and build on the earlier thoughts; do not repeat them. ' +
        'Write complete, working code in fenced blocks labelled with the language (for example ```js). ' +
        'Keep the prose to one or two sentences.'
    );
}

/**
 * A step's text with its last code block closed, if the step ended inside one
 * — cut at the step's token limit, by the loop guard, or by Stop. Left open,
 * that block would take in the next step's heading and code, and every
 * snippet after it would be drawn as one broken block.
 * @param {string} text
 */
export function closeOpenFence(text) {
    const blocks = splitReply(text);
    const last = blocks[blocks.length - 1];
    return last?.type === 'code' && !last.closed ? `${text.trimEnd()}\n\`\`\`` : text;
}

/** The plan as it opens the reply. @param {string[]} steps */
export function formatPlan(steps) {
    return `**Plan**\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}

/** The heading a step's text is written under. */
export function stepHeading(index, total, step) {
    return `### Step ${index + 1}/${total}: ${step}`;
}

/**
 * The end of a long text, about `maxTokens` of it, starting at a line break
 * and never inside a code block it cannot close.
 *
 * @param {string} text
 * @param {number} maxTokens
 */
export function tailTokens(text, maxTokens) {
    const value = `${text || ''}`.trim();
    if (maxTokens <= 0 || !value) return '';
    if (estimateTokens(value) <= maxTokens) return value;
    let low = 0;
    let high = value.length;
    // The shortest start whose tail still fits.
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (estimateTokens(value.slice(mid)) <= maxTokens - 4) high = mid;
        else low = mid + 1;
    }
    let start = low;
    const newline = value.indexOf('\n', start);
    if (newline >= 0 && newline - start < 200) start = newline + 1;
    let tail = value.slice(start);
    // An odd number of fences means the tail starts inside a block: reopen it.
    if (tail.split('```').length % 2 === 0) tail = `\`\`\`\n${tail}`;
    return `…\n${tail}`;
}

/**
 * Earlier thoughts as one block, within `maxTokens`: in the order they were
 * thought, each labelled, and each cut to its end if they do not all fit.
 *
 * @param {{ label: string, text: string }[]} thoughts
 * @param {number} maxTokens
 */
export function formatRecall(thoughts, maxTokens) {
    if (thoughts.length === 0 || maxTokens <= 0) return '';
    const share = Math.floor(maxTokens / thoughts.length) - 8;
    return thoughts
        .map(({ label, text }) => `${label}:\n${tailTokens(text, share)}`)
        .filter((entry) => !entry.endsWith(':\n'))
        .join('\n\n');
}

/**
 * The user message for one step: the task, the plan, the earlier thoughts
 * recalled for it, and which step to do now.
 *
 * @param {{ task: string, steps: string[], index: number, recalled: string }} options
 */
export function stepMessage({ task, steps, index, recalled }) {
    if (steps.length <= 1) return task;
    const plan = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
    return (
        `Task: ${task}\n\nPlan:\n${plan}\n\n` +
        (recalled ? `Earlier thoughts:\n"""\n${recalled.split('"""').join('"')}\n"""\n\n` : '') +
        `Now do step ${index + 1} only: ${steps[index]}`
    );
}
