import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, test, expect } from 'vitest'
import providers from '../../src/lib/providers.js'

const METRICS_RS = join(import.meta.dirname, '..', '..', 'rust', 'thin-gate', 'src', 'metrics.rs')

function knownProvidersFromRust () {
  const src = readFileSync(METRICS_RS, 'utf8')
  const decl = src.match(/const KNOWN_PROVIDERS: \[&str; (\d+)\] = \[([^\]]*)\];/)
  if (!decl) throw new Error('KNOWN_PROVIDERS not found in metrics.rs')
  const names = [...decl[2].matchAll(/"([^"]+)"/g)].map(m => m[1])
  return { declaredLen: Number(decl[1]), names }
}

describe('gate provider metric labels', () => {
  test('KNOWN_PROVIDERS matches the JS provider registry', () => {
    const { names } = knownProvidersFromRust()
    expect(names.slice().sort()).toEqual(Object.keys(providers).sort())
  })

  test('the array length annotation matches its contents', () => {
    const { declaredLen, names } = knownProvidersFromRust()
    expect(names.length).toBe(declaredLen)
  })
})
