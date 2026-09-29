import { describe, test, expect, beforeEach } from 'vitest'

import { selectEntries } from '../../src/cli/export.js'
import { setCuratedCache, clearCuratedCache } from '../../src/lib/curated-cache.js'
import { reviewCandidates } from '../../src/lib/catalog-review.js'

const catalog = {
  $schema: './curated.schema.json',
  _comment: 'not a model',
  'anthropic/claude-sonnet-5-5': { model: 'claude-sonnet-5-5', provider: 'anthropic', creator: 'anthropic', label: 'Claude Sonnet 5.5', inputFormat: ['text'], tags: ['daAuto'] },
  'anthropic/claude-sonnet-5': { deprecated: 'anthropic/claude-sonnet-5-5' },
  'anthropic/claude-sonnet-4': { deprecated: 'anthropic/claude-sonnet-5' },
  'meta/muse-spark-1.3': { model: 'muse-spark-1.3', provider: 'meta', creator: 'meta', label: 'Muse Spark 1.3', inputFormat: ['text'], tags: ['daExpert'] },
  'meta/muse-spark-1.3-contributor': { model: 'muse-spark-1.3-contributor', provider: 'meta', creator: 'meta', label: 'Muse Spark 1.3 Contributor', inputFormat: ['text'] },
  'openai/gpt-6-luna': { model: 'gpt-6-luna', provider: 'openai', creator: 'openai', label: 'GPT-6 Luna', inputFormat: ['text'], tags: ['daAuto', 'daDefault'] }
}

beforeEach(() => {
  clearCuratedCache()
  setCuratedCache(catalog)
})

describe('mo model export — selection', () => {
  test('ids resolve through aliases and come out as the raw entry, keyed by catalog key', () => {
    const { entries, unknown } = selectEntries(catalog, { ids: ['claude-sonnet-5-5'] })
    expect(unknown).toEqual([])
    expect(entries).toEqual({ 'anthropic/claude-sonnet-5-5': catalog['anthropic/claude-sonnet-5-5'] })
  })

  test('an id that resolves to nothing is reported, not skipped', () => {
    const { unknown } = selectEntries(catalog, { ids: ['meta/muse-spark-1.3', 'meta/muse-nope'] })
    expect(unknown).toEqual(['meta/muse-nope'])
  })

  test('a redirect stub exports alone unless redirects are asked for', () => {
    const { entries } = selectEntries(catalog, { ids: ['anthropic/claude-sonnet-5'] })
    expect(Object.keys(entries)).toEqual(['anthropic/claude-sonnet-5'])
  })

  test('--with-redirects follows a two-hop chain to an exported entry', () => {
    const { entries } = selectEntries(catalog, { ids: ['anthropic/claude-sonnet-5-5'], withRedirects: true })
    expect(Object.keys(entries)).toEqual([
      'anthropic/claude-sonnet-4',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-sonnet-5-5'
    ])
  })

  test('--provider and --tag are a union with the ids', () => {
    const { entries } = selectEntries(catalog, { ids: ['anthropic/claude-sonnet-5-5'], providers: ['meta'], tags: ['daDefault'] })
    expect(Object.keys(entries)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'meta/muse-spark-1.3',
      'meta/muse-spark-1.3-contributor',
      'openai/gpt-6-luna'
    ])
  })

  test('meta keys are never exported', () => {
    const { entries } = selectEntries(catalog, { providers: ['anthropic', 'meta', 'openai'], withRedirects: true })
    expect(Object.keys(entries).some(k => k.startsWith('$') || k.startsWith('_'))).toBe(false)
  })

  test('the output is what apply reads: every exported entry reviews as unchanged', () => {
    const { entries } = selectEntries(catalog, { providers: ['anthropic', 'meta', 'openai'] })
    const reviews = reviewCandidates(catalog, JSON.parse(JSON.stringify(entries)))
    expect(reviews.map(r => r.status)).toEqual(reviews.map(() => 'unchanged'))
  })
})
