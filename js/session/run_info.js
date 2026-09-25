/**
 * Catalog entry lookup for a model id, answered by the session that
 * holds the catalog. An embedder of the gate supplies or loads the
 * catalog but never reads it back; this is how it asks.
 *
 * The answer is the entry a call with that `model` would run on: the
 * same lookup and the same effort and speed-lane checks as `run.js`,
 * so an id this accepts is one a call accepts. Shape follows the
 * facade's `info()`: the entry, plus `speed` when a lane is named.
 *
 * @module session/run_info
 */

import { getSpec } from './adapters/_catalog.js'
import { providerOf } from '#core/model-id.js'
import { loadAdapter, normalizeModelId, speedError } from './run.js'

/**
 * @param {{model: string}} request
 * @param {{
 *   resolveSpec?: (key: string) => any,
 *   resolveAdapter?: (provider: string) => Promise<any>
 * }} [options]
 * @returns {Promise<
 *   | {ok: true, result: Record<string, any> | null}
 *   | {ok: false, error: import('#core/errors.js').TypedError}
 * >}
 */
export async function runInfo ({ model }, {
  resolveSpec = getSpec,
  resolveAdapter = loadAdapter
} = {}) {
  const norm = normalizeModelId(/** @type {any} */({ model }), resolveSpec)
  if (norm.error) return { ok: false, error: norm.error.error }
  if (!norm.spec) return { ok: true, result: null }

  const speed = norm.envelope.speed
  if (!speed) return { ok: true, result: { ...norm.spec } }

  const provider = providerOf(norm.key)
  let adapter
  try {
    adapter = await resolveAdapter(provider)
  } catch (e) {
    return {
      ok: false,
      error: {
        message: e instanceof Error ? e.message : String(e),
        severity: 'error',
        retryable: false,
        type: 'SESSION_UNKNOWN_PROVIDER'
      }
    }
  }
  const denied = speedError(norm.key, speed, norm.spec, provider, adapter)
  if (denied) return { ok: false, error: denied.error }
  return { ok: true, result: { ...norm.spec, speed } }
}
