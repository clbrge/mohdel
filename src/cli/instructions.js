import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import providerDefs from '../lib/providers.js'
import PROVIDER_INFO from '../lib/provider-info.js'
import { fieldDefs } from '../lib/schema.js'
import { CURATED_PATH, getConfig, getCuratedModels, catalogEntries, portablePath } from '../lib/common.js'
import { detectAssistants, handoff, launchLines } from '../lib/assistants.js'
import { LOCAL_PATH, TEMPLATE } from '../lib/local-conventions.js'
import { localConventionsOrExit } from './local.js'

const CATALOG_DOC = 'https://github.com/clbrge/mohdel/blob/main/docs/CATALOG.md'

export const BRIEF_FILE = 'mohdel-brief.md'
export const BRIEF_HEADING = '# mohdel catalog entry'

export const writeBrief = async (provider) => {
  const brief = await buildBrief(provider)
  let name = BRIEF_FILE
  let path = resolve(process.cwd(), name)
  if (existsSync(path) && !readFileSync(path, 'utf8').startsWith(BRIEF_HEADING)) {
    let n = 2
    while (existsSync(resolve(process.cwd(), `mohdel-brief-${n}.md`))) n++
    name = `mohdel-brief-${n}.md`
    path = resolve(process.cwd(), name)
  }
  await writeFile(path, brief)
  return name
}

const loadDescriptions = async () => {
  const raw = await readFile(new URL('../../config/curated.schema.json', import.meta.url), 'utf8')
  const props = JSON.parse(raw).$defs.modelEntry.properties
  return Object.fromEntries(Object.entries(props).map(([field, def]) => [field, def.description]))
}

const typeOf = (def) => {
  const types = [def.type, def.altType].filter(Boolean)
  if (def.nullable) types.push('null')
  return types.join(' \\| ')
}

const fieldTable = (descriptions) => {
  const rows = Object.entries(fieldDefs)
    .sort(([, a], [, b]) => Number(!!b.required) - Number(!!a.required))
    .map(([field, def]) => {
      const note = def.deprecated ? ` **deprecated — ${def.deprecated}**` : ''
      return `| \`${field}\` | ${typeOf(def)} | ${def.required ? 'yes' : ''} | ${descriptions[field]}${note} |`
    })
  return ['| field | type | required | meaning |', '|---|---|---|---|', ...rows].join('\n')
}

const referenceList = (name) => {
  const refs = providerDefs[name]?.references
  const free = PROVIDER_INFO[name]?.free ? '\n  - free tier: yes — see *A free tier is not a price* below' : ''
  if (!refs) return `- \`${name}\` — no reference links shipped. Ask the user where this provider publishes prices.${free}`
  const links = Object.entries(refs).map(([kind, url]) => `${kind}: ${url}`).join('\n  - ')
  return `- \`${name}\`\n  - ${links}${free}`
}

const sampleEntry = (curated, name) => {
  const match = catalogEntries(curated).find(([key, spec]) => key.startsWith(`${name}/`) && !spec.deprecated)
  if (!match) return null
  const [key, spec] = match
  const { upstreamIds, ...entry } = spec
  return JSON.stringify({ [key]: entry }, null, 2)
}

