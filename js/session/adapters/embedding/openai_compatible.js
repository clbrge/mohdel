/**
 * Shared embedding adapter for OpenAI-compatible `POST <baseURL>/embeddings`.
 *
 * Covers OpenAI and any self-hosted server that implements the endpoint
 * (Ollama, vLLM, llama.cpp), and is the same shape Mistral, Fireworks and
 * Qwen Cloud expose when they are added. Only the base URL and the name of the
 * dimension parameter differ, so both are bound per provider in `./index.js`.
 *
 * @module session/adapters/embedding/openai_compatible
 */

import { getSpec } from '../_catalog.js'
import { classifyProviderError, fromHttpStatus, typedError } from '../_errors.js'
import { computeEmbeddingCost } from '../_pricing.js'
import { catalogKey, bareOf } from '#core/model-id.js'
import { checkBatch, checkDimensions, resolveInputType, widthOf } from './_shared.js'

/**
 * @param {{baseURL?: string, dimensionsField?: string}} config
 */
export function createEmbeddingAdapter ({ baseURL, dimensionsField = 'dimensions' } = {}) {
  return async function embedding (envelope, deps = {}) {
    const fetchFn = deps.fetch ?? globalThis.fetch
    const spec = deps.spec ?? getSpec(catalogKey(envelope.model)) ?? {}
    const start = String(process.hrtime.bigint())

    checkBatch(envelope, spec)
    const dimensions = checkDimensions(envelope, spec)
    const inputType = resolveInputType(envelope, spec)

    // `local/` carries its endpoint on the entry; everything else is bound
    // to a base URL by the registry.
    const root = (spec.baseURL ?? baseURL ?? '').replace(/\/$/, '')
    if (!root) {
      throw typedError('no baseURL for this embedding model', 'CONFIGURATION_MISSING', false)
    }

    /** @type {Record<string, any>} */
    const body = { model: spec.model ?? bareOf(envelope.model), input: envelope.input }
    if (dimensions !== undefined) body[dimensionsField] = dimensions
    if (inputType) body.input_type = inputType

    let res
    try {
      res = await fetchFn(`${root}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(envelope.auth?.key ? { Authorization: `Bearer ${envelope.auth.key}` } : {})
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
    const rows = Array.isArray(payload?.data) ? payload.data : []
    // `index` is authoritative: the caller matches vectors to inputs by
    // position, and a provider is free to answer out of order.
    const vectors = rows
      .slice()
      .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
      .map(r => r?.embedding)

    if (vectors.length !== envelope.input.length || vectors.some(v => !Array.isArray(v))) {
      throw typedError(
        `expected ${envelope.input.length} vectors, got ${vectors.length}`,
        'EMBED_RESULT_MISMATCH',
        false
      )
    }

    const inputTokens = payload?.usage?.prompt_tokens ?? payload?.usage?.total_tokens ?? 0
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
}
