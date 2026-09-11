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

import { IMAGE_ADAPTER_NAMES } from './adapters/_registry.js'
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
// Loaded per provider rather than as a registry: the image adapters pull the
// OpenAI SDK, which a text-only caller never needs. Checked against the known
// list first — the name comes off the envelope.
const loadImageAdapter = async (provider) => {
  if (!IMAGE_ADAPTER_NAMES.includes(provider)) throw new Error(`no image adapter for provider: ${provider}`)
  const module = await import(`./adapters/image/${provider}.js`)
  return module[`${provider}Image`]
}

export async function runImage (envelope, { resolveAdapter = loadImageAdapter, spec } = {}) {
  let adapter
  try {
    adapter = await resolveAdapter(providerOf(envelope.model))
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
