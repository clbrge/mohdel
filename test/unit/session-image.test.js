import { describe, test, expect, beforeEach } from 'vitest'

import { runImage } from '../../js/session/run_image.js'
import { openaiImage } from '../../js/session/adapters/image/openai.js'
import { novitaImage } from '../../js/session/adapters/image/novita.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

/** @returns {import('#core/image.js').ImageEnvelope} */
function envelope (overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'openai/dall-e-3',
    prompt: 'a red cube',
    ...overrides
  }
}

describe('runImage dispatch', () => {
  test('unknown provider yields SESSION_UNKNOWN_PROVIDER', async () => {
    const out = await runImage(envelope({ model: 'nonesuch/dall-e-3' }))
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })

  test('adapter success returns ok=true with result', async () => {
    const fakeAdapter = async () => ({
      status: 'completed',
      images: [{ mimeType: 'image/png', url: 'https://x/y.png' }],
      seed: 42,
      timestamps: { start: '0', first: '0', end: '0' }
    })
    const out = await runImage(envelope(), { resolveAdapter: () => fakeAdapter })
    expect(out.ok).toBe(true)
    expect(out.result.images[0].url).toBe('https://x/y.png')
    expect(out.result.seed).toBe(42)
  })

  test('adapter throwing untyped error is classified', async () => {
    const fakeAdapter = async () => { throw Object.assign(new Error('boom'), { status: 401 }) }
    const out = await runImage(envelope(), { resolveAdapter: () => fakeAdapter })
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('AUTH_INVALID')
  })

  test('adapter throwing with typed payload passes through', async () => {
    const fakeAdapter = async () => {
      const err = new Error('custom')
      err.typed = { message: 'custom', severity: 'error', retryable: false, type: 'PROVIDER_ERROR' }
      throw err
    }
    const out = await runImage(envelope(), { resolveAdapter: () => fakeAdapter })
    expect(out.ok).toBe(false)
    expect(out.error.type).toBe('PROVIDER_ERROR')
  })
})

describe('openai image adapter', () => {
  beforeEach(() => setCatalog({}))

  test('passes prompt and model; maps response.data to ImageData', async () => {
    const captured = {}
    const client = {
      images: {
        generate: async (req) => {
          captured.req = req
          return { data: [{ url: 'https://openai.test/1.png' }, { b64_json: 'abc==' }] }
        }
      }
    }
    const out = await openaiImage(envelope(), { client })
    expect(captured.req.model).toBe('dall-e-3')
    expect(captured.req.prompt).toBe('a red cube')
    expect(out.status).toBe('completed')
    expect(out.images).toEqual([
      { mimeType: 'image/png', url: 'https://openai.test/1.png', base64: undefined },
      { mimeType: 'image/png', url: undefined, base64: 'abc==' }
    ])
    expect(out.seed).toBeNull()
  })

  test('envelope.size wins over spec.imageDefaultSize', async () => {
    setCatalog({ 'openai/dall-e-3': { imageDefaultSize: '256x256' } })
    const captured = {}
    const client = {
      images: { generate: async (req) => { captured.req = req; return { data: [] } } }
    }
    await openaiImage(envelope({ size: '1024x1024' }), { client })
    expect(captured.req.size).toBe('1024x1024')
  })

  test('falls back to spec.imageDefaultSize when envelope.size missing', async () => {
    setCatalog({ 'openai/dall-e-3': { imageDefaultSize: '512x512' } })
    const captured = {}
    const client = {
      images: { generate: async (req) => { captured.req = req; return { data: [] } } }
    }
    await openaiImage(envelope(), { client })
    expect(captured.req.size).toBe('512x512')
  })

  test('omits size when neither configured', async () => {
    const captured = {}
    const client = {
      images: { generate: async (req) => { captured.req = req; return { data: [] } } }
    }
    await openaiImage(envelope(), { client })
    expect(captured.req.size).toBeUndefined()
  })

  test('401 is classified as AUTH_INVALID', async () => {
    const client = {
      images: {
        generate: async () => { throw Object.assign(new Error('unauth'), { status: 401 }) }
      }
    }
    await expect(openaiImage(envelope(), { client })).rejects.toMatchObject({
      typed: { type: 'AUTH_INVALID' }
    })
  })
})

