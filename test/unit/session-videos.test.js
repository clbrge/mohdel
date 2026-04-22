import { describe, test, expect } from 'vitest'

import { loadVideos } from '../../js/session/adapters/_videos.js'
import { gemini } from '../../js/session/adapters/gemini.js'

// ---------- _videos loader ----------

describe('_videos loadVideos', () => {
  test('https:// URI passes through as fileData', async () => {
    const parts = await loadVideos(
      [{ fileUri: 'https://example.com/clip.mp4', mimeType: 'video/mp4' }],
      { client: stubClient() }
    )
    expect(parts).toEqual([
      { fileData: { fileUri: 'https://example.com/clip.mp4', mimeType: 'video/mp4' } }
    ])
  })

  test('data: URI becomes inlineData with the base64 payload', async () => {
    const parts = await loadVideos(
      [{ fileUri: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4' }],
      { client: stubClient() }
    )
    expect(parts).toEqual([{ inlineData: { data: 'AAAA', mimeType: 'video/mp4' } }])
  })

  test('small local file is inlined as base64', async () => {
    const { client } = stubClient({ failIfCalled: true })
    const parts = await loadVideos(
      [{ fileUri: 'file:///tmp/clip.mp4', mimeType: 'video/mp4' }],
      {
        client,
        readFile: async () => Buffer.from([0x01, 0x02, 0x03, 0x04]),
        stat: async () => ({ size: 4 })
      }
    )
    expect(parts).toEqual([
      { inlineData: { data: Buffer.from([1, 2, 3, 4]).toString('base64'), mimeType: 'video/mp4' } }
    ])
  })

  test('large local file triggers upload + fileData', async () => {
    const captured = {}
    const client = {
      files: {
        upload: async (args) => {
          captured.upload = args
          return { name: 'files/xyz', uri: 'https://gen/files/xyz', state: 'ACTIVE' }
        },
        get: async () => { throw new Error('should not poll — already ACTIVE') }
      }
    }
    const parts = await loadVideos(
      [{ fileUri: 'file:///tmp/big.mp4', mimeType: 'video/mp4' }],
      {
        client,
        readFile: async () => { throw new Error('should not read bytes for upload path') },
        stat: async () => ({ size: 100 * 1024 * 1024 })
      }
    )
    expect(parts).toEqual([
      { fileData: { fileUri: 'https://gen/files/xyz', mimeType: 'video/mp4' } }
    ])
    expect(captured.upload.file).toBe('/tmp/big.mp4')
    expect(captured.upload.config.mimeType).toBe('video/mp4')
  })

  test('useCache=true forces upload even for small files', async () => {
    const client = {
      files: {
        upload: async () => ({ name: 'files/c', uri: 'https://gen/c', state: 'ACTIVE' }),
        get: async () => { throw new Error('unused') }
      }
    }
    const parts = await loadVideos(
      [{ fileUri: 'file:///tmp/tiny.mp4', mimeType: 'video/mp4' }],
      {
        client,
        useCache: true,
        readFile: async () => Buffer.from([1]),
        stat: async () => ({ size: 1 })
      }
    )
    expect(parts[0]).toEqual({
      fileData: { fileUri: 'https://gen/c', mimeType: 'video/mp4' }
    })
  })

  test('upload polls PROCESSING state until ACTIVE', async () => {
    let getCalls = 0
    const client = {
      files: {
        upload: async () => ({ name: 'files/p', state: 'PROCESSING' }),
        get: async ({ name }) => {
          expect(name).toBe('files/p')
          getCalls++
          if (getCalls < 3) return { name, state: 'PROCESSING' }
          return { name, uri: 'https://gen/p', state: 'ACTIVE' }
        }
      }
    }
    const parts = await loadVideos(
      [{ fileUri: 'file:///tmp/x.mp4', mimeType: 'video/mp4' }],
      {
        client,
        sleep: async () => {}, // skip the 5s wait
        readFile: async () => Buffer.from([]),
        stat: async () => ({ size: 100 * 1024 * 1024 })
      }
    )
    expect(getCalls).toBe(3)
    expect(parts[0].fileData.fileUri).toBe('https://gen/p')
  })

  test('upload FAILED state throws', async () => {
    const client = {
      files: {
        upload: async () => ({ name: 'files/f', state: 'FAILED' }),
        get: async () => ({ state: 'FAILED' })
      }
    }
    await expect(loadVideos(
      [{ fileUri: 'file:///tmp/x.mp4', mimeType: 'video/mp4' }],
      {
        client,
        sleep: async () => {},
        readFile: async () => Buffer.from([]),
        stat: async () => ({ size: 100 * 1024 * 1024 })
      }
    )).rejects.toThrow(/file processing failed/i)
  })

  test('deadline reached while still PROCESSING → typed PROVIDER_UNAVAILABLE', async () => {
    // Mock clock advances by 30s per tick — 5 min deadline hits fast.
    let clock = 0
    const now = () => clock
    const advance = () => { clock += 30_000 }

    const client = {
      files: {
        upload: async () => ({ name: 'files/stuck', state: 'PROCESSING' }),
        get: async () => {
          advance()
          return { name: 'files/stuck', state: 'PROCESSING' }
        }
      }
    }

    await expect(loadVideos(
      [{ fileUri: 'file:///tmp/stuck.mp4', mimeType: 'video/mp4' }],
      {
        client,
        sleep: async () => {}, // don't actually wait
        now,
        readFile: async () => Buffer.from([]),
        stat: async () => ({ size: 100 * 1024 * 1024 })
      }
    )).rejects.toMatchObject({
      typed: { type: 'PROVIDER_UNAVAILABLE', retryable: true }
    })
  })

  test('aborted signal mid-poll → AbortError before next SDK call', async () => {
    const controller = new AbortController()
    let pollCount = 0
    const client = {
      files: {
        upload: async () => ({ name: 'files/p', state: 'PROCESSING' }),
        get: async () => {
          pollCount++
          return { name: 'files/p', state: 'PROCESSING' }
        }
      }
    }
    // Abort after one successful poll tick.
    const sleep = async () => {
      if (pollCount >= 1) controller.abort()
    }

    await expect(loadVideos(
      [{ fileUri: 'file:///tmp/a.mp4', mimeType: 'video/mp4' }],
      {
        client,
        sleep,
        signal: controller.signal,
        readFile: async () => Buffer.from([]),
        stat: async () => ({ size: 100 * 1024 * 1024 })
      }
    )).rejects.toThrow(/aborted/)
    // Exactly one poll happened; the abort interrupted the loop.
    expect(pollCount).toBe(1)
  })

  test('pre-aborted signal short-circuits before upload', async () => {
    const controller = new AbortController()
    controller.abort()
    let uploadCalled = false
    const client = {
      files: {
        upload: async () => { uploadCalled = true; return { uri: 'x', state: 'ACTIVE' } },
        get: async () => { throw new Error('unused') }
      }
    }
    await expect(loadVideos(
      [{ fileUri: 'file:///tmp/a.mp4', mimeType: 'video/mp4' }],
      {
        client,
        sleep: async () => {},
        signal: controller.signal,
        readFile: async () => Buffer.from([]),
        stat: async () => ({ size: 100 * 1024 * 1024 })
      }
    )).rejects.toThrow(/aborted/)
    expect(uploadCalled).toBe(false)
  })

  test('entries missing fileUri or mimeType are skipped', async () => {
    const parts = await loadVideos(
      [
        { fileUri: 'https://a/1.mp4', mimeType: 'video/mp4' },
        { fileUri: 'https://a/2.mp4' }, // missing mimeType
        { mimeType: 'video/mp4' } // missing fileUri
      ],
      { client: stubClient() }
    )
    expect(parts).toHaveLength(1)
  })
})

// ---------- Gemini adapter wiring ----------

describe('gemini video injection', () => {
  test('https:// video appears as fileData on the last user content', async () => {
    const { client, captured } = mockGemini([
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }
    ])
    await collect(gemini(envelope('gemini', 'gemini-2.5-flash', {
      videos: [{ fileUri: 'https://example.com/clip.mp4', mimeType: 'video/mp4' }]
    }), { client }))
    const userContent = captured.request.contents.find(c => c.role === 'user')
    const filePart = userContent.parts.find(p => p.fileData)
    expect(filePart).toEqual({
      fileData: { fileUri: 'https://example.com/clip.mp4', mimeType: 'video/mp4' }
    })
  })

  // Upload-failure → adapter yields an `error` event is the same
  // wiring pattern as images; covered by `_videos loadVideos` upload
  // failure tests above + the image adapter equivalent in
  // `session-images.test.js`.

  test('pre-aborted signal yields a cancelled done terminal (not an error)', async () => {
    // loadVideos throws AbortError at the top of its loop before any
    // file ops run, so no tmp file plumbing is needed — the adapter's
    // signal-aware catch converts the AbortError into a cancelled
    // terminal, matching every other adapter's cancel semantics.
    const controller = new AbortController()
    controller.abort()

    const { client } = mockGemini([])
    const events = await collect(gemini(envelope('gemini', 'gemini-2.5-flash', {
      videos: [{ fileUri: 'file:///tmp/never-read.mp4', mimeType: 'video/mp4' }]
    }), { client, signal: controller.signal }))

    const terminal = events.at(-1)
    expect(terminal.type).toBe('done')
    expect(terminal.result.status).toBe('incomplete')
    expect(terminal.result.warning).toBe('cancelled')
  })
})

// ---------- helpers ----------

function stubClient ({ failIfCalled = false } = {}) {
  const throwing = () => {
    if (failIfCalled) throw new Error('client should not have been called for this case')
    return Promise.resolve({})
  }
  return {
    client: {
      files: { upload: throwing, get: throwing }
    }
  }
}

function envelope (provider, model, overrides = {}) {
  return {
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    provider,
    model,
    prompt: 'describe this',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

function mockGemini (chunks) {
  const captured = {}
  return {
    client: {
      models: {
        generateContentStream (req) {
          captured.request = req
          return (async function * () { for (const c of chunks) yield c })()
        }
      },
      files: {
        // real local-file paths aren't hit in these tests; stub as no-ops
        upload: async () => { throw new Error('unused in this test') },
        get: async () => { throw new Error('unused in this test') }
      }
    },
    captured
  }
}
