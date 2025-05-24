import providers from './providers.js'
import { getAPIKey, getDefaultModelId, getCuratedModels } from './common.js'
import sdks from './sdk/index.js'

// Build an inverse lookup table from model IDs to their aliases
const buildAliasMap = async () => {
  const curated = await getCuratedModels()
  const aliasMap = new Map()
  const modelCountByName = new Map()

  // First pass: Count how many times each base model name appears across providers
  for (const fullModelId in curated) {
    const [provider, ...modelParts] = fullModelId.split('/')
    const modelName = modelParts.join('/')

    // Create base name without version (e.g., claude-3-7-sonnet from claude-3-7-sonnet-20250219)
    const baseNameMatch = modelName.match(/^([^-\d]+-\d+(?:-\d+)*(?:-[a-z]+)?)/)
    if (baseNameMatch && baseNameMatch[1]) {
      const baseName = baseNameMatch[1]
      modelCountByName.set(baseName, (modelCountByName.get(baseName) || 0) + 1)

      // Also store the model ID without version
      modelCountByName.set(modelName, (modelCountByName.get(modelName) || 0) + 1)
    }
  }

  // Second pass: Create aliases for unique model names
  for (const fullModelId in curated) {
    const [provider, ...modelParts] = fullModelId.split('/')
    const modelName = modelParts.join('/')

    // Map the full model name (without provider)
    if (modelCountByName.get(modelName) === 1) {
      aliasMap.set(modelName, fullModelId)
    }

    // Create base name without version
    const baseNameMatch = modelName.match(/^([^-\d]+-\d+(?:-\d+)*(?:-[a-z]+)?)/)
    if (baseNameMatch && baseNameMatch[1]) {
      const baseName = baseNameMatch[1]

      // Store the mapping from base name to full model ID if this base name is unique
      if (modelCountByName.get(baseName) === 1) {
        aliasMap.set(baseName, fullModelId)
      }

      // Always store the mapping with provider prefix
      aliasMap.set(`${provider}/${baseName}`, fullModelId)
    }
  }

  return aliasMap
}

const expandModelAlias = async (modelId) => {
  // Get the curated model list and build alias map
  const curated = await getCuratedModels()
  const aliasMap = await buildAliasMap()

  // If the model ID is already in the curated list, return it as is
  if (curated[modelId]) return modelId

  // Check if we have an alias for this model ID
  if (aliasMap.has(modelId)) {
    return aliasMap.get(modelId)
  }

  return modelId
}

const getProviderAndModel = async (modelId) => {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('Model ID must be a string')
  }

  // Get the curated model list
  const curated = await getCuratedModels()

  // Expand the model ID if it's an alias
  const expandedModelId = await expandModelAlias(modelId)

  // If the expanded ID is the same as the input and doesn't contain a slash,
  // it might be a model name without provider prefix
  if (expandedModelId === modelId && !modelId.includes('/')) {
    // Check if any curated model ends with this model ID
    const matchingModels = Object.keys(curated).filter(id => {
      const parts = id.split('/')
      return parts.length > 1 && parts.slice(1).join('/') === modelId
    })

    if (matchingModels.length === 1) {
      // If exactly one match is found, use that
      return getProviderAndModel(matchingModels[0])
    } else if (matchingModels.length > 1) {
      throw new Error(`Ambiguous model name "${modelId}" matches multiple models: ${matchingModels.join(', ')}`)
    }
  }

  const [providerName, ...modelParts] = expandedModelId.split('/')
  const modelName = modelParts.join('/')

  // If no provider was specified and the split didn't produce a valid provider
  if (!providers[providerName]) {
    throw new Error(`Unknown provider: ${providerName}`)
  }

  if (!curated[expandedModelId]) {
    throw new Error(`Model ${expandedModelId} is not in the curated list`)
  }

  return { providerName, modelName }
}

// Helper function to get default parameters for a model
const getModelDefaults = async (providerName, modelName) => {
  // TODO: This could be expanded to read from the config file
  // For now, it accesses the curated model data if needed,
  // but the current SDK structure doesn't seem to pass defaults this way.
  const curated = await getCuratedModels()
  const fullModelId = `${providerName}/${modelName}`
  return curated[fullModelId] || {}
}

const mohdel = (modelId) => {
  const answer = async (prompt, options = {}) => {
    const resolvedModelId = modelId || await getDefaultModelId()
    const { providerName, modelName } = await getProviderAndModel(resolvedModelId)

    const config = providers[providerName]
    const apiKey = getAPIKey(config.apiKeyEnv)

    if (!apiKey) {
      throw new Error(`API key not found for ${providerName} (env var: ${config.apiKeyEnv})`)
    }

    const curated = await getCuratedModels()
    const sdk = sdks[config.sdk] // Gets the SDK function (e.g., anthropicSDK)
    const api = sdk(config.createConfiguration(apiKey), { [resolvedModelId]: curated[resolvedModelId] }) // Instantiates SDK

    return await api.answer(resolvedModelId)(prompt, options) // Calls the specific model's answer method
  }

  return new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'answer') {
        // NOTE: 'answer' method seems slightly different, potentially older implementation?
        // It directly uses sdks[config.sdk] and passes curated specs.
        return answer
      }
      if (prop === 'completion') {
        return async (prompt, options = {}) => {
          const { output } = await answer(prompt, options)
          return output
        }
      }
      return target[prop]
    }
  })
}

export default mohdel
export { expandModelAlias, getProviderAndModel }
