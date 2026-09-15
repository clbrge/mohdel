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

// Gemini shares nothing with the OpenAI shape, which is why it is a launch
// provider: an envelope that only fits OpenAI-shaped vendors is a passthrough.
describe('gemini embeddings', () => {
  const spec = { inputTypes: { document: 'RETRIEVAL_DOCUMENT' }, dimensionsSelectable: true }

  test('one input uses :embedContent and reads embedding.values', async () => {
    const calls = answering({
      embedding: { values: [1, 2, 3] },
      usageMetadata: { promptTokenCount: 5 }
    })
    const r = await runEmbedding(envelope('gemini/gemini-embedding-001', ['a']), { spec })
    expect(calls[0].url).toContain(':embedContent')
    expect(calls[0].body.content.parts).toEqual([{ text: 'a' }])
    expect(r.result.vectors).toEqual([[1, 2, 3]])
    expect(r.result.inputTokens).toBe(5)
  })

  test('several inputs switch to :batchEmbedContents', async () => {
    const calls = answering({ embeddings: [{ values: [1] }, { values: [2] }] })
    const r = await runEmbedding(envelope('gemini/gemini-embedding-001', ['a', 'b']), { spec })
    expect(calls[0].url).toContain(':batchEmbedContents')
    expect(calls[0].body.requests).toHaveLength(2)
    expect(r.result.vectors).toEqual([[1], [2]])
  })

  test('the dimension knob is outputDimensionality, inside the request', async () => {
    const calls = answering({ embedding: { values: [1] } })
    await runEmbedding(envelope('gemini/gemini-embedding-001', ['a'], { dimensions: 256 }), { spec })
    expect(calls[0].body.outputDimensionality).toBe(256)
    expect(calls[0].body.dimensions).toBeUndefined()
  })

  test('the key travels as a header, never in the URL', async () => {
    const calls = answering({ embedding: { values: [1] } })
    await runEmbedding(envelope('gemini/gemini-embedding-001', ['a']), { spec })
    expect(calls[0].url).not.toContain('sk-x')
    expect(JSON.stringify(calls[0].headers)).toContain('sk-x')
  })
})

describe('cohere embeddings', () => {
  const spec = {
    inputTypes: { query: 'search_query', document: 'search_document' },
    defaultInputType: 'document',
    dimensionsSelectable: true
  }

  test('posts texts to /v2/embed and reads the dtype-keyed response', async () => {
    const calls = answering({
      embeddings: { float: [[1, 1], [2, 2]] },
      meta: { billed_units: { input_tokens: 1_000_000 } }
    })
    const r = await runEmbedding(envelope('cohere/embed-v4.0', ['a', 'b']), {
      spec: { ...spec, embeddingPrice: 0.12 }
    })
    expect(calls[0].url).toBe('https://api.cohere.com/v2/embed')
    expect(calls[0].body.texts).toEqual(['a', 'b'])
    expect(calls[0].body.embedding_types).toEqual(['float'])
    expect(r.result.vectors).toEqual([[1, 1], [2, 2]])
    expect(r.result.inputTokens).toBe(1_000_000)
    expect(r.result.cost).toBe(0.12)
  })

  test('the dimension knob is output_dimension', async () => {
    const calls = answering({ embeddings: { float: [[1]] }, meta: {} })
    await runEmbedding(envelope('cohere/embed-v4.0', ['a'], { dimensions: 512 }), { spec })
    expect(calls[0].body.output_dimension).toBe(512)
  })

  // Cohere rejects a call without input_type, so an entry that declares no
  // mapping is unusable rather than merely less accurate.
  test('an entry with no inputTypes fails before dispatch, naming the requirement', async () => {
    const calls = answering({})
    const r = await runEmbedding(envelope('cohere/embed-v4.0', ['a']), { spec: {} })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('EMBED_INPUT_TYPE_REQUIRED')
    expect(r.error.message).toContain('defaultInputType')
    expect(calls).toHaveLength(0)
  })
})

describe('local embeddings', () => {
  test('the endpoint comes from the entry, so a call cannot fall through to a cloud', async () => {
    const calls = answering({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 1 } })
    await runEmbedding(envelope('local/nomic-embed-text', ['a']), {
      spec: { baseURL: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text' }
    })
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/embeddings')
  })

  test('an entry with no baseURL fails rather than defaulting somewhere', async () => {
    const r = await runEmbedding(envelope('local/nomic-embed-text', ['a']), { spec: {} })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('CONFIGURATION_MISSING')
  })
})

describe('providers without an embeddings endpoint', () => {
  test('resolve to a typed error rather than a wrong adapter', async () => {
    const r = await runEmbedding(envelope('groq/qwen3.8-27b', ['a']), { spec: {} })
    expect(r.ok).toBe(false)
    expect(r.error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })
})
