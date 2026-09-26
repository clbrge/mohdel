import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { call } from '../../js/client/call.js'
import { callEmbedding } from '../../js/client/call_embedding.js'

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

// ---------- Caller headers ----------

describe('client — caller headers', () => {
  test('call sends them with the request', async () => {
    let seen = null
    handler = (req, res) => {
      seen = req.headers['x-router-key']
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(JSON.stringify({
        type: 'done',
        result: { status: 'completed', output: 'ok', inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cost: 0, timestamps: { start: '0', first: '0', end: '0' } }
      }) + '\n')
    }
    await collect(call(envelope(), { socketPath: sockPath, headers: { 'x-router-key': 'k1' } }))
    expect(seen).toBe('k1')
  })

  test('callEmbedding sends them with the request', async () => {
    let seen = null
    handler = (req, res) => {
      seen = req.headers['x-router-key']
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ vectors: [[0.1]], dimensions: 1, inputType: null, inputTokens: 1, cost: 0 }))
    }
    await callEmbedding({ callId: 'e1', authId: 'a1', auth: { key: 'k' }, model: 'echo/e', input: ['x'] },
      { socketPath: sockPath, headers: { 'x-router-key': 'k2' } })
    expect(seen).toBe('k2')
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

// ---------- Caller abort → aborted terminal ----------

describe('client/call — abort', () => {
  const doneLine = (result) => JSON.stringify({ type: 'done', result }) + '\n'
  const deltaLine = (type, delta) => JSON.stringify({ type: 'delta', delta: { type, delta } }) + '\n'
  const readBody = (req) => new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => resolve(b))
  })

  test('abort mid-stream → posts /v1/abort and ends with the gate\'s aborted done, usage kept', async () => {
    const aborted = {
      status: 'incomplete',
      output: 'hel',
      inputTokens: 7,
      outputTokens: 2,
      thinkingTokens: 0,
      cost: 0.0003,
      timestamps: { start: '1', first: '2', end: '3' },
      warning: 'aborted'
    }
    let callRes = null
    let abortRequest = null
    handler = async (req, res) => {
      if (req.url === '/v1/abort') {
        abortRequest = { body: JSON.parse(await readBody(req)), key: req.headers['x-router-key'] }
        res.writeHead(202)
        res.end()
        callRes.end(doneLine(aborted))
        return
      }
      callRes = res
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'mohdel-gate': 'g1' })
      res.write(deltaLine('message', 'hel'))
      res.write(deltaLine('function_call', '{"a":1}'))
    }

    const controller = new AbortController()
    const events = []
    const options = { socketPath: sockPath, signal: controller.signal, headers: { 'x-router-key': 'k1' } }
    for await (const ev of call(envelope(), options)) {
      events.push(ev)
      if (events.length === 2) controller.abort()
    }
    expect(events.map(e => e.type)).toEqual(['delta', 'delta', 'done'])
    expect(events.at(-1).result).toEqual(aborted)
    expect(abortRequest).toEqual({ body: { callId: 'c1', authId: 'a1', gate: 'g1' }, key: 'k1' })
  })

  test('abort answered CALL_NOT_FOUND → the call had ended; its own terminal arrives', async () => {
    let callRes = null
    handler = (req, res) => {
      if (req.url === '/v1/abort') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'no such call in flight', severity: 'warn', retryable: false, type: 'CALL_NOT_FOUND' }))
        callRes.end(doneLine({
          status: 'completed',
          output: 'hello',
          inputTokens: 1,
          outputTokens: 1,
          thinkingTokens: 0,
          cost: 0,
          timestamps: { start: '0', first: '0', end: '0' }
        }))
        return
      }
      callRes = res
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'mohdel-gate': 'g1' })
      res.write(deltaLine('message', 'hello'))
    }

    const controller = new AbortController()
    const events = []
    for await (const ev of call(envelope(), { socketPath: sockPath, signal: controller.signal })) {
      events.push(ev)
      controller.abort()
    }
    expect(events.map(e => e.type)).toEqual(['delta', 'done'])
    expect(events.at(-1).result.status).toBe('completed')
  })

  const refusedAbort = async (callHeaders, abortStatus, abortType) => {
    let abortPosted = false
    handler = (req, res) => {
      if (req.url === '/v1/abort') {
        abortPosted = true
        res.writeHead(abortStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'refused', severity: 'error', retryable: false, type: abortType }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson', ...callHeaders })
      res.write(deltaLine('message', 'hel'))
      req.on('close', () => res.destroy())
    }

    const controller = new AbortController()
    const events = []
    try {
      for await (const ev of call(envelope(), { socketPath: sockPath, signal: controller.signal })) {
        events.push(ev)
        controller.abort()
      }
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(events.map(e => e.type)).toEqual(['delta'])
      return { type: err.type, abortPosted }
    }
  }

  test('abort at a gate that did not stream the call → throws CALL_MISDIRECTED', async () => {
    const { type } = await refusedAbort({ 'mohdel-gate': 'g1' }, 421, 'CALL_MISDIRECTED')
    expect(type).toBe('CALL_MISDIRECTED')
  })

  test('abort refused by a router without the route → throws the refusal', async () => {
    const { type } = await refusedAbort({ 'mohdel-gate': 'g1' }, 404, 'PROTOCOL_NOT_FOUND')
    expect(type).toBe('PROTOCOL_NOT_FOUND')
  })

  test('call response without mohdel-gate → abort throws PROTOCOL_GATE_UNIDENTIFIED, posts nothing', async () => {
    const { type, abortPosted } = await refusedAbort({}, 202, 'unused')
    expect(type).toBe('PROTOCOL_GATE_UNIDENTIFIED')
    expect(abortPosted).toBe(false)
  })

  test('already-aborted signal → aborted done without connecting', async () => {
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
    expect(events[0].result.warning).toBe('aborted')
    expect(events[0].result.output).toBe(null)
  })

  test('abort after the terminal arrived → single terminal, no abort posted', async () => {
    let abortPosted = false
    handler = (req, res) => {
      if (req.url === '/v1/abort') {
        abortPosted = true
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: 'no such call in flight', severity: 'warn', retryable: false, type: 'CALL_NOT_FOUND' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(doneLine({
        status: 'completed',
        output: 'ok',
        inputTokens: 1,
        outputTokens: 1,
        thinkingTokens: 0,
        cost: 0,
        timestamps: { start: '0', first: '0', end: '0' }
      }))
    }

    const controller = new AbortController()
    const events = []
    for await (const ev of call(envelope(), { socketPath: sockPath, signal: controller.signal })) {
      events.push(ev)
      if (ev.type === 'done') controller.abort()
    }
    expect(events.map(e => e.type)).toEqual(['done'])
    expect(events[0].result.status).toBe('completed')
    expect(abortPosted).toBe(false)
  })
})

describe('client/call — abort while the response headers are still pending', () => {
  test('→ aborted done, no throw', async () => {
    handler = (req, res) => {
      // Holds the request without answering; only the client's abort ends it.
      req.on('close', () => res.destroy())
    }

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const events = await collect(call(envelope(), { socketPath: sockPath, signal: controller.signal }))
    expect(events.map(e => e.type)).toEqual(['done'])
    expect(events[0].result.status).toBe('incomplete')
    expect(events[0].result.warning).toBe('aborted')
    expect(events[0].result.output).toBe(null)
  })
})
