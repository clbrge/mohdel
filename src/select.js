import * as clack from '@clack/prompts'
import minimist from 'minimist'
import providers from './providers.js'
import *
as dotenv from 'dotenv'
import {
  getAPIKey,
  getCuratedModels,
  getExcludedModels,
  saveCuratedModels,
  saveExcludedModels
} from './common.js'

const HELP_TEXT = `
      Usage: node ./src/build.js [options]

      Options:
        -n, --dry-run         Do nothing
        -h, --help            Show this help message
        -p, --provider        Only run a specific provider
`
dotenv.config()

const initializeAPIs = async () => {
  const api = {}
  const providersWithKeys = []

  for (const [name, config] of Object.entries(providers)) {
    try {
      // Get API key using the common.js functionality
      const apiKey = getAPIKey(config.apiKeyEnv)

      if (!apiKey) {
        console.warn(`Warning: No API key found for ${name} (env var: ${config.apiKeyEnv})`)
        continue
      }

      // Create configuration
      const sdkConfig = config.createConfiguration(apiKey)

      // Import the SDK module dynamically
      const sdkPath = `./sdk/${config.sdk}.js`
      const { default: API } = await import(sdkPath)

      // Initialize the provider with the configuration
      api[name] = API(sdkConfig)
      providersWithKeys.push(name)
    } catch (err) {
      console.error(`Error initializing provider ${name} api:`, err.message)
    }
  }

  return { api, providersWithKeys }
}

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
  const baseNameMatch = modelId.match(/^(\w+[0-9\-\.]+)/)
  if (!baseNameMatch) return []

  const baseName = baseNameMatch[1]
  const baseRegExp = new RegExp(`^${baseName}`)

  const candidates = []

  for (const [curatedKey, curatedInfo] of Object.entries(curated)) {
    const [curProviderName, curModelId] = curatedKey.split('/')
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
const replaceModel = async (modelToReplace, newModelKey, newModelLabel, newModelDetails, curated, excluded) => {
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

  // Preserve custom properties from the old model entry,
  // but explicitly exclude 'model' and 'models' fields from the old entry.
  // This prevents old model identifiers from polluting the new entry if the
  // new model's details (newModelDetails) don't specify them, ensuring correct `coreIds` generation.
  const {
    model: _discardedOldModelIdentifier, // eslint-disable-line no-unused-vars
    models: _discardedOldModelIdentifiers, // eslint-disable-line no-unused-vars
    ...restOfOldModelDataProperties
  } = oldModelDataFromCurated || {}

  // Add new model to curated.
  // Merge properties: Start with applicable old properties (restOfOldModelDataProperties),
  // then layer new model details (newModelDetails), which includes new provider & sdk.
  // Finally, ensure the new label (newModelLabel) is set.
  // Properties in newModelDetails and newModelLabel will override any from restOfOldModelDataProperties.
  curated[newModelKey] = {
    ...restOfOldModelDataProperties,
    ...newModelDetails,
    label: newModelLabel
  }

  // Update both files
  await saveCuratedModels(curated)
  await saveExcludedModels(excluded)

  return true
}

const processModels = async (providerName, providerInstance) => {
  if (!providerInstance.listModels) {
    console.log(`Provider ${providerName} does not support listModels`)
    return
  }

  try {
    console.log(`Processing models for ${providerName}...`)

    const curated = await getCuratedModels()
    const excluded = await getExcludedModels()

    const response = await providerInstance.listModels()

    // Handle different response formats from different providers
    const models = response.data || response.models || (Array.isArray(response) ? response : [])

    for (const model of models) {
      const modelId = model.id
      const modelKey = `${providerName}/${modelId}`

      const isInCurated = Object.values(curated).some(entry => entry.coreIds?.includes(modelKey))
      const isInExcluded = Object.values(excluded).some(entry => entry.coreIds?.includes(modelKey))

      // Skip if already in curated or excluded
      if (isInCurated || isInExcluded) {
        continue
      }

      // Only display details and prompt for models not already in curated or excluded
      // Display full model object for context
      console.log('\nModel details:')
      console.log(JSON.stringify(model, null, 2))

      // Find potential models that this new model could replace
      const replacementCandidates = findReplacementCandidates(providerName, modelId, curated)

      // Build options for the select prompt
      const options = [
        { value: 'include', label: 'Include in curated models' },
        { value: 'exclude', label: 'Add to excluded models' },
        { value: 'skip', label: 'Skip for now' }
      ]

      // Add replacement options for each candidate
      for (let i = 0; i < replacementCandidates.length; i++) {
        const candidate = replacementCandidates[i]
        options.push({
          value: `replace_${i}`,
          label: `Replace existing model: ${candidate.key} (${candidate.label})`
        })
      }

      // Ask user if they want to include this model
      const answer = await clack.select({
        message: `Model ${modelKey} found. What would you like to do?`,
        options
      })

      if (clack.isCancel(answer)) {
        clack.cancel('Operation cancelled')
        return
      }

      // Get detailed model information if available
      const s = clack.spinner()
      s.start(`Fetching detailed information for ${modelKey}...`)

      const modelInfo = await getModelDetails(providerName, modelId, providerInstance)
      s.stop(modelInfo ? 'Model details retrieved successfully' : 'Could not retrieve detailed model information')

      // Add provider and sdk properties to the model info
      const providerConfig = providers[providerName]
      const modelInfoWithMeta = {
        ...modelInfo,
        provider: providerName,
        sdk: providerConfig.sdk
      }

      if (answer === 'include') {
        curated[modelKey] = modelInfoWithMeta
        await saveCuratedModels(curated)
        clack.log.success(`Added ${modelKey} to curated models with detailed information`)
      } else if (answer === 'exclude') {
        excluded[modelKey] = modelInfoWithMeta
        await saveExcludedModels(excluded)
        clack.log.success(`Added ${modelKey} to excluded models with detailed information`)
      } else if (answer.startsWith('replace_')) {
        const index = parseInt(answer.split('_')[1], 10)
        const modelToReplace = replacementCandidates[index]

        await replaceModel(
          modelToReplace,
          modelKey,
          model.label || modelId, // newModelLabel
          modelInfoWithMeta, // newModelDetails
          curated,
          excluded
        )

        clack.log.success(
          `Replaced ${modelToReplace.key} with ${modelKey}. ` +
          'The old model has been moved to excluded models.'
        )
      }
    }
  } catch (err) {
    console.error(`Error processing models for ${providerName}:`, err.message)
  }
}

const main = async () => {
  dotenv.config()

  clack.intro('Model Selection Tool')

  const { api, providersWithKeys } = await initializeAPIs()

  if (providersWithKeys.length === 0) {
    clack.log.error('No providers with valid API keys found. Please set up API keys in your environment variables.')
    process.exit(1)
  }

  const args = minimist(process.argv.slice(2), {
    boolean: ['help', 'dry-run'],
    string: ['provider'],
    alias: {
      h: 'help',
      n: 'dry-run',
      p: 'provider'
    }
  })

  if (args.help) {
    console.log(HELP_TEXT)
    return
  }

  const specificProvider = args.provider

  if (specificProvider) {
    if (!api[specificProvider]) {
      console.error(`Provider "${specificProvider}" not found or not initialized. Available providers: ${providersWithKeys.join(', ')}`)
      return
    }

    await processModels(specificProvider, api[specificProvider])
  } else {
    // Ask user which provider to process
    const selectedProvider = await clack.select({
      message: 'Select a provider to process:',
      options: providersWithKeys.map(name => ({
        value: name,
        label: name
      }))
    })

    if (clack.isCancel(selectedProvider)) {
      clack.cancel('Operation cancelled')
      return
    }

    await processModels(selectedProvider, api[selectedProvider])
  }

  clack.outro('Processing complete')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})