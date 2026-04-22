/**
 * Image-adapter registry. Mirrors session/adapters/index.js but
 * scoped to image-generation providers.
 *
 * @module session/adapters/image
 */

import { openaiImage } from './openai.js'
import { novitaImage } from './novita.js'
import { fakeImage } from './fake.js'

const IMAGE_ADAPTERS = {
  openai: openaiImage,
  novita: novitaImage,
  fake: fakeImage
}

/**
 * @param {string} provider
 * @returns {(
 *   env: import('#core/image.js').ImageEnvelope,
 *   deps?: any
 * ) => Promise<import('#core/image.js').ImageResult>}
 */
export function getImageAdapter (provider) {
  const adapter = IMAGE_ADAPTERS[provider]
  if (!adapter) throw new Error(`no image adapter for provider: ${provider}`)
  return adapter
}

/**
 * Whether the provider has an image adapter registered. Used by
 * `run.js` to distinguish "wrong call path" (image-only provider
 * invoked via answer) from "truly unknown provider".
 *
 * @param {string} provider
 */
export function isImageProvider (provider) {
  return Object.prototype.hasOwnProperty.call(IMAGE_ADAPTERS, provider)
}
