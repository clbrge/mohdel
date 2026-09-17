import mohdel, { silent } from '../lib/index.js'
import { parseJsonFlag, jsonOutputOne } from './json-output.js'

// CLI logger: silent for noisy levels, console.error for errors and fatals.
const cliLogger = { ...silent, error: console.error, fatal: console.error }

const LIMIT_NAMES = ['rpm', 'tpm', 'inpm']

/**
 * `0` is a killswitch, not "unset", so read nullability rather than truth.
 *
 * @param {{rpmLimit?: number, tpmLimit?: number, inpmLimit?: number} | null | undefined} entry
 * @returns {string[]}
 */
function limitParts (entry) {
  if (!entry) return []
  return LIMIT_NAMES
    .filter(name => entry[`${name}Limit`] != null)
    .map(name => `${name}=${entry[`${name}Limit`]}`)
}

/**
 * @param {string[]} cleared  Limits named on the command line; empty means all.
 * @param {string[]} parts    What is left afterwards.
 */
function clearedLine (cleared, parts) {
  if (cleared.length === 0) return 'limits cleared'
  return `${cleared.join(', ')} cleared; ${parts.length ? `${parts.join(' ')} remain` : 'no limits remain'}`
}

/** @param {string[]} names */
function parseLimitNames (names) {
  for (const name of names) {
    if (!LIMIT_NAMES.includes(name)) {
      console.error(`Unknown limit '${name}'. Known: ${LIMIT_NAMES.join(', ')}`)
      process.exit(1)
    }
  }
  return names
}

/** @param {string} raw */
function toCount (raw) {
  const n = parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 0 || String(n) !== String(raw).trim()) {
    console.error(`'${raw}' is not a whole number`)
    process.exit(1)
  }
  return n
}

/**
 * Two forms. Named pairs — `rpm 60 inpm 2000` — reach every limit, including
 * one on its own. The positional `<rpm> [tpm]` covers the common pair; a
 * leading digit picks that form, since no limit is named one.
 *
 * @param {string[]} args
 * @param {string} usage
 * @returns {{rpm?: number, tpm?: number, inpm?: number}}
 */
function parseLimits (args, usage) {
  if (args.length === 0) { console.error(usage); process.exit(1) }

  if (/^\d/.test(args[0])) {
    const [rpm, tpm] = args
    return tpm ? { rpm: toCount(rpm), tpm: toCount(tpm) } : { rpm: toCount(rpm) }
  }

  /** @type {Record<string, number>} */
  const limits = {}
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]
    if (!LIMIT_NAMES.includes(name)) {
      console.error(`Unknown limit '${name}'. Known: ${LIMIT_NAMES.join(', ')}`)
      process.exit(1)
    }
    if (args[i + 1] == null) { console.error(`'${name}' needs a value`); process.exit(1) }
    limits[name] = toCount(args[i + 1])
  }
  return limits
}

