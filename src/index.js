import providers from './providers.js'
import curated from './curated.js'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import * as common from './common.js'

const importSDK = async (providerName) => {
  try {
    const { sdk } = providers[providerName]
    // Use import.meta.url to create a proper URL for dynamic imports
    const sdkPath = new URL(`./sdk/${sdk}.js`, import.meta.url).href
    const { default: SDK } = await import(sdkPath)
    return SDK
  } catch (err) {
    throw new Error(`Failed to import SDK for provider ${providerName}: ${err.message}`)
  }
}

// Build an inverse lookup table from model IDs to their aliases
const buildAliasMap = () => {
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

const aliasMap = buildAliasMap()

const expandModelAlias = (modelId) => {
  // If the model ID is already in the curated list, return it as is
  if (curated[modelId]) return modelId

  // Check if we have an alias for this model ID
  if (aliasMap.has(modelId)) {
    return aliasMap.get(modelId)
  }

  return modelId
}

const getProviderAndModel = (modelId) => {
  if (!modelId || typeof modelId !== 'string') {
    throw new Error('Model ID must be a string')
  }

  // Expand the model ID if it's an alias
  const expandedModelId = expandModelAlias(modelId)

  // If the expanded ID is the same as the input and doesn't contain a slash,
  // it might be a model name without provider prefix that wasn't in our alias map
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

const getDefaultModelId = () => {
  if (defaultParams.defaultModel) {
    return defaultParams.defaultModel
  }
  throw new Error('No default model configured. Run \'npx mohdel\' to set up a default model.')
}

const mohdel = (modelId) => {
  const resolvedModelId = modelId || getDefaultModelId()
  const { providerName, modelName } = getProviderAndModel(resolvedModelId)

  // Create a proxy that will lazily load the SDK when methods are called
  return new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'completion') {
        return async (prompt, userParams = {}) => {
          const config = providers[providerName]
          const apiKey = common.getAPIKey(config.apiKeyEnv)

          if (!apiKey) {
            throw new Error(`API key not found for ${providerName} (env var: ${config.apiKeyEnv})`)
          }

          const SDK = await importSDK(providerName)
          const api = SDK(config.createConfiguration(apiKey))

          // Merge default parameters with user-provided parameters
          const mergedParams = {
            ...defaultParams[providerName],
            ...defaultParams[`${providerName}/${modelName}`],
            ...userParams
          }

          // Call the completion method as defined in the SDK interface
          return await api.completion(modelName)(prompt, mergedParams)
        }
      }
      return target[prop]
    }
  })
}

export default mohdel
