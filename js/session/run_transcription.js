/**
 * Dispatch a TranscriptionEnvelope to the matching transcription
 * adapter.
 *
 * Transcription is a single request/response — no streaming — so
 * this returns a Promise of `TranscriptionResult` rather than an
 * event generator. On adapter failure, the resolved error is a
 * `TypedError` (structured, serializable) rather than a thrown JS
 * `Error`.
 *
 * Like the image path, transcription skips rate-limit and cooldown —
 * low-frequency one-shots that don't justify the per-call tracking
 * overhead.
 *
 * @module session/run_transcription
 */

import { getTranscriptionAdapter } from './adapters/transcription/index.js'
import { classifyProviderError } from './adapters/_errors.js'
import { providerOf } from '#core/model-id.js'

/**
 * @param {import('#core/transcription.js').TranscriptionEnvelope} envelope
 * @param {{
 *   resolveAdapter?: (provider: string) => (
 *     env: import('#core/transcription.js').TranscriptionEnvelope,
 *     deps?: any
 *   ) => Promise<import('#core/transcription.js').TranscriptionResult>,
 *   spec?: any
 * }} [options]
 * @returns {Promise<
 *   | {ok: true, result: import('#core/transcription.js').TranscriptionResult}
 *   | {ok: false, error: import('#core/errors.js').TypedError}
 * >}
 */
export async function runTranscription (envelope, { resolveAdapter = getTranscriptionAdapter, spec } = {}) {
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
