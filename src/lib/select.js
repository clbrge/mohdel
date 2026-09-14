import * as clack from '@clack/prompts'
import providers from './providers.js'
import creators, { creatorFromModelId } from './creators.js'
import {
  getAPIKey,
  getCuratedModels,
  getExcludedModels,
  saveCuratedModels,
  saveExcludedModels,
  loadEnvFile,
  loadDefaultEnv,
  catalogEntries
} from './common.js'
import { getMohdelModel } from './curated-cache.js'
import { stripUnknown } from './schema.js'
import { silent } from './logger.js'

loadEnvFile('.env')
loadDefaultEnv()

// One provider's catalog client, for callers that don't need all of them.
export const providerApi = async (name) => {
  const config = providers[name]
  if (!config || config.catalog === false || !config.apiKeyEnv) return null
  const apiKey = getAPIKey(config.apiKeyEnv)
  if (!apiKey) return null
  const { default: API } = await import(`./catalog/${config.catalogClient || config.sdk}.js`)
  return API({ ...config.createConfiguration(apiKey), baseURL: config.baseURL }, {}, silent)
}

export const providersWithKeys = () =>
  Object.entries(providers)
    .filter(([, c]) => c.catalog !== false && c.apiKeyEnv && getAPIKey(c.apiKeyEnv))
    .map(([name]) => name)

const getModelDetails = async (providerName, modelId, api) => {
  try {
    if (!api.getModelInfo) {
      console.warn(`Provider ${providerName} does not support getModelInfo method`)
      return null
    }

    const modelInfo = await api.getModelInfo(modelId)

    if (!modelInfo) {
      console.warn(`Model ${modelId} not found in provider response`)
      return null
    }

    return modelInfo
  } catch (err) {
    console.error(`Error getting model details for ${modelId}:`, err.message)
    return null
  }
}

// Find potential models to replace based on the new model name
const findReplacementCandidates = (providerName, modelId, curated) => {
  const baseNameMatch = modelId.match(/^(\w+[0-9.-]+)/)
  if (!baseNameMatch) return []

  const baseName = baseNameMatch[1]
  const baseRegExp = new RegExp(`^${baseName}`)

  const candidates = []

  for (const [curatedKey, curatedInfo] of catalogEntries(curated)) {
    const { provider: curProviderName, model: curModelId } = getMohdelModel(curatedKey)
    if (curProviderName === providerName && curModelId !== modelId) {
      if (baseRegExp.test(curModelId)) {
        candidates.push({
          key: curatedKey,
          label: curatedInfo.label,
          modelId: curModelId
        })
      }
    }
  }

  return candidates
}

// Replace a model: move it to excluded and add the new one to curated
const replaceModel = async (modelToReplace, newCuratedKey, newModelLabel, newModelDetails, curated, excluded) => {
  // Get the full data of the model to be replaced from the curated list
  const oldModelDataFromCurated = curated[modelToReplace.key]

  // Move the model to be replaced to excluded, preserving its original data
  if (oldModelDataFromCurated) {
    excluded[modelToReplace.key] = { ...oldModelDataFromCurated }
  } else {
    // Fallback if old data wasn't in curated (should not typically happen)
    excluded[modelToReplace.key] = { label: modelToReplace.label }
  }
  delete curated[modelToReplace.key]

  const {
    model: _discardedOldModelIdentifier, // eslint-disable-line no-unused-vars
    models: _discardedOldModelIdentifiers, // eslint-disable-line no-unused-vars
    ...restOfOldModelDataProperties
  } = oldModelDataFromCurated || {}

  curated[newCuratedKey] = {
    ...restOfOldModelDataProperties,
    ...newModelDetails,
    label: newModelLabel,
    replaces: [...(restOfOldModelDataProperties.replaces || []), modelToReplace.key]
  }

  // Update both files
  await saveCuratedModels(curated)
  await saveExcludedModels(excluded)

  return true
}

const addAliasToExistingModel = async (targetCuratedKey, aliasModelId, curated) => {
  const existingEntry = curated[targetCuratedKey]
  if (!existingEntry) {
    clack.log.error(`Unable to add alias: ${targetCuratedKey} not found in curated models`)
    return false
  }

  const nextAliases = Array.isArray(existingEntry.aliases) ? [...existingEntry.aliases] : []
  if (!nextAliases.includes(aliasModelId)) {
    nextAliases.push(aliasModelId)
  }

  const nextUpstreamIds = Array.isArray(existingEntry.upstreamIds) ? [...existingEntry.upstreamIds] : []
  if (!nextUpstreamIds.includes(aliasModelId)) {
    nextUpstreamIds.push(aliasModelId)
  }

  curated[targetCuratedKey] = {
    ...existingEntry,
    aliases: nextAliases,
    upstreamIds: nextUpstreamIds
  }

  await saveCuratedModels(curated)
  return true
}

