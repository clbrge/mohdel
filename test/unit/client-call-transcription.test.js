import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { callTranscription } from '../../js/client/call_transcription.js'

// One-shot transcription path: POST /v1/transcription → single JSON body.

/** @type {http.Server} */
let server
/** @type {string} */
let sockPath
/** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
let handler

beforeAll(async () => {
  sockPath = path.join(os.tmpdir(), `mohdel-client-transcription-${process.pid}.sock`)
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
    callId: 't1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'groq/whisper-large-v3',
    audio: { fileUri: 'file:///tmp/clip.wav', mimeType: 'audio/wav' },
    ...overrides
  }
}

function result (overrides = {}) {
  return {
    status: 'completed',
    text: 'hello world',
    language: 'en',
    durationSeconds: 2.5,
    cost: 0.0000167,
    timestamps: { start: '0', first: '1', end: '1' },
    ...overrides
  }
}

describe('client/callTranscription — happy path', () => {
  test('returns TranscriptionResult parsed from JSON response', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result()))
    }

    const out = await callTranscription(envelope(), { socketPath: sockPath })
    expect(out.status).toBe('completed')
    expect(out.text).toBe('hello world')
    expect(out.language).toBe('en')
    expect(out.durationSeconds).toBe(2.5)
  })

  test('hits /v1/transcription by default', async () => {
    let capturedPath = null
    handler = (req, res) => {
      capturedPath = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result()))
    }
    await callTranscription(envelope(), { socketPath: sockPath })
    expect(capturedPath).toBe('/v1/transcription')
  })
})

describe('client/callTranscription — error paths', () => {
  test('5xx with unparseable body → PROTOCOL_HTTP_ERROR retryable', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('overloaded')
    }
    try {
      await callTranscription(envelope(), { socketPath: sockPath })
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
      await callTranscription(envelope(), { socketPath: sockPath })
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
      await callTranscription(envelope(), { socketPath: sockPath })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_INVALID_EVENT')
    }
  })

  test('200 with result missing required fields → PROTOCOL_INVALID_EVENT', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed' })) // no `text` string
    }
    try {
      await callTranscription(envelope(), { socketPath: sockPath })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_INVALID_EVENT')
    }
  })
})
