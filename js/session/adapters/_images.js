/**
 * Image URI loader.
 *
 * Three URI schemes are supported (see INTEGRATION.md §Vision):
 *   - `file://` → reads from local filesystem, base64-encodes
 *   - `https://` → passed as URL reference (where the provider accepts it)
 *   - `data:` → base64 data URI parsed inline
 *
 * Each adapter calls `loadImages(images)` to get a normalized
 * intermediate shape `{mimeType, base64?, url?}`, then formats per
 * provider. Errors are surfaced — file IO failures bubble up so the
 * adapter can emit a typed error rather than silently skipping.
 *
 * Local paths are resolved through `_media.js`, which owns symlink
 * resolution, the `MOHDEL_MEDIA_ROOTS` confinement check and the read
 * cap.
 *
 * @module session/adapters/_images
 */

import { dataUriPayload, mediaError, mediaScheme, readLocalMedia } from './_media.js'

const IMAGE_ERROR = 'SESSION_INVALID_IMAGE'

/**
 * @typedef {object} LoadedImage
 * @property {string} mimeType
 * @property {string} [base64]   Raw base64 (no `data:` prefix)
 * @property {string} [url]      Remote URL (only when source was https://)
 */

/**
 * @param {Array<{fileUri: string, mimeType: string}>} images
 * @param {{trusted?: boolean}} [opts]
 * @returns {Promise<LoadedImage[]>}
 */
export async function loadImages (images, opts = {}) {
  if (!images || !Array.isArray(images)) return []
  const out = []
  for (const img of images) {
    if (!img?.fileUri || !img?.mimeType) continue
    out.push(await loadImage(img, opts))
  }
  return out
}

/**
 * @param {{fileUri: string, mimeType: string}} image
 * @param {{trusted?: boolean}} [opts]
 * @returns {Promise<LoadedImage>}
 */
export async function loadImage (image, opts = {}) {
  const { fileUri, mimeType } = image
  switch (mediaScheme(fileUri)) {
    case 'file': {
      const { bytes } = await readLocalMedia(fileUri, { type: IMAGE_ERROR, trusted: opts.trusted })
      return { mimeType, base64: bytes.toString('base64') }
    }
    case 'data':
      return { mimeType, base64: dataUriPayload(fileUri, IMAGE_ERROR) }
    case 'remote':
      return { mimeType, url: fileUri }
    default:
      throw mediaError(
        `unsupported image URI scheme: ${fileUri.slice(0, 32)}…`,
        IMAGE_ERROR
      )
  }
}
