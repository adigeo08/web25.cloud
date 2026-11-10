// @ts-check
/**
 * The models' chat formats, for continuing a reply in place.
 *
 * A chat completion always starts a new assistant turn. To continue one that
 * stopped at the length limit, the page instead sends a plain text completion
 * whose prompt is the conversation in the model's own template, ending inside
 * the unfinished assistant turn — so the next token the model writes is the
 * next token of that reply. This is the same text WebLLM builds for a chat
 * request (`getPromptArrayInternal`), in one of two MLC templates:
 *
 *   llama3  `llama-3_1`, used for Llama 3.x: `<|begin_of_text|>`, then per message
 *           `<|start_header_id|>{role}<|end_header_id|>\n\n{content}<|eot_id|>`,
 *           then the assistant header.
 *   qwen3   `qwen3`, used for Qwen3: ChatML — per message
 *           `<|im_start|>{role}\n{content}<|im_end|>\n`, then `<|im_start|>assistant\n` —
 *           and, since WEB25 runs Qwen3 without thinking, the empty thinking
 *           block WebLLM writes for `enable_thinking: false`
 *           (`<think>\n\n</think>\n\n`) before the reply.
 *
 * Text completion adds no begin-of-text token of its own.
 *
 * Message text is never allowed to contain template tokens: a `<|…|>` in user
 * text, model text or documentation is broken up so it stays text. Both
 * templates' special tokens have that shape.
 */

/** What WebLLM puts at the start of a Qwen3 reply when thinking is off. */
export const EMPTY_THINKING_BLOCK = '<think>\n\n</think>\n\n';

/** @param {string} text */
export function neutralizeTemplateTokens(text) {
    return `${text || ''}`.replace(/<\|/g, '<​|').replace(/\|>/g, '|​>');
}

/** @param {string} role */
const roleOf = (role) => (role === 'system' || role === 'assistant' ? role : 'user');

/**
 * @param {{ role: string, content: string }[]} messages system first, ending on the user's question
 * @param {string} partial the reply so far
 * @param {'llama3'|'qwen3'} [template]
 */
export function formatContinuationPrompt(messages, partial, template = 'llama3') {
    if (template === 'qwen3') {
        let prompt = '';
        for (const message of messages) {
            prompt += `<|im_start|>${roleOf(message.role)}\n${neutralizeTemplateTokens(message.content)}<|im_end|>\n`;
        }
        return `${prompt}<|im_start|>assistant\n${EMPTY_THINKING_BLOCK}${neutralizeTemplateTokens(partial)}`;
    }
    let prompt = '<|begin_of_text|>';
    for (const message of messages) {
        prompt += `<|start_header_id|>${roleOf(message.role)}<|end_header_id|>\n\n${neutralizeTemplateTokens(message.content)}<|eot_id|>`;
    }
    return `${prompt}<|start_header_id|>assistant<|end_header_id|>\n\n${neutralizeTemplateTokens(partial)}`;
}

/**
 * Keeps a `<think>…</think>` block at the very start of a streamed reply off
 * the screen: the empty one WebLLM may hand back with the reply when thinking
 * is off, or a real one a reasoning model writes anyway. Text is held only
 * while it could still be the start of such a block; everything after it, and
 * any reply that does not start with one, passes through unchanged.
 */
export function createThinkingFilter() {
    let held = '';
    /** 'start': still deciding; 'trim': after a block, dropping its trailing blank lines; 'pass' */
    let state = 'start';
    return {
        /** @param {string} text @returns {string} what to show of it */
        push(text) {
            if (state === 'pass') return text;
            if (state === 'trim') {
                const shown = text.replace(/^\s+/, '');
                if (shown) state = 'pass';
                return shown;
            }
            held += text;
            const lead = held.trimStart();
            if (lead.startsWith('<think>')) {
                const end = lead.indexOf('</think>');
                if (end < 0) return '';
                held = '';
                state = 'trim';
                return this.push(lead.slice(end + '</think>'.length));
            }
            if ('<think>'.startsWith(lead)) return '';
            state = 'pass';
            const shown = held;
            held = '';
            return shown;
        },
        /** At the end of the stream: what is still held, if it was never a block. */
        flush() {
            const lead = held.trimStart();
            held = '';
            if (state !== 'start') return '';
            state = 'pass';
            // A block that never closed: its thoughts are all there is to show.
            return lead.startsWith('<think>') ? lead.slice('<think>'.length).trimStart() : lead;
        }
    };
}
