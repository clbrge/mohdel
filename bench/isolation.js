#!/usr/bin/env node
/**
 * Crash-isolation benchmark.
 *
 * Demonstrates the gate's actual advantage — which `bench/bench.js`
 * can't show because throughput isn't what the gate is for. An
 * adapter that calls `process.exit(1)` kills whichever process is
 * running the adapter. In-process, that's the caller (your server).
 * Via the gate, that's one session subprocess; the gate respawns it
 * and the caller continues.
 *
 * The `fake` adapter's `mode: "crash"` is a controlled way to
 * exercise this: the rules of Node mean you can't just "catch" a
 * `process.exit`. Either your caller is the one running the crash,
 * or somebody else is.
 *
 * Run: `node bench/isolation.js`
 *
 * ## Observed behavior
 *
 *   - **In-process caller:** imports `run()` directly, crashes on
 *     the envelope, exit code 1, no recovery possible.
 *   - **Via-gate caller:** POST #1 completes cleanly → POST #2
 *     returns `error type=SESSION_DIED` → POST #3 (after respawn)
 *     completes cleanly. Gate stays up throughout.
 *
 * The gate's value proposition (none of which per-call throughput
 * can measure):
 *   - **Fault isolation** — adapter crash stays in the session
 *     subprocess; caller continues.
 *   - **Cross-language callers** — HTTP + unix socket works from
 *     Python, Go, curl; in-process is Node-only.
 *   - **Cross-process pool sharing** — N caller processes share one
 *     pool (vs N × pool_size sessions with in-process).
 *   - **Multi-tenant correctness** — single enforcer state across
 *     all callers; in-process, each caller has its own private quota
 *     view.
 *   - **Sandboxing** — Landlock / seccomp can lock down the session
 *     process without constraining the caller.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const NORMAL_PROMPT = JSON.stringify({ mode: 'volume', tokens: 5 })
const CRASH_PROMPT = JSON.stringify({ mode: 'crash' })

function envelope (n, prompt) {
  return {
    callId: `iso-${n}`,
    authId: `iso-${n}`, // unique per call to bypass default quota
    auth: { key: 'x' },
    provider: 'fake',
    model: 'm',
    prompt
  }
}

// ---------- Scenario A: in-process ----------
//
// Fork a child node process whose entire job is to call `run()` with
// a crash envelope. Watch it die. Exit code + absence of subsequent
// output is the evidence.

async function inProcessCrash () {
  console.log('─── scenario A: in-process ───────────────────────────────')
  console.log('Caller imports `run()` directly. Adapter crash means the')
  console.log('caller process dies — no recovery possible.\n')

  const script = `
import { run } from '${path.join(ROOT, 'js/session/run.js')}';
const env = {
  callId: 'iso-inp-1', authId: 'iso-inp-1', auth: { key: 'x' },
  provider: 'fake', model: 'm',
  prompt: ${JSON.stringify(CRASH_PROMPT)}
};
// First, prove we're alive.
console.log('[caller] starting, about to consume crash envelope');
try {
  for await (const ev of run(env)) {
    console.log('[caller] got event:', ev.type);
  }
  console.log('[caller] run() returned cleanly — this line should NEVER print');
} catch (e) {
  console.log('[caller] caught error:', e.message);
}
console.log('[caller] continuing after crash — this line should NEVER print');
`

  const started = Date.now()
  const child = spawn('node', ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => { stdout += c.toString() })
  child.stderr.on('data', (c) => { stderr += c.toString() })

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code))
  })
  const wallMs = Date.now() - started

  // Print child output with indentation.
  const prefix = '    │ '
  process.stdout.write(prefix + stdout.trimEnd().replace(/\n/g, '\n' + prefix) + '\n')
  if (stderr.trim()) {
    process.stdout.write(prefix + '(stderr) ' + stderr.trimEnd().replace(/\n/g, '\n' + prefix + '(stderr) ') + '\n')
  }
  console.log()
  console.log(`    child exit code:     ${exitCode ?? 'signal'}`)
  console.log(`    wall time to death:  ${wallMs}ms`)
  const postCrashObserved = stdout.includes('this line should NEVER print')
  console.log(`    post-crash output:   ${postCrashObserved ? 'YES (bug!)' : 'no — caller dead'}`)
  console.log()
  return { exitCode, postCrashObserved }
}

// ---------- Scenario B: via gate ----------
//
// Start the release gate + pool of 2 sessions. Same caller script
// now speaks HTTP instead of importing run(). Crash envelope still
// kills *a* process — but it's the session, not the caller.

async function viaGateCrash () {
  console.log('─── scenario B: via thin-gate ────────────────────────────')
  console.log('Caller speaks HTTP to the gate. Adapter crash kills one')
  console.log('session; the gate respawns it and subsequent calls work.\n')

  const binary = path.join(ROOT, 'target/release/mohdel-thin-gate')
  if (!fs.existsSync(binary)) {
    throw new Error(`release binary missing: ${binary}. Run: cargo build --release`)
  }
  const dataSock = `/tmp/mohdel-iso-${process.pid}.sock`
  const adminSock = `/tmp/mohdel-iso-admin-${process.pid}.sock`
  const sessionBin = path.join(ROOT, 'js/session/bin.js')
  try { fs.unlinkSync(dataSock) } catch {}
  try { fs.unlinkSync(adminSock) } catch {}

  const gate = spawn(binary, [dataSock, adminSock, sessionBin], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MOHDEL_LOG_LEVEL: 'warn', MOHDEL_SESSION_POOL_SIZE: '2' }
  })
  let gateStderr = ''
  gate.stderr.on('data', (c) => { gateStderr += c.toString() })

  try {
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(dataSock)) {
      if (Date.now() > deadline) throw new Error('gate never bound')
      await sleep(20)
    }
    await sleep(400) // pool readiness settling

    const events = async (env) => {
      return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(env))
        const req = http.request({
          socketPath: dataSock,
          method: 'POST',
          path: '/v1/call',
          headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            host: 'unix'
          }
        }, (res) => {
          let buf = ''
          const out = []
          res.on('data', (c) => {
            buf += c.toString()
            let i
            while ((i = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, i).trim()
              buf = buf.slice(i + 1)
              if (line) out.push(JSON.parse(line))
            }
          })
          res.on('end', () => resolve({ status: res.statusCode, events: out }))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.write(body); req.end()
      })
    }

    console.log('[caller] POST #1 (normal) ...')
    const r1 = await events(envelope(1, NORMAL_PROMPT))
    const term1 = r1.events.at(-1)
    console.log(`[caller]   → terminal: ${term1?.type}${term1?.result ? ` status=${term1.result.status}` : ''}${term1?.error ? ` type=${term1.error.type}` : ''}`)

    console.log('[caller] POST #2 (crash envelope) ...')
    const started = Date.now()
    const r2 = await events(envelope(2, CRASH_PROMPT))
    const crashMs = Date.now() - started
    const term2 = r2.events.at(-1)
    console.log(`[caller]   → terminal: ${term2?.type}${term2?.error ? ` type=${term2.error.type}` : ''}`)
    console.log(`[caller]   (wall: ${crashMs}ms — includes read of SESSION_DIED)`)

    // Wait a beat so the respawn+readiness completes.
    await sleep(500)

    console.log('[caller] POST #3 (normal, after crash) ...')
    const r3 = await events(envelope(3, NORMAL_PROMPT))
    const term3 = r3.events.at(-1)
    console.log(`[caller]   → terminal: ${term3?.type}${term3?.result ? ` status=${term3.result.status}` : ''}`)

    // Also verify the gate is still alive.
    const gateAlive = gate.exitCode === null

    console.log()
    console.log(`    gate still running:           ${gateAlive ? 'yes' : 'NO (bug!)'}`)
    console.log(`    crash envelope terminal:      ${term2?.type === 'error' && term2.error.type === 'SESSION_DIED' ? 'SESSION_DIED ✓' : 'unexpected'}`)
    console.log(`    post-crash call succeeded:    ${term3?.type === 'done' && term3.result.status === 'completed' ? 'yes ✓' : 'no'}`)
    console.log()

    if (gateStderr.trim()) {
      console.log('    gate stderr during run (expected — session death + respawn):')
      const lines = gateStderr.trim().split('\n').slice(0, 10)
      for (const l of lines) console.log(`      │ ${l}`)
      if (gateStderr.trim().split('\n').length > 10) console.log('      │ ...')
      console.log()
    }

    return {
      gateAlive,
      crashHandled: term2?.type === 'error' && term2.error.type === 'SESSION_DIED',
      recovered: term3?.type === 'done' && term3.result.status === 'completed'
    }
  } finally {
    gate.kill()
    await sleep(100)
    try { fs.unlinkSync(dataSock) } catch {}
    try { fs.unlinkSync(adminSock) } catch {}
  }
}

// ---------- Resource sharing (qualitative) ----------
//
// Not a benchmark with numbers — a structural statement. N caller
// processes × in-process = N full Node heaps each with its own pool.
// N caller processes × via-gate = 1 gate + K shared sessions, and
// callers can be any language (python/go/curl) because the gate
// speaks HTTP.

function resourceSharingNote () {
  console.log('─── note: resource sharing across callers ───────────────')
  console.log('This benchmark runs a single caller. The gate advantage')
  console.log('compounds with multi-caller deployments:')
  console.log()
  console.log('  • in-process:   N callers × (Node heap + adapter SDKs + pool)')
  console.log('  • via-gate:     N lightweight HTTP clients + 1 shared pool')
  console.log()
  console.log('  Non-Node callers (Python, Go, curl) can use the gate too —')
  console.log('  they speak HTTP over the unix socket. In-process is only')
  console.log('  reachable from Node.')
  console.log()
}

// ---------- Main ----------

async function main () {
  console.log('mohdel 0.90 crash-isolation benchmark')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  const a = await inProcessCrash()
  const b = await viaGateCrash()
  resourceSharingNote()

  console.log('─── summary ──────────────────────────────────────────────')
  console.log()
  console.log(`  in-process caller survived:   ${a.exitCode === 0 ? 'yes' : 'NO — killed by adapter'}`)
  console.log(`  via-gate caller survived:     ${b.gateAlive && b.recovered ? 'yes' : 'no'}`)
  console.log(`  via-gate crash contained:     ${b.crashHandled ? 'yes — SESSION_DIED error' : 'no'}`)
  console.log(`  via-gate follow-up call:      ${b.recovered ? 'succeeded after respawn' : 'failed'}`)
  console.log()
  if (a.exitCode !== 0 && b.gateAlive && b.recovered) {
    console.log('  → The gate contained a fatal adapter crash that would')
    console.log('    have taken down the caller running in-process.')
  }
}

main().catch((e) => {
  console.error(`isolation bench failed: ${e.stack || e.message}`)
  process.exit(1)
})
