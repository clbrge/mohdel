/**
 * Transcription (voice → text) envelope and result.
 *
 * Separate call path from `CallEnvelope` / `AnswerResult`: transcription
 * is a single synchronous request/response (no streaming) against a
 * provider's `/audio/transcriptions` endpoint.
 * Result shape: `{ status, text, language, durationSeconds, cost, timestamps }`.
 *
 * @module core/transcription
 */

/**
 * @typedef {object} AudioRef
 * @property {string} fileUri
 *   `file://` or `data:` URI. Remote `https://` audio is not
 *   supported — providers require multipart upload, so the caller
 *   owns the download.
 * @property {string} mimeType  e.g. "audio/mpeg", "audio/wav".
 */

/**
 * @typedef {object} TranscriptionEnvelope
 *
 * @property {string} callId
 * @property {string} authId
 * @property {import('./envelope.js').Auth} auth
 * @property {string} [traceparent]
 * @property {string} [baggage]
 *
 * @property {import('./model-id.js').ModelId} model
 *   Full mohdel id — `"<provider>/<bare>"`. Same shape as
 *   `CallEnvelope.model` (see `envelope.js`).
 * @property {AudioRef} audio
 *
 * @property {string} [language]  ISO-639-1 hint (e.g. "en", "fr").
 * @property {string} [prompt]    Spelling/context hint forwarded to the provider.
 */

/**
 * @typedef {object} TranscriptionResult
 *
 * @property {'completed'} status
 *   Transcriptions are one-shot — no `incomplete` state.
 * @property {string} text
 * @property {string | null} language
 *   Detected (or echoed) language when the provider reports one.
 * @property {number | null} durationSeconds
 *   Audio duration as reported by the provider; null when not reported.
 * @property {number} [inputTokens]
 *   Present only for token-billed providers (OpenAI gpt-4o-*-transcribe).
 * @property {number} [outputTokens]
 * @property {number} cost
 *   USD. `transcriptionPrice` (per audio minute) × duration when the
 *   provider reports duration; token pricing fallback otherwise; 0 when
 *   the spec carries no usable price.
 * @property {{start: string, first: string, end: string}} timestamps
 *   hrtime-bigint-as-string. `first` = `end` (no streaming).
 */

export const TRANSCRIPTION_ENVELOPE_FIELDS = Object.freeze([
  'callId',
  'authId',
  'auth',
  'traceparent',
  'baggage',
  'model',
  'audio',
  'language',
  'prompt'
])
