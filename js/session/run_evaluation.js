/**
 * Evaluation runtime. Resolves the adapter for the envelope's provider and
 * returns either a result or a typed error, never throwing. Rate limits as in
 * `run_embedding.js`, minus the input count.
 *
 * @module session/run_evaluation
 */

import { getEvaluationAdapter } from './adapters/evaluation/index.js'
import { classifyProviderError } from './adapters/_errors.js'
import { getProviderLimits } from './adapters/_providers.js'
import * as defaultLimiter from './_rate_limiter.js'
import { providerOf } from '#core/model-id.js'

/**
 * @param {import('#core/evaluation.js').EvaluateEnvelope} envelope
 * @param {{
 *   resolveAdapter?: (provider: string) => any,
 *   resolveProviderLimits?: (provider: string) => any,
 *   limiter?: any,
 *   sleep?: (ms: number) => Promise<void>,
 *   modelKey?: string,
 *   spec?: any
 * }} [options]
 * @returns {Promise<
 *   | {ok: true, result: import('#core/evaluation.js').EvaluateResult}
 *   | {ok: false, error: import('#core/errors.js').TypedError}
 * >}
 */
export async function runEvaluation (envelope, {
  resolveAdapter = getEvaluationAdapter,
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
  const bucketKey = spec?.rateLimitScope === 'model' ? modelKey : provider

  if (rpmLimit != null || tpmLimit != null) {
    const delay = limiter.check(bucketKey, { rpmLimit, tpmLimit })
    if (delay > 0) await sleep(delay)
    limiter.recordRequest(bucketKey)
  }

  try {
    const result = await adapter(envelope, spec ? { spec } : {})
    if (tpmLimit != null) limiter.recordTokens(bucketKey, result.inputTokens + result.outputTokens)
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
