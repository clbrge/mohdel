import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { xai } from '../../js/session/adapters/xai.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { groq } from '../../js/session/adapters/groq.js'
import { cerebras } from '../../js/session/adapters/cerebras.js'
import { echo } from '../../js/session/adapters/echo.js'
import { fake } from '../../js/session/adapters/fake.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'
import { markTrustedMedia } from '../../js/session/adapters/_media.js'

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])
const PNG_BASE64 = PNG_BYTES.toString('base64')
const DATA_URI = `data:image/png;base64,${PNG_BASE64}`
const REMOTE = 'https://example.com/page.jpg'

let tmpDir, fileUri

beforeEach(() => {
  setCatalog({})
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-parts-')))
  const file = path.join(tmpDir, 'page.png')
  fs.writeFileSync(file, PNG_BYTES)
  fileUri = `file://${file}`
  process.env.MOHDEL_MEDIA_ROOTS = tmpDir
})

afterEach(() => {
  delete process.env.MOHDEL_MEDIA_ROOTS
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function envelope (model, prompt, overrides = {}) {
  return { callId: 'c1', authId: 'a1', auth: { key: 'k' }, model, prompt, ...overrides }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

const image = (uri, mimeType = 'image/png') => ({ type: 'image', fileUri: uri, mimeType })

function interleaved () {
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'page 7' },
      image(fileUri),
      { type: 'text', text: 'page 8' },
      image(DATA_URI)
    ]
  }]
}

function toolRun () {
  return [
    { role: 'user', content: 'look at pages 1 and 2' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'view_page', arguments: { page: 1 } },
        { id: 'call_2', name: 'view_page', arguments: { page: 2 } }
      ]
    },
    { role: 'tool', toolCallId: 'call_1', toolName: 'view_page', content: [{ type: 'text', text: 'page 1' }, image(fileUri)] },
    { role: 'tool', toolCallId: 'call_2', toolName: 'view_page', content: [{ type: 'text', text: 'page 2' }, image(DATA_URI)] }
  ]
}

function mockAnthropic () {
  const captured = {}
  const client = {
    messages: {
      stream (req) {
        captured.request = req
        return { async * [Symbol.asyncIterator] () { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } } } }
      }
    }
  }
  return { client, captured }
}

function mockResponses () {
  const captured = {}
  const client = {
    responses: {
      stream (req) {
        captured.request = req
        return { async * [Symbol.asyncIterator] () { yield { type: 'response.completed', response: { usage: {} } } } }
      }
    }
  }
  return { client, captured }
}

function mockGemini () {
  const captured = {}
  const client = {
    models: {
      generateContentStream (req) {
        captured.request = req
        return (async function * () { yield { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] } })()
      }
    }
  }
  return { client, captured }
}

function mockChatStream () {
  const captured = {}
  const client = {
    chat: {
      completions: {
        create: async (args) => {
          captured.args = args
          return (async function * () {
            yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }
            yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
          })()
        }
      }
    }
  }
  return { client, captured }
}

const anthropicImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 } }
const openaiImage = { type: 'input_image', image_url: DATA_URI }
const geminiImage = { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }
const chatImage = { type: 'image_url', image_url: { url: DATA_URI, detail: 'high' } }

describe('image parts render where they are written', () => {
  test('anthropic', async () => {
    const { client, captured } = mockAnthropic()
    await collect(anthropic(envelope('anthropic/claude-sonnet-4-5', interleaved()), { client }))
    expect(captured.request.messages[0].content).toEqual([
      { type: 'text', text: 'page 7' }, anthropicImage, { type: 'text', text: 'page 8' }, anthropicImage
    ])
  })

  test('openai', async () => {
    const { client, captured } = mockResponses()
    await collect(openai(envelope('openai/gpt-5', interleaved()), { client }))
    expect(captured.request.input[0].content).toEqual([
      { type: 'input_text', text: 'page 7' }, openaiImage, { type: 'input_text', text: 'page 8' }, openaiImage
    ])
  })

  test('gemini', async () => {
    const { client, captured } = mockGemini()
    await collect(gemini(envelope('gemini/gemini-2.5-flash', interleaved()), { client }))
    expect(captured.request.contents[0].parts).toEqual([
      { text: 'page 7' }, geminiImage, { text: 'page 8' }, geminiImage
    ])
  })

  test('chat completions', async () => {
    const { client, captured } = mockChatStream()
    await collect(groq(envelope('groq/llama-4', interleaved()), { client }))
    expect(captured.args.messages[0].content).toEqual([
      { type: 'text', text: 'page 7' }, chatImage, { type: 'text', text: 'page 8' }, chatImage
    ])
  })
})

