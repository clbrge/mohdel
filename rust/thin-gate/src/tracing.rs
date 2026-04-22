//! OTel trace helpers — parse W3C `traceparent` strings and build a
//! `Context` rooted at the remote parent span. Thin-gate itself does
//! not register a `TracerProvider`; it relies on the embedder or the
//! host process to set one globally before the first request. When
//! no provider is registered, `global::tracer` returns a no-op, spans
//! cost near-zero, and these helpers degrade cleanly.

use opentelemetry::trace::{
    SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
};
use opentelemetry::Context;

/// Parse a W3C `traceparent` string into a remote `SpanContext`.
pub fn parse_traceparent(tp: &str) -> Option<SpanContext> {
    let parts: Vec<&str> = tp.split('-').collect();
    if parts.len() != 4 || parts[0] != "00" {
        return None;
    }
    let trace_id = TraceId::from_hex(parts[1]).ok()?;
    let span_id = SpanId::from_hex(parts[2]).ok()?;
    if trace_id == TraceId::INVALID || span_id == SpanId::INVALID {
        return None;
    }
    let flags = u8::from_str_radix(parts[3], 16).ok()?;
    Some(SpanContext::new(
        trace_id,
        span_id,
        TraceFlags::new(flags),
        true, // is_remote
        TraceState::default(),
    ))
}

/// Build a `Context` rooted at the `traceparent` string, or fall back
/// to the current active context when the input is absent / malformed.
pub fn parent_context(traceparent: Option<&str>) -> Context {
    match traceparent.and_then(parse_traceparent) {
        Some(sc) => Context::current().with_remote_span_context(sc),
        None => Context::current(),
    }
}
