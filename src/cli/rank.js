import { label, price, meta as dim } from './colors.js'
import { getCuratedModels } from '../lib/common.js'
import { rank } from '../lib/rank.js'
import { parseJsonFlag } from './json-output.js'

const USE_CASES = ['balanced', 'analysis', 'tool-loop', 'cowork']

export async function runRank (args) {
  const jsonFlag = parseJsonFlag(args)

  if (args.includes('-h') || args.includes('--help')) {
    console.log(`mohdel model rank — rank models by benchmark performance

Usage:
  model rank [options]

Options:
  --use-case <name>   Weight preset: ${USE_CASES.join(', ')} (default: balanced)
  --top N             Number of results (default: 20)
  --breakdown, -b     Show per-group sub-scores
  --all               Include all upstream models (default: curated only)
  --since YYYY-MM     Filter by release date
  --min-context N     Minimum context window
  --fresh             Bypass cache, fetch live data
  --json              Output as JSON
  --md                Output as markdown

Sources:
  ZeroEval            Backbone — GPQA, MMMU-Pro, MRCR, Toolathlon
  Epoch AI            GPQA Diamond, SWE-bench Verified
  Tau2-bench          Tool reliability (retail)

Cache:
  Benchmark data cached for 24h in ~/.cache/mohdel/rank-*.json
  Use --fresh to bypass`)
    process.exit(0)
  }

  // Parse flags
  const flag = (name) => {
    const idx = args.indexOf(name)
    if (idx === -1) return undefined
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

  const useCase = flagVal('--use-case') || 'balanced'
  const top = parseInt(flagVal('--top') || '20', 10)
  const breakdown = flag('--breakdown') || flag('-b')
  const all = flag('--all')
  const fresh = flag('--fresh')
  const since = flagVal('--since')
  const minContext = flagVal('--min-context') ? parseInt(flagVal('--min-context'), 10) : undefined
  const md = flag('--md')

  if (!USE_CASES.includes(useCase)) {
    console.error(`Unknown use-case: ${useCase}. Available: ${USE_CASES.join(', ')}`)
    process.exit(1)
  }

  const curated = all ? null : await getCuratedModels()

  const { rankings, meta } = await rank({
    curated,
    useCase,
    top,
    all,
    since,
    minContext,
    fresh,
    onStatus: (msg) => process.stderr.write(`  ${msg}\n`)
  })

  if (!rankings.length) {
    console.error('No models matched the criteria.')
    process.exit(1)
  }

  // JSON output
  if (jsonFlag.json) {
    const out = { ...meta, rankings: rankings.map(r => ({ ...r, overall: n(r.overall), analysis: n(r.analysis), tool_loop: n(r.tool_loop), cowork: n(r.cowork), value: n(r.value) })) }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  // Markdown output
  if (md) {
    outputMarkdown(rankings, meta, breakdown)
    return
  }

  // Table output (default)
  outputTable(rankings, meta, breakdown)
}

// --- Formatters ---

const n = (v) => v != null ? Number(v.toFixed(2)) : null
const fmtScore = (v) => v != null ? v.toFixed(1) : dim('—')
const fmtPrice = (v) => v != null ? price(`$${Number(v.toFixed(2))}`) : dim('—')
const fmtValue = (v) => v != null ? v.toFixed(1) : dim('—')
const pad = (str, len, right = false) => {
  const s = String(str)
  return right ? s.padStart(len) : s.padEnd(len)
}
const trunc = (name, max) => name.length > max ? name.slice(0, max - 2) + '..' : name

function outputTable (rankings, meta, breakdown) {
  const nameW = Math.min(32, Math.max(20, ...rankings.map(r => r.model.length)))

  console.log(`\n${label('Model Rankings')} ${dim(`(${meta.date}, ${meta.useCase})`)}`)
  console.log(dim(`Sources: ${meta.sources.join(', ')}\n`))

  if (breakdown) {
    const hdr = ` #  ${pad('Model', nameW)}  Overall  Analysis  Tool   CoWork  $/1M out  Value  Cov`
    console.log(dim(hdr))
    console.log(dim('─'.repeat(hdr.length)))
    for (const r of rankings) {
      console.log(
        `${pad(r.rank, 2, true)}  ${pad(trunc(r.model, nameW), nameW)}` +
        `  ${pad(fmtScore(r.overall), 7, true)}` +
        `  ${pad(fmtScore(r.analysis), 8, true)}` +
        `  ${pad(fmtScore(r.tool_loop), 5, true)}` +
        `  ${pad(fmtScore(r.cowork), 6, true)}` +
        `  ${pad(fmtPrice(r.output_price), 8, true)}` +
        `  ${pad(fmtValue(r.value), 5, true)}` +
        `  ${pad(r.coverage, 3, true)}`
      )
    }
  } else {
    const hdr = ` #  ${pad('Model', nameW)}  Overall  $/1M out  Value  Cov`
    console.log(dim(hdr))
    console.log(dim('─'.repeat(hdr.length)))
    for (const r of rankings) {
      console.log(
        `${pad(r.rank, 2, true)}  ${pad(trunc(r.model, nameW), nameW)}` +
        `  ${pad(fmtScore(r.overall), 7, true)}` +
        `  ${pad(fmtPrice(r.output_price), 8, true)}` +
        `  ${pad(fmtValue(r.value), 5, true)}` +
        `  ${pad(r.coverage, 3, true)}`
      )
    }
  }
  console.log()
}

function outputMarkdown (rankings, meta, breakdown) {
  const fs = (v) => v != null ? v.toFixed(1) : '—'
  const fp = (v) => v != null ? `$${Number(v.toFixed(2))}` : '—'
  const fv = (v) => v != null ? v.toFixed(1) : '—'

  console.log(`## Model Rankings (${meta.date}, ${meta.useCase})`)
  console.log(`*Sources: ${meta.sources.join(', ')}*\n`)

  if (breakdown) {
    console.log('| # | Model | Overall | Analysis | Tool | CoWork | $/1M out | Value | Cov |')
    console.log('|--:|-------|--------:|---------:|-----:|-------:|---------:|------:|----:|')
    for (const r of rankings) {
      console.log(`| ${r.rank} | ${r.model} | ${fs(r.overall)} | ${fs(r.analysis)} | ${fs(r.tool_loop)} | ${fs(r.cowork)} | ${fp(r.output_price)} | ${fv(r.value)} | ${r.coverage} |`)
    }
  } else {
    console.log('| # | Model | Overall | $/1M out | Value | Cov |')
    console.log('|--:|-------|--------:|---------:|------:|----:|')
    for (const r of rankings) {
      console.log(`| ${r.rank} | ${r.model} | ${fs(r.overall)} | ${fp(r.output_price)} | ${fv(r.value)} | ${r.coverage} |`)
    }
  }
  console.log()
}
