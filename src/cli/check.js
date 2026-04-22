import { label, err, warn, ok } from './colors.js'
import providers from '../lib/providers.js'
import { validate, isValidTag } from '../lib/schema.js'
import { getCuratedModels, loadDefaultEnv } from '../lib/common.js'

// --- Local validation ---

const checkLocal = (curated) => {
  const errors = []
  const warnings = []
  const knownProviders = new Set(Object.keys(providers))

  for (const [key, spec] of Object.entries(curated)) {
    const [keyProvider] = key.split('/')

    if (spec.deprecated) {
      if (!curated[spec.deprecated]) {
        errors.push(`${key}: deprecated target '${spec.deprecated}' not in curated`)
      }
      continue
    }

    for (const issue of validate(spec, key)) {
      if (issue.severity === 'error') errors.push(`${key}: ${issue.field} — ${issue.message}`)
      else warnings.push(`${key}: ${issue.field} — ${issue.message}`)
    }

    if (!knownProviders.has(keyProvider)) {
      errors.push(`${key}: provider '${keyProvider}' not in providers.js`)
    }
    if (spec.provider && spec.provider !== keyProvider) {
      errors.push(`${key}: spec.provider '${spec.provider}' doesn't match key prefix '${keyProvider}'`)
    }

    const providerConfig = providers[keyProvider]
    if (providerConfig && spec.sdk && spec.sdk !== providerConfig.sdk) {
      errors.push(`${key}: spec.sdk '${spec.sdk}' doesn't match provider sdk '${providerConfig.sdk}'`)
    }

    if (!spec.label) warnings.push(`${key}: missing label`)

    for (const priceField of ['inputPrice', 'outputPrice', 'thinkingPrice']) {
      const val = spec[priceField]
      if (val != null && typeof val === 'object' && val.default == null) {
        errors.push(`${key}: ${priceField} is tiered but missing 'default' key`)
      }
    }

    if (spec.thinkingEffortLevels && !spec.defaultThinkingEffort) {
      warnings.push(`${key}: has thinkingEffortLevels but no defaultThinkingEffort`)
    }

    if (Array.isArray(spec.tags)) {
      for (const t of spec.tags) {
        if (!isValidTag(t)) warnings.push(`${key}: invalid tag "${t}" — must match /^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/`)
      }
    }
  }

  return { errors, warnings }
}

// --- CLI ---

export async function runCheck (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel model check — validate curated catalog

Usage:
  model check [options]

Options:
  --json               Output as JSON

Checks:
  Schema types, required fields, deprecated targets, provider/sdk
  consistency, tiered pricing, thinking config.

Note: 0.90 drops the upstream-drift check that piggybacked on the
legacy per-provider SDK factory. If you need upstream drift
detection, file an issue — it'll be rebuilt on the /session stack.`)
    process.exit(0)
  }

  loadDefaultEnv()

  const json = args.includes('--json')

  const curated = await getCuratedModels()
  const active = Object.values(curated).filter(s => !s.deprecated).length
  const deprecated = Object.values(curated).length - active

  if (!json) {
    console.log(`${label('Catalog:')} ${active} active, ${deprecated} deprecated\n`)
  }

  const { errors, warnings: localWarnings } = checkLocal(curated)

  if (!json) {
    if (errors.length) {
      console.log(err(`${errors.length} error(s):`))
      for (const e of errors) console.log(`  ${err('✗')} ${e}`)
    }
    if (localWarnings.length) {
      console.log(warn(`${localWarnings.length} warning(s):`))
      for (const w of localWarnings) console.log(`  ${warn('!')} ${w}`)
    }
    if (!errors.length && !localWarnings.length) {
      console.log(ok('Local validation passed'))
    }
  }

  if (json) {
    console.log(JSON.stringify({
      active,
      deprecated,
      errors,
      warnings: localWarnings
    }, null, 2))
  }

  if (errors.length) process.exit(1)
}
