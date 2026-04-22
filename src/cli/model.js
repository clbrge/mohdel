import mohdel, { silent } from '../lib/index.js'
import providerDefs from '../lib/providers.js'
import { loadDefaultEnv, getAPIKey, getCuratedModels, saveCuratedModels } from '../lib/common.js'
import { fieldDefs } from '../lib/schema.js'
import { parseJsonFlag, printAvailableFields, jsonOutput, jsonOutputOne } from './json-output.js'
import { id, label, tag, price, meta, err, ok } from './colors.js'

// Fields available for --json on model list/show
const MODEL_FIELDS = [
  'model', 'provider', 'creator', 'label', 'type',
  'contextTokenLimit', 'outputTokenLimit',
  'inputPrice', 'outputPrice', 'thinkingPrice',
  'inputFormat', 'tags', 'aliases',
  'thinkingEffortLevels', 'defaultThinkingEffort',
  'rpmLimit', 'tpmLimit', 'rateLimitScope',
  'deprecated', 'suspended'
]

export async function runModel (args) {
  const jsonFlag = parseJsonFlag(args)
  const [action, arg1] = args

  if (!action || action === '-h' || action === '--help') {
    console.log(`mohdel model — browse models

Usage:
  model list [--json [fields]]          List all curated models
  model list --sort price|context|name  Sort model list
  model search <term>                   Filter models by name/label
  model stats                           Catalog summary
  model show <model> [--json [fields]]  Show model details
  model get <model> <key>               Get a field value
  model set <model> <key> <value>       Set a field (custom or reserved)
  model rm <model> <key>                Remove a field
  model add <provider>/<model-id>       Add a model manually (interactive)
  model backup list|restore|diff       Manage catalog backups (prev/daily/weekly)
  model check [--local] [--json]       Validate catalog (schema + upstream drift)
  model rank [options]                  Rank models by benchmark performance
  model bench <model> [options]         Benchmark a model with live inference
  model bench --tag <tag> [options]     Benchmark all models with a tag
  model curate [provider]               Add upstream models to catalog (interactive)

Flags:
  --json             List available JSON fields
  --json f1,f2,f3    Output only selected fields as JSON

Aliases:
  mo ls              model list
  mo show <model>    model show <model>`)
    process.exit(0)
  }

  const mo = await mohdel({ logger: silent })
  const all = mo.list()

  if (action === 'list' || action === 'search') {
    const query = action === 'search' ? arg1 : null
    const sortIdx = args.indexOf('--sort')
    const sortKey = sortIdx !== -1 ? args[sortIdx + 1] : null

    let items = all.map(m => ({ id: m.value, label: m.label, info: mo.use(m.value).info() }))

    if (query) {
      const q = query.toLowerCase()
      items = items.filter(m => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      if (!items.length) { console.log(meta(`No models matching "${query}"`)); return }
    }

    if (sortKey) {
      const rp = resolvePrice
      const sorters = {
        price: (a, b) => rp(a.info.inputPrice) - rp(b.info.inputPrice),
        context: (a, b) => (b.info.contextTokenLimit || 0) - (a.info.contextTokenLimit || 0),
        name: (a, b) => a.id.localeCompare(b.id)
      }
      if (sorters[sortKey]) items.sort(sorters[sortKey])
    }

    if (jsonFlag.json && !jsonFlag.fields) {
      printAvailableFields(MODEL_FIELDS)
      return
    }
    if (jsonFlag.json) {
      jsonOutput(items.map(m => ({ id: m.id, ...m.info })), jsonFlag.fields)
      return
    }
    for (const m of items) {
      const tags = (m.info.tags || []).map(t => meta(t)).join(meta(', '))
      const p = formatPrice(m.info)
      console.log(`${id(m.id)}  ${label(m.label)}  ${p}  ${tags}`)
    }
    return
  }

  if (action === 'stats') {
    const providers = new Set()
    const creators = new Set()
    const allTags = new Set()
    let withTools = 0
    let withThinking = 0
    for (const m of all) {
      const info = mo.use(m.value).info()
      if (info.provider) providers.add(info.provider)
      if (info.creator) creators.add(info.creator)
      for (const t of info.tags || []) allTags.add(t)
      if (info.supportsTools) withTools++
      if (info.thinkingEffortLevels) withThinking++
    }
    if (jsonFlag.json) {
      jsonOutputOne({ models: all.length, providers: providers.size, creators: creators.size, tags: allTags.size, withTools, withThinking }, jsonFlag.fields)
      return
    }
    console.log(`${label(all.length)} models across ${id(providers.size)} providers (${meta(creators.size)} creators)`)
    console.log(`${meta('tools:')} ${withTools}  ${meta('thinking:')} ${withThinking}  ${meta('tags:')} ${allTags.size}`)
    return
  }

  if (action === 'show') {
    if (!arg1) { console.error('Usage: model show <model>'); process.exit(1) }
    let model
    try { model = mo.use(arg1) } catch (e) {
      console.error(err(e.message))
      process.exit(1)
    }
    const info = model.info()
    if (jsonFlag.json && !jsonFlag.fields) {
      printAvailableFields(MODEL_FIELDS)
      return
    }
    if (jsonFlag.json) {
      jsonOutputOne({ id: arg1, ...info }, jsonFlag.fields)
      return
    }
    console.log(`${label(info.label)} ${meta(`(${arg1})`)}
${meta('provider:')}     ${id(info.provider)}
${meta('creator:')}      ${info.creator}
${meta('context:')}      ${(info.contextTokenLimit || 0).toLocaleString()} tokens
${meta('output:')}       ${(info.outputTokenLimit || 0).toLocaleString()} tokens
${meta('input price:')}  ${price('$' + resolvePrice(info.inputPrice) + '/M')}
${meta('output price:')} ${price('$' + resolvePrice(info.outputPrice) + '/M')}
${meta('tags:')}         ${(info.tags || []).map(t => tag(t)).join(', ') || meta('(none)')}`)
    return
  }

  if (action === 'get') {
    const modelId = arg1
    const key = args[2]
    if (!modelId || !key) { console.error('Usage: model get <model> <key>'); process.exit(1) }
    let model
    try { model = mo.use(modelId) } catch (e) {
      console.error(err(e.message))
      process.exit(1)
    }
    const info = model.info()
    const value = info[key]
    if (value === undefined) {
      console.error(meta(`${modelId}: ${key} is not set`))
      process.exit(1)
    }
    if (jsonFlag.json) {
      console.log(JSON.stringify(value))
    } else {
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value)
    }
    return
  }

  if (action === 'set') {
    const modelId = arg1
    const key = args[2]
    const rawValue = args.includes('--json-value') ? args[args.indexOf('--json-value') + 1] : args[3]
    if (!modelId || !key) { console.error('Usage: model set <model> <key> <value>'); process.exit(1) }
    if (rawValue === undefined) { console.error('Usage: model set <model> <key> <value> [--json-value]'); process.exit(1) }

    // Resolve alias → canonical ID; throws with suggestions if not found
    let resolved
    try { resolved = mo.use(modelId) } catch (e) {
      console.error(err(e.message))
      process.exit(1)
    }
    const resolvedId = resolved.id
    const curated = await getCuratedModels()
    if (!curated[resolvedId]) {
      // Model resolved via fallback but not in curated
      console.error(err(`Model '${modelId}' is not in the curated catalog. Use "mo model curate" to add it.`))
      process.exit(1)
    }

    // Parse value: --json-value for complex types, otherwise auto-detect
    let value
    if (args.includes('--json-value')) {
      try { value = JSON.parse(rawValue) } catch (e) {
        console.error(err(`Invalid JSON: ${e.message}`))
        process.exit(1)
      }
    } else {
      value = coerceValue(key, rawValue)
    }

    // Validate type for reserved fields
    const def = fieldDefs[key]
    if (def) {
      const expected = def.type
      const actual = Array.isArray(value) ? 'array' : typeof value
      if (actual !== expected && !(def.altType && actual === def.altType)) {
        console.error(err(`Field "${key}" expects ${expected}, got ${actual}`))
        process.exit(1)
      }
    }

    curated[resolvedId][key] = value
    await saveCuratedModels(curated)
    console.log(`${id(resolvedId)}: ${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}`)
    return
  }

  if (action === 'rm' || action === 'rm-field') {
    const modelId = arg1
    const key = args[2]
    if (!modelId || !key) { console.error('Usage: model rm <model> <key>'); process.exit(1) }

    let resolved
    try { resolved = mo.use(modelId) } catch (e) {
      console.error(err(e.message))
      process.exit(1)
    }
    const resolvedId = resolved.id
    const curated = await getCuratedModels()
    if (!curated[resolvedId]) {
      console.error(err(`Model '${modelId}' is not in the curated catalog.`))
      process.exit(1)
    }

    if (fieldDefs[key]?.required) {
      console.error(err(`Cannot remove required field: ${key}`))
      process.exit(1)
    }

    delete curated[resolvedId][key]
    await saveCuratedModels(curated)
    console.log(`${id(resolvedId)}: ${key} removed`)
    return
  }

  if (action === 'backup') {
    const { runBackup } = await import('./backup.js')
    await runBackup(args.slice(1))
    return
  }

  if (action === 'add') {
    const modelId = arg1
    if (!modelId || !modelId.includes('/')) {
      console.error('Usage: model add <provider>/<model-id>')
      console.error('Example: mo model add fireworks/deepseek-r1')
      process.exit(1)
    }

    const [providerName, ...modelParts] = modelId.split('/')
    const modelName = modelParts.join('/')
    const providerConfig = providerDefs[providerName]
    if (!providerConfig) {
      console.error(err(`Unknown provider: ${providerName}`))
      process.exit(1)
    }

    const curated = await getCuratedModels()
    if (curated[modelId]) {
      console.error(err(`${modelId} already exists in catalog`))
      process.exit(1)
    }

    // Pre-fill from provider config
    const entry = {
      model: modelName,
      provider: providerName,
      sdk: providerConfig.sdk
    }

    // Try to fetch upstream info if provider has an API key
    const apiKey = getAPIKey(providerConfig.apiKeyEnv)
    if (apiKey && providerConfig.catalog !== false) {
      try {
        const sdkConfig = providerConfig.createConfiguration(apiKey)
        const { default: API } = await import(`../lib/sdk/${providerConfig.sdk}.js`)
        const noop = () => {}
        const api = API(sdkConfig, {}, { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop })
        if (api.getModelInfo) {
          const info = await api.getModelInfo(modelName)
          if (info) {
            Object.assign(entry, info)
            console.log(meta('Fetched model info from upstream'))
          }
        }
      } catch {}
    }

    // Interactive prompts for missing fields
    const { promptMissingFields } = await import('../lib/select.js')
    const completed = await promptMissingFields(entry, modelId)

    curated[modelId] = completed
    await saveCuratedModels(curated)
    console.log(`${ok('+')} ${id(modelId)} added to catalog`)
    return
  }

  if (action === 'check') {
    const { runCheck } = await import('./check.js')
    await runCheck(args.slice(1))
    return
  }

  if (action === 'rank') {
    const { runRank } = await import('./rank.js')
    await runRank(args.slice(1))
    return
  }

  if (action === 'bench') {
    const { runBench } = await import('./bench.js')
    await runBench(args.slice(1))
    return
  }

  if (action === 'curate') {
    const { initializeAPIs, processModels } = await import('../lib/select.js')
    const { api, providersWithKeys } = await initializeAPIs()

    if (!providersWithKeys.length) {
      console.error(err('No providers with API keys configured. Run "mo" to set up.'))
      process.exit(1)
    }

    // mo model curate <provider> — curate specific provider
    if (arg1) {
      if (!api[arg1]) {
        console.error(err(`Provider "${arg1}" not found or no API key. Available: ${providersWithKeys.join(', ')}`))
        process.exit(1)
      }
      await processModels(arg1, api[arg1])
      return
    }

    // mo model curate — prompt for provider
    const { select, isCancel } = await import('@clack/prompts')
    const selected = await select({
      message: 'Select a provider to curate:',
      options: providersWithKeys.map(name => ({ value: name, label: name }))
    })
    if (isCancel(selected)) return
    await processModels(selected, api[selected])
    return
  }

  console.error(`Unknown action: ${action}. Run "model --help".`)
  process.exit(1)
}

