/**
 * xAI adapter — OpenAI Responses API over x.ai/v1. Delegates to the
 * `openai` adapter with a baseURL-configured client; the openai
 * adapter branches on `providerOf(envelope.model) === 'openai'` for fields
 * that differ between vendors (reasoning param, safety_identifier).
 *
 * @module session/adapters/xai
 */

import OpenAI from 'openai'

import { openai } from './openai.js'
import { streamingDispatcher } from './_dispatcher.js'

const BASE_URL = 'https://api.x.ai/v1'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, signal?: AbortSignal}} [deps]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * xai (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({
    apiKey: envelope.auth.key,
    baseURL: envelope.auth.baseURL || BASE_URL,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  yield * openai(envelope, { ...deps, client })
}
