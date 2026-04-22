/**
 * OpenRouter adapter — meta-provider with streaming chat completions
 * and optional `provider` routing preferences (order/allow/deny).
 *
 * Routing prefs ride on `envelope.providerOptions.openrouter` to keep
 * the base envelope schema clean; the shape matches OpenRouter's
 * `provider` request field: `{order?, allow?, deny?}`.
 *
 * @module session/adapters/openrouter
 */

import OpenAI from 'openai'

import { runChatCompletions } from './_chat_completions.js'

const BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Strip `\r` and `\n` from a header value. Node already rejects CRLF
 * in header values at send time (throws), so this is defense-in-depth
 * against a misconfigured `OPENROUTER_REFERER` / `OPENROUTER_TITLE`
 * env var crashing the adapter instead of producing a valid header.
 *
 * @param {string} v
 */
export function sanitizeHeader (v) {
  return String(v).replace(/[\r\n]/g, '')
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * openrouter (envelope, deps = {}) {
  // OpenRouter accepts optional `HTTP-Referer` + `X-Title` headers for
  // attribution in their dashboard. Only send when the embedder sets
  // the env vars — no defaults, so mohdel never identifies any
  // upstream consumer unprompted.
  const defaultHeaders = {}
  if (process.env.OPENROUTER_REFERER) {
    defaultHeaders['HTTP-Referer'] = sanitizeHeader(process.env.OPENROUTER_REFERER)
  }
  if (process.env.OPENROUTER_TITLE) {
    defaultHeaders['X-Title'] = sanitizeHeader(process.env.OPENROUTER_TITLE)
  }
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL,
    defaultHeaders
  })

  yield * runChatCompletions(envelope, client, {
    provider: 'openrouter',
    stream: true,
    mutateArgs: (env, args) => {
      const routing = env.providerOptions?.openrouter
      if (routing && (routing.order || routing.allow || routing.deny)) {
        args.provider = {}
        if (routing.order) args.provider.order = routing.order
        if (routing.allow) args.provider.allow = routing.allow
        if (routing.deny) args.provider.deny = routing.deny
      }
    }
  }, { signal: deps.signal, log: deps.log, span: deps.span })
}
