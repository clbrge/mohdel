/**
 * Embedding envelope and result.
 *
 * Separate call path from `CallEnvelope` / `AnswerResult`: embeddings are a
 * single synchronous request/response, nothing is generated, and one call
 * carries N inputs and returns N vectors in request order.
 * Result shape: `{ status, vectors, dimensions, inputTokens, cost, timestamps }`.
 *
 * @module core/embedding
 */

/**
 * @typedef {object} EmbedEnvelope
 *
 * @property {string} callId
 * @property {string} authId
 * @property {import('./envelope.js').Auth} auth
 * @property {string} [traceparent]
 * @property {string} [baggage]
 *
 * @property {string} model
 *   Full mohdel id — `"<provider>/<bare>"`. Same shape as
 *   `CallEnvelope.model` (see `envelope.js`).
 * @property {string[]} input
 *   Texts to embed. Always an array, even for one. A batch larger than the
 *   entry's `maxBatch` fails before dispatch rather than being split:
 *   splitting would change both cost attribution and result ordering.
 *
 * @property {number} [dimensions]
 *   Requested output width. Providers spell this three ways
 *   (`dimensions`, `output_dimension`, `outputDimensionality`) and support it
 *   on some models only; an entry without `dimensionsSelectable` rejects the
 *   field rather than sending it to be ignored.
 * @property {string} [inputType]
 *   Symbolic role of the text: `query`, `document`, `classification`,
 *   `clustering`. Asymmetric models embed the same string differently
 *   depending on it, so a query and its matching passage land close together.
 *   The entry's `inputTypes` maps it to the provider's own vocabulary.
 */

/**
 * @typedef {object} EmbedResult
 *
 * @property {'completed'} status
 *   Embeddings are one-shot — no `incomplete` state.
 * @property {number[][]} vectors
 *   One per input, in request order.
 * @property {number} dimensions
 *   Width of the returned vectors, which is what the provider actually
 *   produced rather than what was asked for.
 * @property {string | null} inputType
 *   The provider-native value that was sent, or null when none was. The role
 *   is baked into the vector, so a caller storing these must record it and
 *   query the same namespace the same way.
 * @property {number} inputTokens
 * @property {number} cost
 *   USD. `embeddingPrice` (per million input tokens) × `inputTokens`; 0 when
 *   the spec carries no price.
 * @property {{start: string, first: string, end: string}} timestamps
 *   hrtime-bigint-as-string. `first` = `end` (no streaming).
 */

export const EMBED_ENVELOPE_FIELDS = Object.freeze([
  'callId',
  'authId',
  'auth',
  'traceparent',
  'baggage',
  'model',
  'input',
  'dimensions',
  'inputType'
])

/** Symbolic roles a caller may pass; the entry maps them to provider values. */
export const INPUT_TYPES = Object.freeze(['query', 'document', 'classification', 'clustering'])
