#!/usr/bin/env node

import { intro, outro, spinner } from '@clack/prompts'
import { writeFile } from 'fs/promises'
import * as dotenv from 'dotenv'
import providers from './providers.js'
import curated from './curated.js'

dotenv.config()

// Get model details from the provider API
const getModelDetails = async (providerName, modelId, api) => {
  try {
    if (providerName === 'gemini') {
      // For Gemini, we use the listModels method to get all models
      const models = await api.listModels()
      
      // Find the specific model we're looking for
      const modelDetails = models.models?.find(model => 
        model.id === modelId || model.name === `models/${modelId}`
      )
      
      if (!modelDetails) {
        console.warn(`Model ${modelId} not found in provider response`)
        return null
      }
      
      return {
        id: modelDetails.name.replace('models/', ''),
        displayName: modelDetails.displayName,
        description: modelDetails.description,
        inputTokenLimit: modelDetails.inputTokenLimit,
        outputTokenLimit: modelDetails.outputTokenLimit,
        supportedGenerationMethods: modelDetails.supportedGenerationMethods,
        temperature: modelDetails.temperature,
        topP: modelDetails.topP,
        topK: modelDetails.topK
      }
    }
    
    // For other providers, implement their specific API requirements
    console.warn(`Provider ${providerName} not yet implemented for model details`)
    return null
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

// Save model information to a file
const saveModelInfo = async (modelInfo) => {
  const content = `const models = ${JSON.stringify(modelInfo, null, 2)}\n\nexport default models\n`
  await writeFile('./src/models.js', content, 'utf8')
}

const syncModels = async () => {
  intro('Syncing model characteristics')
  
  const modelInfo = {}
  
  // For now, focus on the specified Gemini model
  const targetModel = 'gemini/gemini-2.5-pro-preview-03-25'
  
  try {
    const [providerName, modelId] = targetModel.split('/')
    
    const progress = spinner()
    progress.start(`Initializing ${providerName} API`)
    
    const api = await initializeAPI(providerName)
    
    progress.message(`Fetching details for ${modelId}`)
    const details = await getModelDetails(providerName, modelId, api)
    
    if (details) {
      modelInfo[targetModel] = details
      progress.message('Saving model information')
      await saveModelInfo(modelInfo)
      progress.stop('Model details synced successfully')
    } else {
      progress.stop(`Could not retrieve details for ${targetModel}`)
    }
  } catch (err) {
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