import { describe, test, expect } from 'vitest'
import { fieldDefs, knownFields, validate, applyDefaults, stripComputed, stripUnknown, isValidTag } from '../../src/lib/schema.js'

describe('validate', () => {
  test('valid minimal entry passes', () => {
    const issues = validate({ model: 'gpt-4o', creator: 'openai', inputFormat: ['text'] }, 'openai/gpt-4o')
    expect(issues).toEqual([])
  })

  test('missing model reports error', () => {
    const issues = validate({}, 'openai/gpt-4o')
    expect(issues).toEqual([
      { field: 'model', message: 'required field missing', severity: 'error' },
      { field: 'creator', message: 'required field missing', severity: 'error' },
      { field: 'inputFormat', message: 'required field missing', severity: 'error' }
    ])
  })

  test('wrong type reports error', () => {
    const issues = validate({ model: 123 }, 'openai/gpt-4o')
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'model', severity: 'error' })
    )
  })

  test('null thinkingEffortLevels is valid', () => {
    const issues = validate({ model: 'x', thinkingEffortLevels: null }, 'p/x')
    const effortIssues = issues.filter(i => i.field === 'thinkingEffortLevels')
    expect(effortIssues).toEqual([])
  })

  test('deprecated displayName warns', () => {
    const issues = validate({ model: 'x', displayName: 'X' }, 'p/x')
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'displayName', severity: 'warn', message: expect.stringContaining('deprecated') })
    )
  })

  test('unknown field in strict mode warns', () => {
    const issues = validate({ model: 'x', foo: 'bar' }, 'p/x', { strict: true })
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'foo', message: 'unknown field', severity: 'warn' })
    )
  })

  test('unknown field in non-strict mode is ignored', () => {
    const issues = validate({ model: 'x', foo: 'bar' }, 'p/x')
    expect(issues.filter(i => i.field === 'foo')).toEqual([])
  })

  test('bad replaces type warns', () => {
    const issues = validate({ model: 'x', replaces: [123] }, 'p/x')
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'replaces', severity: 'warn' })
    )
  })

  test('bad leaderboard length warns', () => {
    const issues = validate({ model: 'x', leaderboard: [1, 2] }, 'p/x')
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'leaderboard', severity: 'warn' })
    )
  })

  test('valid leaderboard passes', () => {
    const issues = validate({ model: 'x', leaderboard: [90, 85, 70] }, 'p/x')
    const lbIssues = issues.filter(i => i.field === 'leaderboard')
    expect(lbIssues).toEqual([])
  })

  test('upstreamIds in strict mode is not flagged as unknown', () => {
    const issues = validate({ model: 'x', upstreamIds: ['x'] }, 'p/x', { strict: true })
    expect(issues.filter(i => i.field === 'upstreamIds')).toEqual([])
  })
})

describe('applyDefaults', () => {
  test('fills tags/aliases/replaces/type with defaults', () => {
    const result = applyDefaults({ model: 'x' })
    expect(result.tags).toEqual([])
    expect(result.aliases).toEqual([])
    expect(result.replaces).toEqual([])
    expect(result.type).toBe('model')
    expect(result.thinkingEffortLevels).toBeNull()
  })

  test('does not overwrite existing values', () => {
    const result = applyDefaults({ model: 'x', tags: ['fast'], type: 'embedding' })
    expect(result.tags).toEqual(['fast'])
    expect(result.type).toBe('embedding')
  })

  test('preserves original entry', () => {
    const original = { model: 'x', label: 'X' }
    const result = applyDefaults(original)
    expect(original).toEqual({ model: 'x', label: 'X' })
    expect(result.label).toBe('X')
  })

  test('default arrays are independent copies', () => {
    const a = applyDefaults({ model: 'x' })
    const b = applyDefaults({ model: 'y' })
    a.tags.push('modified')
    expect(b.tags).toEqual([])
  })
})

describe('stripComputed', () => {
  test('removes upstreamIds', () => {
    const result = stripComputed({ model: 'x', upstreamIds: ['x', 'y'], label: 'X' })
    expect(result).toEqual({ model: 'x', label: 'X' })
  })

  test('preserves all non-computed fields', () => {
    const entry = { model: 'x', tags: ['fast'], aliases: ['y'] }
    const result = stripComputed(entry)
    expect(result).toEqual({ model: 'x', tags: ['fast'], aliases: ['y'] })
  })

  test('does not mutate input', () => {
    const entry = { model: 'x', upstreamIds: ['x'] }
    stripComputed(entry)
    expect(entry.upstreamIds).toEqual(['x'])
  })
})

describe('stripUnknown', () => {
  test('preserves known fields and custom fields, strips computed', () => {
    const entry = { model: 'x', label: 'X', upstreamIds: ['x'], 'app:label': 'Custom' }
    const result = stripUnknown(entry)
    expect(result).toEqual({ model: 'x', label: 'X', 'app:label': 'Custom' })
  })

  test('preserves arbitrary custom fields', () => {
    const entry = { model: 'x', 'app:effort': 'high', myField: 42 }
    const result = stripUnknown(entry)
    expect(result).toEqual({ model: 'x', 'app:effort': 'high', myField: 42 })
  })

  test('strips computed fields only', () => {
    const entry = { model: 'x', upstreamIds: ['x', 'y'], label: 'X' }
    const result = stripUnknown(entry)
    expect(result).toEqual({ model: 'x', label: 'X' })
  })

  test('does not mutate input', () => {
    const entry = { model: 'x', upstreamIds: ['x'], custom: true }
    stripUnknown(entry)
    expect(entry).toEqual({ model: 'x', upstreamIds: ['x'], custom: true })
  })
})

