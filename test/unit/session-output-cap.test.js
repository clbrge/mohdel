import { describe, test, expect, beforeEach } from 'vitest'
import { capOutput } from '../../js/session/adapters/_output_cap.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { groq } from '../../js/session/adapters/groq.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { anthropic } from '../../js/session/adapters/anthropic.js'

const envelope = (model, overrides = {}) => ({
  callId: 'c1', authId: 'a1', auth: { key: 'k' }, model, prompt: 'hi', ...overrides
})

const collect = async (iter) => {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

const chatClient = () => {
  const captured = {}
  return {
    captured,
    client: {
      chat: {
        completions: {
          create: async (args) => {
            captured.args = args
            return {
              choices: [{ message: { content: 'x', tool_calls: null }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1 }
            }
          }
        }
      }
    }
  }
}

const geminiClient = () => {
  const captured = {}
  return {
    captured,
    client: {
      models: {
        generateContentStream (request) {
          captured.request = request
          return (async function * () {
            yield { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }
          })()
        }
      }
    }
  }
}

const anthropicClient = () => {
  const captured = {}
  return {
    captured,
    client: {
      messages: {
        stream (request) {
          captured.request = request
          return {
            async * [Symbol.asyncIterator] () {
              yield { type: 'message_start', message: { usage: { input_tokens: 1 } } }
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }
              yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
            }
          }
        }
      }
    }
  }
}

beforeEach(() => setCatalog({}))

describe('capOutput', () => {
  test('caps a request above the limit', () => {
    expect(capOutput(500000, 393216)).toBe(393216)
  })

  test('leaves a request under the limit alone', () => {
    expect(capOutput(1024, 393216)).toBe(1024)
  })

  test('an unknown limit cannot cap', () => {
    expect(capOutput(500000, undefined)).toBe(500000)
  })

  test('an absent request stays absent', () => {
    expect(capOutput(undefined, 393216)).toBeUndefined()
  })
})

describe('the cap holds on every adapter', () => {
  test('chat-completions: outputBudget over the limit is capped', async () => {
    setCatalog({ 'groq/llama-3': { model: 'llama-3', outputTokenLimit: 8192 } })
    const { client, captured } = chatClient()
    await collect(groq(envelope('groq/llama-3', { outputBudget: 500000 }), { client }))
    expect(captured.args.max_tokens).toBe(8192)
  })

  test('chat-completions: thinking headroom cannot push it back over', async () => {
    setCatalog({ 'groq/llama-3': { model: 'llama-3', outputTokenLimit: 8192, thinkingEffortLevels: { high: 4000 } } })
    const { client, captured } = chatClient()
    await collect(groq(envelope('groq/llama-3', { outputBudget: 8000, outputEffort: 'high' }), { client }))
    expect(captured.args.max_tokens).toBe(8192)
  })

  test('chat-completions: headroom still applies below the limit', async () => {
    setCatalog({ 'groq/llama-3': { model: 'llama-3', outputTokenLimit: 8192, thinkingEffortLevels: { high: 500 } } })
    const { client, captured } = chatClient()
    await collect(groq(envelope('groq/llama-3', { outputBudget: 1000, outputEffort: 'high' }), { client }))
    expect(captured.args.max_tokens).toBe(1500)
  })

  test('gemini: maxOutputTokens over the limit is capped', async () => {
    setCatalog({ 'gemini/gemini-2.5-flash': { model: 'gemini-2.5-flash', outputTokenLimit: 65536 } })
    const { client, captured } = geminiClient()
    await collect(gemini(envelope('gemini/gemini-2.5-flash', { outputBudget: 200000 }), { client }))
    expect(captured.request.config.maxOutputTokens).toBe(65536)
  })

  test('gemini: no outputBudget sends no maxOutputTokens', async () => {
    setCatalog({ 'gemini/gemini-2.5-flash': { model: 'gemini-2.5-flash', outputTokenLimit: 65536 } })
    const { client, captured } = geminiClient()
    await collect(gemini(envelope('gemini/gemini-2.5-flash'), { client }))
    expect(captured.request.config?.maxOutputTokens).toBeUndefined()
  })

  test('anthropic: outputBudget over the limit is capped', async () => {
    setCatalog({ 'anthropic/claude-sonnet-4-5': { model: 'claude-sonnet-4-5', outputTokenLimit: 64000 } })
    const { client, captured } = anthropicClient()
    await collect(anthropic(envelope('anthropic/claude-sonnet-4-5', { outputBudget: 200000 }), { client }))
    expect(captured.request.max_tokens).toBe(64000)
  })

  test('a spec with no outputTokenLimit sends the request as given', async () => {
    setCatalog({ 'groq/llama-3': { model: 'llama-3' } })
    const { client, captured } = chatClient()
    await collect(groq(envelope('groq/llama-3', { outputBudget: 500000 }), { client }))
    expect(captured.args.max_tokens).toBe(500000)
  })
})
