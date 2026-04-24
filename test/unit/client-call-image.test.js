import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { callImage } from '../../js/client/call_image.js'

// F25: one-shot image path: POST /v1/image → single JSON body.

/** @type {http.Server} */
let server
/** @type {string} */
let sockPath
/** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
let handler

beforeAll(async () => {
  sockPath = path.join(os.tmpdir(), `mohdel-client-image-${process.pid}.sock`)
  try { fs.unlinkSync(sockPath) } catch {}
  server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(sockPath, resolve))
})

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()))
  try { fs.unlinkSync(sockPath) } catch {}
})

function envelope (overrides = {}) {
  return {
    callId: 'i1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'openai/gpt-image-1',
    prompt: 'red sphere',
    ...overrides
  }
}

describe('client/callImage — happy path', () => {
  test('returns ImageResult parsed from JSON response', async () => {
    const result = {
      status: 'completed',
      images: [{ mimeType: 'image/png', url: 'https://cdn/ex.png' }],
      seed: 42,
      timestamps: { start: '0', first: '1', end: '1' }
    }
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    }

    const out = await callImage(envelope(), { socketPath: sockPath })
    expect(out.status).toBe('completed')
    expect(out.images).toHaveLength(1)
    expect(out.images[0].url).toBe('https://cdn/ex.png')
    expect(out.seed).toBe(42)
  })

  test('hits /v1/image by default', async () => {
    let capturedPath = null
    handler = (req, res) => {
      capturedPath = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        status: 'completed',
        images: [],
        seed: null,
        timestamps: { start: '0', first: '0', end: '0' }
      }))
    }
    await callImage(envelope(), { socketPath: sockPath })
    expect(capturedPath).toBe('/v1/image')
  })
})

describe('client/callImage — error paths', () => {
  test('5xx with unparseable body → PROTOCOL_HTTP_ERROR retryable', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('overloaded')
    }
    try {
      await callImage(envelope(), { socketPath: sockPath })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_HTTP_ERROR')
      expect(err.retryable).toBe(true)
    }
  })

  test('non-200 with typed-error JSON passes the type through', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'AUTH_INVALID', message: 'bad key', severity: 'error', retryable: false }))
    }
    try {
      await callImage(envelope(), { socketPath: sockPath })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('AUTH_INVALID')
      expect(err.message).toBe('bad key')
    }
  })

  test('200 with malformed JSON → PROTOCOL_INVALID_EVENT', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('not json')
    }
    try {
      await callImage(envelope(), { socketPath: sockPath })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_INVALID_EVENT')
    }
  })

  test('200 with result missing required fields → PROTOCOL_INVALID_EVENT', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed' })) // no `images` array
    }
    try {
      await callImage(envelope(), { socketPath: sockPath })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_INVALID_EVENT')
    }
  })
})
