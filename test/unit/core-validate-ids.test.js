import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, test, expect } from 'vitest'
import {
  validateIds,
  MAX_ID_BYTES,
  MAX_MODEL_BYTES,
  MAX_PROVIDER_BYTES
} from '#core/envelope.js'

const PROTOCOL_RS = join(import.meta.dirname, '..', '..', 'rust', 'thin-gate', 'src', 'protocol.rs')

function rustConst (name) {
  const src = readFileSync(PROTOCOL_RS, 'utf8')
  const m = src.match(new RegExp(`pub const ${name}: usize = ([0-9_]+);`))
  if (!m) throw new Error(`${name} not found in protocol.rs`)
  return Number(m[1].replace(/_/g, ''))
}

describe('core/envelope validateIds', () => {
  test('accepts a well-formed triple', () => {
    expect(validateIds('c-1', 'user-1', 'anthropic/claude-opus-4')).toBeUndefined()
  })

  test('accepts an effort suffix', () => {
    expect(validateIds('c-1', 'u', 'openai/gpt-5:high')).toBeUndefined()
  })

  test('rejects an empty bare model', () => {
    expect(validateIds('c', 'u', 'anthropic/')).toBe("model must be '<provider>/<id>' (got: anthropic/)")
  })

  test('rejects an empty provider', () => {
    expect(validateIds('c', 'u', '/gpt-5')).toBe("model must be '<provider>/<id>' (got: /gpt-5)")
  })

  test('rejects a model id with no slash', () => {
    expect(validateIds('c', 'u', 'gpt-5')).toBe("model must be '<provider>/<id>' (got: gpt-5)")
  })

  test('rejects an oversized callId, authId, model and provider', () => {
    expect(validateIds('c'.repeat(MAX_ID_BYTES + 1), 'u', 'openai/m'))
      .toBe(`callId exceeds ${MAX_ID_BYTES} bytes`)
    expect(validateIds('c', 'u'.repeat(MAX_ID_BYTES + 1), 'openai/m'))
      .toBe(`authId exceeds ${MAX_ID_BYTES} bytes`)
    expect(validateIds('c', 'u', `openai/${'m'.repeat(MAX_MODEL_BYTES)}`))
      .toBe(`model exceeds ${MAX_MODEL_BYTES} bytes`)
    expect(validateIds('c', 'u', `${'p'.repeat(MAX_PROVIDER_BYTES + 1)}/m`))
      .toBe(`model provider exceeds ${MAX_PROVIDER_BYTES} bytes`)
  })

  test('accepts values exactly at each cap', () => {
    expect(validateIds('c'.repeat(MAX_ID_BYTES), 'u'.repeat(MAX_ID_BYTES), `${'p'.repeat(MAX_PROVIDER_BYTES)}/m`))
      .toBeUndefined()
  })

  test('caps are measured in UTF-8 bytes, not UTF-16 units', () => {
    const wide = 'é'.repeat(MAX_ID_BYTES / 2 + 1)
    expect(wide.length).toBeLessThanOrEqual(MAX_ID_BYTES)
    expect(validateIds(wide, 'u', 'openai/m')).toBe(`callId exceeds ${MAX_ID_BYTES} bytes`)
  })
})

describe('validateIds caps match the Rust mirror', () => {
  test('MAX_ID_BYTES', () => expect(MAX_ID_BYTES).toBe(rustConst('MAX_ID_BYTES')))
  test('MAX_MODEL_BYTES', () => expect(MAX_MODEL_BYTES).toBe(rustConst('MAX_MODEL_BYTES')))
  test('MAX_PROVIDER_BYTES', () => expect(MAX_PROVIDER_BYTES).toBe(rustConst('MAX_PROVIDER_BYTES')))
})
