/**
 * OpenAI DALL-E image adapter.
 *
 * Single-shot generation — no streaming. Returns an `ImageResult`.
 *
 * @module session/adapters/image/openai
 */

import OpenAI from 'openai'

import { getSpec } from '../_catalog.js'
import { classifyProviderError } from '../_errors.js'

/**
 * @param {import('#core/image.js').ImageEnvelope} envelope
 * @param {{client?: OpenAI, spec?: any}} [deps]
 * @returns {Promise<import('#core/image.js').ImageResult>}
 */
export async function openaiImage (envelope, deps = {}) {
  const client = deps.client ?? new OpenAI({ apiKey: envelope.auth.key })
  const spec = deps.spec ?? getSpec(`${envelope.provider}/${envelope.model}`) ?? {}
  const start = String(process.hrtime.bigint())

  const args = { model: envelope.model, prompt: envelope.prompt }
  const size = envelope.size || spec.imageDefaultSize
  if (size) args.size = size

  let response
  try {
    response = await client.images.generate(args)
  } catch (e) {
    throw Object.assign(new Error(classifyProviderError(e).message), {
      typed: classifyProviderError(e)
    })
  }

  const images = (response.data || []).map(img => ({
    mimeType: 'image/png',
    url: img.url || undefined,
    base64: img.b64_json || undefined
  }))

  const end = String(process.hrtime.bigint())
  return {
    status: 'completed',
    images,
    seed: null,
    timestamps: { start, first: end, end }
  }
}
