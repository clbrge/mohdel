import { afterEach, describe, expect, it, vi } from 'vitest'

import { mohdexRecommended, mohdexResults } from '../../src/lib/mohdex.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const answering = (status, body) => {
  globalThis.fetch = vi.fn(async () => ({ ok: status === 200, status, json: async () => body }))
  return globalThis.fetch
}

describe('mohdexResults', () => {
  it('asks /v1/results for the tool, the filters it was given and every tag', async () => {
    const fetch = answering(200, {})
    await mohdexResults({ tool: 'spore', provider: 'openrouter', since: '1.51.0', tag: ['suite:conformance', 'tier:core'] })
    const url = new URL(fetch.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://mohdex.dev/v1/results')
    expect(url.searchParams.get('tool')).toBe('spore')
    expect(url.searchParams.get('provider')).toBe('openrouter')
    expect(url.searchParams.get('since')).toBe('1.51.0')
    expect(url.searchParams.getAll('tag')).toEqual(['suite:conformance', 'tier:core'])
    expect(url.searchParams.has('key')).toBe(false)
  })

  it('takes one tag as a string', async () => {
    const fetch = answering(200, {})
    await mohdexResults({ tool: 'spore', tag: 'tier:core' })
    expect(new URL(fetch.mock.calls[0][0]).searchParams.getAll('tag')).toEqual(['tier:core'])
  })

  it('returns the counts as served', async () => {
    const served = { 'openrouter/m': { 'spore/conformance/core/read': { digest: 'd', latestVersion: '1.52.0', runs: 1, passed: 1, failed: 0, reasons: {} } } }
    answering(200, served)
    expect(await mohdexResults({ tool: 'spore' })).toEqual(served)
  })

  it('throws when mohdex refuses', async () => {
    answering(400, 'tool is required')
    await expect(mohdexResults({ tool: 'spore' })).rejects.toThrow('mohdex answered 400')
  })

  it('throws on a body that is not counts', async () => {
    answering(200, [])
    await expect(mohdexResults({ tool: 'spore' })).rejects.toThrow('mohdex returned results mohdel cannot read')
  })
})

describe('mohdexRecommended', () => {
  const models = [{ key: 'openai/gpt-test', version: '1.56.0' }]

  it('asks /v1/recommended for the tool and every tag of the bar', async () => {
    const fetch = answering(200, { models })
    expect(await mohdexRecommended({ tool: 'spore', bar: ['tier:core', 'tier:identity'] })).toEqual(models)
    const url = new URL(fetch.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://mohdex.dev/v1/recommended')
    expect(url.searchParams.get('tool')).toBe('spore')
    expect(url.searchParams.getAll('bar')).toEqual(['tier:core', 'tier:identity'])
  })

  it('takes a bar of one tag as a string', async () => {
    const fetch = answering(200, { models: [] })
    expect(await mohdexRecommended({ tool: 'spore', bar: 'tier:core' })).toEqual([])
    expect(new URL(fetch.mock.calls[0][0]).searchParams.getAll('bar')).toEqual(['tier:core'])
  })

  it('throws on a refusal', async () => {
    answering(400, { error: 'bar is required' })
    await expect(mohdexRecommended({ tool: 'spore', bar: 'tier:core' })).rejects.toThrow('mohdex answered 400')
  })

  it.each([[null], [[]], [{}], [{ models: 'none' }]])('throws on a body without a list of models: %j', async (body) => {
    answering(200, body)
    await expect(mohdexRecommended({ tool: 'spore', bar: 'tier:core' })).rejects.toThrow('cannot read')
  })
})
