import { describe, test, expect, vi, afterEach } from 'vitest'
import { runEmbedding } from '../../js/session/run_embedding.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const envelope = (model, input, extra = {}) => ({
  callId: 'c1', authId: 'a1', auth: { key: 'sk-x' }, model, input, ...extra
})
const answering = (json) => {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
    return { ok: true, status: 200, json: async () => json }
  })
  return calls
}

describe('openai-shaped embeddings', () => {
  const payload = {
    data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }],
    usage: { prompt_tokens: 1_000_000 }
  }

  test('returns one vector per input, ordered by the provider index', async () => {
    answering(payload)
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a', 'b']), {
      spec: { embeddingPrice: 0.02 }
    })
    expect(r.ok).toBe(true)
    expect(r.result.vectors).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(r.result.dimensions).toBe(2)
    expect(r.result.status).toBe('completed')
  })

  test('prices from embeddingPrice per million input tokens', async () => {
    answering(payload)
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a', 'b']), {
      spec: { embeddingPrice: 0.02 }
    })
    expect(r.result.inputTokens).toBe(1_000_000)
    expect(r.result.cost).toBe(0.02)
  })

  test('an entry with no price yields cost 0 rather than a guess', async () => {
    answering(payload)
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a', 'b']), { spec: {} })
    expect(r.result.cost).toBe(0)
  })

  // A provider answering with the wrong count would otherwise misalign every
  // vector against its input, silently.
  test('a short answer is an error, not a truncated result', async () => {
    answering({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 2 } })
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a', 'b']), { spec: {} })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_RESULT_MISMATCH')
  })
})

describe('pre-dispatch checks', () => {
  test('a batch over maxBatch fails before any request is sent', async () => {
    const calls = answering({})
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a', 'b', 'c']), {
      spec: { maxBatch: 2 }
    })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_BATCH_TOO_LARGE')
    expect(r.error.message).toContain('batch limit of 2')
    expect(calls).toHaveLength(0)
  })

  test('dimensions on a model that cannot vary them is an error, not a dropped field', async () => {
    const calls = answering({})
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a'], { dimensions: 256 }), {
      spec: { dimensionsSelectable: false }
    })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_DIMENSIONS_UNSUPPORTED')
    expect(calls).toHaveLength(0)
  })

  test('an empty batch is rejected', async () => {
    answering({})
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', []), { spec: {} })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_INPUT_EMPTY')
  })
})

describe('inputType, which is baked into the vector', () => {
  test('maps the symbolic role to the provider vocabulary and reports it back', async () => {
    const calls = answering({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 3 } })
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a'], { inputType: 'query' }), {
      spec: { inputTypes: { query: 'search_query', document: 'search_document' } }
    })
    expect(calls[0].body.input_type).toBe('search_query')
    expect(r.result.inputType).toBe('search_query')
  })

  test('an undeclared role is an error rather than a silent drop', async () => {
    const calls = answering({})
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a'], { inputType: 'query' }), {
      spec: { inputTypes: { document: 'search_document' } }
    })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_INPUT_TYPE_UNKNOWN')
    expect(calls).toHaveLength(0)
  })

  test('a model declaring none rejects the field', async () => {
    const r = await runEmbedding(envelope('openai/text-embedding-3-small', ['a'], { inputType: 'query' }), {
      spec: {}
    })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_INPUT_TYPE_UNSUPPORTED')
  })

  test('defaultInputType applies when the caller names none', async () => {
    const calls = answering({ data: [{ index: 0, embedding: [1] }], usage: {} })
    await runEmbedding(envelope('openai/text-embedding-3-small', ['a']), {
      spec: { inputTypes: { document: 'search_document' }, defaultInputType: 'document' }
    })
    expect(calls[0].body.input_type).toBe('search_document')
  })
})

// A query embedding is a handful of tokens. At $0.02 per million that is 8e-8,
// which six-decimal rounding reported as $0 — so a million of them summed to
// nothing.
describe('cost survives small calls', () => {
  test('a four-token embedding at $0.02/M is not rounded to zero', async () => {
    const { computeEmbeddingCost } = await import('../../js/session/adapters/_pricing.js')
    const cost = computeEmbeddingCost({ embeddingPrice: 0.02 }, { inputTokens: 4 })
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeCloseTo(0.00000008, 12)
  })

  test('a million such calls sum to their real cost', async () => {
    const { computeEmbeddingCost } = await import('../../js/session/adapters/_pricing.js')
    const one = computeEmbeddingCost({ embeddingPrice: 0.02 }, { inputTokens: 8 })
    expect(one * 1_000_000).toBeCloseTo(0.16, 6)
  })
})
