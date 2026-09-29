/**
 * Meta Model API adapter — OpenAI Responses API over api.meta.ai/v1.
 * Delegates to the `openai` adapter with a baseURL-configured client;
 * the openai adapter branches on `providerOf(envelope.model)` for the
 * fields that differ between vendors.
 *
 * @module session/adapters/meta
 */

import OpenAI from 'openai'

import { openai } from './openai.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://api.meta.ai/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * meta (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: BASE_URL,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * openai(envelope, { ...deps, client })
}
