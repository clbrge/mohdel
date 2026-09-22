import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { gemini } from '../../js/session/adapters/gemini.js'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const fixtures = JSON.parse(fs.readFileSync(path.join(here, '..', 'conformance', 'envelopes.json'), 'utf8'))
const structured = fixtures['structured-prompt-with-parts']

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function envelope (model) {
  return { ...structured, model, auth: { key: 'k' } }
}

describe('reasoning parts on the bespoke adapters', () => {
  test('anthropic omits them and sends the text', async () => {
    const captured = {}
    const client = {
      messages: {
        stream (req) {
          captured.request = req
          return { async * [Symbol.asyncIterator] () { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } } } }
        }
      }
    }
    const events = await collect(anthropic(envelope('anthropic/claude-sonnet-4-5'), { client }))
    expect(events.at(-1).type).toBe('done')
    expect(captured.request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Think step by step.' }] }
    ])
  })

  test('openai omits them and sends the text', async () => {
    const captured = {}
    const client = {
      responses: {
        stream (req) {
          captured.request = req
          return { async * [Symbol.asyncIterator] () { yield { type: 'response.completed', response: { usage: {} } } } }
        }
      }
    }
    const events = await collect(openai(envelope('openai/gpt-5-mini'), { client }))
    expect(events.at(-1).type).toBe('done')
    expect(captured.request.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Think step by step.' }] }
    ])
  })

  test('gemini omits them and sends the text', async () => {
    const captured = {}
    const client = {
      models: {
        generateContentStream (req) {
          captured.request = req
          return (async function * () { yield { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } })()
        }
      }
    }
    const events = await collect(gemini(envelope('gemini/gemini-2.5-flash'), { client }))
    expect(events.at(-1).type).toBe('done')
    expect(captured.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Think step by step.' }] }
    ])
  })
})
