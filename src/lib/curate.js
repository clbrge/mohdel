/**
 * A provider's models added to the catalog without prompting: what it lists that the catalog holds
 * neither as curated nor as excluded, and an entry for each one chosen. `mo curate` is one interface
 * over it; a program that runs mohdel for its user can be another. Keys come from the process
 * environment, which `loadDefaultEnv` fills from mohdel's environment file.
 */

import providers, { billingOf } from './providers.js'
import { creatorFromModelId } from './creators.js'
import { getAPIKey, getCuratedModels, getExcludedModels, hasPrices, saveCuratedModels } from './common.js'
import { getMohdelModel } from './curated-cache.js'
import { stripUnknown, validate } from './schema.js'
import { silent } from './logger.js'

/**
 * One provider's catalog client, or null when it has no key or no listing mohdel reads. `key`
 * is a candidate to check before it is saved; without it the stored key is used.
 */
export const providerApi = async (name, key) => {
  const config = providers[name]
  if (config?.catalogClient === 'chatgpt') {
    const { default: API } = await import('./catalog/chatgpt.js')
    return API()
  }
  if (!config || config.catalog === false || !config.apiKeyEnv) return null
  const apiKey = key ?? getAPIKey(config.apiKeyEnv)
  if (!apiKey) return null
  const { default: API } = await import(`./catalog/${config.catalogClient || config.sdk}.js`)
  return API({ ...config.createConfiguration(apiKey), baseURL: config.baseURL }, {}, silent)
}

const isTracked = (collection, providerName, modelId) => {
  for (const [curatedKey, entry] of Object.entries(collection)) {
    const { provider, model: keyModelId } = getMohdelModel(curatedKey)
    if (provider !== providerName) continue
    if (keyModelId === modelId) return true
    if (Array.isArray(entry.upstreamIds) && entry.upstreamIds.includes(modelId)) return true
  }
  return false
}

export const filterUncurated = (models, providerName, curated, excluded) =>
  models.filter(model => {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string') return false
    return !isTracked(curated, providerName, model.id) && !isTracked(excluded, providerName, model.id)
  })

export const freeModels = (models) =>
  models.filter(m => m.inputPrice === 0 && m.outputPrice === 0)

/** `{ info, why }`: what the provider says of one model, or null and the reason it said nothing. */
export async function modelDetails (api, modelId) {
  if (!api.getModelInfo) return { info: null, why: `the provider gives no details of ${modelId}` }
  try {
    const info = await api.getModelInfo(modelId)
    return info ? { info, why: null } : { info: null, why: `${modelId} is not in the provider's response` }
  } catch (err) {
    return { info: null, why: `the details of ${modelId} could not be read: ${err.message}` }
  }
}

const buildEntry = async (providerName, model, api) => {
  const { info, why } = await modelDetails(api, model.id)
  const entry = stripUnknown({
    provider: providerName,
    sdk: providers[providerName].sdk,
    model: model.id,
    label: model.label || model.id,
    ...(info || {})
  })
  // An upstream list names the provider, never the creator; an OpenRouter id carries the vendor in its first segment.
  if (!entry.creator) entry.creator = creatorFromModelId(model.id) || model.id.split('/')[0]
  return { entry, why }
}

const buildEntries = async (providerName, api, models) => {
  const built = []
  for (const model of models) {
    built.push({ key: `${providerName}/${model.id}`, ...await buildEntry(providerName, model, api) })
  }
  return built
}

const saveEntries = async (built) => {
  const curated = await getCuratedModels()
  for (const { key, entry } of built) curated[key] = entry
  await saveCuratedModels(curated)
  return built
}

/** Each model's entry written to the catalog, `{ key, entry, why }`, `why` as `modelDetails` gives it. */
export const addEntries = async (providerName, api, models) =>
  saveEntries(await buildEntries(providerName, api, models))

const cannotList = (provider) => {
  const def = providers[provider]
  return def.catalog !== false && def.apiKeyEnv && !getAPIKey(def.apiKeyEnv)
    ? `${provider} has no key — mo onboard ${provider} sets it`
    : `mohdel cannot list ${provider}'s models`
}

/** The provider's catalog client and its listing, both null when mohdel cannot list its models. */
const listing = async (provider) => {
  if (!providers[provider]) throw new Error(`${provider} is not a provider mohdel knows — mo providers lists them`)
  const api = await providerApi(provider)
  if (!api?.listModels) return { api: null, listed: null }
  const listed = await api.listModels()
  if (!Array.isArray(listed)) throw new Error(`${provider} returned a model list mohdel cannot read`)
  return { api, listed }
}

/**
 * What `provider` lists that the catalog does not hold, each `{ id, label, inputPrice, outputPrice }`
 * — prices null where the listing carries none. Null when mohdel cannot list the provider's models:
 * no key, or no listing for it.
 */
export async function upstream (provider) {
  const { listed } = await listing(provider)
  if (!listed) return null
  return filterUncurated(listed, provider, await getCuratedModels(), await getExcludedModels())
    .map(m => ({ id: m.id, label: m.label || m.id, inputPrice: m.inputPrice ?? null, outputPrice: m.outputPrice ?? null }))
}

/**
 * `ids` of `provider`'s listing added to the catalog, each `{ model, priced }`: its catalog key, and
 * whether it has prices (null when its calls are not metered). None of them, and an error, when one
 * is not listed, already in the catalog, or excluded from it, or when the provider does not describe
 * one well enough for the catalog to accept its entry.
 */
export async function curate (provider, ids) {
  const { api, listed } = await listing(provider)
  if (!listed) throw new Error(cannotList(provider))
  const curated = await getCuratedModels()
  const excluded = await getExcludedModels()
  const picked = ids.map(id => {
    const found = listed.find(one => one.id === id)
    if (!found) throw new Error(`${provider} does not list ${id}`)
    if (isTracked(curated, provider, id)) throw new Error(`${provider}'s ${id} is already in the catalog`)
    if (isTracked(excluded, provider, id)) throw new Error(`${provider}'s ${id} is excluded from the catalog`)
    return found
  })
  const built = await buildEntries(provider, api, picked)
  const rejected = built.flatMap(({ key, entry, why }) => validate(entry, key)
    .filter(issue => issue.severity === 'error')
    .map(issue => `${key}: ${issue.field} — ${issue.message}${why ? ` (${why})` : ''}`))
  if (rejected.length) {
    throw new Error(`the catalog would reject ${rejected.join('; ')}. mo curate ${provider} asks for what is missing`)
  }
  return (await saveEntries(built)).map(({ key, entry }) => ({
    model: key,
    priced: billingOf(key).kind === 'metered' ? hasPrices(entry) : null
  }))
}
