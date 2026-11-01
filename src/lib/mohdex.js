/**
 * mohdex, the public registry of catalog entries at mohdex.dev. It serves each model's values that
 * reached its public threshold, in the catalog's own shape, with `source` and `sourcedAt`.
 */

import { getCuratedModels, saveCuratedModels } from './common.js'
import { upstream } from './curate.js'
import { validate } from './schema.js'

export const MOHDEX_URL = 'https://mohdex.dev'

export async function mohdexEntries (provider) {
  const res = await fetch(`${MOHDEX_URL}/v1/entries?provider=${encodeURIComponent(provider)}`, {
    signal: AbortSignal.timeout(15000)
  })
  if (!res.ok) throw new Error(`mohdex answered ${res.status}`)
  const body = await res.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('mohdex returned entries mohdel cannot read')
  return body
}

/**
 * What mohdex serves for the models `provider` lists and the catalog lacks: `complete`, each
 * `{ key, entry }` the catalog accepts as served, and the keys of `incomplete` ones, which still
 * need a field mohdex has no public value for. Null when mohdel cannot list the provider's models.
 */
export async function mohdexOffer (provider) {
  const listed = await upstream(provider)
  if (!listed) return null
  const served = await mohdexEntries(provider)
  const reachable = new Set(listed.map(m => `${provider}/${m.id}`))
  const complete = []
  const incomplete = []
  for (const [key, entry] of Object.entries(served)) {
    if (!reachable.has(key) || entry.deprecated) continue
    if (validate(entry, key).some(issue => issue.severity === 'error')) incomplete.push(key)
    else complete.push({ key, entry })
  }
  return { complete, incomplete }
}

export async function addFromMohdex (picked) {
  const curated = await getCuratedModels()
  for (const { key, entry } of picked) curated[key] = entry
  await saveCuratedModels(curated)
}