export async function runProvider (args) {
  const jsonFlag = parseJsonFlag(args)
  const [action, arg1] = args

  const mo = await mohdel({ logger: silent })
  const all = mo.list()

  if ((!action || action === 'list') && !arg1) {
    loadDefaultEnv()
    const providerMap = new Map()
    for (const m of all) {
      const info = mo.use(m.value).info()
      if (!info.provider) continue
      if (!providerMap.has(info.provider)) providerMap.set(info.provider, 0)
      providerMap.set(info.provider, providerMap.get(info.provider) + 1)
    }
    const rows = [...providerMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([provider, count]) => {
        const def = providerDefs[provider]
        const hasKey = def?.apiKeyEnv ? !!getAPIKey(def.apiKeyEnv) : null
        const rl = mo.getProviderRateLimit(provider)
        return { provider, count, hasKey, rpmLimit: rl?.rpmLimit || null, tpmLimit: rl?.tpmLimit || null }
      })

    if (jsonFlag.json && !jsonFlag.fields) {
      printAvailableFields(['provider', 'count', 'hasKey', 'rpmLimit', 'tpmLimit'])
      return
    }
    if (jsonFlag.json) {
      jsonOutput(rows, jsonFlag.fields)
      return
    }
    for (const row of rows) {
      const dot = row.hasKey === null ? ' ' : row.hasKey ? ok('●') : meta('○')
      const rl = []
      if (row.rpmLimit) rl.push(`rpm=${row.rpmLimit}`)
      if (row.tpmLimit) rl.push(`tpm=${row.tpmLimit}`)
      const rlStr = rl.length ? meta(rl.join(' ')) : ''
      console.log(`  ${dot} ${id(row.provider)}  ${meta(`(${row.count} models)`)}  ${rlStr}`)
    }
    const hasUnconfigured = rows.some(r => r.hasKey === false)
    console.log(`\n${meta('Next:')}  mo provider show <name>  ${meta('│')}  mo curate <name>` +
      (hasUnconfigured ? `  ${meta('│')}  mo provider setup <name>` : ''))
    return
  }

  if (action === 'show' || (action === 'list' && arg1)) {
    if (!arg1) { console.error('Usage: provider list <provider>'); process.exit(1) }
    const models = all.filter(m => {
      const info = mo.use(m.value).info()
      return info.provider === arg1
    })
    if (!models.length) { console.error(err(`No models for provider: ${arg1}`)); process.exit(1) }
    if (jsonFlag.json && !jsonFlag.fields) {
      printAvailableFields(MODEL_FIELDS)
      return
    }
    if (jsonFlag.json) {
      const items = models.map(m => ({ id: m.value, ...mo.use(m.value).info() }))
      jsonOutput(items, jsonFlag.fields)
      return
    }
    for (const m of models) {
      const info = mo.use(m.value).info()
      console.log(`${id(m.value)}  ${label(m.label)}  ${formatPrice(info)}`)
    }
    return
  }

  if (action === 'setup') {
    if (!arg1) { console.error('Usage: provider setup <provider>'); process.exit(1) }
    const providerConfig = providerDefs[arg1]
    if (!providerConfig || !providerConfig.apiKeyEnv) {
      console.error(err(`Unknown provider or no API key supported: ${arg1}`))
      process.exit(1)
    }
    const { PROVIDER_INFO, appendToEnvFile } = await import('./onboard.js')
    const { text, note, isCancel } = await import('@clack/prompts')
    const info = PROVIDER_INFO[arg1]

    loadDefaultEnv()
    const existing = getAPIKey(providerConfig.apiKeyEnv)
    if (existing) {
      console.log(`${ok('●')} ${id(arg1)} already configured ${meta(`(${providerConfig.apiKeyEnv})`)}`)
      const { confirm } = await import('@clack/prompts')
      const replace = await confirm({ message: 'Replace existing key?' })
      if (isCancel(replace) || !replace) return
    }

    if (info) {
      note(`${info.hint}\n\n${id(info.url)}`, `${info.label} — API Key`)
    }

    const apiKey = await text({
      message: `Paste your ${arg1} API key:`,
      placeholder: providerConfig.apiKeyEnv,
      validate: (v) => { if (!v?.trim()) return 'API key cannot be empty' }
    })
    if (isCancel(apiKey)) return

    await appendToEnvFile(providerConfig.apiKeyEnv, apiKey.trim())
    console.log(`${ok('✓')} Saved ${providerConfig.apiKeyEnv}`)
    return
  }

  if (action === 'rm' || action === 'remove') {
    if (!arg1) { console.error('Usage: provider rm <provider>'); process.exit(1) }
    const providerConfig = providerDefs[arg1]
    if (!providerConfig || !providerConfig.apiKeyEnv) {
      console.error(err(`Unknown provider: ${arg1}`))
      process.exit(1)
    }
    const { appendToEnvFile } = await import('./onboard.js')
    await appendToEnvFile(providerConfig.apiKeyEnv, '')
    console.log(`${ok('✓')} Removed ${providerConfig.apiKeyEnv}`)
    return
  }

  console.error(`Unknown action: ${action}. Run "mo provider --help".`)
  process.exit(1)
}

