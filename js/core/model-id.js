/**
 * Model-id helpers.
 *
 * A mohdel model id is a single string of shape
 * `"<provider>/<bare>[:<effort>]"` — same on the wire and in-process.
 * See PROTOCOL §3. Nothing in mohdel ever holds the id in a split
 * object form; when the provider or bare part is needed, these
 * helpers return it as a substring.
 *
 * `parseModelId` validates + brands at the boundary (factory input,
 * wire deserialize, admin endpoints). After that every `ModelId` in
 * memory is known-valid; adapters and core code call the accessors
 * freely without re-validating.
 *
 * @module core/model-id
 */

/**
 * Branded string type. Only `parseModelId` produces one.
 * @typedef {string & { __brand: 'ModelId' }} ModelId
 */

const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*(?::[a-z]+)?$/i

/**
 * Validate and brand a raw string. Throws on malformed input so the
 * boundary layer fails loudly instead of letting a bad id flow
 * through.
 *
 * @param {string} raw
 * @returns {ModelId}
 */
export function parseModelId (raw) {
  if (typeof raw !== 'string' || !MODEL_ID_RE.test(raw)) {
    throw new TypeError(`invalid model id: ${JSON.stringify(raw)} (expected "<provider>/<bare>[:<effort>]")`)
  }
  return /** @type {ModelId} */ (raw)
}

/**
 * Provider segment of a model id.
 * @param {ModelId | string} model
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
 * @param {ModelId | string} model
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
 * @param {ModelId | string} model
 * @returns {string}
 */
export function catalogKey (model) {
  const colon = model.lastIndexOf(':')
  const slash = model.indexOf('/')
  // Only treat `:` as an effort separator when it appears after the
  // provider slash (otherwise a model id without `/` that happens to
  // contain `:` would get the wrong thing stripped).
  return colon > slash ? model.slice(0, colon) : model
}

/**
 * Effort suffix, without the `:`, or `undefined` if absent.
 *
 * @param {ModelId | string} model
 * @returns {string | undefined}
 */
export function effortOf (model) {
  const colon = model.lastIndexOf(':')
  const slash = model.indexOf('/')
  if (colon <= slash) return undefined
  return model.slice(colon + 1)
}
