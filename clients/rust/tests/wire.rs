mod common;

use std::collections::HashMap;

use mohdel_client::wire::{self, Body, ChunkState, Framer, Head, WireError};
use mohdel_protocol::{Event, Status, TypedError};

fn run(bytes: &[u8], slice: usize) -> (Head, Vec<String>) {
    let mut buf = Vec::new();
    let mut pos = 0;
    let (head, consumed) = loop {
        if let Some(found) = wire::parse_head(&buf).unwrap() {
            break found;
        }
        let n = slice.min(bytes.len() - pos);
        assert!(n > 0, "head never completed");
        buf.extend_from_slice(&bytes[pos..pos + n]);
        pos += n;
    };
    let mut rest = buf.split_off(consumed);
    let mut body = Body::from_head(&head);
    let mut framer = Framer::new();
    let mut lines = Vec::new();
    let mut data = Vec::new();
    loop {
        body.feed(&rest, &mut data).unwrap();
        lines.extend(framer.feed(&data).unwrap());
        data.clear();
        if pos >= bytes.len() {
            break;
        }
        let n = slice.min(bytes.len() - pos);
        rest = bytes[pos..pos + n].to_vec();
        pos += n;
    }
    if let Some(tail) = framer.finish().unwrap() {
        lines.push(tail);
    }
    (head, lines)
}

#[test]
fn request_bytes() {
    assert_eq!(
        wire::request("POST", "/v1/call", Some(b"{\"a\":1}")),
        b"POST /v1/call HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}".to_vec()
    );
    assert_eq!(
        wire::request("GET", "/v1/health", None),
        b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".to_vec()
    );
}

#[test]
fn stream_fixture_at_every_slice_size() {
    for slice in [1, 7, 4096] {
        let (head, lines) = run(&common::fixture("call-200-stream.raw"), slice);
        assert_eq!(head.status, 200);
        assert_eq!(head.headers["content-type"], "application/x-ndjson");
        assert_eq!(head.headers["transfer-encoding"], "chunked");
        assert_eq!(lines.len(), 5, "slice {slice}");
        let events: Vec<Event> = lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert!(matches!(&events[0], Event::Delta { delta } if delta.delta == "The"));
        let Event::Done { result } = &events[4] else { panic!("last event is not done") };
        assert_eq!(result.output.as_deref(), Some("The sky is blue"));
        assert_eq!(result.status, Status::Incomplete);
        assert_eq!(result.warning.as_deref(), Some("insufficientOutputBudget"));
        assert_eq!(result.input_tokens, 11);
        assert_eq!(result.cost, 0.0);
    }
}

#[test]
fn error_event_fixture() {
    let (head, lines) = run(&common::fixture("call-200-error-event.raw"), 3);
    assert_eq!(head.status, 200);
    assert_eq!(lines.len(), 1);
    let Event::Error { error } = serde_json::from_str(&lines[0]).unwrap() else { panic!() };
    assert_eq!(error.kind.as_deref(), Some("SESSION_UNKNOWN_MODEL"));
    assert!(!error.retryable);
}

#[test]
fn rejection_fixture() {
    let (head, lines) = run(&common::fixture("call-400-invalid-envelope.raw"), 11);
    assert_eq!(head.status, 400);
    assert_eq!(head.headers["content-length"], "439");
    let error: TypedError = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(error.kind.as_deref(), Some("PROTOCOL_INVALID_ENVELOPE"));
}

#[test]
fn health_fixture() {
    let (head, lines) = run(&common::fixture("health-200.raw"), 9);
    assert_eq!(head.status, 200);
    let health: mohdel_client::Health = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(health.status, "ok");
}

#[test]
fn sized_zero_body_is_done() {
    let mut body = Body::Sized { remaining: 0 };
    let mut out = Vec::new();
    assert!(body.feed(b"", &mut out).unwrap());
    assert!(out.is_empty());
}

#[test]
fn chunk_extension_and_trailer() {
    let mut body = Body::Chunked { buf: Vec::new(), state: ChunkState::Size };
    let mut out = Vec::new();
    let done = body.feed(b"5;ext=1\r\nhello\r\n0\r\nX-Trailer: 1\r\n\r\n", &mut out).unwrap();
    assert!(done);
    assert_eq!(out, b"hello");
    assert!(body.may_end_with_close());
}

#[test]
fn malformed_chunk_terminator() {
    let mut body = Body::Chunked { buf: Vec::new(), state: ChunkState::Size };
    let mut out = Vec::new();
    assert_eq!(
        body.feed(b"5\r\nhelloXX", &mut out),
        Err(WireError::Malformed("malformed chunk terminator".into()))
    );
}

#[test]
fn framer_skips_blank_lines_and_keeps_tail() {
    let mut framer = Framer::new();
    assert_eq!(framer.feed(b"\n{\"a\":1}\n\n{\"b\":2}").unwrap(), vec!["{\"a\":1}".to_string()]);
    assert_eq!(framer.finish().unwrap(), Some("{\"b\":2}".to_string()));
}

#[test]
fn framer_line_cap() {
    let mut framer = Framer::new();
    let big = vec![b'x'; wire::MAX_LINE_BYTES + 1];
    assert_eq!(framer.feed(&big), Err(WireError::LineTooLong));
}

#[test]
fn empty_response_is_no_response() {
    assert_eq!(wire::parse_head(b""), Ok(None));
}

#[test]
fn conformance_events_round_trip() {
    let text = common::conformance("events.json");
    let raw: HashMap<String, serde_json::Value> = serde_json::from_str(&text).unwrap();
    let typed: HashMap<String, Event> = serde_json::from_str(&text).unwrap();
    assert_eq!(typed.len(), 22);
    // Optional fields serialize as absent; a fixture may spell them as null.
    fn strip_nulls(value: &mut serde_json::Value) {
        if let serde_json::Value::Object(map) = value {
            map.retain(|_, v| !v.is_null());
            map.values_mut().for_each(strip_nulls);
        }
    }
    for (name, event) in &typed {
        let mut expected = raw[name].clone();
        strip_nulls(&mut expected);
        let mut actual = serde_json::to_value(event).unwrap();
        strip_nulls(&mut actual);
        assert_eq!(actual, expected, "{name}");
    }
    let Event::Done { result } = &typed["done-tool_use"] else { panic!() };
    assert_eq!(result.status, Status::ToolUse);
    assert_eq!(result.tool_calls.as_ref().map(|t| t.len()), Some(1));
    let Event::Error { error } = &typed["error-no-type"] else { panic!() };
    assert!(error.kind.is_none());
}
