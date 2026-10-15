/**
 * Request-size estimation — pure logic, no harness coupling.
 *
 * Design D4 needs to know whether a candidate's context window can hold the
 * request BEFORE it is sent, so an undersized candidate is skipped rather than
 * dispatched and failed. The kernel offers no tokenizer: a grep for
 * `estimateToken|tokenCount|countTokens|approxToken|tokenEstimate|charsPerToken`
 * over the extracted kernel sources returns nothing, and
 * `LlmResolvedModelInfo.context.contextWindow` is the only size metadata that
 * exists.
 *
 * So the size is estimated here from the message text, using the customary
 * ~4 characters per token. The estimate is deliberately coarse, and it fails
 * OPEN: when nothing can be measured the result is `undefined`, and
 * `selectCandidates` is specified never to drop a candidate for an unknown size.
 * A wrong-but-optimistic estimate costs one wasted attempt; a wrong-but-pessimistic
 * one would silently deny the user a working model.
 *
 * @module dsh-model-fallback/request-size
 */

/** Characters per token used by the heuristic estimator. */
export const CHARS_PER_TOKEN = 4

/**
 * Count the text characters a message contributes.
 *
 * Accepts the shapes the kernel actually stores: a bare string, or the content
 * part array (`[{type: 'text', text}]`, plus non-text parts that carry no text).
 *
 * @param {unknown} content - the message content.
 * @returns {number} character count (never negative).
 */
export function textLength(content) {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (typeof part.text === 'string') total += part.text.length
  }
  return total
}

/**
 * Estimate the token size of a request from its messages.
 *
 * @param {unknown} messages - the messages that will be sent.
 * @returns {number|undefined} estimated tokens, or undefined when unmeasurable.
 */
export function estimateTokens(messages) {
  if (!Array.isArray(messages)) return undefined
  let chars = 0
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    chars += textLength(message.content)
  }
  if (chars <= 0) return undefined
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
