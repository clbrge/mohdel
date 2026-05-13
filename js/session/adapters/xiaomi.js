/**
 * Xiaomi MiMo adapter — OpenAI-compatible chat completions against
 * api.xiaomimimo.com. Standard `reasoning_content` field handling
 * is provided by the shared core; this module just wires the base
 * URL and provider tag.
 *
 * @module session/adapters/xiaomi
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://api.xiaomimimo.com/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * xiaomi (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * runChatCompletions(envelope, client, {
    provider: 'xiaomi'
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
