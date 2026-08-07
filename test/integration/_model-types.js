/**
 * Catalog `type` taxonomy for the integration suites.
 *
 * `type` is open-ended — entries are untyped, `model`, `image` or
 * `transcription` — and the suites default to treating anything they
 * do not recognise as a chat model. A non-chat type missing from this
 * list therefore gets driven through `answer()` and rejected by the
 * provider, so the rule lives in one place rather than once per suite.
 *
 * Non-chat endpoints have dedicated coverage: image generation in
 * `provider.test.js`'s `image()` smoke, transcription in
 * `test/live/transcription.live.test.js`.
 *
 * @module test/integration/_model-types
 */

export const IMAGE_TYPES = new Set(['image'])

export const NON_TEXT_TYPES = new Set(['image', 'transcription'])

/** @param {{type?: string}} meta */
export const isTextModel = (meta) => !NON_TEXT_TYPES.has(meta?.type)

/** @param {{type?: string}} meta */
export const isImageModel = (meta) => IMAGE_TYPES.has(meta?.type)
