import { existsSync } from 'fs'
import { label, meta, ok, warn, err, inactive } from './colors.js'
import providers from '../lib/providers.js'
import { validate, isValidTag } from '../lib/schema.js'
import {
  CONFIG_DIR, CURATED_PATH, CONFIG_PATH, ENV_PATH,
  getCuratedModels, getConfig, loadDefaultEnv, getAPIKey, catalogEntries
} from '../lib/common.js'

const row = (status, name, detail = '') =>
  `  ${status}  ${name.padEnd(20)} ${meta(detail)}`

export async function runDoctor (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel doctor — check that your install is wired up

Usage:
  mo doctor [--json]

What it checks:
  - Config directory and environment file exist
  - At least one provider API key is set
  - curated.json parses and passes schema validation
  - Default model (if set) resolves to a real entry

Exit code:
  0  no errors (warnings allowed)
  1  one or more errors — fix them before relying on the install`)
    process.exit(0)
  }

  const json = args.includes('--json')
  loadDefaultEnv()

  const report = {
    configDir: { ok: false, path: CONFIG_DIR },
    envFile: { ok: false, path: ENV_PATH },
    curatedFile: { ok: false, path: CURATED_PATH, active: 0, deprecated: 0 },
    keys: { configured: [], missing: [] },
    schema: { errors: [], warnings: [] },
    defaultModel: { set: false, id: null, resolves: false },
    errors: [],
    warnings: []
  }

  // 1. Config dir + env file
  report.configDir.ok = existsSync(CONFIG_DIR)
  report.envFile.ok = existsSync(ENV_PATH)
  if (!report.configDir.ok) report.warnings.push('config directory does not exist (will be created on first save)')
  if (!report.envFile.ok) report.warnings.push(`no ${ENV_PATH} — set API keys there or via shell env`)

  // 2. API keys per provider
  for (const [name, def] of Object.entries(providers)) {
    if (getAPIKey(def.apiKeyEnv)) {
      report.keys.configured.push({ provider: name, envVar: def.apiKeyEnv })
    } else {
      report.keys.missing.push({ provider: name, envVar: def.apiKeyEnv })
    }
  }
  if (!report.keys.configured.length) {
    report.errors.push('no API keys configured — run "mo" to set one up')
  }

  // 3. curated.json — exists, parses, validates
  let curated = null
  try {
    curated = await getCuratedModels()
    report.curatedFile.ok = true
    const entries = catalogEntries(curated)
    report.curatedFile.active = entries.filter(([, s]) => !s.deprecated).length
    report.curatedFile.deprecated = entries.length - report.curatedFile.active

    // Schema validation (same logic as 'mo check', condensed)
    const knownProviders = new Set(Object.keys(providers))
    for (const [key, spec] of catalogEntries(curated)) {
      if (spec.deprecated) {
        if (!curated[spec.deprecated]) {
          report.schema.errors.push(`${key}: deprecated target '${spec.deprecated}' missing`)
        }
        continue
      }
      for (const issue of validate(spec, key)) {
        if (issue.severity === 'error') report.schema.errors.push(`${key}: ${issue.field} — ${issue.message}`)
        else report.schema.warnings.push(`${key}: ${issue.field} — ${issue.message}`)
      }
      const [keyProvider] = key.split('/')
      if (!knownProviders.has(keyProvider)) {
        report.schema.errors.push(`${key}: provider '${keyProvider}' not in providers.js`)
      }
      if (Array.isArray(spec.tags)) {
        for (const t of spec.tags) {
          if (!isValidTag(t)) report.schema.warnings.push(`${key}: invalid tag "${t}"`)
        }
      }
    }
    if (report.schema.errors.length) {
      report.errors.push(`${report.schema.errors.length} schema error(s) in curated.json — run "mo check" for details`)
    }
  } catch (e) {
    report.errors.push(`curated.json: ${e.message}`)
  }

  // 4. Default model
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = await getConfig()
      if (cfg.defaultModel) {
        report.defaultModel.set = true
        report.defaultModel.id = cfg.defaultModel
        report.defaultModel.resolves = !!(curated && curated[cfg.defaultModel])
        if (!report.defaultModel.resolves) {
          report.errors.push(`default model '${cfg.defaultModel}' is not in curated.json`)
        }
      }
    } catch {
      report.warnings.push('default.json present but failed to parse')
    }
  } else {
    report.warnings.push('no default model set — pass <provider/model> to "mo ask", or run "mo default"')
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.errors.length ? 1 : 0)
  }

  // Pretty output
  console.log(label('Mohdel doctor\n'))

  console.log(label('Configuration'))
  console.log(row(report.configDir.ok ? ok('✓') : warn('!'), 'Config dir', report.configDir.path))
  console.log(row(report.envFile.ok ? ok('✓') : warn('!'), 'Env file', report.envFile.ok ? report.envFile.path : `${report.envFile.path} (missing)`))
  if (report.curatedFile.ok) {
    console.log(row(ok('✓'), 'curated.json', `${report.curatedFile.active} active, ${report.curatedFile.deprecated} deprecated`))
  } else {
    console.log(row(err('✗'), 'curated.json', 'failed to load'))
  }

  console.log()
  console.log(label(`API keys (${report.keys.configured.length} of ${Object.keys(providers).length})`))
  for (const k of report.keys.configured) {
    console.log(row(ok('✓'), k.provider, k.envVar))
  }
  for (const k of report.keys.missing) {
    console.log(row(inactive('○'), k.provider, `${k.envVar} (unset)`))
  }

  console.log()
  console.log(label('Catalog validation'))
  if (report.schema.errors.length) {
    console.log(`  ${err('✗')} ${report.schema.errors.length} error(s) ${meta('— run "mo check" for details')}`)
  } else {
    console.log(`  ${ok('✓')} no errors`)
  }
  if (report.schema.warnings.length) {
    console.log(`  ${warn('!')} ${report.schema.warnings.length} warning(s) ${meta('— run "mo check" for details')}`)
  }

  console.log()
  console.log(label('Default model'))
  if (report.defaultModel.set) {
    const status = report.defaultModel.resolves ? ok('✓') : err('✗')
    const note = report.defaultModel.resolves ? '' : '(not in curated.json)'
    console.log(row(status, report.defaultModel.id, note))
  } else {
    console.log(row(inactive('○'), 'not set', 'pass <provider/model> to mo ask, or run "mo default"'))
  }

  console.log()
  if (report.errors.length) {
    console.log(`${err('✗')} ${report.errors.length} error(s):`)
    for (const e of report.errors) console.log(`  ${err('✗')} ${e}`)
    process.exit(1)
  } else if (report.warnings.length) {
    console.log(`${warn('!')} ${report.warnings.length} warning(s) — install is usable but not fully configured`)
    for (const w of report.warnings) console.log(`  ${warn('!')} ${w}`)
  } else {
    console.log(`${ok('✓')} ready`)
  }
}
