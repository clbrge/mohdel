import { intro, outro, select, text, password, confirm, isCancel, cancel, note, spinner } from '@clack/prompts'
import { id, label, meta, ok } from './colors.js'
import { chmodSync, existsSync, readFileSync } from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import { loadDefaultEnv, getAPIKey, getConfig, saveConfig, getCuratedModels, catalogEntries, ENV_PATH } from '../lib/common.js'
import providers from '../lib/providers.js'
import PROVIDER_INFO from '../lib/provider-info.js'

export { PROVIDER_INFO, appendToEnvFile, verifyKey, askValidatedKey }

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

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function appendToEnvFile (key, value) {
  const dir = dirname(ENV_PATH)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })

  let content = ''
  if (existsSync(ENV_PATH)) {
    content = await readFile(ENV_PATH, 'utf8')
    // Function form: `$&`, `` $` ``, `$'` and `$1` are expanded inside a replacement string, which would rewrite a pasted key.
    const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm')
    if (re.test(content)) {
      content = content.replace(re, () => `${key}=${value}`)
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

  if (configured.length > 0) {
    const curated = await getCuratedModels()
    const active = catalogEntries(curated).filter(([, s]) => !s.deprecated)
    const unpriced = active.filter(([, s]) => s.inputPrice == null).length

    const catalog = active.length === 0
      ? 'catalog empty'
      : `${active.length} model${active.length > 1 ? 's' : ''}` +
        (unpriced ? `, ${unpriced} without prices` : '')
    const shown = configured.slice(0, 4).map(n => id(n)).join(meta(', '))
    const more = configured.length > 4 ? meta(` +${configured.length - 4} more`) : ''
    console.log(`${label('mohdel')} ${meta('—')} ${shown}${more}  ${meta('·')} ${meta(catalog)}\n`)

    const first = configured[0]
    const next = []
    let handOver = null
    if (active.length === 0) {
      next.push([`mo curate ${first}`, 'add the models this key can reach'])
      const { BRIEF_FILE, BRIEF_HEADING } = await import('./instructions.js')
      const briefPath = resolve(process.cwd(), BRIEF_FILE)
      const briefReady = existsSync(briefPath) &&
        readFileSync(briefPath, 'utf8').startsWith(BRIEF_HEADING)
      if (briefReady) {
        const { detectAssistants, preferredAgent, briefPrompt } = await import('../lib/assistants.js')
        const agent = preferredAgent((await getConfig()).assistant, detectAssistants())
        handOver = { file: BRIEF_FILE, line: agent.start(`"${briefPrompt(BRIEF_FILE, first)}"`) }
      } else {
        next.push([`mo model instructions ${first}`, 'let your agent fill in the prices'])
      }
    } else {
      if (unpriced) next.push([`mo model instructions ${first}`, 'fill in the missing prices'])
      next.push(['mo ask <model> "..."', 'one-shot inference'])
      next.push(['mo ls', 'browse the catalog'])
    }
    if (unconfigured.length) {
      next.push(['mo providers', `${unconfigured.length} more providers available`])
    }
    next.push(['mo --help', 'everything else'])

    const width = Math.max(...next.map(([cmd]) => cmd.length))
    for (const [cmd, why] of next) console.log(`  ${id(cmd.padEnd(width))}  ${meta(why)}`)
    if (handOver) {
      console.log(`\n  ${meta(`${handOver.file} is written — hand it over:`)}\n    ${id(handOver.line)}`)
    }
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

  if (!await askKey(selected)) {
    cancel('Setup cancelled')
    process.exit(0)
  }
  await fillCatalog(selected)
}

export async function runOnboardCommand (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel onboard — set up a provider: its key or sign-in, then its models

Usage:
  mo onboard                Pick a provider (interactive)
  mo onboard <provider>     Start at that provider; steps already done are skipped

Exit code (mo onboard <provider>):
  0  the provider has its credential and at least one model in the catalog
  1  it does not yet — the last line names the command that closes it
  2  no such provider`)
    return 0
  }
  const provider = args.find(a => !a.startsWith('-'))
  if (provider) return runOnboardProvider(provider)
  await runOnboard()
  return 0
}

/**
 * `mo onboard <provider>`: that provider's credential — its key, or a ChatGPT sign-in — then its
 * models in the catalog, each step skipped when already done. The exit code is for a program that
 * ran it for its user: 0 when the provider is ready, 1 when it is not, 2 for a provider mohdel does
 * not know.
 */
export async function runOnboardProvider (provider) {
  loadDefaultEnv()
  const def = providers[provider]
  if (!def) {
    console.error(`mo onboard: no provider "${provider}" — mo providers lists them`)
    return 2
  }
  const { credentialOf, providerReadiness } = await import('../lib/readiness.js')
  intro(`mohdel — ${PROVIDER_INFO[provider]?.label ?? provider}`)
  // A stored key the provider refuses counts as unset, so onboarding repairs
  // it instead of skipping past it. Anything unverifiable (offline, a provider
  // with no listing mohdel reads) keeps the stored key and proceeds.
  let credential = await credentialOf(provider)
  if (credential && def.apiKeyEnv) {
    const stored = getAPIKey(def.apiKeyEnv)
    if (stored) {
      const check = spinner()
      check.start('Checking the saved key…')
      const verdict = await verifyKey(provider, stored)
      check.stop(verdict === 'valid' ? 'Saved key accepted' : verdict === 'invalid' ? 'Saved key refused' : 'Could not check the saved key')
      if (verdict === 'invalid') {
        note(`The saved ${def.apiKeyEnv} was refused by ${provider} — paste a fresh one.`, 'Invalid key')
        credential = false
      }
    }
  }
  if (!credential) {
    if (def.catalogClient === 'chatgpt') {
      const { runChatGPT } = await import('./chatgpt.js')
      await runChatGPT(['login'])
    } else if (def.apiKeyEnv && !await askKey(provider)) {
      cancel('Setup cancelled')
      return 1
    }
    loadDefaultEnv()
  }
  if (await credentialOf(provider) && !(await providerReadiness(provider)).models) {
    if (def.catalogClient === 'chatgpt') {
      const { providerApi, processModels } = await import('../lib/select.js')
      await processModels(provider, await providerApi(provider))
    } else {
      await fillCatalog(provider)
    }
  }
  const ready = await providerReadiness(provider)
  outro(ready.ready
    ? `${provider} is ready — ${ready.models} model${ready.models > 1 ? 's' : ''} in the catalog`
    : `${provider} is not ready — ${ready.fix}`)
  return ready.ready ? 0 : 1
}

const AUTH_FAILURE_RE = /40[13]|unauthorized|forbidden|invalid[\s_-]*api[\s_-]*key|invalid key|incorrect api key|authentication/i

const isAuthFailure = (err) => AUTH_FAILURE_RE.test(`${err?.message ?? err}`)

/** OpenRouter's model list is public, so a listing proves nothing about the key. */
const verifyOpenRouterKey = async (key) => {
  let res
  try {
    res = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${key}` } })
  } catch {
    return 'unknown'
  }
  if (res.ok) return 'valid'
  if (res.status === 401 || res.status === 403) return 'invalid'
  return 'unknown'
}

