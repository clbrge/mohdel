/**
 * Provider-level configuration reader.
 *
 * Per-provider rate limits live in `~/.config/mohdel/providers.json`
 * as `{ <provider>: { rpmLimit, tpmLimit } }`. These are
 * per-account values (different plans get different limits), so
 * they live in user config — not source code.
 *
 * Sessions load once and cache in-process.
 *
 * @module session/adapters/_providers
 */

import envPaths from 'env-paths'

import { createLazyJsonFileCache } from './_lazy_json_cache.js'

/**
 * @typedef {object} ProviderLimits
 * @property {number} [rpmLimit]
 * @property {number} [tpmLimit]
 */

const cache = createLazyJsonFileCache(
  // `{ suffix: null }` — see `_catalog.js` for the rationale (stay
  // in lockstep with the CLI's `CONFIG_DIR`, avoid the `-nodejs`
  // suffix env-paths appends by default).
  () => `${envPaths('mohdel', { suffix: null }).config}/providers.json`
)

/**
 * @param {string} path
 * @returns {Record<string, ProviderLimits>}
 */
export function loadProviders (path) {
  return cache.loadSync(path)
}

/**
 * Eager async initialization from the default providers path. Called
 * from `bin.js::main` before `drive()` so `getProviderLimits` doesn't
 * stall the event loop on a sync read mid-call. Idempotent; respects
 * a prior `setProviders` (tests).
 */
export async function initProvidersFromDefault () {
  await cache.initAsync()
}

/** @param {Record<string, ProviderLimits>} table */
export function setProviders (table) {
  cache.set(table)
}

/**
 * @param {string} provider
 * @returns {ProviderLimits | undefined}
 */
export function getProviderLimits (provider) {
  return cache.get(provider)
}
