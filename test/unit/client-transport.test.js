import http from 'node:http'
import { getEventListeners } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { describe, test, expect, afterEach } from 'vitest'
import { requestUnix } from '../../js/client/transport.js'

const sockets = []

afterEach(() => {
  for (const { server, socketPath } of sockets.splice(0)) {
    server.close()
    fs.rmSync(socketPath, { force: true })
  }
})

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 */
async function listen (handler) {
  const socketPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mohdel-transport-')),
    's.sock'
  )
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(socketPath, resolve))
  sockets.push({ server, socketPath })
  return socketPath
}

const drain = async (res) => {
  let out = ''
  for await (const c of res) out += c.toString('utf8')
  return out
}

describe('requestUnix abort wiring', () => {
  test('a reused AbortSignal does not accumulate listeners across calls', async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const controller = new AbortController()

    for (let i = 0; i < 12; i++) {
      const res = await requestUnix({
        socketPath,
        path: '/v1/call',
        method: 'POST',
        body: { i },
        signal: controller.signal
      })
      await drain(res)
    }

    expect(controller.signal.aborted).toBe(false)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  test('aborting mid-stream still destroys the request', async () => {
    const socketPath = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write('{"type":"delta"}\n')
      // Never ends: only an abort can finish this response.
    })
    const controller = new AbortController()

    const res = await requestUnix({
      socketPath,
      path: '/v1/call',
      method: 'POST',
      body: {},
      signal: controller.signal
    })

    setTimeout(() => controller.abort(), 20)
    await expect(drain(res)).rejects.toThrow()
  })

  test('an already-aborted signal rejects before connecting', async () => {
    const socketPath = await listen((_req, res) => res.end('{}'))
    const controller = new AbortController()
    controller.abort()

    await expect(requestUnix({
      socketPath,
      path: '/v1/call',
      method: 'POST',
      body: {},
      signal: controller.signal
    })).rejects.toThrow('aborted')
  })

  test('works with no signal at all', async () => {
    const socketPath = await listen((_req, res) => res.end('{"ok":true}'))
    const res = await requestUnix({ socketPath, path: '/v1/call', method: 'POST', body: {} })
    expect(await drain(res)).toBe('{"ok":true}')
  })
})
