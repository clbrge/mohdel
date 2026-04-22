#!/usr/bin/env node
/**
 * Session process entrypoint. Invoked by thin-gate (or any supervisor)
 * as `node <path-to-this-file>`. Reads one CallEnvelope from stdin
 * and writes events to stdout; stderr is for structured logs.
 *
 * At startup:
 *   - Lazy-initializes OTel SDK when `OTEL_EXPORTER_OTLP_ENDPOINT`
 *     is set (exports spans to the configured collector).
 *   - Constructs the default logger from `MOHDEL_LOG_LEVEL` /
 *     `MOHDEL_VERBOSITY` (see LOGGING.md).
 *
 * `run.js` reads `logger` as a module-level import — `bin.js` does
 * not need to thread it through.
 *
 * @module session/bin
 */

import { drive } from './driver.js'
import { ensureOtelInitialized } from './_tracing.js'
import { logger } from './_logger.js'
import { initCatalogFromDefault } from './adapters/_catalog.js'
import { initProvidersFromDefault } from './adapters/_providers.js'

async function main () {
  await ensureOtelInitialized()

  // `MOHDEL_NO_CONFIG_DISK=1` tells the session that a supervisor is
  // responsible for pushing config over stdin (`op: set_catalog`,
  // future `op: set_providers`). Skip the eager disk init in that
  // case — the catalog cache stays empty until the first injection
  // lands. Standalone use (CLI, tests) leaves the variable unset and
  // the cache warms from `~/.config/mohdel/` as before.
  const noDisk = process.env.MOHDEL_NO_CONFIG_DISK === '1'
  if (!noDisk) {
    await Promise.all([initCatalogFromDefault(), initProvidersFromDefault()])
  }

  logger.info(
    {
      level: logger.level,
      verbosity: logger.verbosity,
      pid: process.pid,
      configFrom: noDisk ? 'supervisor' : 'disk'
    },
    '[mohdel:session] starting'
  )
  await drive(process.stdin, process.stdout)
}

main().catch((e) => {
  logger.fatal({ err: e }, '[mohdel:session] fatal')
  process.exit(1)
})
