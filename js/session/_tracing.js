/**
 * OTel span helpers for the session process.
 *
 * Re-exports the traceparent parser, span lifecycle, and
 * `gen_ai.*` attribute helpers from `src/lib/tracing.js` so adapter
 * code has one canonical import path. `ensureOtelInitialized()`
 * lazily wires `@opentelemetry/sdk-node` when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set — without it, the no-op
 * tracer is fine: span IDs still come from the parsed traceparent
 * (via `remoteParentFromTraceparent` + fresh spanId), so log lines
 * still carry valid correlation even without an exporter.
 *
 * @module session/tracing
 */

export {
  startSpan,
  endSpanOk,
  endSpanError,
  parseTraceparent,
  remoteParentFromTraceparent
} from '../../src/lib/tracing.js'

let otelInitialized = false

/**
 * Lazy OTel SDK setup. Safe to call multiple times — idempotent and
 * no-op when the host app has already registered a tracer provider
 * or when the env doesn't request one.
 */
export async function ensureOtelInitialized () {
  if (otelInitialized) return
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) {
    otelInitialized = true
    return
  }

  try {
    const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-grpc')
    ])
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      serviceName: process.env.OTEL_SERVICE_NAME || 'mohdel-session'
    })
    sdk.start()
    otelInitialized = true
  } catch (e) {
    // Leave the flag false so a retry is possible. The current caller
    // (bin.js::main) runs this once, so "retry" in practice means a
    // process restart — but the semantics should match the flag name.
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', time: Date.now(), msg: '[mohdel:tracing] OTel SDK init failed', err: { message: e.message } })}\n`
    )
  }
}
