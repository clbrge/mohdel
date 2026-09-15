/**
 * Cohere embedding adapter.
 *
 * The most divergent shape mohdel talks to: `POST /v2/embed` rather than
 * `/embeddings`, inputs under `texts`, `input_type` **required**, and
 * `embeddings` returned as an object keyed by dtype
 * (`{ float: [[...]] }`) instead of a `data[]` array. Tokens live at
 * `meta.billed_units.input_tokens`.
 *
 * @module session/adapters/embedding/cohere
 */

import { getSpec } from '../_catalog.js'
import { classifyProviderError, fromHttpStatus, typedError } from '../_errors.js'
import { computeEmbeddingCost } from '../_pricing.js'
import { catalogKey, bareOf } from '#core/model-id.js'
import { checkBatch, checkDimensions, resolveInputType, widthOf } from './_shared.js'

const BASE_URL = 'https://api.cohere.com/v2'

export async function cohereEmbedding (envelope, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch
  const spec = deps.spec ?? getSpec(catalogKey(envelope.model)) ?? {}
  const start = String(process.hrtime.bigint())

  checkBatch(envelope, spec)
  const dimensions = checkDimensions(envelope, spec)
  const inputType = resolveInputType(envelope, spec)

  // Cohere rejects a call without it, so an entry that declares no mapping is
  // unusable rather than merely less accurate.
  if (!inputType) {
    throw typedError(
      'cohere requires an input_type; set inputType or the entry\'s defaultInputType',
      'EMBED_INPUT_TYPE_REQUIRED',
      false
    )
  }

  const body = {
    model: spec.model ?? bareOf(envelope.model),
    texts: envelope.input,
    input_type: inputType,
    embedding_types: ['float'],
    ...(dimensions !== undefined ? { output_dimension: dimensions } : {})
  }

  let res
  try {
    res = await fetchFn(`${BASE_URL}/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${envelope.auth.key}`
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
  const vectors = payload?.embeddings?.float ?? []

  if (vectors.length !== envelope.input.length || vectors.some(v => !Array.isArray(v))) {
    throw typedError(
      `expected ${envelope.input.length} vectors, got ${vectors.length}`,
      'EMBED_RESULT_MISMATCH',
      false
    )
  }

  const inputTokens = payload?.meta?.billed_units?.input_tokens ??
    payload?.meta?.tokens?.input_tokens ?? 0
  const end = String(process.hrtime.bigint())

  return {
    status: 'completed',
    vectors,
    dimensions: widthOf(vectors),
    inputType,
    inputTokens,
    cost: computeEmbeddingCost(spec, { inputTokens }),
    timestamps: { start, first: end, end }
  }
}
