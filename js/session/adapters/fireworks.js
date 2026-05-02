/**
 * Fireworks adapter — OpenAI-compatible chat completions with
 * streaming, over api.fireworks.ai/inference/v1.
 *
 * Catalog `spec.model` carries the full upstream id (with the
 * `accounts/fireworks/models/` prefix). The adapter forwards it
 * verbatim — no normalization needed.
 *
 * Implementation uses the OpenAI SDK with a custom baseURL — the
 * wire shape is identical and the SDK's streaming iterator matches
 * what `_chat_completions.js` expects.
 *
 * @module session/adapters/fireworks
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://api.fireworks.ai/inference/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * fireworks (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * runChatCompletions(envelope, client, {
    provider: 'fireworks',
    stream: true
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
