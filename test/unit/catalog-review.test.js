import { describe, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  reviewEntry,
  reviewCatalog,
  diffEntry,
  parseCandidates,
  reviewCandidates
} from '../../src/lib/catalog-review.js'
import { fieldDefs } from '../../src/lib/schema.js'

const entry = (over = {}) => ({
  model: 'claude-haiku-4-5-20251001',
  creator: 'anthropic',
  provider: 'anthropic',
  sdk: 'anthropic',
  label: 'Claude Haiku 4.5',
  inputFormat: ['text'],
  ...over
})

describe('reviewEntry', () => {
  test('a complete entry reports nothing', () => {
    const { errors, warnings } = reviewEntry('anthropic/claude-haiku-4-5', entry(), {})
    expect({ errors, warnings }).toEqual({ errors: [], warnings: [] })
  })

  test('an effort suffix on the key is an error', () => {
    const { errors } = reviewEntry('anthropic/claude-haiku-4-5:high', entry(), {})
    expect(errors).toContainEqual(expect.stringContaining('call-time'))
  })

  test('a speed suffix on the key is an error', () => {
    const { errors } = reviewEntry('openai/gpt-x@fast', entry({ provider: 'openai', sdk: 'openai' }), {})
    expect(errors).toContainEqual(expect.stringContaining('call-time'))
  })

  test('an unknown input modality is an error', () => {
    const { errors } = reviewEntry('anthropic/x', entry({ inputFormat: ['text', 'smell'] }), {})
    expect(errors).toContainEqual(expect.stringContaining("unknown modality 'smell'"))
  })

  test('a deprecated stub pointing nowhere is an error', () => {
    const { errors } = reviewEntry('anthropic/old', { deprecated: 'anthropic/gone' }, {})
    expect(errors).toEqual(['anthropic/old: deprecated target \'anthropic/gone\' not in curated'])
  })

  test('a namespaced custom field is not unknown-field drift', () => {
    const { warnings } = reviewEntry('anthropic/x', entry({ 'myapp:tier': 'a' }), {}, { strict: true })
    expect(warnings).toEqual([])
  })

  test('an unnamespaced unknown field warns in strict mode only', () => {
    const spec = entry({ pricePerToken: 3 })
    expect(reviewEntry('anthropic/x', spec, {}).warnings).toEqual([])
    expect(reviewEntry('anthropic/x', spec, {}, { strict: true }).warnings)
      .toContainEqual(expect.stringContaining('unknown field'))
  })
})

describe('reviewCatalog', () => {
  test('walks every entry and skips meta keys', () => {
    const { errors } = reviewCatalog({
      $schema: 'https://example.test/schema.json',
      _comment: 'a note',
      'anthropic/good': entry(),
      'nope/bad': entry({ provider: 'nope', sdk: undefined })
    })
    expect(errors).toEqual(["nope/bad: provider 'nope' not in providers.js"])
  })
})

describe('diffEntry', () => {
  test('a new entry is all additions', () => {
    expect(diffEntry(undefined, { model: 'x', inputPrice: 1 })).toEqual([
      { field: 'inputPrice', from: undefined, to: 1 },
      { field: 'model', from: undefined, to: 'x' }
    ])
  })

  test('an omitted field reads as a removal', () => {
    expect(diffEntry({ model: 'x', tags: ['a'] }, { model: 'x' })).toEqual([
      { field: 'tags', from: ['a'], to: undefined }
    ])
  })

  test('the computed upstreamIds field is not a change', () => {
    expect(diffEntry({ model: 'x', upstreamIds: ['x'] }, { model: 'x' })).toEqual([])
  })

  test('key order inside a value is not a change', () => {
    const before = { thinkingEffortLevels: { low: 1, high: 2 } }
    const after = { thinkingEffortLevels: { high: 2, low: 1 } }
    expect(diffEntry(before, after)).toEqual([])
  })
})

