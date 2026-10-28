// @ts-check
/**
 * Sequential thinking for the local chat: decide what kind of conversation
 * this is, then answer it the way that kind needs.
 *
 *   1. Classify. An informative message asks to be told something ("what is a
 *      closure?", "de ce nu merge flexbox aici?"). A productive one asks for
 *      something to be made ("write a debounce function", "creează un
 *      formular de login cu validare").
 *   2. Informative → one short answer. MDN may still be looked up once for the
 *      facts, but the reply is held to a few sentences and a small snippet.
 *   3. Productive → plan, then steps. The model first lists a few concrete
 *      steps; each step is then written in its own request, with its own MDN
 *      lookup made for that step alone, and with the work of earlier steps
 *      handed forward so the code builds up rather than restarting.
 *
 * The classification is deterministic, like the MDN lookup: a 1B model is a
 * poor judge of its own task, and the user should be able to predict what
 * they get. Pure functions; the controller runs the flow.
 */

import { WEBLLM_SYSTEM_PROMPT } from './webllmConfig.js';
import { estimateTokens } from './webllmProgress.js';
import { isDevelopmentQuestion } from './mdnLookup.js';

/** @typedef {'informative'|'productive'} ConversationMode */

// Word ends are checked with a Unicode lookahead, not `\b`: `\b` only knows
// ASCII letters, so it never matches after "ă" or "ț".

/** Polite or indirect openers stripped before the first verb is read. */
const OPENER =
    /^(?:(?:please|pls|hey|hi|ok(?:ay)?|so|now|also|and|then|can you|could you|would you|will you|i need you to|i want you to|i'd like you to|help me|let's|te rog(?: să| sa)?|poți să|poti sa|poţi să|vreau să|vreau sa|aș vrea să|as vrea sa|ajută-mă să|ajuta-ma sa|acum|și|si|apoi)[\s,:!]+)+/i;

/** Verbs that ask for something to be made or changed. */
const MAKE_VERB =
    /^(?:write|create|build|implement|generate|make|code|develop|refactor|convert|port|rewrite|add|fix|debug|scaffold|set up|setup|design|optimi[sz]e|extend|update|modify|translate|scrie(?:-mi|ți|ti)?|creea?ză|creaz[ăa]|construie[șşs]te|implementeaz[ăa]|genereaz[ăa]|f[ăa](?:-mi)?|adaug[ăa]|repar[ăa]|refactorizeaz[ăa]|rescrie|converte[șşs]te|dezvolt[ăa]|modific[ăa]|optimizeaz[ăa]|actualizeaz[ăa])(?![\p{L}\p{N}_])/iu;

const MAKE_ANYWHERE =
    /\b(?:write|create|build|implement|generate|refactor|rewrite|scaffold|scrie|creea?z[ăa]|construie[șşs]te|implementeaz[ăa]|genereaz[ăa]|refactorizeaz[ăa]|rescrie)(?![\p{L}\p{N}_])/iu;

/** Things that get made. */
const ARTIFACT =
    /\b(?:function|component|script|page|form|app|application|class|module|snippet|code|program|api|endpoint|layout|widget|hook|service|worker|plugin|library|website|site|landing|navbar|modal|table|game|test|tests|cli|server|funcți[ea]|functi[ea]|component[ăa]|cod(?:ul)?|pagin[ăa]|formular|aplicați[ea]|aplicati[ea]|clas[ăa]|modul|joc|teste?|tabel)(?![\p{L}\p{N}_])/iu;

/** Signs of a multi-part request. */
const MULTIPART =
    /\b(?:with|that|which|including|and then|step by step|full|complete|end-to-end|from scratch|cu|care|inclusiv|complet[ăa]?|pas cu pas|de la zero)(?![\p{L}\p{N}_])/iu;

/** Questions that ask to be told, not given. */
const ASKS =
    /^(?:what|why|when|where|which|who|whose|is|are|was|were|does|do|did|should|explain|define|describe|tell me|difference|compare|ce|de ce|când|cand|unde|care|cine|este|e|sunt|explic[ăa]|define[șşs]te|descrie|spune-mi|diferen[țţt]a|compar[ăa])(?![\p{L}\p{N}_])/iu;

