/** @module session/adapters/tinker */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * tinker (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: BASE_URL,
    maxRetries: 0,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * runChatCompletions(envelope, client, {
    stream: true,
    provider: 'tinker'
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