/**
 * What the provider says of a candidate key, before anything is saved:
 * `valid`, `invalid` (the provider refused it), or `unknown` (offline, or no
 * listing mohdel reads — nothing to check against). Keyless providers
 * (chatgpt, local) are always `unknown`; callers skip them.
 */
async function verifyKey (provider, key) {
  const def = providers[provider]
  if (!def?.apiKeyEnv) return 'unknown'
  if (provider === 'openrouter') return verifyOpenRouterKey(key)
  let API
  try {
    ({ default: API } = await import(`../lib/catalog/${def.catalogClient || def.sdk}.js`))
  } catch {
    return 'unknown'
  }
  const { silent } = await import('../lib/logger.js')
  let api
  try {
    api = API({ ...def.createConfiguration(key), baseURL: def.baseURL }, {}, silent)
  } catch {
    return 'unknown'
  }
  if (!api?.listModels) return 'unknown'
  try {
    await api.listModels()
    return 'valid'
  } catch (err) {
    return isAuthFailure(err) ? 'invalid' : 'unknown'
  }
}

/**
 * The provider's key, prompted for masked, verified against the provider, and
 * returned — never saved here. Loops on a refused key, offers to save an
 * unverifiable one, and returns null when the user cancels.
 */
async function askValidatedKey (provider) {
  const info = PROVIDER_INFO[provider]
  const envVar = providers[provider].apiKeyEnv

  note(
    `${info.hint}\n\n${id(info.url)}`,
    `${info.label} — API Key`
  )

  for (;;) {
    const pasted = await password({
      message: `Paste your ${provider} API key:`,
      placeholder: envVar,
      mask: '•',
      validate: (value) => {
        if (!value || !value.trim()) return 'API key cannot be empty'
      }
    })

    if (isCancel(pasted)) return null
    const key = pasted.trim()

    const check = spinner()
    check.start('Checking the key…')
    const verdict = await verifyKey(provider, key)
    check.stop(verdict === 'valid' ? 'Key accepted' : verdict === 'invalid' ? 'Key refused' : 'Could not check the key')

    if (verdict === 'valid') return key
    if (verdict === 'unknown') {
      const save = await confirm({ message: 'The key could not be verified (offline?). Save it anyway?' })
      if (isCancel(save)) return null
      if (save) return key
    } else {
      note('That key was refused — check for a truncated paste and try again.', 'Invalid key')
    }
  }
}

