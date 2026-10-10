import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { callInfo } from '../../js/client/call_info.js'

/** @type {http.Server} */
let server
/** @type {string} */
let sockPath
/** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
let handler

beforeAll(async () => {
  sockPath = path.join(os.tmpdir(), `mohdel-client-info-${process.pid}.sock`)
  try { fs.unlinkSync(sockPath) } catch {}
  server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(sockPath, resolve))
})

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()))
  try { fs.unlinkSync(sockPath) } catch {}
})

function json (res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

describe('client/callInfo', () => {
  test('posts { model } to /v1/info and returns the entry', async () => {
    let seen = null
    handler = (req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        seen = { url: req.url, method: req.method, body: JSON.parse(body) }
        json(res, 200, { contextWindow: 200000 })
      })
    }
    const entry = await callInfo('echo/m', { socketPath: sockPath })
    expect(entry).toEqual({ contextWindow: 200000 })
    expect(seen).toEqual({ url: '/v1/info', method: 'POST', body: { model: 'echo/m' } })
  })

  test('a model the catalog lacks is null', async () => {
    handler = (_req, res) => json(res, 200, null)
    expect(await callInfo('echo/other', { socketPath: sockPath })).toBeNull()
  })

  test('a refusal is the gate typed error', async () => {
    handler = (_req, res) => json(res, 400, {
      message: 'effort not supported',
      severity: 'error',
      retryable: false,
      type: 'SESSION_INVALID_OUTPUT_EFFORT'
    })
    await expect(callInfo('echo/m:high', { socketPath: sockPath }))
      .rejects.toMatchObject({ name: 'MohdelError', type: 'SESSION_INVALID_OUTPUT_EFFORT' })
  })
})
