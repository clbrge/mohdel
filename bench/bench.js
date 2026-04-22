#!/usr/bin/env node
/**
 * Benchmark: in-process `run()` vs via thin-gate over a unix
 * socket. Uses the `fake` adapter with `mode: "volume"` so adapter
 * work is fixed and deterministic — what's measured is everything
 * *except* a real provider (HTTP framing, NDJSON serialization,
 * subprocess IPC, gate overhead).
 *
 * Usage:
 *   node bench/bench.js [--calls N] [--concurrency K] [--tokens T]
 *
 * Env:
 *   MOHDEL_BENCH_SKIP_GATE=1   — only run the in-process bench
 *
 * ## Baseline results
 *
 * 500 calls, concurrency 8, pool=2, release build:
 *
 * | workload          | in-process p50 | via-gate p50 | overhead  | throughput retained |
 * |-------------------|----------------|--------------|-----------|---------------------|
 * | volume=50         | 0.55 ms        | 3.35 ms      | +2.80 ms  | 17.8%               |
 * | volume=500        | 1.99 ms        | 9.44 ms      | +7.42 ms  | 19.0%               |
 * | volume=50 pool=8  | 0.55 ms        | 3.50 ms      | +2.94 ms  | 17.1%               |
 *
 * Takeaways:
 *   - Gate overhead is ~3 ms baseline + roughly linear with emitted
 *     tokens (NDJSON framing per delta). Real LLM calls take
 *     100–1000 ms, so +3 ms is <1% of wall time — gate overhead is
 *     negligible for production workloads.
 *   - Bigger pool doesn't help (pool=2 and pool=8 hit the same rate).
 *     The bottleneck is per-call transport cost, not session
 *     concurrency.
 *   - In-process path sustains ~12k calls/sec with fake work —
 *     `run()` itself is not a bottleneck.
 *   - Porting SSE / JSON parsers to Rust via napi-rs wouldn't
 *     meaningfully change either number; the dominant cost is IPC +
 *     framing, not parsing.
 *
 * This benchmark measures raw per-call throughput. The gate's actual
 * value is qualitative (isolation, multi-tenancy, cross-language
 * callers) — see `bench/isolation.js`.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

import { run } from '../js/session/run.js'

const ROOT = path.resolve(import.meta.dirname, '..')

// ---------- CLI ----------

const args = process.argv.slice(2)
function flag (name, fallback) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}

const CALLS = flag('calls', 500)
const CONCURRENCY = flag('concurrency', 8)
const TOKENS = flag('tokens', 50)
const WARMUP = Math.max(10, Math.floor(CALLS / 20))

// ---------- Envelope + event loop ----------

function envelope (n) {
  return {
    callId: `bench-${n}`,
    // Unique authId per call so the gate's default FileQuotaPolicy
    // (rpm=60) doesn't shape the measurement. The quota enforcer
    // has its own tests; this bench isolates gate transport cost.
    authId: `bench-${n}`,
    auth: { key: 'x' },
    provider: 'fake',
    model: 'm',
    prompt: JSON.stringify({ mode: 'volume', tokens: TOKENS })
  }
}

async function consumeInProcess (env) {
  let deltas = 0
  let result = null
  for await (const ev of run(env)) {
    if (ev.type === 'delta') deltas++
    else if (ev.type === 'done') result = ev.result
    else if (ev.type === 'error') throw new Error(`adapter error: ${ev.error.message}`)
  }
  return { deltas, result }
}

async function consumeViaGate (env, socketPath) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(env))
    const req = http.request({
      socketPath,
      method: 'POST',
      path: '/v1/call',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        host: 'unix'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      let buffer = ''
      let deltas = 0
      let result = null
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          try {
            const ev = JSON.parse(line)
            if (ev.type === 'delta') deltas++
            else if (ev.type === 'done') result = ev.result
            else if (ev.type === 'error') return reject(new Error(`adapter: ${ev.error.message}`))
          } catch (e) {
            return reject(new Error(`parse: ${e.message}`))
          }
        }
      })
      res.on('end', () => resolve({ deltas, result }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------- Runner ----------

function percentile (sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

async function timed (fn) {
  const start = process.hrtime.bigint()
  await fn()
  return Number(process.hrtime.bigint() - start) / 1e6
}

async function runBench (label, consume) {
  // Warmup — results discarded.
  for (let i = 0; i < WARMUP; i++) await consume(envelope(-1 - i))

  const latencies = []
  let next = 0
  let completed = 0
  const t0 = process.hrtime.bigint()

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const n = next++
      if (n >= CALLS) return
      const ms = await timed(() => consume(envelope(n)))
      latencies.push(ms)
      completed++
    }
  }))

  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6
  latencies.sort((a, b) => a - b)
  const p50 = percentile(latencies, 0.50)
  const p95 = percentile(latencies, 0.95)
  const p99 = percentile(latencies, 0.99)
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length

  return {
    label,
    calls: completed,
    wallMs,
    callsPerSec: completed / (wallMs / 1000),
    p50,
    p95,
    p99,
    mean
  }
}

function report (row) {
  const r = (n) => n.toFixed(2).padStart(8)
  console.log(
    `  ${row.label.padEnd(16)}  ` +
    `calls=${r(row.calls)}  ` +
    `wall=${r(row.wallMs)}ms  ` +
    `rate=${r(row.callsPerSec)}/s  ` +
    `p50=${r(row.p50)}ms  p95=${r(row.p95)}ms  p99=${r(row.p99)}ms`
  )
}

// ---------- Gate supervisor ----------

async function withGate (fn) {
  // Workspace build puts the binary under the top-level target/,
  // not under rust/thin-gate/target/.
  const binary = path.join(ROOT, 'target/release/mohdel-thin-gate')
  if (!fs.existsSync(binary)) {
    throw new Error(`thin-gate release binary missing at ${binary}; run cargo build --release`)
  }
  const dataSock = `/tmp/mohdel-bench-${process.pid}.sock`
  const adminSock = `/tmp/mohdel-bench-admin-${process.pid}.sock`
  const sessionBin = path.join(ROOT, 'js/session/bin.js')

  // Remove stale sockets if present.
  for (const p of [dataSock, adminSock]) {
    try { fs.unlinkSync(p) } catch {}
  }

  const gate = spawn(binary, [dataSock, adminSock, sessionBin], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, MOHDEL_LOG_LEVEL: 'warn' }
  })

  // Wait for the data socket to appear.
  const deadline = Date.now() + 5_000
  while (!fs.existsSync(dataSock)) {
    if (Date.now() > deadline) {
      gate.kill()
      throw new Error('gate failed to bind data socket within 5s')
    }
    await sleep(20)
  }
  // Give the pool a beat to finish readiness pings.
  await sleep(300)

  try {
    return await fn(dataSock)
  } finally {
    gate.kill()
    // Let stderr drain + socket cleanup.
    await sleep(50)
    for (const p of [dataSock, adminSock]) {
      try { fs.unlinkSync(p) } catch {}
    }
  }
}

// ---------- Main ----------

async function main () {
  console.log('mohdel 0.90 benchmark')
  console.log(`  calls=${CALLS}  concurrency=${CONCURRENCY}  tokens/call=${TOKENS}  warmup=${WARMUP}`)
  console.log()

  const inProc = await runBench('in-process', consumeInProcess)
  report(inProc)

  if (process.env.MOHDEL_BENCH_SKIP_GATE) {
    console.log('\n(skipping gate bench — MOHDEL_BENCH_SKIP_GATE set)')
    return
  }

  let viaGate
  try {
    viaGate = await withGate(async (sock) => {
      return runBench('via-gate', (env) => consumeViaGate(env, sock))
    })
  } catch (e) {
    console.log(`\n(gate bench skipped: ${e.message})`)
    return
  }
  report(viaGate)

  console.log()
  const overheadMs = viaGate.p50 - inProc.p50
  const overheadPct = (viaGate.p50 / inProc.p50 - 1) * 100
  const throughputRatio = viaGate.callsPerSec / inProc.callsPerSec
  console.log(`gate overhead (p50):  +${overheadMs.toFixed(2)}ms  (+${overheadPct.toFixed(1)}%)`)
  console.log(`throughput retained:  ${(throughputRatio * 100).toFixed(1)}% of in-process`)
}

main().catch((e) => {
  console.error(`bench failed: ${e.stack || e.message}`)
  process.exit(1)
})