const isModelTrackedInCollection = (collection, providerName, modelId) => {
  for (const [curatedKey, entry] of Object.entries(collection)) {
    const { provider, model: keyModelId } = getMohdelModel(curatedKey)
    if (provider !== providerName) continue

    if (keyModelId === modelId) return true

    const upstreamIds = Array.isArray(entry.upstreamIds) ? entry.upstreamIds : []
    if (upstreamIds.includes(modelId)) {
      return true
    }
  }
  return false
}

const creatorOptions = async (providerName, guess) => {
  const catalog = await getCuratedModels()
  const served = new Set()
  for (const [key, spec] of catalogEntries(catalog)) {
    if (spec.deprecated || !spec.creator) continue
    if (key.split('/')[0] === providerName) served.add(spec.creator)
  }
  served.delete(guess)
  const rest = Object.keys(creators).filter(c => c !== guess && !served.has(c)).sort()
  return [
    ...(guess ? [{ value: guess, label: guess, hint: 'matches the model id' }] : []),
    ...[...served].sort().map(c => ({ value: c, label: c, hint: `already served by ${providerName}` })),
    ...rest.map(c => ({ value: c, label: c })),
    { value: '__other', label: 'Other… (enter a name)' }
  ]
}

export const promptMissingFields = async (entry, curatedKey) => {
  if (!entry.creator) {
    const [providerName, ...bare] = curatedKey.split('/')
    const guess = creatorFromModelId(bare.join('/'))
    const creatorVal = await clack.select({
      message: `Creator for ${curatedKey}:`,
      initialValue: guess || undefined,
      options: await creatorOptions(providerName, guess)
    })
    if (clack.isCancel(creatorVal)) return entry
    if (creatorVal === '__other') {
      const custom = await clack.text({
        message: `New creator name for ${curatedKey}:`,
        validate: (v) => v?.trim() ? undefined : 'Creator is required'
      })
      if (clack.isCancel(custom)) return entry
      entry.creator = custom.trim()
    } else {
      entry.creator = creatorVal
    }
  }

  const labelVal = await clack.text({
    message: `Label for ${curatedKey}:`,
    initialValue: entry.label || entry.model || '',
    validate: (v) => v ? undefined : 'Label is required'
  })
  if (clack.isCancel(labelVal)) return entry
  entry.label = labelVal

  const numericFields = [
    { key: 'contextTokenLimit', message: 'Context token limit:' },
    { key: 'outputTokenLimit', message: 'Output token limit:' },
    { key: 'inputPrice', message: 'Input price (per million tokens):' },
    { key: 'outputPrice', message: 'Output price (per million tokens):' }
  ]

  for (const { key, message } of numericFields) {
    if (entry[key] !== undefined) continue
    const val = await clack.text({
      message: `${message} (Enter to skip)`,
      initialValue: '',
      validate: (v) => {
        if (!v) return undefined
        const n = Number(v)
        return Number.isFinite(n) ? undefined : 'Must be a number'
      }
    })
    if (clack.isCancel(val)) return entry
    if (val) entry[key] = Number(val)
  }

  // inputFormat — ask if model supports image input
  if (!entry.inputFormat || !entry.inputFormat.length) {
    const supportsImage = await clack.confirm({
      message: `Does ${curatedKey} support image input?`,
      initialValue: false
    })
    if (clack.isCancel(supportsImage)) return entry
    entry.inputFormat = supportsImage ? ['text', 'image'] : ['text']
  }

  return entry
}

// Threshold: providers with more uncurated models than this use search mode
const SEARCH_MODE_THRESHOLD = 50
const SEARCH_MAX_RESULTS = 15

const filterUncurated = (models, providerName, curated, excluded) => {
  return models.filter(model => {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string') return false
    return !isModelTrackedInCollection(curated, providerName, model.id) &&
           !isModelTrackedInCollection(excluded, providerName, model.id)
  })
}

export const freeModels = (models) =>
  models.filter(m => m.inputPrice === 0 && m.outputPrice === 0)

const buildEntry = async (providerName, model, providerInstance) => {
  const info = await getModelDetails(providerName, model.id, providerInstance)
  const entry = stripUnknown({
    provider: providerName,
    sdk: providers[providerName].sdk,
    model: model.id,
    label: model.label || model.id,
    ...(info || {})
  })
  // An upstream list names the provider, never the creator; an OpenRouter id carries the vendor in its first segment.
  if (!entry.creator) entry.creator = creatorFromModelId(model.id) || model.id.split('/')[0]
  return entry
}

