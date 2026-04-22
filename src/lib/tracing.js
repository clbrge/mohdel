import { trace, context, SpanStatusCode } from '@opentelemetry/api'

// Lazy: defer getTracer until first use so the host app can register its TracerProvider first.
let tracer
const getTracer = () => (tracer ??= trace.getTracer('mohdel'))

export const startSpan = (name, attributes, parentSpan) => {
  const parentCtx = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : undefined
  return getTracer().startSpan(name, { attributes }, parentCtx)
}

export const endSpanOk = (span, attributes) => {
  if (attributes) span.setAttributes(attributes)
  span.setStatus({ code: SpanStatusCode.OK })
  span.end()
}

export const endSpanError = (span, err) => {
  span.recordException(err)
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
  span.end()
}

// W3C Trace Context — https://www.w3.org/TR/trace-context/#traceparent-header
// Format: 00-<traceId>-<spanId>-<traceFlags> (lowercase hex). Used by the unix-socket
// sidecar so trace context can cross the process boundary as a header instead of trying
// to serialize a live span object (which has circular OTel internals).
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const INVALID_TRACE_ID = '00000000000000000000000000000000'
const INVALID_SPAN_ID = '0000000000000000'

/**
 * Parse a W3C `traceparent` header into an OTel SpanContext.
 * Returns null if the header is missing, malformed, or contains invalid all-zero IDs.
 */
export const parseTraceparent = (header) => {
  if (!header || typeof header !== 'string') return null
  const m = header.match(TRACEPARENT_RE)
  if (!m) return null
  const [, traceId, spanId, flags] = m
  if (traceId === INVALID_TRACE_ID) return null
  if (spanId === INVALID_SPAN_ID) return null
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true
  }
}

/**
 * Build a non-recording span from a `traceparent` header so the caller can use it
 * as a `parentSpan` in `startSpan(name, attrs, parentSpan)`. Returns null if the
 * header is missing/invalid.
 */
export const remoteParentFromTraceparent = (header) => {
  const spanContext = parseTraceparent(header)
  if (!spanContext) return null
  return trace.wrapSpanContext(spanContext)
}
