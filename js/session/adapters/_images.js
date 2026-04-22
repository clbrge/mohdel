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
 * @module session/adapters/_images
 */

import { readFile } from 'node:fs/promises'

/**
 * @typedef {object} LoadedImage
 * @property {string} mimeType
 * @property {string} [base64]   Raw base64 (no `data:` prefix)
 * @property {string} [url]      Remote URL (only when source was https://)
 */

/**
 * @param {Array<{fileUri: string, mimeType: string}>} images
 * @returns {Promise<LoadedImage[]>}
 */
export async function loadImages (images) {
  if (!images || !Array.isArray(images)) return []
  const out = []
  for (const img of images) {
    if (!img?.fileUri || !img?.mimeType) continue
    out.push(await loadImage(img))
  }
  return out
}

/**
 * @param {{fileUri: string, mimeType: string}} image
 * @returns {Promise<LoadedImage>}
 */
export async function loadImage (image) {
  const { fileUri, mimeType } = image
  if (fileUri.startsWith('file://')) {
    const path = fileUri.replace(/^file:\/\//, '')
    const buf = await readFile(path)
    return { mimeType, base64: buf.toString('base64') }
  }
  if (fileUri.startsWith('data:')) {
    const parts = fileUri.split(',')
    if (parts.length > 1) return { mimeType, base64: parts[1] }
    throw new Error(`malformed data URI: ${fileUri.slice(0, 32)}…`)
  }
  if (fileUri.startsWith('https://') || fileUri.startsWith('http://')) {
    return { mimeType, url: fileUri }
  }
  throw new Error(`unsupported image URI scheme: ${fileUri.slice(0, 32)}…`)
}
