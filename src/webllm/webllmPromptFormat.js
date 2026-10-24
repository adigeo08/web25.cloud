// @ts-check
/**
 * The Llama 3 chat format, for continuing a reply in place.
 *
 * A chat completion always starts a new assistant turn. To continue one that
 * stopped at the length limit, the page instead sends a plain text completion
 * whose prompt is the conversation in the model's own template, ending inside
 * the unfinished assistant turn — so the next token the model writes is the
 * next token of that reply. This is the same text WebLLM builds for a chat
 * request (`getPromptArrayInternal` with MLC's `llama-3_1` template, used for
 * Llama 3.x): `<|begin_of_text|>`, then per message
 * `<|start_header_id|>{role}<|end_header_id|>\n\n{content}<|eot_id|>`, then the
 * assistant header. Text completion adds no `<|begin_of_text|>` of its own.
 *
 * Message text is never allowed to contain template tokens: a `<|…|>` in user
 * text, model text or documentation is broken up so it stays text.
 */

/** @param {string} text */
export function neutralizeTemplateTokens(text) {
    return `${text || ''}`.replace(/<\|/g, '<​|').replace(/\|>/g, '|​>');
}

/**
 * @param {{ role: string, content: string }[]} messages system first, ending on the user's question
 * @param {string} partial the reply so far
 */
export function formatContinuationPrompt(messages, partial) {
    let prompt = '<|begin_of_text|>';
    for (const message of messages) {
        const role = message.role === 'system' || message.role === 'assistant' ? message.role : 'user';
        prompt += `<|start_header_id|>${role}<|end_header_id|>\n\n${neutralizeTemplateTokens(message.content)}<|eot_id|>`;
    }
    return `${prompt}<|start_header_id|>assistant<|end_header_id|>\n\n${neutralizeTemplateTokens(partial)}`;
}
