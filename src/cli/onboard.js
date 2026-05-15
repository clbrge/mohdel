import { intro, outro, select, text, isCancel, cancel, note } from '@clack/prompts'
import { id, label, meta, ok } from './colors.js'
import { chmodSync, existsSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { loadDefaultEnv, getAPIKey, ENV_PATH } from '../lib/common.js'
import providers from '../lib/providers.js'

const PROVIDER_INFO = {
  gemini: {
    label: 'Google Gemini',
    description: 'Gemini 2.5/3 — long context, vision, video. Free tier, no card required.',
    url: 'https://aistudio.google.com/apikey',
    hint: 'Create an API key at aistudio.google.com → Get API Key',
    free: true
  },
  groq: {
    label: 'Groq',
    description: 'Llama 4 — fastest inference available. Free tier, no card required.',
    url: 'https://console.groq.com/keys',
    hint: 'Create an API key at console.groq.com → API Keys',
    free: true
  },
  cerebras: {
    label: 'Cerebras',
    description: 'Llama, Qwen — fast inference on custom hardware. Free tier available.',
    url: 'https://cloud.cerebras.ai/platform',
    hint: 'Create an API key at cloud.cerebras.ai → Platform → API Keys',
    free: true
  },
  anthropic: {
    label: 'Anthropic',
    description: 'Claude Opus, Sonnet, Haiku — reasoning, coding, vision, tool use.',
    url: 'https://console.anthropic.com/settings/keys',
    hint: 'Create an API key at console.anthropic.com → Settings → API Keys',
    free: false
  },
  openai: {
    label: 'OpenAI',
    description: 'GPT-5, o-series — reasoning, vision, image generation.',
    url: 'https://platform.openai.com/api-keys',
    hint: 'Create an API key at platform.openai.com → API Keys',
    free: false
  },
  xai: {
    label: 'xAI',
    description: 'Grok — reasoning and tool use.',
    url: 'https://console.x.ai',
    hint: 'Create an API key at console.x.ai',
    free: false
  },
  mistral: {
    label: 'Mistral',
    description: 'Mistral Large, Codestral, Pixtral — coding, reasoning, vision. Free tier available.',
    url: 'https://console.mistral.ai/api-keys',
    hint: 'Create an API key at console.mistral.ai → API Keys',
    free: true
  },
  deepseek: {
    label: 'DeepSeek',
    description: 'DeepSeek R1/V3 — reasoning, coding. Low cost.',
    url: 'https://platform.deepseek.com/api_keys',
    hint: 'Create an API key at platform.deepseek.com → API Keys',
    free: false
  },
  fireworks: {
    label: 'Fireworks',
    description: 'Llama, Qwen, DeepSeek — serverless inference with reasoning.',
    url: 'https://fireworks.ai/account/api-keys',
    hint: 'Create an API key at fireworks.ai → Account → API Keys',
    free: false
  },
  openrouter: {
    label: 'OpenRouter',
    description: 'Multi-provider router — access 200+ models with one key.',
    url: 'https://openrouter.ai/settings/keys',
    hint: 'Create an API key at openrouter.ai → Settings → Keys',
    free: false
  },
  novita: {
    label: 'Novita',
    description: 'Image generation — Flux, SDXL.',
    url: 'https://novita.ai/dashboard/key',
    hint: 'Create an API key at novita.ai → Dashboard → API Key',
    free: false
  }
}

export { PROVIDER_INFO, appendToEnvFile }

function getConfiguredProviders () {
  const configured = []
  const unconfigured = []
  for (const [name, config] of Object.entries(providers)) {
    if (!config.apiKeyEnv) continue
    const hasKey = !!getAPIKey(config.apiKeyEnv)
    if (hasKey) configured.push(name)
    else unconfigured.push(name)
  }
  return { configured, unconfigured }
}

async function appendToEnvFile (key, value) {
  const dir = dirname(ENV_PATH)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })

  let content = ''
  if (existsSync(ENV_PATH)) {
    content = await readFile(ENV_PATH, 'utf8')
    // Replace existing line if present
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`)
      await writeFile(ENV_PATH, content, { mode: 0o600 })
      chmodSync(ENV_PATH, 0o600)
      return
    }
    if (!content.endsWith('\n')) content += '\n'
  }
  content += `${key}=${value}\n`
  await writeFile(ENV_PATH, content, { mode: 0o600 })
  chmodSync(ENV_PATH, 0o600)
}

export async function runOnboard () {
  loadDefaultEnv()
  const { configured, unconfigured } = getConfiguredProviders()

  // Has providers configured — show status
  if (configured.length > 0) {
    console.log(label('mohdel') + meta(` — ${configured.length} provider${configured.length > 1 ? 's' : ''} configured\n`))
    for (const name of configured) {
      console.log(`  ${ok('●')} ${id(name)}`)
    }
    if (unconfigured.length) {
      console.log('')
      for (const name of unconfigured) {
        console.log(`  ${meta('○')} ${meta(name)}`)
      }
    }
    console.log(`\n${meta('Commands:')}
  mo ask <model> "..."     One-shot inference (pipeable)
  mo doctor                Check install health
  mo model list            Browse curated models
  mo model show <model>    Model details
  mo default               Set default model
  mo provider setup <p>    Add another provider
  mo --help                All commands`)
    return
  }

  // No providers — onboarding wizard
  intro('mohdel — first-time setup')

  note(
    'New to LLM APIs? Start with Gemini, Groq, or Cerebras —\nall offer free tiers with no credit card required.',
    'Tip'
  )

  // Sort: free-tier providers first, then paid
  const providerOptions = unconfigured
    .filter(name => PROVIDER_INFO[name])
    .sort((a, b) => {
      const af = PROVIDER_INFO[a].free ? 0 : 1
      const bf = PROVIDER_INFO[b].free ? 0 : 1
      return af - bf
    })
    .map(name => {
      const info = PROVIDER_INFO[name]
      return {
        value: name,
        label: info.label + (info.free ? ok(' (free)') : ''),
        hint: info.description
      }
    })

  const selected = await select({
    message: 'Select a provider to configure:',
    options: providerOptions
  })

  if (isCancel(selected)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  const info = PROVIDER_INFO[selected]
  const envVar = providers[selected].apiKeyEnv

  note(
    `${info.hint}\n\n${id(info.url)}`,
    `${info.label} — API Key`
  )

  const apiKey = await text({
    message: `Paste your ${selected} API key:`,
    placeholder: envVar,
    validate: (value) => {
      if (!value || !value.trim()) return 'API key cannot be empty'
    }
  })

  if (isCancel(apiKey)) {
    cancel('Setup cancelled')
    process.exit(0)
  }

  await appendToEnvFile(envVar, apiKey.trim())

  note(`${ok('✓')} Saved ${envVar} to ${meta(ENV_PATH)}`, 'Done')

  // Reload env so the new key is visible, then offer to curate models
  loadDefaultEnv()
  const { confirm } = await import('@clack/prompts')
  const shouldCurate = await confirm({
    message: `Fetch and curate models from ${info.label}?`,
    initialValue: true
  })

  if (isCancel(shouldCurate) || !shouldCurate) {
    outro(`Run ${id('mo model curate ' + selected)} later to browse available models.`)
    return
  }

  const { initializeAPIs, processModels } = await import('../lib/select.js')
  const { api } = await initializeAPIs()

  if (!api[selected]) {
    outro(`Could not initialize ${info.label}. Run ${id('mo model curate ' + selected)} to retry.`)
    return
  }

  await processModels(selected, api[selected])
  outro(`Run ${id('mo model list')} to see your curated models.`)
}
