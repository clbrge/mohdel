/**
 * mohdel session — provider executor.
 *
 * Public surface (0.90):
 *   - run(envelope): AsyncGenerator<Event>
 *   - adapters: { [provider]: adapter }
 *   - getAdapter(provider): adapter
 *   - drive(stdin, stdout): NDJSON stdio driver
 *
 * Usually invoked as a subprocess via `./bin.js`. Exports exist so
 * the pieces can also be embedded in tests or custom supervisors.
 *
 * @module session
 */

export { run } from './run.js'
export { adapters, getAdapter } from './adapters/index.js'
export { drive } from './driver.js'
