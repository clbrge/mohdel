import OpenAI from 'openai'
import { openai } from './openai.js'
import { streamingDispatcher } from './_dispatcher.js'
import { classifyProviderError } from './_errors.js'
import { catalogKey, bareOf } from '#core/model-id.js'
import { getSpec } from './_catalog.js'
import { discoverModels } from '../../chatgpt/models.js'
import { abortedDone } from './_aborted.js'

// A token belongs to one account, so its model list only changes with the token.
const discovered = new Map()
const DISCOVERED_TOKENS = 8

async function accountModels (key, deps) {
  const cached = discovered.get(key)
  if (cached) return cached
  const models = await discoverModels(key, deps)
  discovered.set(key, models)
  if (discovered.size > DISCOVERED_TOKENS) discovered.delete(discovered.keys().next().value)
  return models
}

/**
 * Uses only the caller's OAuth access token, including behind the gate.
 * Session subprocesses never read the host's saved ChatGPT account.
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{client?: any, fetch?: typeof fetch, signal?: AbortSignal, log?: any, span?: any}} [deps]
 */
export async function * chatgpt (envelope, deps = {}) {
  const key = envelope.auth?.key
  const start = String(process.hrtime.bigint())
  const model = getSpec(catalogKey(envelope.model))?.model ?? bareOf(catalogKey(envelope.model))
  try {
    const models = await accountModels(key, deps)
    if (!models.some(m => m.slug === model)) {
      yield { type: 'error', error: { type: 'INVALID_REQUEST', severity: 'error', message: 'This model is not available to the selected ChatGPT account.', retryable: false } }
      return
    }
  } catch (err) {
    if (deps.signal?.aborted) {
      yield abortedDone(start, null, envelope, '', 0, 0)
      return
    }
    yield { type: 'error', error: classifyProviderError(err, key, { provider: 'chatgpt' }) }
    return
  }
  const client = deps.client ?? new OpenAI({
    apiKey: key,
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    fetchOptions: { dispatcher: streamingDispatcher() }
  })
  // SDK errors can carry request details; never put OAuth credentials in logs.
  const log = deps.log ? { warn: (_data, message) => deps.log.warn({ provider: 'chatgpt' }, message) } : undefined
  yield * openai(envelope, { ...deps, client, log })
}
