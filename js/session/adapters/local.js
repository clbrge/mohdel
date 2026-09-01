/**
 * Local adapter — any OpenAI-compatible chat-completions server
 * (Ollama, vLLM, llama.cpp server, LM Studio). The endpoint is the
 * catalog entry's `baseURL`; there is no default and no per-call
 * override, so a call can never fall through to a cloud provider.
 *
 * @module session/adapters/local
 */

import OpenAI from 'openai'

import { catalogKey } from '#core/model-id.js'

import { getSpec } from './_catalog.js'
import { runChatCompletions } from './_chat_completions.js'
import { streamingDispatcher } from './_dispatcher.js'

// The SDK constructor rejects an empty `apiKey`. An unauthenticated
// server gets a placeholder key that never reaches the wire: the
// explicit `Authorization: null` default header makes the SDK omit
// the header entirely.
const UNAUTHENTICATED = 'unauthenticated'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * local (envelope, deps = {}) {
  const key = catalogKey(envelope.model)
  const baseURL = getSpec(key)?.baseURL
  if (!baseURL) {
    yield {
      type: 'error',
      error: {
        message: 'local provider has no endpoint',
        detail: `catalog entry '${key}' has no baseURL`,
        severity: 'error',
        retryable: false,
        type: 'CONFIGURATION_MISSING'
      }
    }
    return
  }
  const client = deps.client ?? new OpenAI({
    baseURL,
    fetchOptions: { dispatcher: streamingDispatcher() },
    ...(envelope.auth.key
      ? { apiKey: envelope.auth.key }
      : { apiKey: UNAUTHENTICATED, defaultHeaders: { Authorization: null } })
  })
  yield * runChatCompletions(envelope, client, {
    provider: 'local',
    stream: true
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
