/**
 * Novita adapter — OpenAI-compatible chat completions against
 * api.novita.ai. Image generation lives in `adapters/image/novita.js`;
 * this file covers the text path only.
 *
 * @module session/adapters/novita
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'

const BASE_URL = 'https://api.novita.ai/openai'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * novita (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({ apiKey: envelope.auth.key, baseURL: envelope.auth.baseURL || BASE_URL })
  yield * runChatCompletions(envelope, client, {
    provider: 'novita'
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
