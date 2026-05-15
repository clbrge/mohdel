import mohdel, { silent } from '../lib/index.js'
import { loadDefaultEnv } from '../lib/common.js'

const noop = () => {}

// Friendly next-step hints for common ask-time failures. Pure pattern match on
// err.message — keeps the lib layer neutral, but gives CLI users a copy-pasteable
// command instead of just an error.
const hintsForError = (err, modelId) => {
  const msg = String(err?.message || '')
  const detail = String(err?.detail || '')
  const both = `${msg}\n${detail}`
  const provider = modelId.includes('/') ? modelId.split('/')[0] : null
  const hints = []

  if (/not found in curated models/i.test(both)) {
    if (provider) {
      hints.push(`→ run:  mo curate ${provider}        # add upstream models from this provider`)
      hints.push(`→ or:   mo model add ${modelId}      # add this one manually`)
    } else {
      hints.push('→ run:  mo ls                       # list available models')
    }
    hints.push('→ see:  docs/CATALOG.md             # catalog format reference')
  }

  if (/API key not found/i.test(both) || /AUTH_INVALID/i.test(err?.type || '') || /401|unauthorized|invalid api key/i.test(both)) {
    if (provider) hints.push(`→ run:  mo setup ${provider}`)
    else hints.push('→ run:  mo                          # interactive provider/key setup')
  }

  if (/deprecated/i.test(both) && /replacement/i.test(both)) {
    hints.push('→ run:  mo check                    # find broken deprecation links in curated.json')
  }

  if (/Provider configuration for/i.test(both)) {
    hints.push('→ see:  docs/CATALOG.md             # the provider segment must match a known adapter')
  }

  return hints
}

export async function runAsk (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel ask — one-shot inference, pipeable

Usage:
  mo ask <model> [prompt]              Prompt from args
  echo "prompt" | mo ask <model>       Prompt from stdin
  mo ask <model> "question" < file     Combined: args + stdin

Options:
  --effort <level>     Thinking effort: high, medium, low, none
  --budget <tokens>    Output token budget
  --json               Output full result as JSON
  --stream             Stream output to stdout in real time
  -v, --verbose        Show debug info on stderr (cooldown, rate limit, SDK calls)

Output:
  stdout: model output text (raw, no formatting — or JSON with --json)
  stderr: model name + token usage summary

Examples:
  mo ask gemini/gemini-3-flash-preview "why is the sky blue"
  cat article.txt | mo ask anthropic/claude-sonnet-4-6 "summarize this"
  mo ask openai/gpt-5.4 --effort high "explain monads" --json | jq .cost`)
    process.exit(0)
  }

  loadDefaultEnv()

  // Parse flags
  const flagVal = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return undefined
    const val = args[idx + 1]
    args.splice(idx, 2)
    return val
  }
  const flag = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return false
    args.splice(idx, 1)
    return true
  }

  const json = flag('--json')
  const stream = flag('--stream')
  const verbose = flag('--verbose') || flag('-v')
  const effort = flagVal('--effort')
  const budget = flagVal('--budget')

  // First remaining arg is model
  const modelId = args[0]
  if (!modelId) {
    console.error('Usage: mo ask <model> [prompt]')
    process.exit(1)
  }

  // Remaining args form the prompt
  const promptArgs = args.slice(1).join(' ').trim()

  // Read stdin if piped
  let stdinContent = ''
  if (!process.stdin.isTTY) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    stdinContent = Buffer.concat(chunks).toString('utf8').trim()
  }

  // Build prompt: args + stdin
  const parts = [promptArgs, stdinContent].filter(Boolean)
  const prompt = parts.join('\n\n')

  if (!prompt) {
    console.error('No prompt provided. Pass as argument or pipe via stdin.')
    process.exit(1)
  }

  const log = verbose ? (...args) => process.stderr.write(`${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`) : noop
  // Verbose mode routes info+warn+error+fatal (and debug) to stderr; trace stays silent.
  // Non-verbose: only error/fatal go to stderr (everything else silent).
  const askLogger = {
    ...silent,
    debug: verbose ? log : noop,
    info: log,
    warn: log,
    error: log,
    fatal: log
  }
  const mo = await mohdel({ logger: askLogger })
  let model
  try {
    model = mo.use(modelId)
  } catch (err) {
    console.error(err.message)
    for (const h of hintsForError(err, modelId)) console.error(h)
    process.exit(1)
  }

  const options = {}
  if (effort) options.outputEffort = effort
  if (budget) options.outputBudget = parseInt(budget, 10)
  if (stream && !json) {
    options.realtimeHandler = (delta) => process.stdout.write(delta)
    options.bufferOpts = { maxChars: 1, maxMs: 0 }
  }

  process.stderr.write(`${model.id}\n`)

  try {
    const result = await model.answer(prompt, options)
    const output = typeof result === 'string' ? result : result?.output || ''
    const tokens = typeof result === 'object' ? result : {}

    if (json) {
      console.log(JSON.stringify({
        model: model.id,
        output,
        inputTokens: tokens.inputTokens || 0,
        outputTokens: tokens.outputTokens || 0,
        thinkingTokens: tokens.thinkingTokens || 0,
        cost: tokens.cost ?? null,
        status: tokens.status || 'completed'
      }, null, 2))
    } else if (!stream) {
      process.stdout.write(output)
      if (output && !output.endsWith('\n')) process.stdout.write('\n')
    } else {
      // Stream already wrote to stdout; ensure trailing newline
      if (output && !output.endsWith('\n')) process.stdout.write('\n')
    }

    // Token + timing summary to stderr
    const summary = []
    if (tokens.inputTokens) summary.push(`${tokens.inputTokens} in`)
    if (tokens.outputTokens) summary.push(`${tokens.outputTokens} out`)
    if (tokens.thinkingTokens) summary.push(`${tokens.thinkingTokens} think`)
    if (tokens.cost != null) summary.push(`$${tokens.cost.toFixed(4)}`)
    const ts = tokens.timestamps
    if (ts) {
      const toMs = (a, b) => {
        if (!a || !b) return null
        const na = typeof a === 'bigint' ? a : BigInt(a)
        const nb = typeof b === 'bigint' ? b : BigInt(b)
        return Number(nb - na) / 1e6
      }
      const ttft = toMs(ts.start, ts.first)
      const total = toMs(ts.start, ts.end)
      if (ttft != null) summary.push(`${Math.round(ttft)}ms ttft`)
      if (total != null) summary.push(`${Math.round(total)}ms total`)
    }
    if (summary.length) process.stderr.write(`${summary.join(', ')}\n`)
  } catch (err) {
    console.error(`Error: ${err.detail || err.message}`)
    for (const h of hintsForError(err, modelId)) console.error(h)
    process.exit(1)
  }
}