/** The provider's key, asked for and written to the environment file; false when the user cancelled. */
async function askKey (selected) {
  const envVar = providers[selected].apiKeyEnv

  const key = await askValidatedKey(selected)
  if (!key) return false

  await appendToEnvFile(envVar, key)

  note(`${ok('✓')} Saved ${envVar} to ${meta(ENV_PATH)}`, 'Done')
  return true
}

/**
 * Fills the catalog with the provider's models: its free ones, picked by hand, or briefed to the
 * user's coding agent, which reads the provider's pricing page.
 */
async function fillCatalog (selected) {
  // Reload env so the new key is visible, then fill the catalog.
  loadDefaultEnv()
  // A provider with no entry there (local) is named by its id.
  const info = PROVIDER_INFO[selected] ?? { label: selected }

  const selfPricing = !!providers[selected]?.pricesFromApi

  let api = null
  let free = []
  if (selfPricing) {
    const { providerApi, freeModels } = await import('../lib/select.js')
    api = await providerApi(selected)
    if (api?.listModels) {
      const s = spinner()
      s.start(`Reading ${info.label}'s model list...`)
      try {
        free = freeModels(await api.listModels())
        s.stop(`${info.label}: ${free.length} of its models cost nothing`)
      } catch (e) {
        s.stop(`Could not read ${info.label}'s model list: ${e.message}`)
      }
    }
  }

  const how = await select({
    message: 'How do you want to fill your catalog?',
    initialValue: free.length ? 'free' : selfPricing ? 'hand' : 'agent',
    options: selfPricing
      ? [
          ...(free.length
            ? [{ value: 'free', label: `Add the free models (${free.length})`, hint: 'nothing to pay, nothing to type' }]
            : []),
          { value: 'hand', label: 'Pick models by hand', hint: `${info.label} publishes prices — nothing else needed` },
          { value: 'agent', label: 'Let my coding agent do it', hint: 'for anything the model list omits' },
          { value: 'later', label: 'Later' }
        ]
      : [
          { value: 'agent', label: 'Let my coding agent do it', hint: 'fetches the model list and the prices' },
          { value: 'hand', label: 'Pick models by hand', hint: 'ids only — prices left for later' },
          { value: 'later', label: 'Later' }
        ]
  })
  if (isCancel(how) || how === 'later') {
    outro(`Later: ${id('mo model instructions ' + selected)}  ${meta('│')}  ${id('mo curate ' + selected)}`)
    return
  }

  if (how === 'free') {
    const { addModels } = await import('../lib/select.js')
    const s = spinner()
    s.start(`Adding ${free.length} model${free.length > 1 ? 's' : ''}...`)
    await addModels(selected, api, free)
    s.stop(`Added ${free.length} model${free.length > 1 ? 's' : ''}, priced at $0`)
    outro(`Ready — ${id('mo ls')} lists them, then ${id('mo ask <model> "…"')}. ` +
      `${id('mo curate ' + selected)} adds the paid ones.`)
    return
  }

  if (how === 'hand') {
    const { providerApi, processModels } = await import('../lib/select.js')
    api = api || await providerApi(selected)
    if (!api) {
      outro(`Could not reach ${info.label}. Run ${id('mo curate ' + selected)} to retry.`)
      return
    }
    if (!await processModels(selected, api)) {
      outro(`Nothing curated. Retry with ${id('mo curate ' + selected)}.`)
      return
    }
    outro(selfPricing
      ? `Catalog complete — ${id('mo ls')} to see it, then ${id('mo ask <model> "…"')}.`
      : `Prices are still missing — ${id('mo model instructions ' + selected)} fills them in.`)
    return
  }

  await writeCatalogBrief(selected)
}

