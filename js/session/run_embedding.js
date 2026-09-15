/**
 * Embedding runtime. Resolves the adapter for the envelope's provider and
 * returns either a result or a typed error, never throwing.
 *
 * Mirrors `run_transcription.js`: one synchronous request, no streaming, no
 * cancellation path beyond the caller's own signal.
 *
 * @module session/run_embedding
 */

import { getEmbeddingAdapter } from './adapters/embedding/index.js'
import { classifyProviderError } from './adapters/_errors.js'
import { providerOf } from '#core/model-id.js'

/**
 * @param {import('#core/embedding.js').EmbedEnvelope} envelope
 * @param {{resolveAdapter?: (provider: string) => any, spec?: any}} [options]
 * @returns {Promise<
 *   | {ok: true, result: import('#core/embedding.js').EmbedResult}
 *   | {ok: false, error: import('#core/errors.js').TypedError}
 * >}
 */
export async function runEmbedding (envelope, { resolveAdapter = getEmbeddingAdapter, spec } = {}) {
  let adapter
  try {
    adapter = resolveAdapter(providerOf(envelope.model))
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

  try {
    const result = await adapter(envelope, spec ? { spec } : {})
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
