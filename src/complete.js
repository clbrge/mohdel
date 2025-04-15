#!/usr/bin/env node

import { intro, outro, text, spinner, confirm, isCancel, cancel, select } from '@clack/prompts'
import { getCuratedModels, saveCuratedModels, getConfig } from './common.js'

const run = async () => {
  intro('Complete Model Information')

  const s = spinner()
  s.start('Loading models...')

  // Load curated models
  const curated = await getCuratedModels()

  // Get configuration to check for requiredInfo
  const config = await getConfig()

  // Define the properties we want to ensure exist for each model
  const defaultRequiredInfo = [
    { name: 'inputPrice', label: 'Input price per 1M tokens', placeholder: '2.00' },
    { name: 'outputPrice', label: 'Output price per 1M tokens', placeholder: '10.00' },
    { name: 'inputTokenLimit', label: 'Input token limit', placeholder: '8192' },
    { name: 'outputTokenLimit', label: 'Output token limit', placeholder: '4096' }
  ]

  // Use requiredInfo from config if available, otherwise use the default
  const requiredInfo = config.requiredInfo || defaultRequiredInfo

  // Track which models need completion
  const modelsToUpdate = []

  // Scan models for missing properties
  for (const [modelId, modelInfo] of Object.entries(curated)) {
    const missingProps = {}
    let hasMissingProps = false

    for (const prop of requiredInfo) {
      // Check if this property should be included based on onlyIf condition
      const shouldInclude = !prop.onlyIf || (modelInfo[prop.onlyIf] && !!modelInfo[prop.onlyIf])
      
      // Only check for missing properties if this property should be included
      if (shouldInclude && (modelInfo[prop.name] === undefined || modelInfo[prop.name] === null)) {
        missingProps[prop.name] = true
        hasMissingProps = true
      }
    }

    if (hasMissingProps) {
      modelsToUpdate.push({
        modelId,
        modelInfo,
        missing: missingProps
      })
    }
  }

  s.stop(`Found ${modelsToUpdate.length} models that need additional information`)

  if (modelsToUpdate.length === 0) {
    outro('All models already have complete information.')
    return
  }

  // Let user choose to continue or exit
  const shouldContinue = await confirm({
    message: `Ready to complete information for ${modelsToUpdate.length} models?`
  })

  if (isCancel(shouldContinue) || !shouldContinue) {
    cancel('Operation cancelled')
    return
  }

  // Ask user if they want to filter by provider
  const providers = [...new Set(modelsToUpdate.map(model => model.modelId.split('/')[0]))]

  const filterOptions = [
    { value: 'all', label: 'All providers' },
    ...providers.map(provider => ({ value: provider, label: provider }))
  ]

  const selectedProvider = await select({
    message: 'Which provider models would you like to update?',
    options: filterOptions
  })

  if (isCancel(selectedProvider)) {
    cancel('Operation cancelled')
    return
  }

  // Filter models by selected provider
  const filteredModels = selectedProvider === 'all'
    ? modelsToUpdate
    : modelsToUpdate.filter(model => model.modelId.startsWith(`${selectedProvider}/`))

  // Process each model that needs completion
  for (const { modelId, modelInfo, missing } of filteredModels) {
    const [providerName, modelName] = modelId.split('/')
    const displayName = modelInfo.displayName || modelInfo.label || modelName

    console.log(`\n${displayName} (${modelId})`)
    console.log('-'.repeat(40))

    // Display existing model information for context
    console.log('Current information:')
    for (const prop of requiredInfo) {
      // Check if this property should be included based on onlyIf condition
      const shouldInclude = !prop.onlyIf || (modelInfo[prop.onlyIf] && !!modelInfo[prop.onlyIf])
      
      if (shouldInclude) {
        console.log(`- ${prop.label}: ${modelInfo[prop.name] !== undefined ? modelInfo[prop.name] : 'Missing'}`)
      }
    }

    // Gather missing information
    let updated = false
    let shouldBreak = false

    for (const prop of requiredInfo) {
      // Check if this property should be included based on onlyIf condition
      const shouldInclude = !prop.onlyIf || (modelInfo[prop.onlyIf] && !!modelInfo[prop.onlyIf])
      
      if (shouldInclude && missing[prop.name]) {
        if (prop.select && Array.isArray(prop.select)) {
          const options = prop.select.map(option => {
            return typeof option === 'string'
              ? { value: option, label: option }
              : option
          })
          
          const value = await select({
            message: `${prop.label} for ${displayName}:`,
            options
          })
          
          if (isCancel(value)) {
            cancel('Operation cancelled')
            return
          }
          
          modelInfo[prop.name] = value
          updated = true
        } else {
          // Use text input for non-select properties
          const placeholder = prop.placeholder ? String(prop.placeholder) : ''
          
          const value = await text({
            message: `${prop.label} for ${displayName}:`,
            placeholder,
            validate: value => {
              if (value === '.') return
              if (value && value.trim() === '') return

              // For numerical properties, validate they're numbers
              if (['inputPrice', 'outputPrice', 'inputTokenLimit', 'outputTokenLimit'].includes(prop.name) &&
                  value && isNaN(parseFloat(value))) {
                return 'Please enter a valid number'
              }
            }
          })

          if (isCancel(value)) {
            cancel('Operation cancelled')
            return
          }

          // Check for exit signal
          if (value === '.') {
            shouldBreak = true
            break
          } else if (value && value.trim() !== '') {
            // Dynamically determine if the value should be stored as a number or string
            const parsedValue = parseFloat(value)
            modelInfo[prop.name] = !isNaN(parsedValue) ? parsedValue : value
            updated = true
          }
        }
      }
    }

    if (updated) {
      console.log(`Updated information for ${displayName}`)
    }

    if (shouldBreak) {
      console.log('Exiting input loop. Previous updates were saved.')
      break
    }
  }

  // Ask for confirmation before saving changes
  const shouldSave = await confirm({
    message: 'Save updated model information?'
  })

  if (isCancel(shouldSave) || !shouldSave) {
    cancel('Changes discarded')
    return
  }

  // Save updated models
  s.start('Saving updated model information...')

  try {
    await saveCuratedModels(curated)
    s.stop('Model information updated successfully')
  } catch (err) {
    s.stop(`Error saving model information: ${err.message}`)
    console.error('Error:', err)
  }

  outro('Model completion process finished')
}

run().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})