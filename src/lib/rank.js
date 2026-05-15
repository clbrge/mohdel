// Model ranking engine — fetches benchmarks, merges sources, computes scores.
// No CLI, no output formatting — pure data.

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { CACHE_DIR } from './cache.js'
import { catalogEntries } from './common.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, '..', '..', 'config', 'benchmarks.json')

// --- Config ---

export const loadConfig = async () => {
  const raw = await readFile(CONFIG_PATH, 'utf8')
  return JSON.parse(raw)
}

// --- Cache ---

const cachePath = (name) => join(CACHE_DIR, `rank-${name}.json`)

const loadCache = async (name, ttlMs) => {
  try {
    const raw = await readFile(cachePath(name), 'utf8')
    const { timestamp, data } = JSON.parse(raw)
    if (Date.now() - timestamp < ttlMs) return data
  } catch {}
  return null
}

const saveCache = async (name, data) => {
  try {
    if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(cachePath(name), JSON.stringify({ timestamp: Date.now(), data }))
  } catch {}
}

// --- Name matching ---

const normalizeCompact = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

const buildNameIndex = (models) => {
  const index = new Map()
  for (const m of models) {
    index.set(normalizeCompact(m.name), m.model_id)
    index.set(normalizeCompact(m.model_id), m.model_id)
    const stripped = m.model_id.replace(/-\d{8}$/, '')
    if (stripped !== m.model_id) index.set(normalizeCompact(stripped), m.model_id)
  }
  return index
}

const matchModel = (name, nameIndex) => {
  const compact = normalizeCompact(name)
  if (nameIndex.has(compact)) return nameIndex.get(compact)
  const cleaned = normalizeCompact(name.replace(/\s*\(.*?\)\s*/g, ''))
  if (cleaned !== compact && nameIndex.has(cleaned)) return nameIndex.get(cleaned)
  const noVersion = normalizeCompact(name.replace(/-\d{4,8}$/, ''))
  if (noVersion !== compact && nameIndex.has(noVersion)) return nameIndex.get(noVersion)
  return null
}

// --- CSV parser ---

const parseCSV = (text) => {
  const rows = []
  let row = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuote = false
      } else { field += ch }
    } else if (ch === '"') { inQuote = true } else if (ch === ',') { row.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1) rows.push(row)
      row = []
    } else { field += ch }
  }
  if (row.length || field) { row.push(field); rows.push(row) }
  return rows
}

// --- Sources ---

const URLS = {
  zeroeval: 'https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true',
  epoch: 'https://epoch.ai/data/benchmarks.csv',
  tau2Manifest: 'https://raw.githubusercontent.com/sierra-research/tau2-bench/main/web/leaderboard/public/submissions/manifest.json',
  tau2Base: 'https://raw.githubusercontent.com/sierra-research/tau2-bench/main/web/leaderboard/public/submissions'
}

const fetchZeroEval = async (fresh, ttlMs) => {
  if (!fresh) {
    const cached = await loadCache('zeroeval', ttlMs)
    if (cached) return { data: cached, fromCache: true }
  }
  const res = await fetch(URLS.zeroeval)
  if (!res.ok) throw new Error(`ZeroEval API ${res.status}`)
  const data = await res.json()
  await saveCache('zeroeval', data)
  return { data, fromCache: false }
}

const fetchEpoch = async (fresh, ttlMs) => {
  if (!fresh) {
    const cached = await loadCache('epoch', ttlMs)
    if (cached) return cached
  }
  const res = await fetch(URLS.epoch)
  if (!res.ok) throw new Error(`Epoch AI ${res.status}`)
  const rows = parseCSV(await res.text())
  if (!rows.length) return {}

  const header = rows[0]
  const taskIdx = header.indexOf('task')
  const modelIdx = header.indexOf('Model')
  const scoreIdx = header.indexOf('best_score')
  if (taskIdx < 0 || modelIdx < 0 || scoreIdx < 0) return {}

  const results = {}
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const task = (row[taskIdx] || '').trim()
    const model = (row[modelIdx] || '').trim()
    const score = parseFloat(row[scoreIdx])
    if (!model || !Number.isFinite(score)) continue
    let field = null
    if (task === 'GPQA diamond') field = 'gpqa_score'
    else if (task === 'SWE-Bench verified') field = 'swe_bench_verified_score'
    if (!field) continue
    if (!results[model]) results[model] = {}
    if (results[model][field] == null || score > results[model][field]) {
      results[model][field] = score
    }
  }
  await saveCache('epoch', results)
  return results
}

