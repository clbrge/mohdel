/**
 * Groq adapter — OpenAI-compatible chat completions, non-streaming.
 *
 * @module session/adapters/groq
 */

import Groq from 'groq-sdk'

import { runChatCompletions } from './_chat_completions.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * groq (envelope, deps = {}) {
  const client = deps.client ?? new Groq({ apiKey: envelope.auth.key })
  yield * runChatCompletions(envelope, client, { provider: 'groq' }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
