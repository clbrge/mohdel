/**
 * mohdex, the public registry of catalog entries at mohdex.dev. It serves each model's values that
 * reached its public threshold, in the catalog's own shape, with `source` and `sourcedAt`.
 */

import { getCuratedModels, saveCuratedModels } from './common.js'
import { upstream } from './curate.js'
import providers from './providers.js'
import { stripUnknown, validate } from './schema.js'
import { providerOf } from '#core/model-id.js'

export const MOHDEX_URL = 'https://mohdex.dev'

/** Fields of a source entry that describe the source's own route, never a `pricesFrom` route's. */
const ROUTE_FIELDS = ['speeds', 'rpmLimit', 'tpmLimit', 'inpmLimit', 'rateLimitScope']

async function fetchEntries (search) {
  const res = await fetch(`${MOHDEX_URL}/v1/entries${search}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`mohdex answered ${res.status}`)
  const body = await res.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('mohdex returned entries mohdel cannot read')
  return body
}

/**
 * The entries mohdex serves for `provider`. A provider declaring `pricesFrom` gets that provider's
 * entries, keyed and labelled as its own, without the fields that describe the source's route.
 */
export async function mohdexEntries (provider) {
  const from = providers[provider].pricesFrom
  const served = await fetchEntries(`?provider=${encodeURIComponent(from ?? provider)}`)
  if (!from) return served
  const entries = {}
  for (const [key, entry] of Object.entries(served)) {
    const carried = { ...entry, provider }
    for (const field of ROUTE_FIELDS) delete carried[field]
    entries[`${provider}/${key.slice(from.length + 1)}`] = carried
  }
  return entries
}

/**
 * How models did at tasks in `tool`, as mohdex counts them: `{ [catalogKey]: { [taskId]: { digest,
 * latestVersion, runs, passed, failed, reasons } } }`, counting only each task's newest version.
 * Counts, never a verdict: what passes is the caller's to decide. `tag` is one tag or several, all
 * of which a task must carry; `since` is the oldest tool version counted.
 */
export async function mohdexResults ({ tool, task, tag, key, provider, since, grading }) {
  const params = new URLSearchParams({ tool })
  for (const [name, value] of Object.entries({ task, key, provider, since, grading })) {
    if (value !== undefined) params.set(name, value)
  }
  for (const one of [tag ?? []].flat()) params.append('tag', one)
  const res = await fetch(`${MOHDEX_URL}/v1/results?${params}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`mohdex answered ${res.status}`)
  const body = await res.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('mohdex returned results mohdel cannot read')
  return body
}

/**
 * The models that meet a bar at a tool: `[{ key, version }]`, `version` the tool version a model was
 * last judged on. The caller names the bar, one or several tags; mohdex applies it. An unreachable
 * mohdex throws.
 */
export async function mohdexRecommended ({ tool, bar }) {
  const params = new URLSearchParams({ tool })
  for (const one of [bar].flat()) params.append('bar', one)
  const res = await fetch(`${MOHDEX_URL}/v1/recommended?${params}`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`mohdex answered ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.models)) throw new Error('mohdex returned recommendations mohdel cannot read')
  return body.models
}

/** How many entries mohdex serves for each provider mohdel knows, `pricesFrom` routes included. */
export async function mohdexCounts () {
  const perSource = {}
  for (const key of Object.keys(await fetchEntries(''))) {
    const source = providerOf(key)
    perSource[source] = (perSource[source] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(providers)
    .map(([name, def]) => [name, perSource[def.pricesFrom ?? name] ?? 0]))
}

/**
 * The served entry for the model `provider` lists as `id`, as `{ key, entry }`, or null: the one
 * keyed by it, else one naming it as its `model` or among its `aliases`, as the catalog matches a
 * listing.
 */
export function mohdexMatch (served, provider, id) {
  const key = `${provider}/${id}`
  if (served[key]) return { key, entry: served[key] }
  const found = Object.entries(served).find(([, entry]) => entry.model === id || entry.aliases?.includes(id))
  return found ? { key: found[0], entry: found[1] } : null
}

/**
 * What mohdex serves for the models `provider` lists and the catalog lacks: `complete`, each
 * `{ key, entry }` the catalog accepts as served; `incomplete`, the keys of entries still missing a
 * field mohdex has no public value for; and `unserved`, the keys of listed models it holds no entry
 * for. Null when mohdel cannot list the provider's models.
 */
export async function mohdexOffer (provider) {
  const listed = await upstream(provider)
  if (!listed) return null
  const served = await mohdexEntries(provider)
  const complete = []
  const incomplete = []
  const unserved = []
  const offered = new Set()
  for (const { id } of listed) {
    const match = mohdexMatch(served, provider, id)
    if (!match) {
      unserved.push(`${provider}/${id}`)
      continue
    }
    const { key, entry } = match
    if (entry.deprecated || offered.has(key)) continue
    offered.add(key)
    if (validate(entry, key).some(issue => issue.severity === 'error')) incomplete.push(key)
    else complete.push({ key, entry })
  }
  return { complete, incomplete, unserved }
}

export async function addFromMohdex (picked) {
  const curated = await getCuratedModels()
  for (const { key, entry } of picked) curated[key] = stripUnknown(entry)
  await saveCuratedModels(curated)
}
