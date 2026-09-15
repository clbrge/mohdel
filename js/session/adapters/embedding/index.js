/**
 * Embedding-adapter registry. Mirrors `session/adapters/transcription` but
 * scoped to providers with an embeddings endpoint.
 *
 * Five of mohdel's thirteen providers offer embeddings at all, and neither
 * meta-provider does. Of those that do, only the base URL and the name of the
 * dimension parameter differ across the OpenAI-shaped ones, so they share one
 * adapter; Gemini and Cohere need their own.
 *
 * @module session/adapters/embedding
 */

import { createEmbeddingAdapter } from './openai_compatible.js'
import { geminiEmbedding } from './gemini.js'
import { cohereEmbedding } from './cohere.js'

const EMBEDDING_ADAPTERS = {
  openai: createEmbeddingAdapter({ baseURL: 'https://api.openai.com/v1' }),
  // The endpoint is the catalog entry's `baseURL`, as it is for local chat.
  local: createEmbeddingAdapter(),
  gemini: geminiEmbedding,
  cohere: cohereEmbedding
}

/** Providers with an embeddings adapter, for capability checks. */
export const EMBEDDING_PROVIDERS = Object.freeze(Object.keys(EMBEDDING_ADAPTERS))

/**
 * @param {string} provider
 */
export function getEmbeddingAdapter (provider) {
  const adapter = EMBEDDING_ADAPTERS[provider]
  if (!adapter) throw new Error(`no embedding adapter for provider: ${provider}`)
  return adapter
}

export const embeddingAdapters = Object.freeze(EMBEDDING_ADAPTERS)