export async function runCreator (args) {
  const jsonFlag = parseJsonFlag(args)
  const [action, arg1] = args

  const mo = await mohdel({ logger: silent })
  const all = mo.list()

  if ((!action || action === 'list') && !arg1) {
    const creators = new Map()
    for (const m of all) {
      const info = mo.use(m.value).info()
      if (!info.creator) continue
      if (!creators.has(info.creator)) creators.set(info.creator, 0)
      creators.set(info.creator, creators.get(info.creator) + 1)
    }
    if (jsonFlag.json && !jsonFlag.fields) {
      printAvailableFields(['creator', 'count'])
      return
    }
    if (jsonFlag.json) {
      const items = [...creators.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([creator, count]) => ({ creator, count }))
      jsonOutput(items, jsonFlag.fields)
      return
    }
    for (const [name, count] of [...creators.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`${id(name)}  ${meta(`(${count} models)`)}`)
    }
    return
  }

  if (action === 'show' || (action === 'list' && arg1)) {
    if (!arg1) { console.error('Usage: creator list <creator>'); process.exit(1) }
    const models = all.filter(m => {
      const info = mo.use(m.value).info()
      return info.creator === arg1
    })
    if (!models.length) { console.error(err(`No models for creator: ${arg1}`)); process.exit(1) }
    if (jsonFlag.json && !jsonFlag.fields) {
      printAvailableFields(MODEL_FIELDS)
      return
    }
    if (jsonFlag.json) {
      const items = models.map(m => ({ id: m.value, ...mo.use(m.value).info() }))
      jsonOutput(items, jsonFlag.fields)
      return
    }
    for (const m of models) {
      const info = mo.use(m.value).info()
      console.log(`${id(m.value)}  ${label(m.label)}  ${formatPrice(info)}  ${meta('via ' + info.provider)}`)
    }
    return
  }

  console.error(`Unknown action: ${action}. Use "creator list" or "creator show <name>".`)
  process.exit(1)
}

// Auto-detect value type from string input
function coerceValue (key, raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  // Reserved fields: use schema type hint
  const def = fieldDefs[key]
  if (def?.type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  // Unrecognized: try number, fall back to string
  const n = Number(raw)
  if (raw !== '' && Number.isFinite(n)) return n
  return raw
}

function resolvePrice (p) {
  if (p == null) return 0
  if (typeof p === 'number') return p
  if (typeof p === 'object') return p.default || Object.values(p)[0] || 0
  return 0
}

function formatPrice (info) {
  const inp = resolvePrice(info.inputPrice)
  const out = resolvePrice(info.outputPrice)
  if (!inp && !out) return meta('free')
  return price(`$${inp}`) + meta('/') + price(`$${out}`)
}
