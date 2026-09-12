import providerDefs from '../lib/providers.js'
import { fieldDefs } from '../lib/schema.js'
import { getCuratedModels, catalogEntries } from '../lib/common.js'
import { ALIASES } from './aliases.js'

// Never import the factory here: it loads every provider SDK, on every tab press.

const NOUNS = ['model', 'provider', 'creator', 'tag', 'ratelimit', 'ask', 'transcribe', 'default', 'doctor']

const VERBS = {
  model: ['list', 'search', 'stats', 'show', 'get', 'set', 'rm', 'add', 'instructions',
    'check', 'apply', 'rank', 'bench', 'curate', 'backup'],
  provider: ['list', 'show', 'models', 'setup', 'rm'],
  creator: ['list', 'show'],
  tag: ['list', 'show', 'add', 'rm'],
  ratelimit: ['show', 'set', 'rm', 'provider']
}

const ARGUMENT = {
  ask: ['model'],
  transcribe: ['model'],
  'model show': ['model'],
  'model get': ['model', 'field'],
  'model set': ['model', 'field'],
  'model rm': ['model', 'field'],
  'model bench': ['model'],
  'model curate': ['provider'],
  'model instructions': ['provider'],
  'provider list': ['provider'],
  'provider show': ['provider'],
  'provider models': ['provider'],
  'provider setup': ['provider'],
  'provider rm': ['provider'],
  'creator show': ['creator'],
  'tag list': ['model'],
  'tag show': ['tag'],
  'tag add': ['model', 'tag'],
  'tag rm': ['model', 'tag'],
  'ratelimit show': ['model'],
  'ratelimit set': ['model'],
  'ratelimit rm': ['model']
}

const fromCatalog = async (pick) => {
  const catalog = await getCuratedModels()
  const out = new Set()
  for (const [key, spec] of catalogEntries(catalog)) {
    if (spec.deprecated) continue
    pick(key, spec, out)
  }
  return [...out]
}

const kinds = {
  model: () => fromCatalog((key, _spec, out) => out.add(key)),
  creator: () => fromCatalog((_key, spec, out) => spec.creator && out.add(spec.creator)),
  tag: () => fromCatalog((_key, spec, out) => (spec.tags || []).forEach(t => out.add(t))),
  provider: async () => Object.keys(providerDefs),
  field: async () => Object.keys(fieldDefs)
}

/**
 * @param {number} cword  Index of the word being completed (bash COMP_CWORD).
 * @param {string[]} words  The full command line, split (bash COMP_WORDS).
 * @returns {Promise<string[]>}
 */
export const candidates = async (cword, words) => {
  const current = words[cword] ?? ''
  const before = words.slice(1, cword).filter(w => !w.startsWith('-'))

  const offer = (list) => list.filter(c => c.startsWith(current)).sort()

  if (!before.length) {
    return offer([...NOUNS, ...Object.keys(ALIASES)])
  }

  const alias = ALIASES[before[0]]
  const chain = alias ? [alias.noun, ...alias.inject, ...before.slice(1)] : before
  const [noun, verb, ...rest] = chain

  if (chain.length === 1 && VERBS[noun]) return offer(VERBS[noun])

  const paired = ARGUMENT[`${noun} ${verb}`]
  const shape = paired ?? ARGUMENT[noun]
  if (!shape) return []
  const typed = paired ? rest : [verb, ...rest].filter(Boolean)

  const kind = shape[typed.length]
  if (!kind || !kinds[kind]) return []
  return offer(await kinds[kind]())
}

export const BASH_SCRIPT = `# mohdel completion for bash.  Add to ~/.bashrc:
#   source <(mo completion bash)
_mo_completion() {
  local IFS=$'\\n'
  COMPREPLY=($(mo __complete "$COMP_CWORD" "\${COMP_WORDS[@]}" 2>/dev/null))
}
complete -o default -F _mo_completion mo
`

export async function runComplete (args) {
  // An unreadable catalog offers nothing rather than breaking the tab key.
  try {
    const cword = Number.parseInt(args[0], 10)
    if (!Number.isFinite(cword)) return
    const list = await candidates(cword, args.slice(1))
    if (list.length) process.stdout.write(`${list.join('\n')}\n`)
  } catch {}
}

export function runCompletionScript (args) {
  const shell = args[0]
  if (shell === 'bash') {
    process.stdout.write(BASH_SCRIPT)
    return
  }
  console.error(`Usage: mo completion bash${shell ? `  (got "${shell}")` : ''}`)
  process.exit(1)
}
