#!/usr/bin/env node

/**
 * mohdel CLI — model management (noun-verb pattern).
 *
 * Nouns: model, provider, creator, tag, ratelimit
 * Each noun supports: list, show, and noun-specific verbs.
 *
 * Aliases: ls → model list, rl → ratelimit
 */

const [command, ...args] = process.argv.slice(2)

if (!command) {
  const { runOnboard } = await import('./onboard.js')
  await runOnboard()
  process.exit(0)
}

if (command === '-h' || command === '--help') {
  console.log(`mohdel — model catalog management

Commands:
  model list [--sort price|context|name]  List all curated models
  model search <term>                     Filter models by name/label
  model stats                             Catalog summary
  model show <model>                      Show model details
  model get <model> <key>                 Get a field value
  model set <model> <key> <value>         Set a field
  model rm <model> <key>                  Remove a field
  model add <provider>/<model-id>         Add a model manually
  model check [--local]                   Validate catalog
  model rank [--use-case <name>]          Rank models by benchmarks
  model bench <model>                     Benchmark with live inference
  model curate [provider]                 Add upstream models to catalog

  provider list                           List all providers
  provider list <provider>                List models from a provider
  provider setup <provider>               Configure API key (interactive)
  provider rm <provider>                  Remove API key

  creator list                            List all creators
  creator list <creator>                  List models by a creator

  tag list                                List all unique tags
  tag list <model>                        Show tags on a model
  tag show <tag>                          List models with a tag
  tag add <model> <tag>                   Add a tag
  tag rm <model> <tag>                    Remove a tag

  ratelimit show <model|provider>         Show effective limits
  ratelimit set <model> [rpm] [tpm]       Set model-level limits
  ratelimit rm <model>                    Remove model-level limits
  ratelimit provider set <p> [rpm] [tpm]  Set provider-level limits
  ratelimit provider rm <p>               Remove provider-level limits

  ask <provider/model> [prompt]           One-shot inference (pipeable)
  transcribe <provider/model> <file>      Speech → text from an audio file

  default                                 Set default model (interactive)
  doctor                                  Check that your install is wired up

Aliases:
  models                model list
  providers             provider list
  creators              creator list
  tags                  tag list
  ls                    model list
  show <model>          model show <model>
  search <term>         model search <term>
  stats                 model stats
  check                 model check
  setup <provider>      provider setup <provider>
  rank                  model rank
  bench <model>         model bench <model>
  curate [provider]     model curate [provider]
  rl                    ratelimit

Global flags:
  --json [fields]       Output as JSON (omit fields to list available)

Environment:
  API keys are loaded from ~/.config/mohdel/environment (KEY=value format).
  Run "mo" with no arguments to configure interactively.

  ANTHROPIC_API_SK      Anthropic API key
  OPENAI_API_SK         OpenAI API key
  GEMINI_API_SK         Google Gemini API key
  GROQ_API_SK           Groq API key
  CEREBRAS_API_SK       Cerebras API key
  XAI_API_SK            xAI API key
  MISTRAL_API_SK        Mistral API key
  DEEPSEEK_API_SK       DeepSeek API key
  FIREWORKS_API_SK      Fireworks API key
  OPENROUTER_API_SK     OpenRouter API key
  NOVITA_API_SK         Novita API key

Configuration:
  ~/.config/mohdel/environment      API keys (loaded automatically)
  ~/.config/mohdel/curated.json     Model catalog
  ~/.config/mohdel/providers.json   Provider-level rate limits
  ~/.config/mohdel/default.json     Default model selection`)
  process.exit(0)
}

// Alias resolution: short commands → noun + verb
const ALIASES = {
  models: { noun: 'model', inject: ['list'] },
  providers: { noun: 'provider', inject: ['list'] },
  creators: { noun: 'creator', inject: ['list'] },
  tags: { noun: 'tag', inject: ['list'] },
  ls: { noun: 'model', inject: ['list'] },
  show: { noun: 'model', inject: ['show'] },
  search: { noun: 'model', inject: ['search'] },
  stats: { noun: 'model', inject: ['stats'] },
  check: { noun: 'model', inject: ['check'] },
  setup: { noun: 'provider', inject: ['setup'] },
  rank: { noun: 'model', inject: ['rank'] },
  bench: { noun: 'model', inject: ['bench'] },
  curate: { noun: 'model', inject: ['curate'] },
  rl: { noun: 'ratelimit', inject: [] }
}

const alias = ALIASES[command]
const resolved = alias ? alias.noun : command
const resolvedArgs = alias ? [...alias.inject, ...args] : args

if (resolved === 'default') {
  const { runDefault } = await import('./default.js')
  await runDefault()
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
