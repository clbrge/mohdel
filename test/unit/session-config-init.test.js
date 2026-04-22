import { describe, test, expect, beforeEach } from 'vitest'

import {
  setCatalog,
  getSpec,
  initCatalogFromDefault
} from '../../js/session/adapters/_catalog.js'
import {
  setProviders,
  getProviderLimits,
  initProvidersFromDefault
} from '../../js/session/adapters/_providers.js'

// F17: eager async init from bin.js must be idempotent and must not
// clobber a prior setCatalog/setProviders (tests).

describe('catalog eager init', () => {
  beforeEach(() => setCatalog({}))

  test('initCatalogFromDefault is idempotent when catalog already set', async () => {
    setCatalog({ 'p/m': { outputTokens: 42 } })
    await initCatalogFromDefault()
    await initCatalogFromDefault()
    expect(getSpec('p/m')).toEqual({ outputTokens: 42 })
  })
})

describe('providers eager init', () => {
  beforeEach(() => setProviders({}))

  test('initProvidersFromDefault is idempotent when already set', async () => {
    setProviders({ openai: { rpmLimit: 60, tpmLimit: 100000 } })
    await initProvidersFromDefault()
    await initProvidersFromDefault()
    expect(getProviderLimits('openai')).toEqual({ rpmLimit: 60, tpmLimit: 100000 })
  })
})