describe('image model fields', () => {
  test('image model entry validates cleanly', () => {
    const entry = {
      model: 'flux-2-dev',
      creator: 'bfl',
      provider: 'novita',
      label: 'Flux 2 Dev',
      type: 'image',
      inputFormat: ['text'],
      imagePrice: 0.012,
      imageEndpoint: 'flux-2-dev',
      imageDefaultSize: '1024x1024',
      tags: []
    }
    const issues = validate(entry, 'novita/flux-2-dev')
    expect(issues).toEqual([])
  })

  test('image fields with wrong types report errors', () => {
    const issues = validate({ model: 'x', creator: 'y', imagePrice: 'free' }, 'p/x')
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'imagePrice', severity: 'error' })
    )
  })

  test('image fields not flagged as unknown in strict mode', () => {
    const issues = validate(
      { model: 'x', creator: 'y', imagePrice: 0.01, imageEndpoint: 'ep', imageDefaultSize: '1024x1024' },
      'p/x',
      { strict: true }
    )
    const unknowns = issues.filter(i => i.message === 'unknown field')
    expect(unknowns).toEqual([])
  })
})

describe('altType (tiered pricing)', () => {
  test('inputPrice as object passes validation', () => {
    const issues = validate({ model: 'x', creator: 'y', inputPrice: { default: 2.5, '>272000': 5 } }, 'p/x')
    const priceIssues = issues.filter(i => i.field === 'inputPrice')
    expect(priceIssues).toEqual([])
  })

  test('outputPrice as object passes validation', () => {
    const issues = validate({ model: 'x', creator: 'y', outputPrice: { default: 15, '>272000': 22.5 } }, 'p/x')
    const priceIssues = issues.filter(i => i.field === 'outputPrice')
    expect(priceIssues).toEqual([])
  })

  test('thinkingPrice as object passes validation', () => {
    const issues = validate({ model: 'x', creator: 'y', thinkingPrice: { default: 15 } }, 'p/x')
    const priceIssues = issues.filter(i => i.field === 'thinkingPrice')
    expect(priceIssues).toEqual([])
  })

  test('inputPrice as number still passes', () => {
    const issues = validate({ model: 'x', creator: 'y', inputPrice: 3.0 }, 'p/x')
    const priceIssues = issues.filter(i => i.field === 'inputPrice')
    expect(priceIssues).toEqual([])
  })

  test('inputPrice as string fails', () => {
    const issues = validate({ model: 'x', creator: 'y', inputPrice: 'free' }, 'p/x')
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'inputPrice', severity: 'error' })
    )
  })
})

describe('knownFields', () => {
  test('contains expected fields', () => {
    const expected = ['model', 'provider', 'sdk', 'type', 'label', 'tags', 'aliases', 'replaces', 'leaderboard', 'inputPrice', 'outputPrice', 'inputFormat', 'version', 'imagePrice', 'imageEndpoint', 'imageDefaultSize']
    for (const field of expected) {
      expect(knownFields.has(field)).toBe(true)
    }
  })

  test('does not contain computed fields', () => {
    expect(knownFields.has('upstreamIds')).toBe(false)
  })

  test('matches fieldDefs keys', () => {
    expect(knownFields.size).toBe(Object.keys(fieldDefs).length)
  })
})

describe('isValidTag', () => {
  test('simple tags', () => {
    expect(isValidTag('fast')).toBe(true)
    expect(isValidTag('production')).toBe(true)
    expect(isValidTag('cheap')).toBe(true)
  })

  test('tags with dots, hyphens, underscores', () => {
    expect(isValidTag('gpt-5.4')).toBe(true)
    expect(isValidTag('my_tag')).toBe(true)
    expect(isValidTag('v2.0-beta')).toBe(true)
  })

  test('must start with a letter', () => {
    expect(isValidTag('3fast')).toBe(false)
    expect(isValidTag('-tag')).toBe(false)
    expect(isValidTag('.tag')).toBe(false)
    expect(isValidTag('_tag')).toBe(false)
  })

  test('rejects spaces and special chars', () => {
    expect(isValidTag('my tag')).toBe(false)
    expect(isValidTag('foo/bar')).toBe(false)
    expect(isValidTag('tag!')).toBe(false)
    expect(isValidTag('tag@2')).toBe(false)
  })

  test('rejects empty and too long', () => {
    expect(isValidTag('')).toBe(false)
    expect(isValidTag('a'.repeat(33))).toBe(false)
  })

  test('accepts max length', () => {
    expect(isValidTag('a'.repeat(32))).toBe(true)
  })

  test('rejects non-strings', () => {
    expect(isValidTag(null)).toBe(false)
    expect(isValidTag(undefined)).toBe(false)
    expect(isValidTag(42)).toBe(false)
  })
})
