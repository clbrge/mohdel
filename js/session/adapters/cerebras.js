/**
 * Cerebras adapter — non-streaming chat completions with
 * Cerebras-specific reasoning toggle for zai-family models.
 *
 * @module session/adapters/cerebras
 */

import Cerebras from '@cerebras/cerebras_cloud_sdk'

import { runChatCompletions } from './_chat_completions.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * cerebras (envelope, deps = {}) {
  const client = deps.client ?? new Cerebras({ apiKey: envelope.auth.key })
  yield * runChatCompletions(envelope, client, {
    provider: 'cerebras',
    toolChoiceFlavor: 'cerebras',
    reasoningField: 'cerebras_zai'
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