const localSection = (local) => {
  const parts = ['## Local conventions', '',
    `This installation adds the following to its catalog. None of it is part of
mohdel and no vendor docs page describes it — ${portablePath(LOCAL_PATH)} is the only
source. Treat everything here as binding for this catalog.`]

  if (local.notes) parts.push('', local.notes)

  const fields = Object.entries(local.fields)
  if (fields.length) {
    parts.push('', '### Local fields', '', '| field | type | meaning |', '|---|---|---|')
    for (const [name, def] of fields) parts.push(`| \`${name}\` | ${def.type} | ${def.description} |`)
    const measured = fields.filter(([, def]) => def.measured)
    if (measured.length) {
      parts.push('', 'These are **measured, not published**. There is no page to read them off.',
        'Run the command, or leave the field out and say which one you could not obtain:', '')
      for (const [name, def] of measured) parts.push(`- \`${name}\` — \`${def.measured}\``)
    }
    const read = fields.filter(([, def]) => def.readBy)
    if (read.length) {
      parts.push('', 'Read by:', '')
      for (const [name, def] of read) parts.push(`- \`${name}\` — ${def.readBy}`)
    }
  }

  const tags = Object.entries(local.tags)
  if (tags.length) {
    parts.push('', '### Local tags', '',
      'A tag here is not a label — it routes the model into something.', '',
      '| tag | what it does | required alongside |', '|---|---|---|')
    for (const [name, def] of tags) {
      parts.push(`| \`${name}\` | ${def.description} | ${def.requires.length ? def.requires.map(f => `\`${f}\``).join(', ') : '—'} |`)
    }
  }

  if (local.adding.field) parts.push('', '### Adding a new field', '', local.adding.field)
  if (local.adding.tag) parts.push('', '### Adding a new tag', '', local.adding.tag)

  return parts.join('\n')
}

export async function runInstructions (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel model instructions — brief for the coding agent that edits your catalog

Usage:
  model instructions [provider]      Write mohdel-brief.md and show how to
                                     hand it over. Redirected or piped, the
                                     brief goes to stdout instead.
  model instructions --print         Always write the brief to stdout
  model instructions --init-local    Scaffold this installation's own field
                                     and tag declarations, then edit them

Redirected or piped, the brief goes to stdout and the hand-off recipe to
stderr, so the file keeps only the brief:

  mo model instructions anthropic > mohdel-brief.md

Then start your coding agent on <prompt>:

     read mohdel-brief.md, then add claude-haiku-5 to my mohdel catalog

${launchLines().join('\n')}

One-shot instead of a session, where the agent supports it:

  mo model instructions anthropic | claude -p "add claude-haiku-5 to my catalog"
  mo model instructions anthropic | codex exec -`)
    process.exit(0)
  }

  if (args.includes('--init-local')) {
    const { err, ok, meta } = await import('./colors.js')
    if (existsSync(LOCAL_PATH)) {
      console.error(err(`${LOCAL_PATH} already exists — edit it, or move it aside first.`))
      process.exit(1)
    }
    await mkdir(dirname(LOCAL_PATH), { recursive: true })
    await writeFile(LOCAL_PATH, TEMPLATE)
    console.log(`${ok('✓')} wrote ${LOCAL_PATH}`)
    console.log(meta('Edit it, then "mo check" enforces it and "mo model instructions" hands it to your agent.'))
    return
  }

  const only = args.find(a => !a.startsWith('--'))
  if (only && !providerDefs[only]) {
    const { err } = await import('./colors.js')
    console.error(err(`Unknown provider: ${only}. Known: ${Object.keys(providerDefs).join(', ')}`))
    process.exit(1)
  }

  const local = await localConventionsOrExit()

  const assistant = (await getConfig()).assistant || null

  if (process.stdout.isTTY && !args.includes('--print')) {
    const { preferredAgent, briefPrompt } = await import('../lib/assistants.js')
    const { ok, meta, id: cmd } = await import('./colors.js')
    const name = await writeBrief(only)
    const agent = preferredAgent(assistant, detectAssistants())
    console.log(`${ok('✓')} wrote ${cmd(name)}\n`)
    console.log(`  ${cmd(agent.start(`"${briefPrompt(name, only)}"`))}\n`)
    console.log(meta('It drafts mohdel-candidate.json and checks it with "mo model check --entry mohdel-candidate.json";'))
    console.log(meta('you apply it with "mo model apply mohdel-candidate.json", which shows the diff first.'))
    console.log(meta(`\nThe brief itself: mo model instructions${only ? ' ' + only : ''} --print`))
    return
  }

  console.error(handoff(only, detectAssistants(), assistant))
  if (!local) {
    console.error(`
No local conventions declared. If your own services read catalog fields or tags
that mohdel does not know about, declare them once so the agent is told:

  mo model instructions --init-local`)
  }
  console.error('')

  console.log(await buildBrief(only, local))
}

export const buildBrief = async (only = null, local = undefined) => {
  if (local === undefined) local = await localConventionsOrExit()
  const names = only ? [only] : Object.keys(providerDefs)
  const descriptions = await loadDescriptions()
  const curated = await getCuratedModels()
  const sample = only ? sampleEntry(curated, only) : null
  const size = catalogEntries(curated).filter(([, spec]) => !spec.deprecated).length

  return `# mohdel catalog entry — brief for a coding agent

You are filling in one or more entries for a mohdel model catalog. Mohdel
computes real USD cost from these numbers on every call, so a wrong price is
a silent billing error, not a crash. Accuracy matters more than completeness.

## Hard rules

1. **Do not edit ${portablePath(CURATED_PATH)}.** Write your entries to a separate JSON
   file. The user applies it themselves.
2. **Do not invent a number.** Every price and limit must come from a page you
   actually read. If you cannot find one, leave the field out and say which
   ones you left out and why. If you have no way to fetch a web page at all,
   stop and say so — an entry of plausible-looking prices is worse than no
   entry, because nothing downstream can tell the difference.
3. **Prices are USD per 1,000,000 tokens.** \`"inputPrice": 3\` means $3 per
   million input tokens. \`imagePrice\` is per image; \`transcriptionPrice\` is
   per audio minute.
4. **The catalog key is \`<provider>/<model>\`** and carries no \`:effort\` or
   \`@speed\` suffix — those are call-time. The key may differ from the
   provider's literal id; the literal id goes in \`model\`.
5. **Record where the numbers came from**: \`source\` (the URL you read) and
   \`sourcedAt\` (YYYY-MM-DD). This is what makes a later price re-check possible.
6. **An entry replaces the existing one wholesale** — a field you leave out is a
   field removed. Editing an existing model? Read its current entry out of the
   catalog file first and change only what you mean to. Step 2 below prints
   every removal, so check the diff before handing it over.
${local
? `7. **This installation has its own fields and tags** — see *Local conventions*
   below, and do not treat the field table as the whole story. A field marked
   *measured* has no page to read it off: run the command named for it. Never
   apply a tag whose required fields you cannot supply — leave the tag off and
   say which one you skipped and why. \`mo model check --entry\` enforces both.
`
: ''}
${size === 0
? `## This catalog is empty

Nothing is curated yet, so the person asking probably cannot name the models
they want — do not ask them to. Start from what their key can actually reach:

\`\`\`bash
mo provider models ${only || '<provider>'} --json
\`\`\`

Read the pricing page, then propose a short starter set — three or four
entries, not everything on offer. A cheap fast model for routine work, one
strong model for hard work, and whatever else the list clearly justifies.
Show the prices you found and let them confirm before you write anything.
Prefer current models over older ones where the ids make the generation
obvious, and leave out anything you cannot price.

`
: ''}## Output shape

