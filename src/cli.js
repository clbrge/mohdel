#!/usr/bin/env node

import { intro, outro, select, isCancel, cancel } from '@clack/prompts'
import { existsSync } from 'fs'
import curated from './curated.js'
import providers from './providers.js'
import { CONFIG_DIR, CONFIG_PATH, saveConfig } from './common.js'

const run = async () => {
  intro('Mohdel Configuration')

  // Create options from curated models
  const modelOptions = Object.entries(curated).map(([modelId, info]) => ({
    value: modelId,
    label: `${info.label} (${modelId})`
  }))

  // Sort options by label
  modelOptions.sort((a, b) => a.label.localeCompare(b.label))

  const selectedModelId = await select({
    message: 'Select your default model:',
    options: modelOptions
  })

  if (isCancel(selectedModelId)) {
    cancel('Configuration cancelled')
    process.exit(0)
  }

  // Extract provider name from the model ID
  const [providerName] = selectedModelId.split('/')

  try {
    // Create a basic configuration with the selected model
    const config = {
      defaultModel: selectedModelId
    }

    // Add placeholder for API keys
    const apiKeyEnv = providers[providerName]?.apiKeyEnv
    if (apiKeyEnv) {
      config.apiKeyInfo = `Set ${apiKeyEnv} environment variable for this provider`
    }

    await saveConfig(config)
    outro(`Configuration saved to ${CONFIG_PATH}`)
  } catch (err) {
    cancel(`Error creating configuration: ${err.message}`)
    process.exit(1)
  }
}

run().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})