const fetchTau2 = async (fresh, ttlMs) => {
  if (!fresh) {
    const cached = await loadCache('tau2', ttlMs)
    if (cached) return cached
  }
  const manifestRes = await fetch(URLS.tau2Manifest)
  if (!manifestRes.ok) throw new Error(`Tau2 manifest ${manifestRes.status}`)
  const manifest = await manifestRes.json()
  const allNames = [...(manifest.submissions || []), ...(manifest.legacy_submissions || [])]

  const results = {}
  for (let i = 0; i < allNames.length; i += 8) {
    const batch = allNames.slice(i, i + 8)
    await Promise.all(batch.map(async (name) => {
      try {
        const res = await fetch(`${URLS.tau2Base}/${name}/submission.json`)
        if (!res.ok) return
        const sub = await res.json()
        const modelName = sub.model_name
        const retail = sub.results?.retail?.pass_1
        if (modelName && retail != null) {
          const val = retail / 100
          const prev = results[modelName]?.tau_bench_retail_score
          if (prev == null || val > prev) {
            results[modelName] = { tau_bench_retail_score: val }
          }
        }
      } catch {}
    }))
  }
  await saveCache('tau2', results)
  return results
}

// --- Merge ---

const mergeSources = (models, epoch, tau2, nameIndex) => {
  const byId = new Map()
  for (const m of models) byId.set(m.model_id, m)

  const overlays = [
    { name: 'epoch', data: epoch, fields: ['gpqa_score', 'swe_bench_verified_score'] },
    { name: 'tau2', data: tau2, fields: ['tau_bench_retail_score'] }
  ]

  const stats = { overlaid: 0, unmatched: [] }
  for (const { name, data, fields } of overlays) {
    if (!data || !Object.keys(data).length) continue
    for (const [modelName, scores] of Object.entries(data)) {
      const modelId = matchModel(modelName, nameIndex)
      if (!modelId || !byId.has(modelId)) {
        stats.unmatched.push({ source: name, model: modelName })
        continue
      }
      const model = byId.get(modelId)
      for (const field of fields) {
        if (scores[field] != null) { model[field] = scores[field]; stats.overlaid++ }
      }
    }
  }
  return stats
}

// --- Scoring ---

const normalizeScore = (value, scale) => {
  if (value == null) return null
  return scale === '0-1' ? value * 100 : value
}

const computeScores = (model, benchmarks, weights) => {
  const available = {}
  let totalWeight = 0
  let coverage = 0

  for (const [field, cfg] of Object.entries(benchmarks)) {
    const normalized = normalizeScore(model[field], cfg.scale)
    if (normalized != null) {
      available[field] = normalized
      totalWeight += weights[field]
      coverage++
    }
  }
  if (!totalWeight) return null

  let overall = 0
  for (const [field, normalized] of Object.entries(available)) {
    overall += normalized * (weights[field] / totalWeight)
  }
  return { overall, available, coverage }
}

const computeGroupScores = (available, benchmarks) => {
  const groups = {}
  for (const [field, normalized] of Object.entries(available)) {
    const group = benchmarks[field].group
    if (!groups[group]) groups[group] = { sum: 0, count: 0 }
    groups[group].sum += normalized
    groups[group].count++
  }
  const result = {}
  for (const [group, { sum, count }] of Object.entries(groups)) {
    result[group] = count > 0 ? sum / count : null
  }
  return result
}

// --- Curated matching ---

const buildCuratedIndex = (curated) => {
  const index = new Map()
  for (const [key, entry] of catalogEntries(curated)) {
    if (entry.deprecated) continue
    const modelPart = key.split('/').slice(1).join('/')
    index.set(modelPart, key)
    if (entry.model) index.set(entry.model, key)
  }
  return index
}

const matchCurated = (zeroEvalId, curatedIndex) => {
  if (curatedIndex.has(zeroEvalId)) return curatedIndex.get(zeroEvalId)
  const stripped = zeroEvalId.replace(/-\d{8}$/, '')
  if (curatedIndex.has(stripped)) return curatedIndex.get(stripped)
  return null
}

// --- Public API ---

