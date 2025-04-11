import * as clack from '@clack/prompts'
import minimist from 'minimist'
import fs from 'fs/promises'
import providers from './providers.js'
import * as dotenv from 'dotenv'
import curated from './curated.js'
import excluded from './excluded.js'
import path from 'path'

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
      // Get API key from environment variable
      const apiKey = process.env[config.apiKeyEnv]

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

const writeToFile = async (filePath, content) => {
  const formattedContent = `const ${path.basename(filePath, '.js')} = ${JSON.stringify(content, null, 2)}\n\nexport default ${path.basename(filePath, '.js')}\n`
  await fs.writeFile(filePath, formattedContent, 'utf8')
}

const processModels = async (providerName, providerInstance) => {
  if (!providerInstance.listModels) {
    console.log(`Provider ${providerName} does not support listModels`)
    return
  }

  try {
    console.log(`Processing models for ${providerName}...`)

    const response = await providerInstance.listModels()

    // Handle different response formats from different providers
    const models = response.data || response.models || (Array.isArray(response) ? response : [])

    for (const model of models) {
      const modelId = model.id
      const modelKey = `${providerName}/${modelId}`

      // Skip if already in curated or excluded
      if (curated[modelKey] || excluded[modelKey]) {
        continue
      }

      // Only display details and prompt for models not already in curated or excluded
      // Display full model object for context
      console.log('\nModel details:')
      console.log(JSON.stringify(model, null, 2))

      // Ask user if they want to include this model
      const answer = await clack.select({
        message: `Model ${modelKey} found. What would you like to do?`,
        options: [
          { value: 'include', label: 'Include in curated models' },
          { value: 'exclude', label: 'Add to excluded models' },
          { value: 'skip', label: 'Skip for now' }
        ]
      })

      if (clack.isCancel(answer)) {
        clack.cancel('Operation cancelled')
        return
      }

      if (answer === 'include') {
        curated[modelKey] = { label: model.label || modelId }
        await writeToFile('./src/curated.js', curated)
        clack.log.success(`Added ${modelKey} to curated models`)
      } else if (answer === 'exclude') {
        excluded[modelKey] = { label: model.label || modelId }
        await writeToFile('./src/excluded.js', excluded)
        clack.log.success(`Added ${modelKey} to excluded models`)
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