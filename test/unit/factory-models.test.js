import { describe, test, expect } from 'vitest'
import http from 'node:http'

import mohdel from '../../src/lib/index.js'

const logger = { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} }

async function withServer (fn) {
  const seen = {}
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.request = JSON.parse(body)
      seen.authorization = req.headers.authorization
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, seen)
  } finally {
    server.close()
  }
}

function modelsFor (baseURL, prices) {
  return { 'local/lib-model': { model: 'lib-tag:1b', provider: 'local', baseURL, ...prices } }
}

describe('factory `models` / `configurations` overrides', () => {
  test('`models` alone replaces the catalog: wire name and prices come from the entry', async () => {
    await withServer(async (baseURL, seen) => {
      const mo = await mohdel({ models: modelsFor(baseURL, { inputPrice: 2_000_000, outputPrice: 3_000_000 }), logger })
      const result = await mo.use('local/lib-model').answer('hi')
      expect(seen.request.model).toBe('lib-tag:1b')
      expect(result.status).toBe('completed')
      expect(result.output).toBe('ok')
      expect(result.cost).toBe(5)
    })
  })

  test('`models` alone: a key outside the table is unknown to use() and list()', async () => {
    const mo = await mohdel({ models: modelsFor('http://127.0.0.1:1/v1', {}), logger })
    expect(mo.list().map(m => m.value)).toEqual(['local/lib-model'])
    expect(() => mo.use('anthropic/claude-sonnet-4-6')).toThrow(/not found in catalog/)
  })

  test('`configurations[provider]` overrides the key for that provider', async () => {
    await withServer(async (baseURL, seen) => {
      const mo = await mohdel({ models: modelsFor(baseURL, {}), configurations: { local: { apiKey: 'tok' } }, logger })
      await mo.use('local/lib-model').answer('hi')
      expect(seen.authorization).toBe('Bearer tok')
    })
  })

  test('an aborted `signal` stops the call before any request is sent', async () => {
    await withServer(async (baseURL, seen) => {
      const mo = await mohdel({ models: modelsFor(baseURL, {}), logger })
      const controller = new AbortController()
      controller.abort()
      await mo.use('local/lib-model').answer('hi', { signal: controller.signal }).catch(() => {})
      expect(seen.request).toBeUndefined()
    })
  })
})
