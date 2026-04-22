/**
 * Shared lazy-load-once JSON cache for config files under
 * `~/.config/mohdel/`. `_catalog.js` and `_providers.js` both had
 * byte-similar implementations before F62; this helper owns the
 * pattern.
 *
 * Contract:
 *   - `loadSync(path?)` — synchronous read; used as the lazy
 *     fallback inside `get()` and by tests that want to parse an
 *     arbitrary file without touching the shared cache.
 *   - `initAsync()` — idempotent eager init from the default path.
 *     Called from `bin.js::main` before `drive()` so the first
 *     `get()` doesn't stall the event loop on a sync read.
 *   - `set(table)` — replace the in-memory table (tests + extension
 *     hook for deployments that source config from elsewhere).
 *   - `get(key)` — read-through; loads synchronously on first miss.
 *
 * A malformed / missing / non-object file resolves to the supplied
 * `defaultValue` (default `{}`) so callers never have to handle
 * file-absence explicitly.
 *
 * @module session/adapters/_lazy_json_cache
 */

import fs from 'node:fs'

/**
 * @template V
 * @param {() => string} pathFn  Resolves the default file path.
 * @param {{defaultValue?: V}} [opts]
 */
export function createLazyJsonFileCache (pathFn, { defaultValue = /** @type {any} */({}) } = {}) {
  /** @type {V | null} */
  let active = null

  /** @param {unknown} parsed */
  function normalize (parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return defaultValue
    }
    return /** @type {V} */(parsed)
  }

  /** @param {string} [p] */
  function loadSync (p) {
    const file = p ?? pathFn()
    try {
      return normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch {
      return defaultValue
    }
  }

  async function initAsync () {
    if (active !== null) return
    try {
      const text = await fs.promises.readFile(pathFn(), 'utf8')
      active = normalize(JSON.parse(text))
    } catch {
      active = defaultValue
    }
  }

  /** @param {V} table */
  function set (table) {
    active = /** @type {V} */({ ...table })
  }

  /** @param {string} key */
  function get (key) {
    if (active === null) active = loadSync()
    return active[key]
  }

  return { loadSync, initAsync, set, get }
}