export async function runRateLimit (args) {
  const jsonFlag = parseJsonFlag(args)
  const [action, arg1] = args

  if (!action || action === '-h' || action === '--help') {
    console.log(`mohdel ratelimit — manage rate limits

Usage:
  ratelimit show <model|provider> [--json]       Show effective limits
  ratelimit set <model> <limit> <value> …        Set limits by name
  ratelimit set <model> <rpm> [tpm]              Shortcut for the two common ones
  ratelimit rm <model> [limit …]                 Remove limits, or all of them

A <model> may carry a speed lane — openai/gpt-x@fast — to reach the quota that
lane sells separately. A lane outranks the entry, and carries rpm and tpm only.
  ratelimit provider set <provider> <limit> <value> …
  ratelimit provider set <provider> <rpm> [tpm]
  ratelimit provider rm <provider> [limit …]     Remove limits, or all of them

Limits:
  rpm     requests per minute
  tpm     tokens per minute
  inpm    inputs per minute — what an embedding endpoint is metered in when
          the provider counts inputs rather than requests or tokens

Examples:
  ratelimit show anthropic                   Provider limits
  ratelimit show gemini/gemini-flash-latest  Model limits, then provider
  ratelimit set cohere/embed-v4.0 inpm 2000
  ratelimit set gemini/gemini-flash-latest rpm 15 tpm 1000000
  ratelimit set openai/gpt-x@fast rpm 200
  ratelimit set gemini/gemini-flash-latest 15 1000000
  ratelimit rm cohere/embed-v4.0 inpm
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
      const parts = limitParts(entry)
      console.log(parts.length ? `${providerName}: ${parts.join(' ')}` : `${providerName}: no limits set`)
      return
    }

    if (providerAction === 'set') {
      if (!providerName) { console.error('Usage: ratelimit provider set <provider> [rpm] [tpm]'); process.exit(1) }
      const limits = parseLimits(providerArgs, 'Usage: ratelimit provider set <provider> <limit> <value> … | <rpm> [tpm]')
      const result = await mo.setProviderRateLimit(providerName, limits)
      console.log(`${providerName}: ${limitParts(result).join(' ')}`)
      return
    }

    if (providerAction === 'rm' || providerAction === 'remove') {
      if (!providerName) { console.error('Usage: ratelimit provider rm <provider> [limit …]'); process.exit(1) }
      const names = parseLimitNames(providerArgs)
      const remaining = await mo.clearProviderRateLimit(providerName, names)
      console.log(`${providerName}: ${clearedLine(names, limitParts(remaining))}`)
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
      const lane = info.speed ? info.speeds?.[info.speed] ?? {} : {}
      const rpmLimit = lane.rpmLimit ?? info.rpmLimit ?? providerEntry.rpmLimit
      const tpmLimit = lane.tpmLimit ?? info.tpmLimit ?? providerEntry.tpmLimit
      const inpmLimit = info.inpmLimit ?? providerEntry.inpmLimit
      // A lane only gets its own bucket when it declares a limit; otherwise its
      // traffic counts against the entry's, which is what `scope` then describes.
      const scope = limitParts(lane).length ? `lane:${info.speed}` : (info.rateLimitScope || 'provider')
      const source = limitParts(lane).length ? 'lane' : (limitParts(info).length ? 'model' : 'provider')
      if (jsonFlag.json) {
        jsonOutputOne({ id: arg1, rpmLimit: rpmLimit || null, tpmLimit: tpmLimit || null, inpmLimit: inpmLimit || null, scope, source })
        return
      }
      const parts = limitParts({ rpmLimit, tpmLimit, inpmLimit })
      if (parts.length === 0) {
        console.log(`${arg1}: no limits`)
      } else {
        console.log(`${arg1}: ${[...parts, `scope=${scope}`, `(${source})`].join(' ')}`)
      }
    } else {
      // Treat as provider name
      const entry = mo.getProviderRateLimit(arg1)
      if (jsonFlag.json) {
        jsonOutputOne({ provider: arg1, rpmLimit: entry?.rpmLimit || null, tpmLimit: entry?.tpmLimit || null, inpmLimit: entry?.inpmLimit || null })
        return
      }
      if (!entry) {
        console.log(`${arg1}: no limits set`)
      } else {
        const parts = []
        if (entry.rpmLimit) parts.push(`rpm=${entry.rpmLimit}`)
        if (entry.tpmLimit) parts.push(`tpm=${entry.tpmLimit}`)
        if (entry.inpmLimit) parts.push(`inpm=${entry.inpmLimit}`)
        console.log(`${arg1}: ${parts.join(' ')}`)
      }
    }
    return
  }

  if (action === 'set') {
    const usage = 'Usage: ratelimit set <model> <limit> <value> … | <rpm> [tpm]'
    if (!arg1) { console.error(usage); process.exit(1) }
    const limits = parseLimits(args.slice(2), usage)
    const model = useModel(arg1)
    const lane = arg1.split('@')[1]
    let result
    try {
      result = await model.setRateLimit(limits)
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
    console.log(`${arg1}: ${limitParts(result).join(' ')} scope=${lane ? `lane:${lane}` : 'model'}`)
    return
  }

  if (action === 'rm' || action === 'remove') {
    if (!arg1) { console.error('Usage: ratelimit rm <model> [limit …]'); process.exit(1) }
    const names = parseLimitNames(args.slice(2))
    const model = useModel(arg1)
    const remaining = await model.clearRateLimit(names)
    console.log(`${arg1}: ${clearedLine(names, limitParts(remaining))}`)
    return
  }

  console.error(`Unknown action: ${action}. Run "ratelimit --help".`)
  process.exit(1)
}
