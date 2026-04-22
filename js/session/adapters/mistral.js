/**
 * Mistral adapter — OpenAI-compatible chat completions against
 * api.mistral.ai/v1. Mistral uses `tool_choice: "any"` for what
 * other providers spell as `required`; the shared core re-routes via
 * `toolChoiceFlavor: 'mistral'`.
 *
 * @module session/adapters/mistral
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'

const BASE_URL = 'https://api.mistral.ai/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * mistral (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({ apiKey: envelope.auth.key, baseURL: envelope.auth.baseURL || BASE_URL })
  yield * runChatCompletions(envelope, client, {
    provider: 'mistral',
    toolChoiceFlavor: 'mistral'
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
