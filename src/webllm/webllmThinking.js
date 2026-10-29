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
 * The plan's steps: strings only, trimmed, distinct, at most `maxSteps`.
 * Fewer than two is no plan.
 *
 * @param {string} text
 * @param {number} maxSteps
 * @returns {string[]}
 */
export function parsePlan(text, maxSteps) {
    const raw = readJson(text)?.steps;
    if (!Array.isArray(raw)) return [];
    /** @type {string[]} */
    const steps = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        // A fence in a step would open a code block in the plan and the heading.
        const step = entry.split('\n').join(' ').split('```').join('').trim().slice(0, 140);
        if (step.length < 3 || steps.some((existing) => existing.toLowerCase() === step.toLowerCase())) continue;
        steps.push(step);
        if (steps.length >= maxSteps) break;
    }
    return steps.length >= 2 ? steps : [];
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

/**
 * How a step ended:
 *
 *   complete    the model ended it, and its code holds together
 *   truncated   it reached the step's token limit (after the one continuation
 *               it may get)
 *   looped      the loop guard cut it; the first pass was kept
 *   stopped     the user pressed Stop
 *   malformed   the model ended it, but its code does not hold together
 *
 * @typedef {'complete'|'truncated'|'looped'|'stopped'|'malformed'} StepStatus
 */

/** Languages whose brackets are checked. */
const BRACKETED = new Set(['js', 'javascript', 'mjs', 'cjs', 'jsx', 'ts', 'typescript', 'tsx', 'json', 'css', 'scss']);
const HTML = new Set(['html', 'htm', 'xml', 'svg', 'vue']);
const PAIRS = /** @type {Record<string, string>} */ ({ ')': '(', ']': '[', '}': '{' });

/**
 * Whether a piece of code ends with every bracket, string and comment it
 * opened closed. Strings, template literals and comments are skipped, and an
 * escaped character never counts. Deterministic and forgiving: it only says
 * "unfinished" for code that clearly is — a function that never closes, a
 * string still open at the end.
 *
 * @param {string} code
 * @param {{ css?: boolean }} [options] CSS has no `//` comments or template literals
 */
export function bracketsBalanced(code, { css = false } = {}) {
    /** @type {string[]} */
    const stack = [];
    /** @type {string|null} the quote of the string being read */
    let quote = null;
    let line = false;
    let block = false;
    for (let i = 0; i < code.length; i += 1) {
        const char = code[i];
        const next = code[i + 1];
        if (line) {
            if (char === '\n') line = false;
            continue;
        }
        if (block) {
            if (char === '*' && next === '/') {
                block = false;
                i += 1;
            }
            continue;
        }
        if (char === '\\') {
            i += 1;
            continue;
        }
        if (quote) {
            if (char === quote) quote = null;
            // A line break ends a quoted string; only a template literal spans lines.
            else if (char === '\n' && quote !== '`') quote = null;
            continue;
        }
        if (char === '/' && next === '*') {
            block = true;
            i += 1;
        } else if (!css && char === '/' && next === '/') {
            line = true;
            i += 1;
        } else if (char === '"' || char === "'" || (!css && char === '`')) {
            quote = char;
        } else if (char === '(' || char === '[' || char === '{') {
            stack.push(char);
        } else if (char in PAIRS) {
            // A closer that does not match the innermost opener (a bracket in
            // a regex, say) closes the nearest one that does match; one with
            // no opener at all is ignored. Only what stays open counts.
            const at = stack.lastIndexOf(PAIRS[char]);
            if (at >= 0) stack.length = at;
        }
    }
    return stack.length === 0 && !block && quote !== '`';
}

/** @param {string} html @param {string} tag */
const count = (html, tag) => (html.match(new RegExp(tag, 'gi')) || []).length;

/**
 * Whether an HTML snippet closes the elements that, left open, would mean it
 * was cut off — and whether its scripts and styles hold together.
 * @param {string} html
 */
export function htmlBalanced(html) {
    for (const tag of ['html', 'head', 'body', 'script', 'style', 'template', 'svg']) {
        if (count(html, `<${tag}[\\s>]`) > count(html, `</${tag}\\s*>`)) return false;
    }
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
        if (!bracketsBalanced(match[1])) return false;
    }
    for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
        if (!bracketsBalanced(match[1], { css: true })) return false;
    }
    // A tag cut in half: `<div class="a` at the very end.
    return !/<[a-z][^>]*$/i.test(html.trimEnd());
}

