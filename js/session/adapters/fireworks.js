/**
 * Fireworks adapter — OpenAI-compatible chat completions with
 * streaming, over api.fireworks.ai/inference/v1.
 *
 * Fireworks model IDs carry an `accounts/fireworks/models/` prefix;
 * envelopes can supply either form. The `mutateArgs` hook normalizes
 * `args.model` before the request leaves the adapter.
 *
 * Implementation uses the OpenAI SDK with a custom baseURL — the
 * wire shape is identical and the SDK's streaming iterator matches
 * what `_chat_completions.js` expects.
 *
 * @module session/adapters/fireworks
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'

const BASE_URL = 'https://api.fireworks.ai/inference/v1'
const MODEL_PREFIX = 'accounts/fireworks/models/'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal, log?: any, span?: any}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * fireworks (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL
  })
  yield * runChatCompletions(envelope, client, {
    provider: 'fireworks',
    stream: true,
    mutateArgs: (env, args) => {
      if (!args.model.includes('/')) {
        args.model = `${MODEL_PREFIX}${args.model}`
      }
    }
  }, {
    signal: deps.signal,
    log: deps.log,
    span: deps.span
  })
}
