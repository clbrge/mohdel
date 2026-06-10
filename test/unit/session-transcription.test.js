import { describe, test, expect, beforeEach } from 'vitest'

import { runTranscription } from '../../js/session/run_transcription.js'
import { createTranscriptionAdapter, loadAudio } from '../../js/session/adapters/transcription/openai_compatible.js'
import { computeTranscriptionCost } from '../../js/session/adapters/_pricing.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

// "hi" as base64 — content is irrelevant, the adapter never inspects audio bytes.
const DATA_URI = 'data:audio/wav;base64,aGk='

/** @returns {import('#core/transcription.js').TranscriptionEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'groq/whisper-large-v3-turbo',
    audio: { fileUri: DATA_URI, mimeType: 'audio/wav' },
    ...overrides
  }
}

function okFetch (body, capture = {}) {
  return async (url, init) => {
    capture.url = url
    capture.init = init
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
  }
}

describe('runTranscription dispatch', () => {
  test('unknown provider yields SESSION_UNKNOWN_PROVIDER', async () => {
    const out = await runTranscription(envelope({ model: 'nonesuch/whisper' }))
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })

  test('adapter success returns ok=true with result', async () => {
    const fakeAdapter = async () => ({
      status: 'completed',
      text: 'hello world',
      language: 'en',
      durationSeconds: 3,
      cost: 0,
      timestamps: { start: '0', first: '0', end: '0' }
    })
    const out = await runTranscription(envelope(), { resolveAdapter: () => fakeAdapter })
    expect(out.ok).toBe(true)
    expect(out.result.text).toBe('hello world')
  })

  test('adapter throwing untyped error is classified', async () => {
    const fakeAdapter = async () => { throw Object.assign(new Error('boom'), { status: 401 }) }
    const out = await runTranscription(envelope(), { resolveAdapter: () => fakeAdapter })
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('AUTH_INVALID')
  })

  test('adapter throwing with typed payload passes through', async () => {
    const fakeAdapter = async () => {
      const err = new Error('custom')
      err.typed = { message: 'custom', severity: 'error', retryable: false, type: 'PROVIDER_ERROR' }
      throw err
    }
    const out = await runTranscription(envelope(), { resolveAdapter: () => fakeAdapter })
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('PROVIDER_ERROR')
  })
})

describe('openai-compatible transcription adapter', () => {
  beforeEach(() => setCatalog({}))

  const groq = createTranscriptionAdapter({
    baseURL: 'https://api.groq.com/openai/v1',
    responseFormat: 'verbose_json'
  })

  test('posts multipart form to <baseURL>/audio/transcriptions with auth header', async () => {
    const capture = {}
    const out = await groq(envelope(), { fetch: okFetch({ text: 'bonjour', duration: 2.5, language: 'fr' }, capture) })

    expect(capture.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(capture.init.method).toBe('POST')
    expect(capture.init.headers.Authorization).toBe('Bearer k')

    const form = capture.init.body
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('model')).toBe('whisper-large-v3-turbo')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('file').name).toBe('audio.wav')

    expect(out.status).toBe('completed')
    expect(out.text).toBe('bonjour')
    expect(out.language).toBe('fr')
    expect(out.durationSeconds).toBe(2.5)
  })

  test('spec.model wins over the bare catalog-key segment', async () => {
    const capture = {}
    await groq(envelope(), {
      fetch: okFetch({ text: '' }, capture),
      spec: { model: 'whisper-upstream-id' }
    })
    expect(capture.init.body.get('model')).toBe('whisper-upstream-id')
  })

  test('language and prompt are forwarded only when set', async () => {
    const capture = {}
    await groq(envelope({ language: 'en', prompt: 'Coppersmith, mohdel' }), { fetch: okFetch({ text: '' }, capture) })
    expect(capture.init.body.get('language')).toBe('en')
    expect(capture.init.body.get('prompt')).toBe('Coppersmith, mohdel')

    const capture2 = {}
    await groq(envelope(), { fetch: okFetch({ text: '' }, capture2) })
    expect(capture2.init.body.get('language')).toBeNull()
    expect(capture2.init.body.get('prompt')).toBeNull()
  })

  test('response_format omitted when not configured (mistral)', async () => {
    const mistral = createTranscriptionAdapter({ baseURL: 'https://api.mistral.ai/v1' })
    const capture = {}
    await mistral(envelope({ model: 'mistral/voxtral-mini-transcribe' }), { fetch: okFetch({ text: '' }, capture) })
    expect(capture.init.body.get('response_format')).toBeNull()
  })

  test('auth.baseURL overrides the provider default', async () => {
    const capture = {}
    await groq(envelope({ auth: { key: 'k', baseURL: 'https://proxy.local/v1/' } }), { fetch: okFetch({ text: '' }, capture) })
    expect(capture.url).toBe('https://proxy.local/v1/audio/transcriptions')
  })

  test('duration from mistral usage.prompt_audio_seconds', async () => {
    const out = await groq(envelope(), {
      fetch: okFetch({ text: 'x', usage: { prompt_audio_seconds: 203, prompt_tokens: 4 } })
    })
    expect(out.durationSeconds).toBe(203)
  })

  test('duration from openai usage.seconds', async () => {
    const out = await groq(envelope(), { fetch: okFetch({ text: 'x', usage: { type: 'duration', seconds: 9 } }) })
    expect(out.durationSeconds).toBe(9)
  })

  test('token usage is surfaced and priced when duration is absent', async () => {
    const out = await groq(envelope(), {
      fetch: okFetch({ text: 'x', usage: { type: 'tokens', input_tokens: 1000, output_tokens: 200 } }),
      spec: { inputPrice: 3, outputPrice: 5 }
    })
    expect(out.durationSeconds).toBeNull()
    expect(out.inputTokens).toBe(1000)
    expect(out.outputTokens).toBe(200)
    expect(out.cost).toBe((1000 * 3 + 200 * 5) / 1_000_000)
  })

  test('per-minute pricing from transcriptionPrice × reported duration', async () => {
    const out = await groq(envelope(), {
      fetch: okFetch({ text: 'x', duration: 120 }),
      spec: { transcriptionPrice: 0.0006 }
    })
    expect(out.cost).toBe(0.0012)
  })

  test('no price in spec degrades to cost 0', async () => {
    const out = await groq(envelope(), { fetch: okFetch({ text: 'x', duration: 60 }) })
    expect(out.cost).toBe(0)
  })

  test('HTTP 401 maps to AUTH_INVALID; body goes to detail, not message', async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"bad key sk-xxxxx"}'
    })
    try {
      await groq(envelope(), { fetch: fetchFn })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.typed.type).toBe('AUTH_INVALID')
      expect(e.typed.message).not.toContain('sk-xxxxx')
      expect(e.typed.detail).toContain('transcription request failed')
      expect(e.typed.detail).toContain('sk-xxxxx')
    }
  })

  test('network failure maps to retryable NET_ERROR', async () => {
    const fetchFn = async () => { throw new Error('ECONNREFUSED') }
    await expect(groq(envelope(), { fetch: fetchFn })).rejects.toMatchObject({
      typed: { type: 'NET_ERROR', retryable: true }
    })
  })
})

describe('loadAudio', () => {
  test('data: URI decodes base64 and synthesizes a filename from mimeType', async () => {
    const out = await loadAudio({ fileUri: 'data:audio/mpeg;base64,aGk=', mimeType: 'audio/mpeg' })
    expect(out.bytes.toString('utf8')).toBe('hi')
    expect(out.filename).toBe('audio.mp3')
  })

  test('file:// keeps the on-disk basename', async () => {
    const out = await loadAudio({ fileUri: `file://${process.cwd()}/package.json`, mimeType: 'audio/wav' })
    expect(out.filename).toBe('package.json')
    expect(out.bytes.length).toBeGreaterThan(0)
  })

  test('unreadable file throws SESSION_INVALID_AUDIO', async () => {
    await expect(
      loadAudio({ fileUri: 'file:///nonexistent/audio.mp3', mimeType: 'audio/mpeg' })
    ).rejects.toMatchObject({ typed: { type: 'SESSION_INVALID_AUDIO' } })
  })

  test('https:// is rejected — caller owns remote downloads', async () => {
    await expect(
      loadAudio({ fileUri: 'https://example.com/a.mp3', mimeType: 'audio/mpeg' })
    ).rejects.toMatchObject({ typed: { type: 'SESSION_INVALID_AUDIO' } })
  })

  test('missing fileUri or mimeType throws SESSION_INVALID_AUDIO', async () => {
    await expect(loadAudio({ fileUri: DATA_URI })).rejects.toMatchObject({ typed: { type: 'SESSION_INVALID_AUDIO' } })
    await expect(loadAudio(undefined)).rejects.toMatchObject({ typed: { type: 'SESSION_INVALID_AUDIO' } })
  })
})

describe('computeTranscriptionCost', () => {
  test('duration wins over token usage when both present (mistral)', () => {
    const spec = { transcriptionPrice: 0.002, inputPrice: 3, outputPrice: 5 }
    const cost = computeTranscriptionCost(spec, { durationSeconds: 60, inputTokens: 1000, outputTokens: 100 })
    expect(cost).toBe(0.002)
  })

  test('token fallback when no duration', () => {
    const spec = { inputPrice: 3, outputPrice: 5 }
    expect(computeTranscriptionCost(spec, { inputTokens: 1_000_000 })).toBe(3)
  })

  test('no spec or no usable price returns 0', () => {
    expect(computeTranscriptionCost(undefined, { durationSeconds: 60 })).toBe(0)
    expect(computeTranscriptionCost({}, { durationSeconds: 60 })).toBe(0)
    expect(computeTranscriptionCost({ transcriptionPrice: 0.002 }, {})).toBe(0)
  })
})