export const addModels = async (providerName, providerInstance, models) => {
  const curated = await getCuratedModels()
  for (const model of models) {
    curated[`${providerName}/${model.id}`] = await buildEntry(providerName, model, providerInstance)
  }
  await saveCuratedModels(curated)
  return models.length
}

const searchModels = (models, query) => {
  const q = query.toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)
  return models.filter(m => {
    const haystack = `${m.id} ${m.label || ''}`.toLowerCase()
    return terms.every(t => haystack.includes(t))
  })
}

const processModelsSearchMode = async (providerName, providerInstance, allModels) => {
  let curated = await getCuratedModels()
  const excluded = await getExcludedModels()
  let uncurated = filterUncurated(allModels, providerName, curated, excluded)

  clack.log.info(`${providerName}: ${allModels.length} models upstream, ${uncurated.length} uncurated`)

  const free = freeModels(uncurated)
  if (free.length) {
    const chosen = await clack.multiselect({
      message: `${free.length} model${free.length > 1 ? 's' : ''} cost${free.length > 1 ? '' : 's'} nothing. Add them?`,
      options: free.map(m => ({ value: m.id, label: m.id, hint: m.label !== m.id ? m.label : undefined })),
      initialValues: free.map(m => m.id),
      maxItems: 12,
      required: false
    })
    if (!clack.isCancel(chosen) && chosen.length) {
      const picked = free.filter(m => chosen.includes(m.id))
      const s = clack.spinner()
      s.start(`Adding ${picked.length} model${picked.length > 1 ? 's' : ''}...`)
      await addModels(providerName, providerInstance, picked)
      s.stop(`Added ${picked.length} model${picked.length > 1 ? 's' : ''}, priced at $0`)
      curated = await getCuratedModels()
      uncurated = filterUncurated(allModels, providerName, curated, excluded)
    }
  }

  while (true) {
    const query = await clack.text({
      message: `Search ${providerName} models (or "done" to finish):`,
      placeholder: 'e.g. claude sonnet, llama 70b, gemini flash',
      validate: (v) => v?.trim() ? undefined : 'Type a few characters to search'
    })

    if (clack.isCancel(query) || query.trim().toLowerCase() === 'done') break

    const matches = searchModels(uncurated, query.trim())

    if (matches.length === 0) {
      clack.log.warn(`No uncurated models matching "${query.trim()}"`)
      continue
    }

    if (matches.length > SEARCH_MAX_RESULTS) {
      clack.log.warn(`${matches.length} matches — narrow your search (showing first ${SEARCH_MAX_RESULTS})`)
    }

    const shown = matches.slice(0, SEARCH_MAX_RESULTS)

    const selected = await clack.select({
      message: `${matches.length} match${matches.length > 1 ? 'es' : ''} — select a model to curate:`,
      options: [
        ...shown.map(m => ({ value: m.id, label: `${m.id}  ${m.label !== m.id ? m.label : ''}`.trim() })),
        { value: '__refine', label: '← Search again' }
      ]
    })

    if (clack.isCancel(selected)) break
    if (selected === '__refine') continue

    const model = allModels.find(m => m.id === selected)
    await processOneModel(providerName, providerInstance, model, curated, excluded)
  }
}

