import { describe, test, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { runInfo } from '../../js/session/run_info.js'
import { drive } from '../../js/session/driver.js'
import { setCatalog } from '../../js/session/adapters/_catalog.js'

const catalog = {
  'acme/chat': {
    contextTokenLimit: 200000,
    inputCeilingMargin: 4000,
    thinkingEffortLevels: { low: 1024, high: 8192 },
    speeds: { fast: { inputPrice: 6 } }
  },
  'acme/plain': { contextTokenLimit: 32000 },
  'acme/v1@2025': { contextTokenLimit: 8000 },
  'acme/embed': { maxBatch: 96, inputTypes: { query: 'search_query' }, dimensionsSelectable: true }
}

const resolveSpec = key => catalog[key]
const lanes = async () => ({ speedLanes: new Set(['fast']) })
const noAdapter = async () => { throw new Error('adapter must not load without a speed lane') }

describe('session/run_info', () => {
  test('exact key returns a copy of the entry', async () => {
    const out = await runInfo({ model: 'acme/embed' }, { resolveSpec, resolveAdapter: noAdapter })
    expect(out).toEqual({ ok: true, result: catalog['acme/embed'] })
    if (out.ok) expect(out.result).not.toBe(catalog['acme/embed'])
  })

  test('unknown model is null', async () => {
    expect(await runInfo({ model: 'acme/nope' }, { resolveSpec, resolveAdapter: noAdapter }))
      .toEqual({ ok: true, result: null })
    expect(await runInfo({ model: 'acme/nope:high@fast' }, { resolveSpec, resolveAdapter: noAdapter }))
      .toEqual({ ok: true, result: null })
  })

  test('a catalog key containing a suffix sigil resolves whole', async () => {
    const out = await runInfo({ model: 'acme/v1@2025' }, { resolveSpec, resolveAdapter: noAdapter })
    expect(out).toEqual({ ok: true, result: catalog['acme/v1@2025'] })
  })

  test('a valid effort suffix returns the base entry', async () => {
    const out = await runInfo({ model: 'acme/chat:high' }, { resolveSpec, resolveAdapter: noAdapter })
    expect(out).toEqual({ ok: true, result: catalog['acme/chat'] })
  })

  test('an effort the entry lacks is the call\'s error', async () => {
    const out = await runInfo({ model: 'acme/chat:max' }, { resolveSpec, resolveAdapter: noAdapter })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.type).toBe('SESSION_INVALID_OUTPUT_EFFORT')
    const none = await runInfo({ model: 'acme/plain:low' }, { resolveSpec, resolveAdapter: noAdapter })
    if (!none.ok) expect(none.error.type).toBe('SESSION_INVALID_OUTPUT_EFFORT')
    expect(none.ok).toBe(false)
  })

  test('a speed lane is folded in as `speed`, lane overlay left as declared', async () => {
    const out = await runInfo({ model: 'acme/chat:low@fast' }, { resolveSpec, resolveAdapter: lanes })
    expect(out).toEqual({ ok: true, result: { ...catalog['acme/chat'], speed: 'fast' } })
  })

  test('a lane the entry does not declare is the call\'s error', async () => {
    const out = await runInfo({ model: 'acme/plain@fast' }, { resolveSpec, resolveAdapter: lanes })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.type).toBe('SESSION_INVALID_SPEED')
  })

  test('a declared lane the adapter cannot serve is the call\'s error', async () => {
    const out = await runInfo({ model: 'acme/chat@fast' }, { resolveSpec, resolveAdapter: async () => ({}) })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.type).toBe('SESSION_SPEED_NOT_IMPLEMENTED')
  })

  test('a lane on a provider without an adapter is SESSION_UNKNOWN_PROVIDER', async () => {
    const out = await runInfo({ model: 'acme/chat@fast' }, {
      resolveSpec,
      resolveAdapter: async (p) => { throw new Error(`unknown provider: ${p}`) }
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.type).toBe('SESSION_UNKNOWN_PROVIDER')
  })
})

describe('session/driver info op', () => {
  test('answers info_done with the entry, or null', async () => {
    setCatalog({ 'echo/m': { contextTokenLimit: 1000 } })
    const stdin = Readable.from([
      JSON.stringify({ op: 'info', callId: 'i1', model: 'echo/m' }) + '\n',
      JSON.stringify({ op: 'info', callId: 'i2', model: 'echo/other' }) + '\n'
    ])
    const chunks = []
    const stdout = new Writable({ write (c, _e, cb) { chunks.push(c.toString('utf8')); cb() } })

    await drive(stdin, stdout)
    const lines = chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines).toEqual([
      { type: 'info_done', result: { contextTokenLimit: 1000 } },
      { type: 'info_done', result: null }
    ])
  })

  test('an invalid suffix answers the error line', async () => {
    setCatalog({ 'echo/m': {} })
    const stdin = Readable.from([JSON.stringify({ op: 'info', callId: 'i3', model: 'echo/m:high' }) + '\n'])
    const chunks = []
    const stdout = new Writable({ write (c, _e, cb) { chunks.push(c.toString('utf8')); cb() } })

    await drive(stdin, stdout)
    const [line] = chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(line.type).toBe('error')
    expect(line.error.type).toBe('SESSION_INVALID_OUTPUT_EFFORT')
  })
})
