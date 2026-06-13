/**
 * Qwen Cloud adapter — OpenAI-compatible chat completions against
 * Alibaba's international DashScope endpoint. Reasoning arrives as
 * the standard `reasoning_content` field handled by the shared core;
 * thinking is wired via `reasoningField: 'qwen'` (`enable_thinking`
 * + `thinking_budget`) because Qwen hybrid models think by default.
 *
 * @module session/adapters/qwen
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * qwen (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * runChatCompletions(envelope, client, {
    provider: 'qwen',
    reasoningField: 'qwen'
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