async function writeCatalogBrief (selected) {
  const { AGENTS, detectAssistants, preferredAgent, briefPrompt } = await import('../lib/assistants.js')
  const installed = detectAssistants()

  const stored = (await getConfig()).assistant
  if (!installed.length && !stored) {
    note(
      `Nothing on your PATH looks like a coding agent. Mohdel does not ship
one — Claude Code, Codex CLI and opencode all install from npm.

Whichever you use has to be able to fetch a web page: it is being sent to
read the provider's pricing page.

To skip the agent entirely, use OpenRouter: it publishes prices in its own
model list, so "mo curate openrouter" writes a complete catalog by itself.`,
      'You will need an agent'
    )
  }
  const chosen = await select({
    message: 'Which coding agent do you use?',
    initialValue: stored || installed[0] || AGENTS[0].bin,
    options: [
      ...AGENTS.map(a => ({
        value: a.bin,
        label: a.label,
        hint: installed.includes(a.bin) ? 'found on your PATH' : undefined
      })),
      { value: '__other', label: 'Other…', hint: 'any command that takes a prompt' }
    ]
  })
  if (isCancel(chosen)) return

  let bin = chosen
  if (chosen === '__other') {
    const typed = await text({
      message: 'Command that starts it:',
      placeholder: 'my-agent',
      validate: (v) => v?.trim() ? undefined : 'A command is required'
    })
    if (isCancel(typed)) return
    bin = typed.trim()
  }

  const config = await getConfig()
  await saveConfig({ ...config, assistant: bin })

  const { writeBrief } = await import('./instructions.js')
  const name = await writeBrief(selected)

  const agent = preferredAgent(bin, installed)
  const prompt = `"${briefPrompt(name, selected)}"`
  note(
    `${ok('✓')} Wrote ${meta(name)} in this directory.

${agent.start(prompt)}

The agent drafts mohdel-candidate.json and checks it with
${meta('mo model check --entry mohdel-candidate.json')}; you apply it with
${meta('mo model apply mohdel-candidate.json')}, which shows the diff first.`,
    `Hand it to ${agent.label}`
  )
  outro(`Launch lines for other agents: ${id('mo model instructions --help')}`)
}
