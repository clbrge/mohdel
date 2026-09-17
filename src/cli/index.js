#!/usr/bin/env node

/**
 * mohdel CLI — model management (noun-verb pattern).
 *
 * Nouns: model, provider, creator, tag, ratelimit
 * Each noun supports: list, show, and noun-specific verbs.
 *
 * Aliases: ls → model list, rl → ratelimit
 */

import { detectAssistants, launchLines } from '../lib/assistants.js'
import { getConfig } from '../lib/common.js'
import { ALIASES } from './aliases.js'

const [command, ...args] = process.argv.slice(2)

if (!command) {
  const { runOnboard } = await import('./onboard.js')
  await runOnboard()
  process.exit(0)
}

// Before anything else: a tab press must not pay for the factory import.
if (command === '__complete') {
  const { runComplete } = await import('./complete.js')
  await runComplete(args)
  process.exit(0)
}

if (command === 'completion') {
  const { runCompletionScript } = await import('./complete.js')
  runCompletionScript(args)
  process.exit(0)
}

if (command === '-h' || command === '--help') {
  const assistant = (await getConfig()).assistant || null
  const { default: PROVIDER_INFO } = await import('../lib/provider-info.js')
  const { default: providerDefs } = await import('../lib/providers.js')
  const keyRows = Object.keys(PROVIDER_INFO)
    .map(name => [providerDefs[name].apiKeyEnv, `${PROVIDER_INFO[name].label} API key`])
    .concat([['MOHDEL_LOCAL_API_SK', 'Bearer token for a local server, if it wants one']])
  const keyWidth = Math.max(...keyRows.map(([k]) => k.length))
  const keys = keyRows.map(([k, d]) => `  ${k.padEnd(keyWidth + 2)}${d}`).join('\n')
  console.log(`mohdel — self-hosted LLM gateway and SDK for Node

Run a model, see what the call cost, and curate the catalog those prices
come from. Your keys, your infra, no SaaS in the path.

Commands:
  model list [--sort price|context|name]  List all curated models                 (mo ls, mo models)
  model search <term>                     Filter models by name/label             (mo search)
  model stats                             Catalog summary                         (mo stats)
  model show <model>                      Show model details                      (mo show)
  model get <model> <key>                 Get a field value
  model set <model> <key> <value>         Set a field
  model rm <model> <key>                  Remove a field
  model add <provider>/<model-id>         Add a model manually
  model instructions [provider]           Brief for your coding agent             (mo instructions)
  model check [--entry <file|->]          Validate catalog, or candidate entries  (mo check)
  model apply <file|->                    Write reviewed entries to the catalog   (mo apply)
  model rank [--use-case <name>]          Rank models by benchmarks               (mo rank)
  model bench <model>                     Benchmark with live inference           (mo bench)
  model curate [provider]                 Add upstream models to catalog          (mo curate)

  provider list                           List all providers                      (mo providers)
  provider list <provider>                List curated models for a provider
  provider models <provider>              List models the key can reach upstream
  provider setup <provider>               Configure API key (interactive)         (mo setup)
  provider rm <provider>                  Remove API key

  creator list                            List all creators                       (mo creators)
  creator list <creator>                  List models by a creator

  tag list                                List all unique tags                    (mo tags)
  tag list <model>                        Show tags on a model
  tag show <tag>                          List models with a tag
  tag add <model> <tag>                   Add a tag
  tag rm <model> <tag>                    Remove a tag

  ratelimit show <model|provider>         Show effective limits                   (mo rl show)
  ratelimit set <model> <limit> <value>   Set limits: rpm, tpm, inpm
  ratelimit rm <model>                    Remove model-level limits
  ratelimit provider set <p> <limit> <v>  Set provider-level limits
  ratelimit provider rm <p>               Remove provider-level limits

  ask <provider/model> [prompt]           One-shot inference (pipeable)
  transcribe <provider/model> <file>      Speech → text from an audio file

  default [model]                         Set the model "mo ask" uses by default
  doctor                                  Check that your install is wired up
  completion bash                         Shell completion — source <(mo completion bash)

Catalog work with a coding agent:
  Prices, context limits and cache rates are in no provider API — they live on
  docs pages. Put the brief in front of the coding agent you already use:

    mo model instructions openai > mohdel-brief.md

  then start it on <prompt>:

     read mohdel-brief.md, then add gpt-5.6 to my mohdel catalog

${launchLines(detectAssistants(), assistant).join('\n')}

  The agent needs to be able to fetch a web page — that is where the prices
  are. It drafts mohdel-candidate.json and checks it; you apply it:

    mo model check --entry mohdel-candidate.json
    mo model apply mohdel-candidate.json     ← prints the diff first

Aliases appear in brackets above. "mo rl" stands in for "mo ratelimit" on
every subcommand, not only its list form.

Global flags:
  --json [fields]       Output as JSON (omit fields to list available)

Environment:
  API keys are loaded from ~/.config/mohdel/environment (KEY=value format).
  Run "mo" with no arguments to configure interactively.

${keys}

Configuration:
  ~/.config/mohdel/environment        API keys (loaded automatically)
  ~/.config/mohdel/curated.json       Model catalog
  ~/.config/mohdel/catalog.local.json This installation's own fields and tags
  ~/.config/mohdel/providers.json     Provider-level rate limits
  ~/.config/mohdel/excluded.json      Models to hide from list and curate
  ~/.config/mohdel/default.json       Default model, and your coding agent`)
  process.exit(0)
}

const alias = ALIASES[command]
const resolved = alias ? alias.noun : command
const resolvedArgs = alias ? [...alias.inject, ...args] : args

if (resolved === 'default') {
  const { runDefault } = await import('./default.js')
  await runDefault(resolvedArgs)
} else if (resolved === 'doctor') {
  const { runDoctor } = await import('./doctor.js')
  await runDoctor(resolvedArgs)
} else if (resolved === 'ask') {
  const { runAsk } = await import('./ask.js')
  await runAsk(resolvedArgs)
} else if (resolved === 'transcribe') {
  const { runTranscribe } = await import('./transcribe.js')
  await runTranscribe(resolvedArgs)
} else if (resolved === 'model') {
  const { runModel } = await import('./model.js')
  await runModel(resolvedArgs)
} else if (resolved === 'provider') {
  const { runProvider } = await import('./model.js')
  await runProvider(resolvedArgs)
} else if (resolved === 'creator') {
  const { runCreator } = await import('./model.js')
  await runCreator(resolvedArgs)
} else if (resolved === 'tag') {
  const { runTag } = await import('./tag.js')
  await runTag(resolvedArgs)
} else if (resolved === 'ratelimit' || resolved === 'rl') {
  const { runRateLimit } = await import('./ratelimit.js')
  await runRateLimit(resolvedArgs)
} else {
  console.error(`Unknown command: ${command}. Run "mo --help" for usage.`)
  process.exit(1)
}