A JSON object keyed by model id, same shape as the catalog itself:

\`\`\`json
{
  "openai/gpt-5.4-mini": {
    "model": "gpt-5.4-mini-2026-01-15",
    "creator": "openai",
    "provider": "openai",
    "sdk": "openai",
    "label": "GPT-5.4 mini",
    "inputFormat": ["text", "image"],
    "inputPrice": 0.25,
    "outputPrice": 2,
    "contextTokenLimit": 400000,
    "outputTokenLimit": 128000,
    "source": "https://developers.openai.com/api/docs/pricing",
    "sourcedAt": "2026-09-10"
  }
}
\`\`\`

Retiring an id instead? A deprecated stub is a one-field redirect:
\`{ "openai/gpt-4o": { "deprecated": "openai/gpt-5.4-mini" } }\`.

## Workflow

\`\`\`bash
# 1. ask the provider which models this key can actually reach
mo provider models ${only || '<provider>'} --json

# 2. you write the candidate
$EDITOR mohdel-candidate.json

# 3. you check it — repeat until 0 errors
mo model check --entry mohdel-candidate.json --json

# 4. the user applies it (this is the step that writes)
mo model apply mohdel-candidate.json
\`\`\`

Step 1 is the authority on which ids exist and how they are spelled: a docs
page may list models this key cannot reach, miss ones shipped last week, or
spell them differently from the API. Take the id from there and the prices
from the docs page. Steps 1 and 3 only read, so run them as often as you need.
Step 4 writes to the user's catalog and shows them the diff first — hand them
the command, do not run it for them.

## Where to read the numbers

${names.map(referenceList).join('\n')}

${only && providerDefs[only]?.pricesFromApi
? `${only} is the exception among providers: its model list carries per-token
prices, so step 1 gives you the ids *and* the prices, and \`mo curate ${only}\`
writes complete entries on its own. Check what it produced rather than
transcribing anything, and use the pages below only for what the list omits.`
: `Provider APIs return model *ids*, not prices. Step 1 above gets you the ids;
the pages below carry everything the API does not expose: prices, context and
output limits, thinking budgets, cache rates.`}

### A free tier is not a price

Some of these providers let you call them for nothing up to a quota. Record
the **paid** rates anyway — a quota is not a price, mohdel bills against these
numbers, and they are what \`mo rank\` compares. But say plainly that the tier
exists when the provider has one, especially if that is why they chose it:
someone who picked a provider *because* it was free should not be shown a
table of dollar figures with no explanation. The rates apply once the free
quota is gone.

## Entry kinds

- **Text/vision model** — the default. \`inputFormat\` lists what it accepts.
- **Image generation** — \`"type": "image"\` plus \`imagePrice\`, \`imageEndpoint\`,
  \`imageDefaultSize\`.
- **Transcription** — \`"type": "transcription"\` plus \`transcriptionPrice\` (USD
  per audio minute).
- **Self-hosted** — a \`local/\` key. \`baseURL\` is required and rejected on every
  other provider. A server tag like \`llama3.1:8b\` goes in \`model\`; the key
  uses a dash.

## Fields

${fieldTable(descriptions)}

Fields mohdel does not know are preserved untouched — namespace your own with
a prefix (\`myapp:tier\`) so they stay distinct.

Full reference, including thinking-effort mapping and service speed lanes:
${CATALOG_DOC}
${local ? `\n${localSection(local)}\n` : ''}${sample ? `\n## An existing ${only} entry, for shape\n\n\`\`\`json\n${sample}\n\`\`\`\n` : ''}`
}
