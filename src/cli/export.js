import { catalogEntries } from '../lib/common.js'
import { loadCuratedCache, getCuratedCacheSnapshot, expandModelAliasSync } from '../lib/curated-cache.js'
import { providerOf } from '#core/model-id.js'
import { err } from './colors.js'

const USAGE = 'Usage: mo model export <id…> [--provider <p>] [--tag <t>] [--with-redirects]'

const HELP = `mohdel model export — print catalog entries for another host's \`mo model apply\`

${USAGE}

Prints { "<provider>/<model>": <entry> } as written in curated.json. Ids resolve
through aliases; one that resolves to nothing fails the command and prints nothing.

  --provider <p>     Every entry of a provider (repeatable)
  --tag <t>          Every entry carrying a tag (repeatable)
  --with-redirects   Add the deprecated stubs whose chain ends at an exported entry

Copy to another host — preview, then write (the remote backup is the undo):
  mo model export meta/muse-spark-1.3 | ssh host mo model check --entry -
  mo model export meta/muse-spark-1.3 | ssh host mo model apply - --yes`

/**
 * @param {Record<string, any>} catalog
 * @param {{ ids?: string[], providers?: string[], tags?: string[], withRedirects?: boolean }} selection
 * @param {(id: string) => string} [resolve]
 * @returns {{ entries: Record<string, any>, unknown: string[] }}
 */
export const selectEntries = (catalog, { ids = [], providers = [], tags = [], withRedirects = false }, resolve = expandModelAliasSync) => {
  const keys = new Set()
  const unknown = []

  for (const requested of ids) {
    const key = resolve(requested)
    if (catalog[key]) keys.add(key)
    else unknown.push(requested)
  }
  for (const [key, entry] of catalogEntries(catalog)) {
    if (providers.includes(providerOf(key))) keys.add(key)
    if ((entry.tags || []).some(t => tags.includes(t))) keys.add(key)
  }

  if (withRedirects) {
    for (const [key, entry] of catalogEntries(catalog)) {
      if (!entry.deprecated || keys.has(key)) continue
      const seen = new Set([key])
      let target = entry.deprecated
      while (catalog[target]?.deprecated && !seen.has(target)) {
        seen.add(target)
        target = catalog[target].deprecated
      }
      if (keys.has(target)) {
        for (const hop of seen) keys.add(hop)
      }
    }
  }

  const entries = {}
  for (const key of [...keys].sort()) entries[key] = catalog[key]
  return { entries, unknown }
}

const usageError = (message) => {
  console.error(err(message))
  console.error(USAGE)
  process.exit(1)
}

const parseArgs = (args) => {
  const selection = { ids: [], providers: [], tags: [], withRedirects: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--provider' || arg === '--tag') {
      const value = args[++i]
      if (!value || value.startsWith('-')) usageError(`${arg} needs a value`)
      selection[arg === '--provider' ? 'providers' : 'tags'].push(value)
    } else if (arg === '--with-redirects') {
      selection.withRedirects = true
    } else if (arg.startsWith('-')) {
      usageError(`Unknown flag: ${arg}`)
    } else {
      selection.ids.push(arg)
    }
  }
  return selection
}

export async function runExport (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP)
    return
  }

  const { ids, providers, tags, withRedirects } = parseArgs(args)

  if (!ids.length && !providers.length && !tags.length) {
    console.error(USAGE)
    process.exit(1)
  }

  await loadCuratedCache()
  const { entries, unknown } = selectEntries(getCuratedCacheSnapshot(), { ids, providers, tags, withRedirects })

  if (unknown.length) {
    console.error(err(`Not in the catalog: ${unknown.join(', ')}`))
    process.exit(1)
  }
  if (!Object.keys(entries).length) {
    console.error(err('No entry matched.'))
    process.exit(1)
  }

  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
}
