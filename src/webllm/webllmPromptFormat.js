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
 *   chatml  `chatml`, used for SmolLM2: per message
 *           `<|im_start|>{role}\n{content}<|im_end|>\n`, then `<|im_start|>assistant\n`.
 *
 * Text completion adds no begin-of-text token of its own.
 *
 * Message text is never allowed to contain template tokens: a `<|…|>` in user
 * text, model text or documentation is broken up so it stays text. Both
 * templates' special tokens have that shape.
 */

/** @param {string} text */
export function neutralizeTemplateTokens(text) {
    return `${text || ''}`.replace(/<\|/g, '<​|').replace(/\|>/g, '|​>');
}

/** @param {string} role */
const roleOf = (role) => (role === 'system' || role === 'assistant' ? role : 'user');

/**
 * @param {{ role: string, content: string }[]} messages system first, ending on the user's question
 * @param {string} partial the reply so far
 * @param {'llama3'|'chatml'} [template]
 */
export function formatContinuationPrompt(messages, partial, template = 'llama3') {
    if (template === 'chatml') {
        let prompt = '';
        for (const message of messages) {
            prompt += `<|im_start|>${roleOf(message.role)}\n${neutralizeTemplateTokens(message.content)}<|im_end|>\n`;
        }
        return `${prompt}<|im_start|>assistant\n${neutralizeTemplateTokens(partial)}`;
    }
    let prompt = '<|begin_of_text|>';
    for (const message of messages) {
        prompt += `<|start_header_id|>${roleOf(message.role)}<|end_header_id|>\n\n${neutralizeTemplateTokens(message.content)}<|eot_id|>`;
    }
    return `${prompt}<|start_header_id|>assistant<|end_header_id|>\n\n${neutralizeTemplateTokens(partial)}`;
}
