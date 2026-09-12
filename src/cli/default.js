import { intro, outro, select, isCancel, cancel } from '@clack/prompts'
import { getConfig, getCuratedModels, saveConfig, catalogEntries } from '../lib/common.js'

export async function runDefault (args = []) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel default — the model "mo ask" uses when you name none

Usage:
  default                Pick one from your catalog (interactive)
  default <model>        Set it directly

Stored in ~/.config/mohdel/default.json. The library and the gate never
read it: a program names its model, or selects one by tag.`)
    process.exit(0)
  }

  const curated = await getCuratedModels()

  const named = args.find(a => !a.startsWith('-'))
  if (named) {
    if (!curated[named] || curated[named].deprecated) {
      console.error(`'${named}' is not a model in your catalog. "mo ls" lists them.`)
      process.exit(1)
    }
    await saveConfig({ ...(await getConfig()), defaultModel: named })
    console.log(`Default set to ${named} — "mo ask" uses it when you give no model.`)
    return
  }

  intro('mohdel — set the default model')
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

  try {
    // The file also holds the chosen coding agent; replacing it wholesale drops that.
    await saveConfig({ ...(await getConfig()), defaultModel: selectedModelId })
    outro(`Default set to ${selectedModelId} — "mo ask" uses it when you give no model.`)
  } catch (err) {
    cancel(`Error: ${err.message}`)
    process.exit(1)
  }
}