/**
 * Informative or productive?
 *
 * Scored, so no single word decides: an imperative "make" verb counts most, a
 * thing to make and signs of a multi-part request add to it, code pasted in
 * adds to it, and a message that opens as a question takes away. "How do I
 * create an array?" stays informative; "Create a login form with validation"
 * does not. Productive means code: "write an essay" is not, however it scores.
 *
 * @param {string} text
 * @returns {ConversationMode}
 */
export function classifyIntent(text) {
    const value = `${text || ''}`.trim();
    if (value.length < 6) return 'informative';
    const lead = value.replace(OPENER, '');
    let score = 0;
    if (MAKE_VERB.test(lead)) score += 2;
    if (MAKE_ANYWHERE.test(value)) score += 1;
    if (ARTIFACT.test(value)) score += 1;
    if (MULTIPART.test(value)) score += 1;
    if (/```/.test(value)) score += 1;
    if (ASKS.test(lead) || /^how (?:does|do|is|are|can|would|should)\b/i.test(lead) || /^cum\b/i.test(lead)) score -= 2;
    const aboutCode = ARTIFACT.test(value) || /```/.test(value) || isDevelopmentQuestion(value);
    return score >= 3 && aboutCode ? 'productive' : 'informative';
}

/** Added to the system prompt for an informative answer. */
export const INFORMATIVE_INSTRUCTION =
    'Mode: informative. Answer briefly: at most three short sentences or a few bullet points. ' +
    'Include a code snippet only if it is essential, at most six lines, in a fenced block labelled with its language. ' +
    'No introduction and no summary.';

/** The system prompt an informative answer is written under. */
export const INFORMATIVE_SYSTEM_PROMPT = `${WEBLLM_SYSTEM_PROMPT}\n\n${INFORMATIVE_INSTRUCTION}`;

/** @param {number} maxSteps */
export function planInstruction(maxSteps) {
    return (
        `Mode: planning. Break the user's task into 2 to ${maxSteps} concrete implementation steps, in order. ` +
        'Reply with only a numbered list, one short line per step (under 15 words). No code and no explanations.'
    );
}

/** @param {number} index zero-based @param {number} total */
export function stepInstruction(index, total) {
    if (total <= 1) {
        return (
            'Mode: productive. Complete the task. Write complete, working code in fenced blocks labelled with the ' +
            'language (for example ```js). Keep the prose short: one or two sentences around each block.'
        );
    }
    return (
        `Mode: productive, step ${index + 1} of ${total}. You are writing one step of a larger task. ` +
        'Do only this step and build on the work already done; do not repeat it. ' +
        'Write complete, working code in fenced blocks labelled with the language (for example ```js). ' +
        'Keep the prose to one or two sentences.'
    );
}

/**
 * The steps out of the model's numbered list. Anything that is not a list
 * item is ignored; fewer than two steps is no plan.
 *
 * @param {string} text
 * @param {number} maxSteps
 * @returns {string[]}
 */
export function parsePlan(text, maxSteps) {
    const steps = [];
    for (const line of `${text || ''}`.split('\n')) {
        const match = line.match(/^\s*(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*•])\s+(.+)$/i);
        if (!match) continue;
        const step = match[1]
            .replace(/\*\*|__|`/g, '')
            .replace(/^step\s*\d+\s*[:.-]\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 140);
        if (step.length < 3 || steps.some((existing) => existing.toLowerCase() === step.toLowerCase())) continue;
        steps.push(step);
        if (steps.length >= maxSteps) break;
    }
    return steps.length >= 2 ? steps : [];
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
    if ((tail.match(/```/g) || []).length % 2 === 1) tail = `\`\`\`\n${tail}`;
    return `…\n${tail}`;
}

/**
 * The user message for one step: the task, the plan, what earlier steps
 * wrote (its end, within `previousTokens`), and which step to do now.
 *
 * @param {{ task: string, steps: string[], index: number, previous: string, previousTokens: number }} options
 */
export function stepMessage({ task, steps, index, previous, previousTokens }) {
    if (steps.length <= 1) return task;
    const plan = steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
    const done = tailTokens(previous, previousTokens);
    return (
        `Task: ${task}\n\nPlan:\n${plan}\n\n` +
        (done ? `Work already done in earlier steps:\n"""\n${done.replace(/"{3,}/g, '"')}\n"""\n\n` : '') +
        `Now do step ${index + 1} only: ${steps[index]}`
    );
}