describe('image parts in tool results', () => {
  test('anthropic keeps them inside tool_result', async () => {
    const { client, captured } = mockAnthropic()
    await collect(anthropic(envelope('anthropic/claude-sonnet-4-5', toolRun()), { client }))
    const results = captured.request.messages.slice(2).map(m => m.content[0])
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'page 1' }, anthropicImage] },
      { type: 'tool_result', tool_use_id: 'call_2', content: [{ type: 'text', text: 'page 2' }, anthropicImage] }
    ])
  })

  test('openai keeps them inside function_call_output', async () => {
    const { client, captured } = mockResponses()
    await collect(openai(envelope('openai/gpt-5', toolRun()), { client }))
    const outputs = captured.request.input.filter(i => i.type === 'function_call_output')
    expect(outputs.map(o => o.output)).toEqual([
      [{ type: 'input_text', text: 'page 1' }, openaiImage],
      [{ type: 'input_text', text: 'page 2' }, openaiImage]
    ])
    expect(captured.request.input.at(-1).type).toBe('function_call_output')
  })

  test('xai moves them into one user message after the tool results', async () => {
    const { client, captured } = mockResponses()
    await collect(xai(envelope('xai/grok-4', toolRun()), { client }))
    expect(captured.request.input.slice(-3)).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'page 1' },
      { type: 'function_call_output', call_id: 'call_2', output: 'page 2' },
      { role: 'user', content: [openaiImage, openaiImage] }
    ])
  })

  test('gemini moves them into one user content after the tool results', async () => {
    const { client, captured } = mockGemini()
    await collect(gemini(envelope('gemini/gemini-2.5-flash', toolRun()), { client }))
    const tail = captured.request.contents.slice(-3)
    expect(tail[0].parts[0].functionResponse.response).toEqual({ result: 'page 1' })
    expect(tail[1].parts[0].functionResponse.response).toEqual({ result: 'page 2' })
    expect(tail[2]).toEqual({ role: 'user', parts: [geminiImage, geminiImage] })
  })

  test('chat completions moves them into one user message after the tool results', async () => {
    const { client, captured } = mockChatStream()
    await collect(groq(envelope('groq/llama-4', [...toolRun(), { role: 'user', content: 'compare them' }]), { client }))
    expect(captured.args.messages.slice(-4)).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'page 1' },
      { role: 'tool', tool_call_id: 'call_2', content: 'page 2' },
      { role: 'user', content: [chatImage, chatImage] },
      { role: 'user', content: 'compare them' }
    ])
  })
})

describe('the caller transcript is not modified', () => {
  const cases = [
    ['anthropic', anthropic, 'anthropic/claude-sonnet-4-5', mockAnthropic],
    ['openai', openai, 'openai/gpt-5', mockResponses],
    ['xai', xai, 'xai/grok-4', mockResponses],
    ['gemini', gemini, 'gemini/gemini-2.5-flash', mockGemini],
    ['chat completions', groq, 'groq/llama-4', mockChatStream]
  ]
  for (const [name, adapter, model, mock] of cases) {
    test(name, async () => {
      const prompt = [...interleaved(), ...toolRun()]
      const before = structuredClone(prompt)
      const { client } = mock()
      await collect(adapter(envelope(model, prompt, { images: [{ fileUri: DATA_URI, mimeType: 'image/png' }] }), { client }))
      expect(prompt).toEqual(before)
    })
  }
})

