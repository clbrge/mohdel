/**
 * Curated catalog reader. Single source of truth for per-model
 * metadata used by adapters: pricing, thinking effort levels,
 * output token limits, etc. Lives in `~/.config/mohdel/curated.json`;
 * each entry keyed by `<provider>/<model>` carries the model spec.
 *
 * Adapters and `_pricing.js` both consume this — no parallel cache,
 * no parallel file read.
 *
 * @module session/adapters/_catalog
 */

import envPaths from 'env-paths'

import { catalogKey } from '#core/model-id.js'

import { createLazyJsonFileCache } from './_lazy_json_cache.js'
import { mergeSpeed } from './_speed.js'

// `{ suffix: null }` mirrors `src/lib/common.js::CONFIG_DIR` so the
// session subprocess reads the same `~/.config/mohdel/curated.json`
// the `mo` CLI writes. Without the override, env-paths appends
// `-nodejs` and the cache silently loads empty.
const cache = createLazyJsonFileCache(() => `${envPaths('mohdel', { suffix: null }).config}/curated.json`)

/**
 * @param {string} path
 * @returns {Record<string, any>}
 */
export function loadCatalog (path) {
  return cache.loadSync(path)
}

/**
 * Eager async initialization from the default curated path. Called from
 * `bin.js::main` before `drive()` so the first `getSpec` doesn't stall
 * the event loop on a sync read mid-call. Idempotent; respects a
 * prior `setCatalog` (tests).
 */
export async function initCatalogFromDefault () {
  await cache.initAsync()
}

/**
 * Replace the active catalog. Test injection point and the extension
 * seam for deployments that source spec from somewhere other than
 * curated.json.
 *
 * @param {Record<string, any>} table
 */
export function setCatalog (table) {
  cache.set(table)
}

/**
 * @param {string} model  Fully-qualified `<provider>/<model>` key.
 * @returns {any | undefined}
 */
export function getSpec (model) {
  return cache.get(model)
}

/**
 * Effective spec for a call: the catalog entry with any speed-lane
 * overlay applied. Adapters resolve spec through this rather than
 * `getSpec` so lane prices and quotas reach pricing and throttling
 * without each adapter merging for itself.
 *
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @returns {any | undefined}
 */
export function specFor (envelope) {
  return mergeSpeed(getSpec(catalogKey(envelope.model)), envelope.speed)
}