const processOneModel = async (providerName, providerInstance, model, curated, excluded) => {
  const modelId = model.id
  const modelLabel = model.label || modelId
  const curatedKey = `${providerName}/${modelId}`

  console.log('\nModel details:')
  console.log(JSON.stringify(model, null, 2))

  const replacementCandidates = findReplacementCandidates(providerName, modelId, curated)

  const options = [
    { value: 'include', label: 'Include in curated models' },
    { value: 'exclude', label: 'Add to excluded models' },
    { value: 'skip', label: 'Skip for now' }
  ]

  for (let i = 0; i < replacementCandidates.length; i++) {
    const candidate = replacementCandidates[i]
    const candidateLabel = candidate.label || candidate.modelId
    options.push({
      value: `alias_${i}`,
      label: `Add as alias of: ${candidate.key} (${candidateLabel})`
    })
    options.push({
      value: `replace_${i}`,
      label: `Replace existing model: ${candidate.key} (${candidateLabel})`
    })
  }

  const answer = await clack.select({
    message: `Model ${curatedKey} found. What would you like to do?`,
    options
  })

  if (clack.isCancel(answer)) return

  const providerConfig = providers[providerName]
  const baseModelMeta = {
    provider: providerName,
    sdk: providerConfig.sdk,
    model: modelId,
    label: modelLabel
  }

  let modelInfoWithMeta = null
  if (answer === 'include' || answer.startsWith('replace_')) {
    const s = clack.spinner()
    s.start(`Fetching detailed information for ${curatedKey}...`)

    const modelInfo = await getModelDetails(providerName, modelId, providerInstance)
    s.stop(modelInfo ? 'Model details retrieved successfully' : 'Could not retrieve detailed model information')

    modelInfoWithMeta = stripUnknown({
      ...baseModelMeta,
      ...(modelInfo || {})
    })
    modelInfoWithMeta = await promptMissingFields(modelInfoWithMeta, curatedKey)
  }

  if (answer === 'include') {
    curated[curatedKey] = modelInfoWithMeta || baseModelMeta
    await saveCuratedModels(curated)
    clack.log.success(`Added ${curatedKey} to curated models with detailed information`)
  } else if (answer === 'exclude') {
    excluded[curatedKey] = baseModelMeta
    await saveExcludedModels(excluded)
    clack.log.success(`Added ${curatedKey} to excluded models`)
  } else if (answer.startsWith('alias_')) {
    const index = parseInt(answer.split('_')[1], 10)
    const candidate = replacementCandidates[index]
    const aliasAdded = await addAliasToExistingModel(candidate.key, modelId, curated)
    if (aliasAdded) {
      clack.log.success(`${modelId} added as alias of ${candidate.key}`)
    }
  } else if (answer.startsWith('replace_')) {
    const index = parseInt(answer.split('_')[1], 10)
    const modelToReplace = replacementCandidates[index]

    await replaceModel(
      modelToReplace,
      curatedKey,
      modelLabel,
      modelInfoWithMeta || baseModelMeta,
      curated,
      excluded
    )

    clack.log.success(
      `Replaced ${modelToReplace.key} with ${curatedKey}. ` +
      'The old model has been moved to excluded models.'
    )
  }
}

const processModelsSelectMode = async (providerName, providerInstance, allModels) => {
  const curated = await getCuratedModels()
  const excluded = await getExcludedModels()
  const uncurated = filterUncurated(allModels, providerName, curated, excluded)

  if (!uncurated.length) {
    clack.log.info(`${providerName}: no new models`)
    return
  }

  clack.log.info(`${providerName}: ${uncurated.length} new model${uncurated.length > 1 ? 's' : ''}`)

  const selected = await clack.select({
    message: 'Select a model to curate (or skip all):',
    options: [
      ...uncurated.map(m => ({
        value: m.id,
        label: `${m.id}  ${m.label !== m.id ? m.label : ''}`.trim()
      })),
      { value: '__skip', label: '← Skip all' }
    ]
  })

  if (clack.isCancel(selected) || selected === '__skip') return

  const model = allModels.find(m => m.id === selected)
  await processOneModel(providerName, providerInstance, model, curated, excluded)

  // After curating one, recurse to offer the rest
  await processModelsSelectMode(providerName, providerInstance, allModels)
}

export const processModels = async (providerName, providerInstance) => {
  if (!providerInstance.listModels) {
    console.log(`Provider ${providerName} does not support listModels`)
    return false
  }

  // The spinner is started outside the try so a failed fetch can stop it. It
  // used to be created inside, and any error left it spinning forever.
  const s = clack.spinner()
  let spinning = true
  const stop = (message) => {
    if (!spinning) return
    spinning = false
    s.stop(message)
  }
  s.start(`Fetching model list from ${providerName}...`)

  try {
    const models = await providerInstance.listModels()
    if (!Array.isArray(models)) {
      stop(`${providerName} returned an invalid model list`)
      return false
    }

    const curated = await getCuratedModels()
    const excluded = await getExcludedModels()
    const uncurated = filterUncurated(models, providerName, curated, excluded)
    stop(`${providerName}: ${models.length} models upstream, ${uncurated.length} uncurated`)

    if (!uncurated.length) {
      clack.log.info(`Nothing new to curate. To add a model not in the upstream catalog:\n  mo model add ${providerName}/<model-id>`)
      return true
    }

    if (uncurated.length > SEARCH_MODE_THRESHOLD) {
      await processModelsSearchMode(providerName, providerInstance, models)
    } else {
      await processModelsSelectMode(providerName, providerInstance, models)
    }
    return true
  } catch (err) {
    stop(`${providerName}: could not fetch the model list`)
    console.error(err.message)
    console.error(`Check the key with "mo doctor", or reset it with "mo provider setup ${providerName}".`)
    return false
  }
}
