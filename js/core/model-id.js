/**
 * Model-id helpers.
 *
 * A mohdel model id is a single string of shape
 * `"<provider>/<bare>[:<effort>][@<speed>]"` — same on the wire and
 * in-process. See PROTOCOL §3. Nothing in mohdel ever holds the id in
 * a split object form; when a part is needed, these helpers return it
 * as a substring.
 *
 * Ids are validated at ingress by the gate
 * (`rust/thin-gate/src/protocol.rs::validate_ids`); these accessors
 * assume a well-formed id and do not re-validate.
 *
 * @module core/model-id
 */

/**
 * Provider segment of a model id.
 * @param {string} model
 * @returns {string}
 */
export function providerOf (model) {
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(0, slash) : ''
}

/**
 * Bare id (everything after the provider slash), including any
 * `:effort` suffix. Callers that want effort stripped use
 * `catalogKey()` instead.
 *
 * @param {string} model
 * @returns {string}
 */
export function bareOf (model) {
  const slash = model.indexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

/**
 * The catalog key: `<provider>/<bare>` with any `:effort` suffix
 * removed. This is the key under which prices, thinking levels,
 * output limits etc. are stored — per-effort variants do not get
 * their own entry.
 *
 * @param {string} model
 * @returns {string}
 */
export function catalogKey (model) {
  const base = beforeSuffix(model, SPEED_SIGIL)
  return beforeSuffix(base, EFFORT_SIGIL)
}

/**
 * Effort suffix, without the `:`, or `undefined` if absent.
 *
 * @param {string} model
 * @returns {string | undefined}
 */
export function effortOf (model) {
  return afterSuffix(beforeSuffix(model, SPEED_SIGIL), EFFORT_SIGIL)
}

/**
 * Speed-lane suffix, without the `@`, or `undefined` if absent.
 *
 * @param {string} model
 * @returns {string | undefined}
 */
export function speedOf (model) {
  return afterSuffix(model, SPEED_SIGIL)
}

const EFFORT_SIGIL = ':'
const SPEED_SIGIL = '@'

/**
 * Index of `sigil` when it separates a suffix, or `-1`. A sigil only
 * separates when it falls after the provider slash, so a bare id that
 * itself contains one is left whole.
 *
 * @param {string} model
 * @param {string} sigil
 * @returns {number}
 */
function suffixIndex (model, sigil) {
  const slash = model.indexOf('/')
  if (slash < 0) return -1
  const at = model.lastIndexOf(sigil)
  return at > slash ? at : -1
}

/** @returns {string} */
function beforeSuffix (model, sigil) {
  const at = suffixIndex(model, sigil)
  return at < 0 ? model : model.slice(0, at)
}

/** @returns {string | undefined} */
function afterSuffix (model, sigil) {
  const at = suffixIndex(model, sigil)
  return at < 0 ? undefined : model.slice(at + 1)
}
