/**
 * Gemini embedding adapter.
 *
 * Shares nothing with the OpenAI shape: a different endpoint per batch size
 * (`:embedContent` for one input, `:batchEmbedContents` for several), vectors
 * under `embedding.values`, and tokens under
 * `usageMetadata.promptTokenCount`. The dimension parameter is
 * `outputDimensionality` and lives inside a config object rather than at the
 * top level.
 *
 * @module session/adapters/embedding/gemini
 */

import { getSpec } from '../_catalog.js'
import { classifyProviderError, fromHttpStatus, typedError } from '../_errors.js'
import { computeEmbeddingCost } from '../_pricing.js'
import { catalogKey, bareOf } from '#core/model-id.js'
import { checkBatch, checkDimensions, resolveInputType, widthOf } from './_shared.js'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export async function geminiEmbedding (envelope, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch
  const spec = deps.spec ?? getSpec(catalogKey(envelope.model)) ?? {}
  const start = String(process.hrtime.bigint())

  checkBatch(envelope, spec)
  const dimensions = checkDimensions(envelope, spec)
  const taskType = resolveInputType(envelope, spec)

  const model = spec.model ?? bareOf(envelope.model)
  const name = model.startsWith('models/') ? model : `models/${model}`
  const batched = envelope.input.length > 1

  const one = (text) => ({
    model: name,
    content: { parts: [{ text }] },
    ...(taskType ? { taskType } : {}),
    ...(dimensions !== undefined ? { outputDimensionality: dimensions } : {})
  })
  const body = batched
    ? { requests: envelope.input.map(one) }
    : one(envelope.input[0])

  const method = batched ? 'batchEmbedContents' : 'embedContent'
  let res
  try {
    res = await fetchFn(`${BASE_URL}/${name}:${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': envelope.auth.key
      },
      body: JSON.stringify(body)
    })
  } catch (e) {
    throw typedError(classifyProviderError(e, envelope.auth?.key).message, 'NET_ERROR', true)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw fromHttpStatus(res.status, detail, envelope.auth?.key)
  }

  const payload = await res.json()
  const vectors = batched
    ? (payload?.embeddings ?? []).map(e => e?.values)
    : [payload?.embedding?.values]

  if (vectors.length !== envelope.input.length || vectors.some(v => !Array.isArray(v))) {
    throw typedError(
      `expected ${envelope.input.length} vectors, got ${vectors.length}`,
      'EMBED_RESULT_MISMATCH',
      false
    )
  }

  // Only the single-content endpoint reports usage; the batch one does not,
  // so a batched call prices at 0 rather than on a guessed token count.
  const inputTokens = payload?.usageMetadata?.promptTokenCount ?? 0
  const end = String(process.hrtime.bigint())

  return {
    status: 'completed',
    vectors,
    dimensions: widthOf(vectors),
    inputType: taskType,
    inputTokens,
    cost: computeEmbeddingCost(spec, { inputTokens }),
    timestamps: { start, first: end, end }
  }
}
