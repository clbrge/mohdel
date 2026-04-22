import { getCuratedModels, saveCuratedModels } from './common.js'

let curatedCache = null
let aliasMapCache = null

export const getMohdelModel = curatedKey => {
  const [provider, ...modelParts] = curatedKey.split('/')
  return { provider, model: modelParts.join('/') }
}

const BASE_NAME_RE = /^([^-\d]+-\d+(?:-\d+)*(?:-[a-z]+)?)/

const buildAliasMap = (curatedModels) => {
  const aliasMap = new Map()
  const modelCountByName = new Map()
  const parsed = []

  // Pass 1: count names and cache parsed results
  for (const fullModelId in curatedModels) {
    const { provider, model: modelName } = getMohdelModel(fullModelId)
    const baseMatch = modelName.match(BASE_NAME_RE)
    const baseName = baseMatch?.[1] || null

    if (baseName) modelCountByName.set(baseName, (modelCountByName.get(baseName) || 0) + 1)
    modelCountByName.set(modelName, (modelCountByName.get(modelName) || 0) + 1)
    parsed.push({ fullModelId, provider, modelName, baseName, entry: curatedModels[fullModelId] })
  }

  // Pass 2: build aliases + explicit aliases
  for (const { fullModelId, provider, modelName, baseName, entry } of parsed) {
    if (modelCountByName.get(modelName) === 1) aliasMap.set(modelName, fullModelId)

    if (baseName) {
      if (modelCountByName.get(baseName) === 1) aliasMap.set(baseName, fullModelId)
      aliasMap.set(`${provider}/${baseName}`, fullModelId)
    }

    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (!aliasMap.has(alias)) aliasMap.set(alias, fullModelId)
      }
    }
  }

  return aliasMap
}

const expandModelAliasInternal = (modelId) => {
  if (curatedCache[modelId]) return modelId
  if (aliasMapCache.has(modelId)) {
    return aliasMapCache.get(modelId)
  }
  return modelId
}

const ensureCuratedCache = async () => {
  if (!curatedCache) {
    curatedCache = await getCuratedModels()
    aliasMapCache = buildAliasMap(curatedCache)
  }
  return curatedCache
}

const rebuildAliasMap = () => {
  aliasMapCache = buildAliasMap(curatedCache || {})
  return aliasMapCache
}

export const loadCuratedCache = ensureCuratedCache

export const getCuratedCacheSnapshot = () => curatedCache

export const getAliasMapSnapshot = () => aliasMapCache

// Find close matches for a model ID that wasn't found.
// Returns array of { id, label } sorted by relevance (max 5).
export const suggestModels = (query, maxResults = 5) => {
  if (!curatedCache) return []
  const q = query.toLowerCase()
  const scored = []

  for (const fullId of Object.keys(curatedCache)) {
    if (curatedCache[fullId].deprecated) continue
    const entry = curatedCache[fullId]
    const label = (entry.label || '').toLowerCase()
    const id = fullId.toLowerCase()
    const model = (entry.model || '').toLowerCase()

    // Score by how well the query matches
    let score = 0
    if (id.includes(q)) score = 3
    else if (model.includes(q)) score = 2.5
    else if (label.includes(q)) score = 2
    else {
      // Fuzzy: check if all query segments appear somewhere
      const terms = q.split(/[\s/\-_]+/).filter(Boolean)
      const haystack = `${id} ${label} ${model}`
      const matched = terms.filter(t => haystack.includes(t))
      if (matched.length === terms.length) score = 1.5
      else if (matched.length > 0) score = matched.length / terms.length
    }

    if (score > 0) scored.push({ id: fullId, label: entry.label || fullId, score })
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return scored.slice(0, maxResults)
}

export const expandModelAliasSync = (modelId) => {
  if (!curatedCache || !aliasMapCache) {
    throw new Error('Curated cache has not been loaded yet')
  }
  return expandModelAliasInternal(modelId)
}

export const expandModelAlias = async (modelId) => {
  await ensureCuratedCache()
  return expandModelAliasInternal(modelId)
}

export const persistCuratedCache = async () => {
  if (!curatedCache) {
    await ensureCuratedCache()
  }

  rebuildAliasMap()
  await saveCuratedModels(curatedCache)
  return curatedCache
}

export const overwriteCuratedCache = async (nextCache) => {
  curatedCache = nextCache || {}
  return persistCuratedCache()
}

export const reloadCuratedCache = async () => {
  curatedCache = null
  aliasMapCache = null
  return ensureCuratedCache()
}

export const clearCuratedCache = () => {
  curatedCache = null
  aliasMapCache = null
}