describe('novita image adapter', () => {
  beforeEach(() => setCatalog({ 'novita/flux-dev': { imageEndpoint: 'flux-dev' } }))

  test('missing imageEndpoint throws PROVIDER_ERROR', async () => {
    setCatalog({})
    await expect(
      novitaImage(envelope({ model: 'novita/flux-dev' }), {
        fetch: async () => { throw new Error('unreachable') }
      })
    ).rejects.toMatchObject({ typed: { type: 'PROVIDER_ERROR' } })
  })

  test('submit + poll flow returns images and seed', async () => {
    const calls = []
    let pollCount = 0
    const fetchFn = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/v3/async/flux-dev')) {
        return { ok: true, status: 200, json: async () => ({ task_id: 'tk-1' }) }
      }
      if (url.includes('/task-result')) {
        pollCount++
        if (pollCount < 2) {
          return { ok: true, status: 200, json: async () => ({ task: { status: 'TASK_STATUS_QUEUED' } }) }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            task: { status: 'TASK_STATUS_SUCCEED', seed: 777 },
            images: [{ image_url: 'https://cdn.novita/img.webp', image_type: 'webp' }]
          })
        }
      }
      throw new Error(`unexpected url: ${url}`)
    }
    const out = await novitaImage(envelope({ model: 'novita/flux-dev', size: '1024x1024' }), {
      fetch: fetchFn,
      sleep: async () => {},
      now: () => 0
    })
    expect(out.status).toBe('completed')
    expect(out.images).toEqual([{ mimeType: 'image/webp', url: 'https://cdn.novita/img.webp' }])
    expect(out.seed).toBe(777)

    const submitBody = JSON.parse(calls[0].init.body)
    expect(submitBody.prompt).toBe('a red cube')
    expect(submitBody.size).toBe('1024*1024')
  })

  test('seed is forwarded when set', async () => {
    let submitted
    const fetchFn = async (url, init) => {
      if (url.includes('/v3/async/flux-dev')) {
        submitted = JSON.parse(init.body)
        return { ok: true, status: 200, json: async () => ({ task_id: 'tk' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          task: { status: 'TASK_STATUS_SUCCEED' },
          images: []
        })
      }
    }
    await novitaImage(envelope({ model: 'novita/flux-dev', seed: 123 }), {
      fetch: fetchFn, sleep: async () => {}, now: () => 0
    })
    expect(submitted.seed).toBe(123)
  })

  test('failed task throws PROVIDER_ERROR', async () => {
    const fetchFn = async (url) => {
      if (url.includes('/v3/async/flux-dev')) {
        return { ok: true, status: 200, json: async () => ({ task_id: 'tk' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ task: { status: 'TASK_STATUS_FAILED', reason: 'content-policy' } })
      }
    }
    await expect(
      novitaImage(envelope({ model: 'novita/flux-dev' }), {
        fetch: fetchFn, sleep: async () => {}, now: () => 0
      })
    ).rejects.toMatchObject({ typed: { type: 'PROVIDER_ERROR' } })
  })

  test('submit HTTP 401 maps to AUTH_INVALID', async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized'
    })
    await expect(
      novitaImage(envelope({ model: 'novita/flux-dev' }), {
        fetch: fetchFn, sleep: async () => {}, now: () => 0
      })
    ).rejects.toMatchObject({ typed: { type: 'AUTH_INVALID' } })
  })

  // F45: TypedError.message must stay stable + machine-readable;
  // provider response bodies belong in `detail`.
  test('submit failure: body goes to detail, not message', async () => {
    const fetchFn = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":"bad key sk-xxxxx"}'
    })
    try {
      await novitaImage(envelope({ model: 'novita/flux-dev' }), {
        fetch: fetchFn, sleep: async () => {}, now: () => 0
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.typed.type).toBe('AUTH_INVALID')
      expect(e.typed.message).not.toContain('sk-xxxxx')
      expect(e.typed.message).not.toContain('bad key')
      expect(e.typed.detail).toContain('novita submit failed')
      expect(e.typed.detail).toContain('sk-xxxxx')
    }
  })

  test('task failure: reason goes to detail, not message', async () => {
    const fetchFn = async (url, opts) => {
      if (opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ task_id: 'tk' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ task: { status: 'TASK_STATUS_FAILED', reason: 'nsfw-policy' } })
      }
    }
    try {
      await novitaImage(envelope({ model: 'novita/flux-dev' }), {
        fetch: fetchFn, sleep: async () => {}, now: () => 0
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e.typed.type).toBe('PROVIDER_ERROR')
      expect(e.typed.message).toBe('novita image failed')
      expect(e.typed.message).not.toContain('nsfw-policy')
      expect(e.typed.detail).toBe('nsfw-policy')
    }
  })

  test('polling deadline throws PROVIDER_UNAVAILABLE', async () => {
    let timeCursor = 0
    const fetchFn = async (url) => {
      if (url.includes('/v3/async/flux-dev')) {
        return { ok: true, status: 200, json: async () => ({ task_id: 'tk' }) }
      }
      timeCursor += 60_000
      return {
        ok: true,
        status: 200,
        json: async () => ({ task: { status: 'TASK_STATUS_QUEUED' } })
      }
    }
    await expect(
      novitaImage(envelope({ model: 'novita/flux-dev' }), {
        fetch: fetchFn, sleep: async () => {}, now: () => timeCursor
      })
    ).rejects.toMatchObject({ typed: { type: 'PROVIDER_UNAVAILABLE' } })
  })
})
