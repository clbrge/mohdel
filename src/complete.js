#!/usr/bin/env node

import { intro, outro, text, spinner, confirm, isCancel, cancel } from '@clack/prompts'
import { getCuratedModels } from './common.js'

const run = async () => {
  intro('Complete Model Information')

  const s = spinner()
  s.start('Loading models...')

  // Import models dynamically
  const { default: models } = await import('./models.js')
  const curated = await getCuratedModels()

  // Track which models need completion
  const modelsToUpdate = []
  
  // Scan models for missing properties
  for (const [modelId, modelInfo] of Object.entries(models)) {
    if (!modelInfo.inputPrice || !modelInfo.outputPrice) {
      modelsToUpdate.push({
        modelId,
        modelInfo,
        missing: {
          inputPrice: !modelInfo.inputPrice,
          outputPrice: !modelInfo.outputPrice
        }
      })
    }
  }

  s.stop(`Found ${modelsToUpdate.length} models that need pricing information`)

  if (modelsToUpdate.length === 0) {
    outro('All models already have complete pricing information.')
    return
  }

  // Process each model that needs completion
  for (const { modelId, modelInfo, missing } of modelsToUpdate) {
    const [providerName, modelName] = modelId.split('/')
    const displayName = modelInfo.displayName || curated[modelId]?.label || modelName
    
    console.log(`\n${displayName} (${modelId})`)
    console.log('-'.repeat(40))
    
    // Display existing model information for context
    console.log('Current information:')
    console.log(`- Input token limit: ${modelInfo.inputTokenLimit || 'Unknown'}`)
    console.log(`- Output token limit: ${modelInfo.outputTokenLimit || 'Unknown'}`)
    
    // Gather missing information
    let updated = false
    let shouldBreak = false
    
    if (missing.inputPrice) {
      const inputPrice = await text({
        message: `Input price per 1M tokens for ${displayName}:`,
        placeholder: '2.00',
        validate: value => {
          if (value === '.') return
          if (value && value.trim() === '') return
          if (value && isNaN(parseFloat(value))) {
            return 'Please enter a valid number'
          }
        }
      })
      
      if (isCancel(inputPrice)) {
        cancel('Operation cancelled')
        return
      }
      
      // Check for exit signal
      if (inputPrice === '.') {
        shouldBreak = true
      } else if (inputPrice && inputPrice.trim() !== '') {
        modelInfo.inputPrice = parseFloat(inputPrice)
        updated = true
      }
    }
    
    if (!shouldBreak && missing.outputPrice) {
      const outputPrice = await text({
        message: `Output price per 1M tokens for ${displayName}:`,
        placeholder: '10.00',
        validate: value => {
          if (value === '.') return
          if (value && value.trim() === '') return
          if (value && isNaN(parseFloat(value))) {
            return 'Please enter a valid number'
          }
        }
      })
      
      if (isCancel(outputPrice)) {
        cancel('Operation cancelled')
        return
      }
      
      // Check for exit signal
      if (outputPrice === '.') {
        shouldBreak = true
      } else if (outputPrice && outputPrice.trim() !== '') {
        modelInfo.outputPrice = parseFloat(outputPrice)
        updated = true
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
    const { writeFile } = await import('fs/promises')
    const content = `const models = ${JSON.stringify(models, null, 2)}\n\nexport default models\n`
    await writeFile('./src/models.js', content, 'utf8')
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