/**
 * Whether a step's text, as the model wrote it, is structurally whole: no
 * code block left open — the fence `closeOpenFence` adds for the screen is
 * not the model's and must not be what is checked — and every block's
 * brackets or tags closed.
 *
 * @param {string} text the step's raw text
 * @returns {{ whole: boolean, reason: ''|'open-code-block'|'unbalanced-code' }}
 */
export function stepStructure(text) {
    for (const block of splitReply(text)) {
        if (block.type !== 'code') continue;
        if (!block.closed) return { whole: false, reason: 'open-code-block' };
        const lang = block.lang.toLowerCase();
        if (BRACKETED.has(lang) && !bracketsBalanced(block.code, { css: lang === 'css' || lang === 'scss' })) {
            return { whole: false, reason: 'unbalanced-code' };
        }
        if (HTML.has(lang) && !htmlBalanced(block.code)) return { whole: false, reason: 'unbalanced-code' };
    }
    return { whole: true, reason: '' };
}

/**
 * How a step ended, from the generation's finish reason and the step's text.
 * @param {string|null|undefined} finishReason
 * @param {string} text the step's raw text
 * @param {{ stopped?: boolean }} [options]
 * @returns {StepStatus}
 */
export function stepStatus(finishReason, text, { stopped = false } = {}) {
    if (stopped || finishReason === 'abort') return 'stopped';
    if (finishReason === 'length') return 'truncated';
    const { whole } = stepStructure(text);
    if (finishReason === 'loop') return whole ? 'looped' : 'malformed';
    return whole ? 'complete' : 'malformed';
}

/**
 * Whether a step's text can be built on as earlier work: written to the end,
 * or cut by the loop guard after a first pass that holds together.
 * @param {StepStatus} status
 */
export function stepConfirmed(status) {
    return status === 'complete' || status === 'looped';
}

/**
 * The line written under a step that did not finish, so it is never shown as
 * if it had. Plain text and bold only, as the chat draws it.
 * @param {StepStatus} status
 * @param {number} index zero-based
 * @param {number} total
 */
export function incompleteStepMarker(status, index, total) {
    const which = total > 1 ? `Step ${index + 1} is incomplete` : 'This answer is incomplete';
    const why =
        status === 'truncated'
            ? 'it reached the length limit before it finished, so its code may be cut off.'
            : 'its code does not look finished (a block, bracket or tag is left open), so check it before using it.';
    return `\n\n**⚠ ${which}:** ${why}`;
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
 * @param {{ label: string, text: string, weight?: number }[]} thoughts
 * @param {number} maxTokens
 */
export function formatRecall(thoughts, maxTokens) {
    if (thoughts.length === 0 || maxTokens <= 0) return '';
    // A thought may weigh more — the step just before gets a larger share —
    // and the shares still add up to no more than `maxTokens`.
    const total = thoughts.reduce((sum, thought) => sum + (thought.weight ?? 1), 0);
    return thoughts
        .map(({ label, text, weight = 1 }) => {
            const share = Math.floor((maxTokens * weight) / total) - 8;
            return `${label}:\n${tailTokens(text, share)}`;
        })
        .filter((entry) => !entry.endsWith(':\n'))
        .join('\n\n');
}

/**
 * The user message for one step: the task, the plan, the earlier thoughts
 * recalled for it, and which step to do now.
 *
 * @param {{ task: string, steps: string[], index: number, recalled: string, incomplete?: number[] }} options
 *   `incomplete` lists the zero-based earlier steps that did not finish: the
 *   step is told not to rely on them, since their thoughts are not recalled
 */
export function stepMessage({ task, steps, index, recalled, incomplete = [] }) {
    if (steps.length <= 1) return task;
    const plan = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
    const unfinished = incomplete.filter((i) => i < index).map((i) => i + 1);
    const note =
        unfinished.length === 0
            ? ''
            : `Note: step${unfinished.length > 1 ? 's' : ''} ${unfinished.join(', ')} did not finish; ` +
              'do not rely on code from them, write what this step needs in full.\n\n';
    return (
        `Task: ${task}\n\nPlan:\n${plan}\n\n` +
        (recalled ? `Earlier thoughts:\n"""\n${recalled.split('"""').join('"')}\n"""\n\n` : '') +
        note +
        `Now do step ${index + 1} only: ${steps[index]}`
    );
}
