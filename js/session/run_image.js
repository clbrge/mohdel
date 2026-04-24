/**
 * Dispatch an ImageEnvelope to the matching image adapter.
 *
 * Image generation is a single request/response — no streaming — so
 * this returns a Promise of `ImageResult` rather than an event
 * generator. On adapter failure, the resolved error is a `TypedError`
 * (structured, serializable) rather than a thrown JS `Error`.
 *
 * The image path skips rate-limit and cooldown — images are
 * low-frequency one-shots that don't justify the per-call tracking
 * overhead. Wire it here if that assumption ever changes.
 *
 * @module session/run_image
 */

import { getImageAdapter } from './adapters/image/index.js'
import { classifyProviderError } from './adapters/_errors.js'
import { providerOf } from '#core/model-id.js'

/**
 * @param {import('#core/image.js').ImageEnvelope} envelope
 * @param {{
 *   resolveAdapter?: (provider: string) => (
 *     env: import('#core/image.js').ImageEnvelope,
 *     deps?: any
 *   ) => Promise<import('#core/image.js').ImageResult>,
 *   spec?: any
 * }} [options]
 * @returns {Promise<
 *   | {ok: true, result: import('#core/image.js').ImageResult}
 *   | {ok: false, error: import('#core/errors.js').TypedError}
 * >}
 */
export async function runImage (envelope, { resolveAdapter = getImageAdapter, spec } = {}) {
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
    const typed = /** @type {any} */(e).typed || classifyProviderError(e)
    return { ok: false, error: typed }
  }
}

/** @param {unknown} e */
function messageOf (e) {
  return e instanceof Error ? e.message : String(e)
}
