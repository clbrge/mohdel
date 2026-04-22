import mohdel, { silent } from '../lib/index.js'
import { parseJsonFlag, jsonOutputOne } from './json-output.js'

// CLI logger: silent for noisy levels, console.error for errors and fatals.
const cliLogger = { ...silent, error: console.error, fatal: console.error }

export async function runRateLimit (args) {
  const jsonFlag = parseJsonFlag(args)
  const [action, arg1, arg2, arg3] = args

  if (!action || action === '-h' || action === '--help') {
    console.log(`mohdel ratelimit — manage rate limits

Usage:
  ratelimit show <model|provider> [--json]       Show effective limits
  ratelimit set <model> [rpm] [tpm]              Set model-level limits
  ratelimit rm <model>                           Remove model-level limits
  ratelimit provider set <provider> [rpm] [tpm]  Set provider-level limits
  ratelimit provider rm <provider>               Remove provider-level limits

Examples:
  ratelimit show anthropic                     Show provider limits
  ratelimit show gemini/gemini-2.0-flash       Show model limits (with provider fallback)
  ratelimit set gemini/gemini-2.0-flash 15 1000000
  ratelimit provider set anthropic 60 100000

Aliases:
  mo rl show <x>     ratelimit show <x>

Configuration:
  Provider-level limits stored in ~/.config/mohdel/providers.json
  Model-level limits stored in ~/.config/mohdel/curated.json (per model entry)`)
    process.exit(0)
  }

  const mo = await mohdel({ logger: cliLogger })

  function useModel (id) {
    try { return mo.use(id) } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
  }

  // --- provider subcommand ---
  if (action === 'provider') {
    const [providerAction, providerName, ...providerArgs] = args.slice(1)

    if (providerAction === 'show') {
      if (!providerName) { console.error('Usage: ratelimit provider show <provider>'); process.exit(1) }
      const entry = mo.getProviderRateLimit(providerName)
      if (!entry) {
        console.log(`${providerName}: no limits set`)
      } else {
        const parts = []
        if (entry.rpmLimit) parts.push(`rpm=${entry.rpmLimit}`)
        if (entry.tpmLimit) parts.push(`tpm=${entry.tpmLimit}`)
        console.log(`${providerName}: ${parts.join(' ')}`)
      }
      return
    }

    if (providerAction === 'set') {
      if (!providerName) { console.error('Usage: ratelimit provider set <provider> [rpm] [tpm]'); process.exit(1) }
      const [rpmStr, tpmStr] = providerArgs
      const rpm = rpmStr ? parseInt(rpmStr, 10) : undefined
      const tpm = tpmStr ? parseInt(tpmStr, 10) : undefined
      if (rpm == null && tpm == null) { console.error('Provide at least rpm or tpm'); process.exit(1) }
      const result = await mo.setProviderRateLimit(providerName, { rpm, tpm })
      const parts = []
      if (result.rpmLimit) parts.push(`rpm=${result.rpmLimit}`)
      if (result.tpmLimit) parts.push(`tpm=${result.tpmLimit}`)
      console.log(`${providerName}: ${parts.join(' ')}`)
      return
    }

    if (providerAction === 'rm' || providerAction === 'remove') {
      if (!providerName) { console.error('Usage: ratelimit provider rm <provider>'); process.exit(1) }
      await mo.clearProviderRateLimit(providerName)
      console.log(`${providerName}: limits cleared`)
      return
    }

    console.error(`Unknown provider action: ${providerAction}. Run "ratelimit --help".`)
    process.exit(1)
  }

  // --- model-level commands ---
  if (action === 'show') {
    if (!arg1) { console.error('Usage: ratelimit show <model|provider>'); process.exit(1) }

    // Try as model first; fall back to provider
    let model
    try { model = mo.use(arg1) } catch {}

    if (model) {
      const info = model.info()
      const providerEntry = mo.getProviderRateLimit(info.provider) || {}
      const rpmLimit = info.rpmLimit ?? providerEntry.rpmLimit
      const tpmLimit = info.tpmLimit ?? providerEntry.tpmLimit
      const scope = info.rateLimitScope || 'provider'
      const source = (info.rpmLimit || info.tpmLimit) ? 'model' : 'provider'
      if (jsonFlag.json) {
        jsonOutputOne({ id: arg1, rpmLimit: rpmLimit || null, tpmLimit: tpmLimit || null, scope, source })
        return
      }
      if (!rpmLimit && !tpmLimit) {
        console.log(`${arg1}: no limits`)
      } else {
        const parts = []
        if (rpmLimit) parts.push(`rpm=${rpmLimit}`)
        if (tpmLimit) parts.push(`tpm=${tpmLimit}`)
        parts.push(`scope=${scope}`)
        parts.push(`(${source})`)
        console.log(`${arg1}: ${parts.join(' ')}`)
      }
    } else {
      // Treat as provider name
      const entry = mo.getProviderRateLimit(arg1)
      if (jsonFlag.json) {
        jsonOutputOne({ provider: arg1, rpmLimit: entry?.rpmLimit || null, tpmLimit: entry?.tpmLimit || null })
        return
      }
      if (!entry) {
        console.log(`${arg1}: no limits set`)
      } else {
        const parts = []
        if (entry.rpmLimit) parts.push(`rpm=${entry.rpmLimit}`)
        if (entry.tpmLimit) parts.push(`tpm=${entry.tpmLimit}`)
        console.log(`${arg1}: ${parts.join(' ')}`)
      }
    }
    return
  }

  if (action === 'set') {
    if (!arg1) { console.error('Usage: ratelimit set <model> [rpm] [tpm]'); process.exit(1) }
    const rpm = arg2 ? parseInt(arg2, 10) : undefined
    const tpm = arg3 ? parseInt(arg3, 10) : undefined
    if (rpm == null && tpm == null) { console.error('Provide at least rpm or tpm'); process.exit(1) }
    const model = useModel(arg1)
    const result = await model.setRateLimit({ rpm, tpm })
    const parts = []
    if (result.rpmLimit) parts.push(`rpm=${result.rpmLimit}`)
    if (result.tpmLimit) parts.push(`tpm=${result.tpmLimit}`)
    console.log(`${arg1}: ${parts.join(' ')} scope=model`)
    return
  }

  if (action === 'rm' || action === 'remove') {
    if (!arg1) { console.error('Usage: ratelimit rm <model>'); process.exit(1) }
    const model = useModel(arg1)
    await model.clearRateLimit()
    console.log(`${arg1}: model limits cleared`)
    return
  }

  console.error(`Unknown action: ${action}. Run "ratelimit --help".`)
  process.exit(1)
}
