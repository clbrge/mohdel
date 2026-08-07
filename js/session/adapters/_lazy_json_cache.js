/**
 * Shared lazy-load-once JSON cache for config files under
 * `~/.config/mohdel/`. `_catalog.js` and `_providers.js` both had
 * byte-similar implementations; this helper owns the pattern.
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
 * A missing file resolves to the supplied `defaultValue` (default
 * `{}`) so callers never have to handle file-absence explicitly. A
 * file that exists but does not parse throws: absent config is a
 * runtime state, corrupt config is a bug, and collapsing the two
 * turns a typo in `curated.json` into `Unknown model` on every call
 * with nothing naming the real cause.
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

  /** @param {string} file */
  function parseOrThrow (text, file) {
    try {
      return normalize(JSON.parse(text))
    } catch (e) {
      throw new Error(`[mohdel] ${file} is not valid JSON: ${e.message}`, { cause: e })
    }
  }

  /** @param {string} [p] */
  function loadSync (p) {
    const file = p ?? pathFn()
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') return defaultValue
      throw e
    }
    return parseOrThrow(text, file)
  }

  async function initAsync () {
    if (active !== null) return
    const file = pathFn()
    let text
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') {
        active = defaultValue
        return
      }
      throw e
    }
    active = parseOrThrow(text, file)
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