describe('parseCandidates', () => {
  test('meta keys are reported, not treated as entries', () => {
    const { entries, ignored } = parseCandidates('{"$schema":"s","anthropic/x":{"model":"x"}}')
    expect(Object.keys(entries)).toEqual(['anthropic/x'])
    expect(ignored).toEqual(['$schema'])
  })

  test('a bare entry is rejected with the expected shape', () => {
    expect(() => parseCandidates('{"model":"x","creator":"y"}'))
      .toThrow(/not an entry object/)
  })

  test('invalid JSON is rejected', () => {
    expect(() => parseCandidates('nope')).toThrow(/not valid JSON/)
  })

  test('an empty object is rejected', () => {
    expect(() => parseCandidates('{}')).toThrow(/no entries/)
  })
})

describe('reviewCandidates', () => {
  const catalog = { 'anthropic/claude-haiku-4-5': { ...entry(), inputPrice: 1, upstreamIds: ['claude-haiku-4-5-20251001'] } }

  test('classifies new, changed and unchanged', () => {
    const reviews = reviewCandidates(catalog, {
      'anthropic/claude-haiku-4-5': { ...entry(), inputPrice: 1 },
      'anthropic/claude-opus-5': entry({ model: 'claude-opus-5' }),
      'anthropic/claude-sonnet-4-6': entry({ model: 'claude-sonnet-4-6', inputPrice: 3 })
    })
    expect(reviews.map(r => [r.key, r.status])).toEqual([
      ['anthropic/claude-haiku-4-5', 'unchanged'],
      ['anthropic/claude-opus-5', 'new'],
      ['anthropic/claude-sonnet-4-6', 'new']
    ])
  })

  test('a price edit is reported as a change', () => {
    const [review] = reviewCandidates(catalog, {
      'anthropic/claude-haiku-4-5': { ...entry(), inputPrice: 1.1 }
    })
    expect(review.status).toBe('changed')
    expect(review.changes).toEqual([{ field: 'inputPrice', from: 1, to: 1.1 }])
  })

  test('a candidate can point a stub at another candidate', () => {
    const reviews = reviewCandidates({}, {
      'anthropic/old': { deprecated: 'anthropic/new' },
      'anthropic/new': entry({ model: 'new' })
    })
    expect(reviews.flatMap(r => r.errors)).toEqual([])
  })
})

describe('field documentation', () => {
  test('every catalog field is described in curated.schema.json', async () => {
    const raw = await readFile(new URL('../../config/curated.schema.json', import.meta.url), 'utf8')
    const props = JSON.parse(raw).$defs.modelEntry.properties
    const undocumented = Object.keys(fieldDefs).filter(f => !props[f]?.description)
    expect(undocumented).toEqual([])
  })

  test('curated.schema.json describes no field the validator does not know', async () => {
    const raw = await readFile(new URL('../../config/curated.schema.json', import.meta.url), 'utf8')
    const props = JSON.parse(raw).$defs.modelEntry.properties
    const orphans = Object.keys(props).filter(f => !fieldDefs[f])
    expect(orphans).toEqual([])
  })
})

// Every type a field may declare needs a checker in schema.js; a missing one
// rejects every value, including a correct one, with the useless message
// "expected boolean, got boolean".
describe('every declared field type has a checker', () => {
  test('no field type rejects its own correct value', async () => {
    const { fieldDefs, validate } = await import('../../src/lib/schema.js')
    const sample = { string: 'x', number: 1, boolean: true, array: ['text'], object: { a: 'b' } }
    const base = { model: 'm', creator: 'openai', inputFormat: ['text'] }
    const broken = []
    for (const [field, def] of Object.entries(fieldDefs)) {
      const value = sample[def.type]
      if (value === undefined) { broken.push(`${field}: no sample for type ${def.type}`); continue }
      const issues = validate({ ...base, [field]: value }, 'openai/m')
        .filter(i => i.field === field && i.message.startsWith('expected'))
      if (issues.length) broken.push(`${field}: ${issues[0].message}`)
    }
    expect(broken).toEqual([])
  })
})
