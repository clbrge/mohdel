import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { anthropic } from '../../js/session/adapters/anthropic.js'
import { openai } from '../../js/session/adapters/openai.js'
import { gemini } from '../../js/session/adapters/gemini.js'
import { loadImage, loadImages } from '../../js/session/adapters/_images.js'

/** @returns {import('#core/envelope.js').CallEnvelope} */
function envelope (provider, model, overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    provider,
    model,
    prompt: 'Describe this image.',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

const PNG_BYTES = Buffer.from([
  // Tiny 1×1 PNG
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])
const PNG_BASE64 = PNG_BYTES.toString('base64')

// ---------- _images loader ----------

describe('_images loadImage', () => {
  let tmpDir, tmpFile

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-images-'))
    tmpFile = path.join(tmpDir, 'tiny.png')
    fs.writeFileSync(tmpFile, PNG_BYTES)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('file:// URI loads from disk and base64-encodes', async () => {
    const loaded = await loadImage({
      fileUri: `file://${tmpFile}`,
      mimeType: 'image/png'
    })
    expect(loaded).toEqual({ mimeType: 'image/png', base64: PNG_BASE64 })
  })

  test('data: URI extracts base64 payload', async () => {
    const loaded = await loadImage({
      fileUri: `data:image/png;base64,${PNG_BASE64}`,
      mimeType: 'image/png'
    })
    expect(loaded).toEqual({ mimeType: 'image/png', base64: PNG_BASE64 })
  })

  test('https:// URI is passed through as url', async () => {
    const loaded = await loadImage({
      fileUri: 'https://example.com/img.jpg',
      mimeType: 'image/jpeg'
    })
    expect(loaded).toEqual({ mimeType: 'image/jpeg', url: 'https://example.com/img.jpg' })
  })

  test('unsupported scheme throws', async () => {
    await expect(loadImage({
      fileUri: 'ftp://elsewhere/img.png',
      mimeType: 'image/png'
    })).rejects.toThrow(/unsupported image URI scheme/)
  })

  test('loadImages skips entries missing fileUri or mimeType', async () => {
    const out = await loadImages([
      { fileUri: 'data:image/png;base64,abc', mimeType: 'image/png' },
      { fileUri: 'data:image/png;base64,xyz' }, // missing mimeType
      { mimeType: 'image/png' } // missing fileUri
    ])
    expect(out).toHaveLength(1)
  })
})

// ---------- Anthropic ----------

function mockAnthropic (events) {
  const captured = {}
  return {
    client: {
      messages: {
        stream (req) {
          captured.request = req
          return {
            async * [Symbol.asyncIterator] () { for (const e of events) yield e }
          }
        }
      }
    },
    captured
  }
}

describe('anthropic image injection', () => {
  test('data: URI image becomes base64 source block on last user message', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5', {
      images: [{ fileUri: `data:image/png;base64,${PNG_BASE64}`, mimeType: 'image/png' }]
    }), { client }))

    const userMsg = captured.request.messages.find(m => m.role === 'user')
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 }
      }
    ])
  })

  test('https:// URI image becomes url source block', async () => {
    const { client, captured } = mockAnthropic([
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    ])
    await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5', {
      images: [{ fileUri: 'https://example.com/img.jpg', mimeType: 'image/jpeg' }]
    }), { client }))

    const userMsg = captured.request.messages.find(m => m.role === 'user')
    const imgBlock = userMsg.content.find(c => c.type === 'image')
    expect(imgBlock).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/img.jpg' }
    })
  })

  test('image load failure yields a typed error event', async () => {
    const { client } = mockAnthropic([])
    const events = await collect(anthropic(envelope('anthropic', 'claude-sonnet-4-5', {
      images: [{ fileUri: 'ftp://nope/img.png', mimeType: 'image/png' }]
    }), { client }))

    expect(events.length).toBe(1)
    expect(events[0].type).toBe('error')
  })
})

// ---------- OpenAI ----------

function mockOpenAI (events) {
  const captured = {}
  return {
    client: {
      responses: {
        stream (req) {
          captured.request = req
          return {
            async * [Symbol.asyncIterator] () { for (const e of events) yield e }
          }
        }
      }
    },
    captured
  }
}

describe('openai image injection', () => {
  test('data: URI image becomes input_image part with data: image_url', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', {
      images: [{ fileUri: `data:image/png;base64,${PNG_BASE64}`, mimeType: 'image/png' }]
    }), { client }))

    const userItem = captured.request.input.find(i => i.role === 'user')
    expect(userItem.content).toEqual([
      { type: 'input_text', text: 'Describe this image.' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}` }
    ])
  })

  test('https:// URI image is passed as image_url URL', async () => {
    const { client, captured } = mockOpenAI([
      { type: 'response.completed', response: { usage: {} } }
    ])
    await collect(openai(envelope('openai', 'gpt-5', {
      images: [{ fileUri: 'https://example.com/img.jpg', mimeType: 'image/jpeg' }]
    }), { client }))

    const userItem = captured.request.input.find(i => i.role === 'user')
    const imgPart = userItem.content.find(p => p.type === 'input_image')
    expect(imgPart).toEqual({ type: 'input_image', image_url: 'https://example.com/img.jpg' })
  })
})

// ---------- Gemini ----------

function mockGemini (chunks) {
  const captured = {}
  return {
    client: {
      models: {
        generateContentStream (req) {
          captured.request = req
          return (async function * () { for (const c of chunks) yield c })()
        }
      }
    },
    captured
  }
}

describe('gemini image injection', () => {
  test('data: URI image becomes inlineData part on last user message', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-2.5-flash', {
      images: [{ fileUri: `data:image/png;base64,${PNG_BASE64}`, mimeType: 'image/png' }]
    }), { client }))

    const userContent = captured.request.contents.find(c => c.role === 'user')
    const inlinePart = userContent.parts.find(p => p.inlineData)
    expect(inlinePart).toEqual({
      inlineData: { mimeType: 'image/png', data: PNG_BASE64 }
    })
  })

  test('https:// URI image becomes fileData part', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-2.5-flash', {
      images: [{ fileUri: 'https://example.com/img.jpg', mimeType: 'image/jpeg' }]
    }), { client }))

    const userContent = captured.request.contents.find(c => c.role === 'user')
    const filePart = userContent.parts.find(p => p.fileData)
    expect(filePart).toEqual({
      fileData: { mimeType: 'image/jpeg', fileUri: 'https://example.com/img.jpg' }
    })
  })
})
