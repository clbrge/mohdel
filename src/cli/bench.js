import { id, label, meta, price, err } from './colors.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import mohdel from '../lib/index.js'
import { loadDefaultEnv } from '../lib/common.js'
import {
  loadPrompt, parseJson, scoreCorrectness, computeCost,
  computeTiming, formatNumber
} from '../lib/benchmark-score.js'

export async function runBench (args) {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel model bench — benchmark models with live inference

Usage:
  model bench <model> [options]         Benchmark a single model
  model bench --tag <tag> [options]     Benchmark all models with a tag

Options:
  --effort <level>      Thinking effort: high, medium, low, none
  --budget <tokens>     Output token budget (default: 12000)
  --prompt <path>       Prompt file (default: test/benchmark.md)
  --save <path>         Save results to JSON file
  --json                Output as JSON (single model only)

Examples:
  mo bench anthropic/claude-sonnet-4-6
  mo bench --tag fast --effort low
  mo bench openai/gpt-5 --budget 8000 --save results.json`)
    process.exit(0)
  }

  loadDefaultEnv()

  // Parse flags
  const flag = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return false
    args.splice(idx, 1)
    return true
  }
  const flagVal = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return undefined
    const val = args[idx + 1]
    args.splice(idx, 2)
    return val
  }

  const json = flag('--json')
  const effort = flagVal('--effort')
  const budget = parseInt(flagVal('--budget') || '12000', 10)
  const promptPath = flagVal('--prompt') || 'test/benchmark.md'
  const savePath = flagVal('--save')
  const tags = []
  let t
  while ((t = flagVal('--tag'))) tags.push(t)

  const mo = await mohdel()

  if (tags.length) {
    await runSuite(mo, { tags, effort, budget, promptPath, savePath })
  } else {
    const modelId = args[0]
    if (!modelId) {
      console.error('Provide a model ID or --tag. Run "mo model bench --help".')
      process.exit(1)
    }
    await runSingle(mo, modelId, { effort, budget, promptPath, savePath, json })
  }
}

// --- Single model ---

async function runSingle (mo, modelId, { effort, budget, promptPath, savePath, json }) {
  const prompt = await loadPrompt(promptPath)
  const model = mo.use(modelId)
  const info = model.info()
  const pricing = resolvePricing(info)

  const result = await benchmarkModel(model, prompt, { effort, budget, pricing })

  if (savePath) {
    await fs.writeFile(path.resolve(savePath), JSON.stringify(result, null, 2))
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    printSingleResult(result)
  }
}

// --- Suite (multi-model by tag) ---

async function runSuite (mo, { tags, effort, budget, promptPath, savePath }) {
  const prompt = await loadPrompt(promptPath)
  const seen = new Set()
  const models = []
  for (const tag of tags) {
    for (const m of mo.list(tag)) {
      if (!seen.has(m.value)) {
        seen.add(m.value)
        models.push(m)
      }
    }
  }

  if (!models.length) {
    console.error(err(`No models found with tags: ${tags.join(', ')}`))
    process.exit(1)
  }

  const results = []
  for (let i = 0; i < models.length; i++) {
    const { value, label } = models[i]
    process.stderr.write(`[${i + 1}/${models.length}] ${value}...`)

    try {
      const model = mo.use(value)
      const pricing = resolvePricing(model.info())
      const result = await benchmarkModel(model, prompt, { effort, budget, pricing })
      results.push(result)
      process.stderr.write(` ${result.correctness.toFixed(3)}\n`)
    } catch (e) {
      process.stderr.write(` ${err('FAILED')}: ${e.message}\n`)
      results.push({ model: value, label, correctness: null, cost: null, correctnessPerDollar: null, error: e.message })
    }
  }

  results.sort((a, b) => {
    if (a.correctnessPerDollar === null && b.correctnessPerDollar === null) return 0
    if (a.correctnessPerDollar === null) return 1
    if (b.correctnessPerDollar === null) return -1
    return b.correctnessPerDollar - a.correctnessPerDollar
  })

  printSuiteTable(results)

  if (savePath) {
    await fs.writeFile(path.resolve(savePath), JSON.stringify(results, null, 2))
    process.stderr.write(`\nResults saved to ${path.resolve(savePath)}\n`)
  }
}

// --- Shared benchmark runner ---

async function benchmarkModel (model, prompt, { effort, budget, pricing }) {
  const runTag = `[run:${Date.now()}-${Math.random().toString(36).slice(2, 8)}]`
  const minimalBudget = Math.min(budget || 0, 32) || 32

  const minimalResponse = await model.answer(`${runTag} say ack`, { outputBudget: minimalBudget, outputEffort: effort })
  const response = await model.answer(`${runTag}\n${prompt}`, { outputBudget: budget, outputEffort: effort })

  const rawOutput = typeof response === 'string' ? response : response?.output || ''
  const parsed = parseJson(rawOutput)
  const scoring = scoreCorrectness(parsed)

  const minimalTiming = computeTiming(typeof minimalResponse === 'object' ? minimalResponse.timestamps : {})
  const standardTiming = computeTiming(typeof response === 'object' ? response.timestamps : {})

  const generationSeconds = standardTiming.generationMs !== null ? standardTiming.generationMs / 1000 : null
  const outputTokens = Number.isFinite(response?.outputTokens) ? response.outputTokens : null

  const tokens = {
    input: response?.inputTokens ?? null,
    output: response?.outputTokens ?? null,
    thinking: response?.thinkingTokens ?? null
  }

  const costDollars = computeCost(tokens, pricing)

  return {
    model: model.id,
    label: model.label,
    correctness: formatNumber(scoring.correctness),
    cost: costDollars !== null ? formatNumber(costDollars) : null,
    correctnessPerDollar: costDollars > 0 ? formatNumber(scoring.correctness / costDollars) : null,
    breakdown: Object.fromEntries(
      Object.entries(scoring.breakdown).map(([k, v]) => [k, formatNumber(v)])
    ),
    tokens,
    pricing: pricing ? { inputPerMillion: pricing.input, outputPerMillion: pricing.output, thinkingPerMillion: pricing.thinking } : null,
    parse: { ok: parsed.ok, error: parsed.ok ? null : parsed.error, extraneous: parsed.extraneous },
    timing: { minimal: minimalTiming, standard: standardTiming },
    throughput: {
      outputTokensPerSecond: outputTokens !== null && generationSeconds > 0 ? formatNumber(outputTokens / generationSeconds) : null,
      charactersPerSecond: generationSeconds > 0 ? formatNumber(rawOutput.length / generationSeconds) : null
    },
    latencyMs: { minimal: minimalTiming.latencyMs, standard: standardTiming.latencyMs },
    requested: { outputBudget: budget, outputEffort: effort || null },
    details: scoring.details,
    raw: rawOutput
  }
}

// --- Helpers ---

function resolvePricing (info) {
  if (!info) return null
  const rp = p => typeof p === 'number' ? p : (p?.default ?? 0)
  return { input: rp(info.inputPrice), output: rp(info.outputPrice), thinking: rp(info.thinkingPrice) }
}

// --- Output ---

function printSingleResult (r) {
  console.log(`\n${label(r.label)} ${meta(`(${r.model})`)}`)
  console.log(`${meta('correctness:')}  ${id(r.correctness?.toFixed(3) || '—')}`)
  console.log(`${meta('cost:')}         ${r.cost != null ? price('$' + r.cost.toFixed(4)) : '—'}`)
  console.log(`${meta('corr/$:')}       ${r.correctnessPerDollar?.toFixed(1) || '—'}`)
  console.log(`${meta('latency:')}      ${r.latencyMs.standard != null ? r.latencyMs.standard.toFixed(0) + 'ms' : '—'}`)
  console.log(`${meta('throughput:')}   ${r.throughput.outputTokensPerSecond || '—'} tok/s`)
  console.log(`${meta('tokens:')}       ${r.tokens.input || 0} in, ${r.tokens.output || 0} out, ${r.tokens.thinking || 0} thinking`)

  if (r.breakdown) {
    const parts = Object.entries(r.breakdown).map(([k, v]) => `${k}=${v?.toFixed(3) || '—'}`)
    console.log(`${meta('breakdown:')}    ${parts.join('  ')}`)
  }
  console.log()
}

const pad = (str, len) => {
  const s = String(str)
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

const fmtNum = (v, width) => {
  if (v === null || v === undefined) return pad('-', width)
  return pad(v.toFixed(3), width)
}

function printSuiteTable (results) {
  const colModel = 35
  const colNum = 9
  const header = pad('Model', colModel) +
    pad('Correct', colNum) +
    pad('Cost($)', colNum) +
    pad('Corr/$', colNum) +
    pad('Entities', colNum) +
    pad('Metrics', colNum) +
    pad('Contrad.', colNum)
  console.log('\n' + meta(header))
  console.log(meta('─'.repeat(header.length)))

  for (const r of results) {
    if (r.error) {
      console.log(pad(r.model, colModel) + err('FAILED: ' + r.error))
      continue
    }
    console.log(
      pad(r.model, colModel) +
      fmtNum(r.correctness, colNum) +
      fmtNum(r.cost, colNum) +
      fmtNum(r.correctnessPerDollar, colNum) +
      fmtNum(r.breakdown?.entities, colNum) +
      fmtNum(r.breakdown?.metrics, colNum) +
      fmtNum(r.breakdown?.contradictions, colNum)
    )
  }
  console.log()
}
