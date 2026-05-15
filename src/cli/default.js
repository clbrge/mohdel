import { intro, outro, select, isCancel, cancel } from '@clack/prompts'
import { getCuratedModels, CONFIG_PATH, saveConfig, catalogEntries } from '../lib/common.js'
import providers from '../lib/providers.js'

export async function runDefault () {
  intro('Mohdel — Set Default Model')

  const curated = await getCuratedModels()
  const modelOptions = catalogEntries(curated).map(([modelId, info]) => ({
    value: modelId,
    label: `${info.label} (${modelId})`
  }))
  modelOptions.sort((a, b) => a.label.localeCompare(b.label))

  const selectedModelId = await select({
    message: 'Select your default model:',
    options: modelOptions
  })

  if (isCancel(selectedModelId)) {
    cancel('Cancelled')
    process.exit(0)
  }

  const [providerName] = selectedModelId.split('/')

  try {
    const config = { defaultModel: selectedModelId }
    const apiKeyEnv = providers[providerName]?.apiKeyEnv
    if (apiKeyEnv) {
      config.apiKeyInfo = `Set ${apiKeyEnv} environment variable for this provider`
    }
    await saveConfig(config)
    outro(`Default set to ${selectedModelId} — saved to ${CONFIG_PATH}`)
  } catch (err) {
    cancel(`Error: ${err.message}`)
    process.exit(1)
  }
}
