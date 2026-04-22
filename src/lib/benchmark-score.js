import fs from 'node:fs/promises'
import path from 'node:path'
import * as truth from './benchmark-truth.js'

export { truth }

export const loadPrompt = async (promptPath) => {
  const absolutePath = path.resolve(promptPath)
  return fs.readFile(absolutePath, 'utf8')
}

export const findCandidateJson = (raw) => {
  if (typeof raw !== 'string') return { candidate: null, extraneous: false }
  const trimmed = raw.trim()
  const fence = /```json\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence && fence[1]) {
    const candidate = fence[1].trim()
    return { candidate, extraneous: trimmed !== fence[0].trim() }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = trimmed.slice(start, end + 1).trim()
    return { candidate, extraneous: trimmed !== candidate }
  }
  return { candidate: trimmed, extraneous: false }
}

export const parseJson = (raw) => {
  const { candidate, extraneous } = findCandidateJson(raw)
  if (!candidate) {
    return { ok: false, error: 'no-json-found', extraneous }
  }
  try {
    return { ok: true, value: JSON.parse(candidate), extraneous }
  } catch (err) {
    return { ok: false, error: err.message, extraneous }
  }
}

export const getPath = (object, pathValue) => {
  return pathValue.split('.').reduce((acc, key) => (acc && key in acc ? acc[key] : undefined), object)
}

// --- Correctness scoring ---

export const arrayContains = (arr, keyword) => {
  if (!Array.isArray(arr) || arr.length === 0) return false
  const text = arr.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n').toLowerCase()
  return keyword.toLowerCase().split('|').some(k => text.includes(k))
}

export const scoreEntities = (data) => {
  const hits = { people: [], organizations: [], locations: [] }
  const misses = { people: [], organizations: [], locations: [] }

  for (const name of truth.people) {
    ;(arrayContains(data?.entities?.people, name) ? hits : misses).people.push(name)
  }
  for (const org of truth.organizations) {
    ;(arrayContains(data?.entities?.organizations, org) ? hits : misses).organizations.push(org)
  }
  for (const loc of truth.locations) {
    ;(arrayContains(data?.entities?.locations, loc) ? hits : misses).locations.push(loc)
  }

  const total = truth.people.length + truth.organizations.length + truth.locations.length
  const hitCount = hits.people.length + hits.organizations.length + hits.locations.length
  return { score: hitCount / total, hits, misses }
}

export const scoreMetrics = (data) => {
  const section = JSON.stringify(data?.metrics_and_numbers || []).toLowerCase()
  const hits = []
  const misses = []

  for (const metric of truth.metrics) {
    ;(section.includes(metric.match.toLowerCase()) ? hits : misses).push(metric.label)
  }

  return { score: hits.length / truth.metrics.length, hits, misses }
}

export const scoreContradictions = (data) => {
  const section = JSON.stringify(data?.contradictions || []).toLowerCase()
  const hits = []
  const misses = []

  for (const c of truth.contradictions) {
    const found = c.match.some(m => section.includes(m.toLowerCase()))
    ;(found ? hits : misses).push(c.label)
  }

  return { score: hits.length / truth.contradictions.length, hits, misses }
}

export const scoreEnums = (data) => {
  let valid = 0
  let total = 0
  const issues = []

  for (const [pathValue, allowed] of Object.entries(truth.enums)) {
    total++
    const value = getPath(data, pathValue)
    if (typeof value === 'string' && allowed.includes(value.toLowerCase())) {
      valid++
    } else {
      issues.push({ path: pathValue, value: value ?? null, allowed })
    }
  }

  return { score: total > 0 ? valid / total : 0, issues }
}

export const scoreAdherence = (parsed) => {
  let score = 0
  const checks = []

  if (parsed.ok) {
    score += 0.5
    checks.push({ check: 'json-valid', pass: true })
  } else {
    checks.push({ check: 'json-valid', pass: false })
  }

  if (!parsed.extraneous) {
    score += 0.2
    checks.push({ check: 'no-extraneous', pass: true })
  } else {
    checks.push({ check: 'no-extraneous', pass: false })
  }

  if (parsed.ok) {
    const present = truth.requiredKeys.filter(k => k in parsed.value)
    const keyScore = present.length / truth.requiredKeys.length
    score += 0.3 * keyScore
    checks.push({ check: 'schema-keys', pass: present.length === truth.requiredKeys.length, present: present.length, total: truth.requiredKeys.length })
  }

  return { score: Math.min(1, score), checks }
}

export const scoreCorrectness = (parsed) => {
  const adherence = scoreAdherence(parsed)

  if (!parsed.ok) {
    const zero = { entities: 0, metrics: 0, contradictions: 0, enums: 0, adherence: adherence.score }
    const correctness = Object.entries(truth.weights).reduce((sum, [k, w]) => sum + (zero[k] || 0) * w, 0)
    return { correctness, breakdown: zero, details: { adherence } }
  }

  const data = parsed.value
  const entities = scoreEntities(data)
  const metrics = scoreMetrics(data)
  const contradictions = scoreContradictions(data)
  const enums = scoreEnums(data)

  const breakdown = {
    entities: entities.score,
    metrics: metrics.score,
    contradictions: contradictions.score,
    enums: enums.score,
    adherence: adherence.score
  }

  const correctness = Object.entries(truth.weights).reduce((sum, [k, w]) => sum + (breakdown[k] || 0) * w, 0)

  return { correctness, breakdown, details: { entities, metrics, contradictions, enums, adherence } }
}

// --- Pricing ---

export const computeCost = (tokens, pricing) => {
  if (!pricing) return null
  const input = (tokens.input || 0) / 1_000_000 * pricing.input
  const output = (tokens.output || 0) / 1_000_000 * pricing.output
  const thinking = (tokens.thinking || 0) / 1_000_000 * (pricing.thinking || 0)
  return input + output + thinking
}

// --- Timing helpers ---

export const formatNumber = (value) => Number.isFinite(value) ? Number(value.toFixed(3)) : null

export const computeTiming = (timestamps = {}) => {
  const toNs = (value) => {
    if (value == null) return null
    if (typeof value === 'bigint') return value
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
    if (Number.isFinite(value)) return BigInt(Math.round(value * 1_000_000))
    return null
  }

  const startNs = toNs(timestamps.start)
  const firstNs = toNs(timestamps.first)
  const endNs = toNs(timestamps.end)

  const toMs = (ns) => ns === null ? null : Number(ns) / 1_000_000

  const start = toMs(startNs)
  const first = toMs(firstNs)
  const end = toMs(endNs)

  const latencyMs = (start !== null && first !== null && first >= start)
    ? first - start
    : null
  const totalTimeMs = (start !== null && end !== null && end >= start)
    ? end - start
    : null
  const generationMs = (first !== null && end !== null && end >= first)
    ? end - first
    : null

  return { start, first, end, latencyMs, generationMs, totalTimeMs }
}