describe('chat completions image sources', () => {
  test('a data: URI goes out byte-identical', async () => {
    const odd = 'data:image/png;charset=binary;base64,' + PNG_BASE64
    const { client, captured } = mockChatStream()
    await collect(groq(envelope('groq/llama-4', 'describe', {
      images: [{ fileUri: odd, mimeType: 'image/png' }]
    }), { client }))
    expect(captured.args.messages[0].content[1].image_url.url).toBe(odd)
  })

  test('an envelope file:// image is read and sent as a data URI', async () => {
    const { client, captured } = mockChatStream()
    await collect(groq(envelope('groq/llama-4', 'describe', {
      images: [{ fileUri, mimeType: 'image/png' }]
    }), { client }))
    expect(captured.args.messages[0].content).toEqual([{ type: 'text', text: 'describe' }, chatImage])
  })

  test('an https:// image passes through', async () => {
    const { client, captured } = mockChatStream()
    await collect(groq(envelope('groq/llama-4', [{ role: 'user', content: [image(REMOTE, 'image/jpeg')] }]), { client }))
    expect(captured.args.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: REMOTE, detail: 'high' } }
    ])
  })

  test('cerebras refuses an https:// image part before dispatch', async () => {
    const { client, captured } = mockChatStream()
    const events = await collect(cerebras(envelope('cerebras/llama-4', [{ role: 'user', content: [image(REMOTE, 'image/jpeg')] }]), { client }))
    expect(captured.args).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
  })

  test('cerebras refuses an https:// envelope image before dispatch', async () => {
    const { client, captured } = mockChatStream()
    const events = await collect(cerebras(envelope('cerebras/llama-4', 'describe', {
      images: [{ fileUri: REMOTE, mimeType: 'image/jpeg' }]
    }), { client }))
    expect(captured.args).toBeUndefined()
    expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
  })
})

describe('refusals are typed on every builder', () => {
  const builders = [
    ['anthropic', anthropic, 'anthropic/claude-sonnet-4-5', mockAnthropic],
    ['openai', openai, 'openai/gpt-5', mockResponses],
    ['gemini', gemini, 'gemini/gemini-2.5-flash', mockGemini],
    ['chat completions', groq, 'groq/llama-4', mockChatStream]
  ]

  for (const [name, adapter, model, mock] of builders) {
    test(`${name}: a part outside MOHDEL_MEDIA_ROOTS, even on a trusted envelope`, async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-outside-'))
      const file = path.join(outside, 'x.png')
      fs.writeFileSync(file, PNG_BYTES)
      try {
        const { client } = mock()
        const env = markTrustedMedia(envelope(model, [{ role: 'user', content: [image(`file://${file}`)] }]))
        const events = await collect(adapter(env, { client }))
        expect(events).toHaveLength(1)
        expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
        expect(events[0].error.message).toMatch(/outside the permitted directories/)
      } finally {
        fs.rmSync(outside, { recursive: true, force: true })
      }
    })

    test(`${name}: a part missing mimeType`, async () => {
      const { client } = mock()
      const events = await collect(adapter(envelope(model, [{ role: 'user', content: [{ type: 'image', fileUri: DATA_URI }] }]), { client }))
      expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
    })

    test(`${name}: an envelope ref missing fileUri`, async () => {
      const { client } = mock()
      const events = await collect(adapter(envelope(model, 'describe', { images: [{ mimeType: 'image/png' }] }), { client }))
      expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
    })

    test(`${name}: a part on an assistant message`, async () => {
      const { client } = mock()
      const events = await collect(adapter(envelope(model, [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [image(DATA_URI)] }
      ]), { client }))
      expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
    })
  }

  test('a file:// part is refused off the wire when no roots are set', async () => {
    delete process.env.MOHDEL_MEDIA_ROOTS
    const { client } = mockChatStream()
    const events = await collect(groq(envelope('groq/llama-4', interleaved()), { client }))
    expect(events[0].error.type).toBe('SESSION_INVALID_IMAGE')
    expect(events[0].error.message).toMatch(/not permitted/)
  })
})

describe('test adapters accept image parts', () => {
  test('echo', async () => {
    const events = await collect(echo(envelope('echo/echo', interleaved())))
    expect(events.at(-1).type).toBe('done')
  })

  test('fake', async () => {
    const events = await collect(fake(envelope('fake/fake', interleaved())))
    expect(events.at(-1).type).toBe('done')
  })
})
