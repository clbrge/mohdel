/**
 * Embedding runtime. Resolves the adapter for the envelope's provider and
 * returns either a result or a typed error, never throwing.
 *
 * Mirrors `run_transcription.js`: one synchronous request, no streaming, no
 * cancellation path beyond the caller's own signal. Rate limits are enforced
 * as in `run.js`, minus the speed lanes embeddings do not have.
 *
 * @module session/run_embedding
 */

import { getEmbeddingAdapter } from './adapters/embedding/index.js'
import { classifyProviderError } from './adapters/_errors.js'
import { getProviderLimits } from './adapters/_providers.js'
import * as defaultLimiter from './_rate_limiter.js'
import { providerOf } from '#core/model-id.js'

/**
 * @param {import('#core/embedding.js').EmbedEnvelope} envelope
 * @param {{
 *   resolveAdapter?: (provider: string) => any,
 *   resolveProviderLimits?: (provider: string) => any,
 *   limiter?: any,
 *   sleep?: (ms: number) => Promise<void>,
 *   modelKey?: string,
 *   spec?: any
 * }} [options]
 * @returns {Promise<
 *   | {ok: true, result: import('#core/embedding.js').EmbedResult}
 *   | {ok: false, error: import('#core/errors.js').TypedError}
 * >}
 */
export async function runEmbedding (envelope, {
  resolveAdapter = getEmbeddingAdapter,
  resolveProviderLimits = getProviderLimits,
  limiter = defaultLimiter,
  sleep = defaultSleep,
  modelKey = envelope.model,
  spec
} = {}) {
  const provider = providerOf(envelope.model)

  let adapter
  try {
    adapter = resolveAdapter(provider)
  } catch (e) {
    return {
      ok: false,
      error: {
        message: messageOf(e),
        severity: 'error',
        retryable: false,
        type: 'SESSION_UNKNOWN_PROVIDER'
      }
    }
  }

  const providerCfg = resolveProviderLimits(provider) || {}
  const rpmLimit = spec?.rpmLimit ?? providerCfg.rpmLimit
  const tpmLimit = spec?.tpmLimit ?? providerCfg.tpmLimit
  const inpmLimit = spec?.inpmLimit ?? providerCfg.inpmLimit
  // `modelKey` is the catalog key, which the envelope carries over the wire but
  // not on the in-process path, where it holds the upstream id instead.
  const bucketKey = spec?.rateLimitScope === 'model' ? modelKey : provider
  // A malformed envelope is metered as nothing: `checkBatch` rejects it inside
  // the adapter, and a call that never reaches the provider must not spend quota.
  const inputs = Array.isArray(envelope.input) ? envelope.input.length : 0

  if (inputs > 0 && (rpmLimit != null || tpmLimit != null || inpmLimit != null)) {
    const delay = limiter.check(bucketKey, { rpmLimit, tpmLimit, inpmLimit }, { inputs })
    if (delay > 0) await sleep(delay)
    limiter.recordRequest(bucketKey)
    if (inpmLimit != null) limiter.recordInputs(bucketKey, inputs)
  }

  try {
    const result = await adapter(envelope, spec ? { spec } : {})
    if (tpmLimit != null && result.inputTokens) limiter.recordTokens(bucketKey, result.inputTokens)
    return { ok: true, result }
  } catch (e) {
    const typed = /** @type {any} */(e).typed || classifyProviderError(e, envelope.auth?.key)
    return { ok: false, error: typed }
  }
}

/** @param {unknown} e */
function messageOf (e) {
  return e instanceof Error ? e.message : String(e)
}

/** @param {number} ms */
function defaultSleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