export const resolveWeights = (useCase, benchmarks, presets) => {
  const name = useCase === 'tool-loop' ? 'tool_loop' : useCase
  if (name === 'balanced') {
    return Object.fromEntries(
      Object.entries(benchmarks).map(([field, cfg]) => [field, cfg.weight])
    )
  }
  return presets[name] || null
}

/**
 * Fetch all benchmark sources.
 * Returns { models, sources, mergeStats } or throws.
 */
export const fetchBenchmarks = async ({ fresh = false, onStatus } = {}) => {
  const config = await loadConfig()
  const ttlMs = config.cacheTtlHours * 60 * 60 * 1000
  const log = onStatus || (() => {})

  const fetchSource = async (name, fn) => {
    try { return await fn(fresh, ttlMs) } catch (err) {
      log(`${name}: failed (${err.message})`)
      return null
    }
  }

  log('Fetching benchmark sources...')
  const [zeroEvalResult, epoch, tau2] = await Promise.all([
    fetchSource('ZeroEval', fetchZeroEval),
    fetchSource('Epoch AI', fetchEpoch),
    fetchSource('Tau2', fetchTau2)
  ])

  if (!zeroEvalResult) throw new Error('ZeroEval fetch failed — cannot rank without skeleton data')
  const models = zeroEvalResult.data
  const nameIndex = buildNameIndex(models)

  const sources = [`ZeroEval (${models.length})`]
  const epochCount = epoch ? Object.keys(epoch).length : 0
  const tau2Count = tau2 ? Object.keys(tau2).length : 0
  if (epochCount) sources.push(`Epoch AI (${epochCount})`)
  if (tau2Count) sources.push(`Tau2 (${tau2Count})`)

  const mergeStats = mergeSources(models, epoch, tau2, nameIndex)
  log(`Sources: ${sources.join(', ')}`)
  if (mergeStats.overlaid) log(`${mergeStats.overlaid} scores overlaid`)

  return { models, sources, mergeStats, config }
}

// Combined fetch + rank
export const rank = async ({ curated, useCase = 'balanced', top = 20, all = false, since, minContext, fresh = false, onStatus } = {}) => {
  const { models, sources, config } = await fetchBenchmarks({ fresh, onStatus })
  const { benchmarks, minCoverage, useCasePresets } = config

  const weights = resolveWeights(useCase, benchmarks, useCasePresets)
  if (!weights) throw new Error(`Unknown use-case: ${useCase}. Available: balanced, analysis, tool-loop, cowork`)

  const curatedIndex = !all && curated ? buildCuratedIndex(curated) : null
  const benchmarkCount = Object.keys(benchmarks).length

  // Filter
  let filtered = models
  if (curatedIndex) filtered = filtered.filter(m => matchCurated(m.model_id, curatedIndex))
  if (since) {
    const sinceDate = new Date(since + '-01')
    filtered = filtered.filter(m => m.release_date && new Date(m.release_date) >= sinceDate)
  }
  if (minContext) {
    filtered = filtered.filter(m => m.context && m.context >= minContext)
  }

  // Score
  const scored = []
  for (const model of filtered) {
    const result = computeScores(model, benchmarks, weights)
    if (!result || result.coverage < minCoverage) continue
    const groupScores = computeGroupScores(result.available, benchmarks)
    const outputPrice = model.output_price
    const value = (outputPrice != null && outputPrice > 0) ? result.overall / outputPrice : null

    scored.push({
      model: model.name,
      organization: model.organization,
      overall: result.overall,
      analysis: groupScores.analysis ?? null,
      tool_loop: groupScores.tool_loop ?? null,
      cowork: groupScores.cowork ?? null,
      output_price: outputPrice ?? null,
      value,
      coverage: `${result.coverage}/${benchmarkCount}`,
      scores: Object.fromEntries(
        Object.keys(benchmarks).map(field => [
          field.replace(/_score$/, ''),
          model[field] ?? null
        ])
      )
    })
  }

  scored.sort((a, b) => b.overall - a.overall)
  const rankings = scored.slice(0, top).map((r, i) => ({ rank: i + 1, ...r }))

  return {
    rankings,
    meta: {
      date: new Date().toISOString().split('T')[0],
      sources,
      benchmarkCount,
      useCase,
      totalModels: models.length,
      matchedModels: filtered.length,
      rankedModels: rankings.length
    }
  }
}
