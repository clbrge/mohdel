import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import providers from '../../src/lib/providers.js'

const root = new URL('../../', import.meta.url)
const readme = readFileSync(new URL('README.md', root), 'utf8')
const adapterDir = fileURLToPath(new URL('js/session/adapters/', root))

const rows = new Map(
  [...readme.matchAll(/^\| ([A-Za-z][\w .]*?) \| (Yes|No) \|/gm)]
    .map(m => [m[1].trim().toLowerCase(), m[2]])
)
const label = { 'qwen cloud': 'qwen' }
const key = name => label[name] || name

describe('the README provider matrix', () => {
  it('lists every provider mohdel can route to', () => {
    const listed = new Set([...rows.keys()].map(key))
    const missing = Object.keys(providers).filter(p => !listed.has(p))
    expect(missing).toEqual([])
  })

  // The Streaming column is a claim about the adapter, and the adapter decides
  // it by passing `stream: true` to the shared chat-completions core.
  it('agrees with the adapters about streaming', () => {
    const wrong = []
    for (const [name, claim] of rows) {
      const file = `${key(name)}.js`
      if (!readdirSync(adapterDir).includes(file)) continue
      const src = readFileSync(adapterDir + file, 'utf8')
      if (!src.includes('runChatCompletions')) continue
      const streams = src.includes('stream: true') ? 'Yes' : 'No'
      if (streams !== claim) wrong.push(`${name}: README says ${claim}, adapter says ${streams}`)
    }
    expect(wrong).toEqual([])
  })
})

describe('the live-suite specs', () => {
  const specs = readFileSync(fileURLToPath(new URL('test/live/specs.js', root)), 'utf8')
  const declared = new Map(
    [...specs.matchAll(/^\s{2}(\w+): \{[^}]*streams: (true|false)/gm)].map(m => [m[1], m[2] === 'true'])
  )

  it('claim the same streaming behaviour as the adapters', () => {
    const wrong = []
    for (const [provider, streams] of declared) {
      const file = `${provider}.js`
      if (!readdirSync(adapterDir).includes(file)) continue
      const src = readFileSync(adapterDir + file, 'utf8')
      if (!src.includes('runChatCompletions')) continue
      const actual = src.includes('stream: true')
      if (actual !== streams) wrong.push(`${provider}: spec says ${streams}, adapter says ${actual}`)
    }
    expect(wrong).toEqual([])
  })

  it('cover every adapter that can be smoke-tested', () => {
    const adapters = readdirSync(adapterDir)
      .filter(f => f.endsWith('.js') && !f.startsWith('_') && !['index.js', 'echo.js', 'fake.js'].includes(f))
      .map(f => f.slice(0, -3))
    expect(adapters.filter(a => !declared.has(a))).toEqual([])
  })
})
