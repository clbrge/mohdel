#!/usr/bin/env node

import { intro, outro, spinner } from '@clack/prompts'
import * as dotenv from 'dotenv'
import providers from './providers.js'
import { getCuratedModels, getExcludedModels, saveCuratedModels } from './common.js'

dotenv.config()

// Get model details from the provider API
const getModelDetails = async (providerName, modelId, api) => {
  try {
    if (!api.getModelInfo) {
      console.warn(`Provider ${providerName} does not support getModelInfo method`)
      return null
    }

    const modelDetails = await api.getModelInfo(modelId)
    
    if (!modelDetails) {
      console.warn(`Model ${modelId} not found in provider response`)
      return null
    }
    
    // Process model details based on provider
    if (providerName === 'gemini') {
      // Return all properties from the model details
      // Including core fields with fallbacks to ensure we always have basic info
      return {
        id: modelDetails.name?.replace('models/', '') || modelId,
        displayName: modelDetails.displayName,
        description: modelDetails.description,
        inputTokenLimit: modelDetails.inputTokenLimit,
        outputTokenLimit: modelDetails.outputTokenLimit,
        supportedGenerationMethods: modelDetails.supportedGenerationMethods,
        supportedActions: modelDetails.supportedActions,
        temperature: modelDetails.temperature,
        topP: modelDetails.topP,
        topK: modelDetails.topK,
        // Preserve all other properties from the response
        ...Object.entries(modelDetails)
          .filter(([key]) => !['name', 'displayName', 'description', 'inputTokenLimit', 'outputTokenLimit', 
                             'supportedGenerationMethods', 'supportedActions', 'temperature', 'topP', 'topK'].includes(key))
          .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
      }
    } else if (providerName === 'anthropic') {
      // Process Anthropic model details
      return {
        id: modelId,
        displayName: modelDetails.name || modelId,
        description: modelDetails.description || '',
        inputTokenLimit: modelDetails.context_window_size || 0,
        outputTokenLimit: modelDetails.max_tokens || 0,
        // Include all other properties
        ...Object.entries(modelDetails)
          .filter(([key]) => !['name', 'description', 'context_window_size', 'max_tokens'].includes(key))
          .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
      }
    } else if (providerName === 'openai') {
      // Process OpenAI model details
      return {
        id: modelId,
        displayName: modelDetails.name || modelId,
        description: modelDetails.description || '',
        inputTokenLimit: modelDetails.context_window || 0,
        outputTokenLimit: modelDetails.max_tokens || 0,
        // Include all other properties
        ...Object.entries(modelDetails)
          .filter(([key]) => !['name', 'description', 'context_window', 'max_tokens'].includes(key))
          .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {})
      }
    } else {
      // Generic model details for other providers - preserve all data
      return {
        id: modelId,
        displayName: modelDetails.name || modelId,
        description: modelDetails.description || 'No description available',
        provider: providerName,
        // Include all properties from the API response
        ...modelDetails
      }
    }
  } catch (err) {
    console.error(`Error getting model details for ${modelId}:`, err.message)
    return null
  }
}

// Initialize the API for a specific provider
const initializeAPI = async (providerName) => {
  const providerConfig = providers[providerName]
  if (!providerConfig) {
    throw new Error(`Provider ${providerName} not found`)
  }
  
  const apiKey = process.env[providerConfig.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`API key not found for ${providerName} (env var: ${providerConfig.apiKeyEnv})`)
  }
  
  const sdkConfig = providerConfig.createConfiguration(apiKey)
  const sdkPath = `./sdk/${providerConfig.sdk}.js`
  const { default: API } = await import(sdkPath)
  
  return API(sdkConfig)
}

const syncModels = async () => {
  intro('Syncing model characteristics')
  
  // Process all models in curated list
  const progress = spinner()
  progress.start('Initializing APIs for all providers')
  
  try {
    // Get curated and excluded models from config directory
    const curated = await getCuratedModels()
    const excluded = await getExcludedModels()
    
    // Group models by provider for efficient API initialization
    const modelsByProvider = {}
    
    for (const modelKey in curated) {
      const [providerName] = modelKey.split('/')
      if (!modelsByProvider[providerName]) {
        modelsByProvider[providerName] = []
      }
      modelsByProvider[providerName].push(modelKey)
    }
    
    // Process each provider's models
    for (const [providerName, models] of Object.entries(modelsByProvider)) {
      try {
        progress.message(`Initializing ${providerName} API`)
        const api = await initializeAPI(providerName)
        
        for (const modelKey of models) {
          const [, ...modelParts] = modelKey.split('/')
          const modelId = modelParts.join('/')
          
          progress.message(`Fetching details for ${modelKey}`)
          const details = await getModelDetails(providerName, modelId, api)
          
          if (details) {
            // Update the curated model info with details from the API
            curated[modelKey] = {
              ...curated[modelKey],
              ...details
            }
          }
        }
      } catch (err) {
        console.error(`Error processing provider ${providerName}:`, err.message)
        // Continue with next provider
      }
    }
    
    progress.message('Saving updated curated model information')
    await saveCuratedModels(curated)
    progress.stop('Model details synced successfully to curated.json')
  } catch (err) {
    progress.stop(`Error syncing models: ${err.message}`)
    console.error('Error syncing models:', err.message)
    process.exit(1)
  }
  
  outro('Model sync complete')
}

// Run the sync process
syncModels().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})