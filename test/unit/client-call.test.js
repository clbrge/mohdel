import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { call } from '../../js/client/call.js'

// ---------- Test harness ----------
//
// Each test spins up a local HTTP server listening on a unix socket
// and controls the response via a handler it installs. Matches the
// real thin-gate wire shape: 200 + NDJSON Event stream on the happy
// path, non-200 + TypedError JSON / unparseable body on errors.

/** @type {http.Server} */
let server
/** @type {string} */
let sockPath
/** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
let handler

beforeAll(async () => {
  sockPath = path.join(os.tmpdir(), `mohdel-client-call-${process.pid}.sock`)
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
    callId: 'c1',
    authId: 'a1',
    auth: { key: 'k' },
    model: 'echo/m',
    prompt: 'hi',
    ...overrides
  }
}

async function collect (iter) {
  const out = []
  for await (const v of iter) out.push(v)
  return out
}

// ---------- Happy path (pins the fromJSON branch distinction) ----------

describe('client/call — happy path', () => {
  test('iterates Events from NDJSON body', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ type: 'delta', delta: { type: 'message', delta: 'hello' } }) + '\n')
      res.end(JSON.stringify({
        type: 'done',
        result: {
          status: 'completed',
          output: 'hello',
          inputTokens: 1,
          outputTokens: 1,
          thinkingTokens: 0,
          cost: 0,
          timestamps: { start: '0', first: '0', end: '0' }
        }
      }) + '\n')
    }

    const events = await collect(call(envelope(), { socketPath: sockPath }))
    expect(events.map(e => e.type)).toEqual(['delta', 'done'])
    expect(events.at(-1).result.status).toBe('completed')
  })
})

// ---------- non-Event body ----------

describe('client/call — non-Event object in stream', () => {
  test('throws MohdelError with PROTOCOL_INVALID_EVENT type', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      // Valid JSON, but not an Event shape (no `type` discriminator).
      res.end(JSON.stringify({ not: 'an event' }) + '\n')
    }

    try {
      await collect(call(envelope(), { socketPath: sockPath }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.name).toBe('MohdelError')
      expect(err.message).toBe('received non-Event object from thin-gate')
      expect(err.type).toBe('PROTOCOL_INVALID_EVENT')
      expect(err.retryable).toBe(false)
    }
  })
})

// ---------- HTTP-error vocabulary ----------

describe('client/call — HTTP error paths', () => {
  test('5xx with unparseable body → PROTOCOL_HTTP_ERROR retryable', async () => {
    handler = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('upstream overloaded')
    }

    try {
      await collect(call(envelope(), { socketPath: sockPath }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_HTTP_ERROR')
      expect(err.message).toContain('503')
      expect(err.retryable).toBe(true)
    }
  })

  test('4xx with unparseable body → PROTOCOL_HTTP_ERROR non-retryable', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }

    try {
      await collect(call(envelope(), { socketPath: sockPath }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err.type).toBe('PROTOCOL_HTTP_ERROR')
      expect(err.retryable).toBe(false)
    }
  })

  test('non-200 with parseable TypedError JSON passes through via fromJSON', async () => {
    const wireError = {
      message: 'provider rate limit exceeded',
      type: 'RATE_LIMIT',
      severity: 'warn',
      retryable: true,
      detail: 'retry after 30s'
    }
    handler = (_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify(wireError))
    }

    try {
      await collect(call(envelope(), { socketPath: sockPath }))
      expect.unreachable('should have thrown')
    } catch (err) {
      // fromJSON preserves the wire shape verbatim — vocab normalization
      // only applies to the client-synthesized fallback (tested above).
      expect(err.type).toBe('RATE_LIMIT')
      expect(err.message).toBe('provider rate limit exceeded')
      expect(err.severity).toBe('warn')
      expect(err.retryable).toBe(true)
      expect(err.detail).toBe('retry after 30s')
    }
  })
})

// ---------- Caller abort → cancelled terminal ----------

describe('client/call — abort', () => {
  test('abort mid-stream → cancelled done with the relayed partial output, no throw', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ type: 'delta', delta: { type: 'message', delta: 'hel' } }) + '\n')
      res.write(JSON.stringify({ type: 'delta', delta: { type: 'function_call', delta: '{"a":1}' } }) + '\n')
      // Never ends on its own: only the client's abort finishes this call.
      req.on('close', () => res.destroy())
    }

    const controller = new AbortController()
    const events = []
    for await (const ev of call(envelope(), { socketPath: sockPath, signal: controller.signal })) {
      events.push(ev)
      if (events.length === 2) controller.abort()
    }
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
    const done = events.at(-1)
    expect(done.result.status).toBe('incomplete')
    expect(done.result.warning).toBe('cancelled')
    expect(done.result.output).toBe('hel')
    expect(done.result.inputTokens).toBe(0)
    expect(done.result.cost).toBe(0)
  })

  test('already-aborted signal → cancelled done without connecting', async () => {
    let connected = false
    handler = (_req, res) => {
      connected = true
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end()
    }

    const controller = new AbortController()
    controller.abort()
    const events = await collect(call(envelope(), { socketPath: sockPath, signal: controller.signal }))
    expect(connected).toBe(false)
    expect(events.map(e => e.type)).toEqual(['done'])
    expect(events[0].result.warning).toBe('cancelled')
    expect(events[0].result.output).toBe(null)
  })

  test('abort after the terminal arrived → single terminal, no synthesized second one', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({
        type: 'done',
        result: {
          status: 'completed',
          output: 'ok',
          inputTokens: 1,
          outputTokens: 1,
          thinkingTokens: 0,
          cost: 0,
          timestamps: { start: '0', first: '0', end: '0' }
        }
      }) + '\n')
      req.on('close', () => res.destroy())
    }

    const controller = new AbortController()
    const events = []
    for await (const ev of call(envelope(), { socketPath: sockPath, signal: controller.signal })) {
      events.push(ev)
      if (ev.type === 'done') controller.abort()
    }
    expect(events.map(e => e.type)).toEqual(['done'])
    expect(events[0].result.status).toBe('completed')
  })
})

describe('client/call — abort while the response headers are still pending', () => {
  test('→ cancelled done, no throw', async () => {
    handler = (req, res) => {
      // Holds the request without answering; only the client's abort ends it.
      req.on('close', () => res.destroy())
    }

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const events = await collect(call(envelope(), { socketPath: sockPath, signal: controller.signal }))
    expect(events.map(e => e.type)).toEqual(['done'])
    expect(events[0].result.status).toBe('incomplete')
    expect(events[0].result.warning).toBe('cancelled')
    expect(events[0].result.output).toBe(null)
  })
})
