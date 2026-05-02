/**
 * DeepSeek adapter — OpenAI-compatible chat completions against
 * api.deepseek.com. DeepSeek models occasionally emit tool calls as
 * DSML XML-style blocks in `content` rather than the native
 * `tool_calls` array; the shared core handles the fallback parse
 * when `parseDsml: true`.
 *
 * @module session/adapters/deepseek
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://api.deepseek.com'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * deepseek (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * runChatCompletions(envelope, client, {
    provider: 'deepseek',
    parseDsml: true
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
