/**
 * Image-generation envelope and result.
 *
 * Separate call path from `CallEnvelope` / `AnswerResult`: image
 * generation is a single synchronous request/response (no streaming).
 * Result shape: `{ status, images, seed, timestamps }`.
 *
 * @module core/image
 */

/**
 * @typedef {object} ImageEnvelope
 *
 * @property {string} callId
 * @property {string} authId
 * @property {import('./envelope.js').Auth} auth
 * @property {string} [traceparent]
 * @property {string} [baggage]
 *
 * @property {import('./model-id.js').ModelId} model
 *   Full mohdel id — `"<provider>/<bare>"`. Same shape as
 *   `CallEnvelope.model` (see `envelope.js`). No separate `provider`
 *   field.
 * @property {string} prompt
 *
 * @property {string} [size]       e.g. "1024x1024". Provider-specific.
 * @property {number} [seed]       Deterministic generation seed (provider support varies).
 */

/**
 * @typedef {object} ImageData
 * @property {string} mimeType
 * @property {string} [url]        Remote URL (transient — providers may expire).
 * @property {string} [base64]     Inline base64-encoded image bytes.
 */

/**
 * @typedef {object} ImageResult
 *
 * @property {'completed'} status
 *   Images are one-shot — no `incomplete` state.
 * @property {ImageData[]} images
 * @property {number | null} seed
 *   Echo of provider seed when available; null otherwise.
 * @property {{start: string, first: string, end: string}} timestamps
 *   hrtime-bigint-as-string. `first` = `end` for image (no streaming).
 */

export const IMAGE_ENVELOPE_FIELDS = Object.freeze([
  'callId',
  'authId',
  'auth',
  'traceparent',
  'baggage',
  'model',
  'prompt',
  'size',
  'seed'
])
