import { label, err, warn, ok } from './colors.js'
import { reviewCatalog } from '../lib/catalog-review.js'
import { localConventionsOrExit } from './local.js'
import { getCuratedModels, loadDefaultEnv, catalogValues } from '../lib/common.js'

// --- CLI ---

export async function runCheck (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel model check — validate the catalog

Usage:
  model check [options]
  model check --entry <file|->   Validate entries not yet in the catalog

Options:
  --json               Output as JSON
  --entry <file|->     Read entries in curated.json shape and report what they
                       would change, without writing. 'mo model apply' writes.

Checks:
  Schema types, required fields, deprecated targets, provider/sdk
  consistency, tiered pricing, thinking config.`)
    process.exit(0)
  }

  if (args.includes('--entry')) {
    const { runCheckEntry } = await import('./entry.js')
    await runCheckEntry(args)
    return
  }

  loadDefaultEnv()

  const json = args.includes('--json')

  const curated = await getCuratedModels()
  const all = catalogValues(curated)
  const active = all.filter(s => !s.deprecated).length
  const deprecated = all.length - active

  if (!json) {
    console.log(`${label('Catalog:')} ${active} active, ${deprecated} deprecated\n`)
  }

  const { errors, warnings: localWarnings } = reviewCatalog(curated, { local: await localConventionsOrExit() })

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
