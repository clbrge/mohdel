//! Cross-language conformance tests.
//!
//! Fixture JSON files under `test/conformance/` are the source of
//! truth for the frozen wire shape. These tests assert:
//!
//!   1. Every fixture parses as the corresponding Rust type.
//!   2. Parse → serialize yields a `serde_json::Value` **structurally
//!      equal to the original fixture**. Any field the Rust type
//!      silently dropped (missing `#[serde(default)]` with a
//!      mismatched optional, a stray un-modeled field, wrong
//!      camelCase, etc.) fails this assertion.
//!   3. A second round-trip is idempotent (catches encode-side
//!      instability like unordered serialization of Value objects).
//!
//! Pair with `test/unit/core-conformance.test.js` — that one covers
//! the JS side against the same fixtures.

use std::collections::BTreeMap;
use std::path::PathBuf;

use mohdel_thin_gate::protocol::{
    CallEnvelope, Event, ImageEnvelope, ImageResult, TranscriptionEnvelope, TranscriptionResult,
};
use serde_json::Value;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("conformance")
}

fn load_map(name: &str) -> BTreeMap<String, Value> {
    let path = fixtures_dir().join(name);
    let body = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
    serde_json::from_str(&body).expect("parse fixture map")
}

/// Normalize a fixture `Value` for comparison against what our Rust
/// types re-emit:
///
///   - Drops `null` leaves from objects. Our protocol skip-serializes
///     `None` options (`#[serde(skip_serializing_if = ...)]`), so a
///     fixture that writes `"warning": null` round-trips to `None`
///     and re-serializes with no key at all. Logical equality, not
///     byte-identical.
///   - Promotes integer numbers to floats. JSON doesn't distinguish
///     `0` from `0.0`, but `serde_json::Value::Number` does track
///     the encoding. A fixture with `"cost": 0` compared against
///     Rust's `f64: 0.0` → `Number(0.0)` would fail on that alone.
fn normalize(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let normalized: serde_json::Map<String, Value> = map
                .into_iter()
                .filter_map(|(k, v)| match v {
                    Value::Null => None,
                    other => Some((k, normalize(other))),
                })
                .collect();
            Value::Object(normalized)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            } else {
                Value::Number(n)
            }
        }
        other => other,
    }
}

#[test]
fn envelopes_round_trip_losslessly() {
    let map = load_map("envelopes.json");
    assert!(!map.is_empty(), "expected at least one envelope fixture");

    for (name, raw) in map {
        let parsed: CallEnvelope = serde_json::from_value(raw.clone())
            .unwrap_or_else(|e| panic!("parse envelope {}: {}", name, e));
        let reserialized: Value = serde_json::to_value(&parsed)
            .unwrap_or_else(|e| panic!("reserialize envelope {}: {}", name, e));

        let expected = normalize(raw.clone());
        let actual = normalize(reserialized);
        assert_eq!(
            actual, expected,
            "envelope '{}' was not preserved through parse+serialize",
            name
        );

        // Idempotence: re-serializing the reparsed struct must equal
        // the first serialization.
        let reparsed: CallEnvelope = serde_json::from_value(serde_json::to_value(&parsed).unwrap())
            .unwrap_or_else(|e| panic!("reparse envelope {}: {}", name, e));
        let a = serde_json::to_string(&parsed).unwrap();
        let b = serde_json::to_string(&reparsed).unwrap();
        assert_eq!(a, b, "envelope '{}' is not encode-idempotent", name);
    }
}

#[test]
fn events_round_trip_losslessly() {
    let map = load_map("events.json");
    assert!(!map.is_empty(), "expected at least one event fixture");

    for (name, raw) in map {
        let parsed: Event = serde_json::from_value(raw.clone())
            .unwrap_or_else(|e| panic!("parse event {}: {}", name, e));
        let reserialized: Value = serde_json::to_value(&parsed)
            .unwrap_or_else(|e| panic!("reserialize event {}: {}", name, e));

        let expected = normalize(raw.clone());
        let actual = normalize(reserialized);
        assert_eq!(
            actual, expected,
            "event '{}' was not preserved through parse+serialize",
            name
        );

        let reparsed: Event = serde_json::from_value(serde_json::to_value(&parsed).unwrap())
            .unwrap_or_else(|e| panic!("reparse event {}: {}", name, e));
        let a = serde_json::to_string(&parsed).unwrap();
        let b = serde_json::to_string(&reparsed).unwrap();
        assert_eq!(a, b, "event '{}' is not encode-idempotent", name);
    }
}

/// Enforces the frozen-types promise: an envelope with a field the
/// Rust type doesn't model is rejected at parse time. Silently
/// dropping it would let 0.91 senders appear to work against 0.90
/// gates while actually losing state.
#[test]
fn unknown_envelope_fields_are_rejected() {
    let injected = serde_json::json!({
        "callId": "c1",
        "authId": "a1",
        "auth": { "key": "k" },
        "provider": "echo",
        "model": "m",
        "prompt": "hi",
        "unknownFutureField": 42
    });
    let result: Result<CallEnvelope, _> = serde_json::from_value(injected);
    let err = result.expect_err("unknown field must be rejected");
    assert!(
        err.to_string().contains("unknown") || err.to_string().contains("unknownFutureField"),
        "expected 'unknown field' error, got: {err}"
    );
}

#[test]
fn image_envelopes_and_results_round_trip_losslessly() {
    let map = load_map("images.json");
    assert!(!map.is_empty(), "expected at least one image fixture");

    for (name, raw) in map {
        if name.starts_with("envelope-") {
            let parsed: ImageEnvelope = serde_json::from_value(raw.clone())
                .unwrap_or_else(|e| panic!("parse image envelope {}: {}", name, e));
            let reserialized: Value = serde_json::to_value(&parsed).unwrap();
            assert_eq!(
                normalize(reserialized),
                normalize(raw.clone()),
                "image envelope '{}' not preserved",
                name
            );
        } else if name.starts_with("result-") {
            let parsed: ImageResult = serde_json::from_value(raw.clone())
                .unwrap_or_else(|e| panic!("parse image result {}: {}", name, e));
            let reserialized: Value = serde_json::to_value(&parsed).unwrap();
            assert_eq!(
                normalize(reserialized),
                normalize(raw.clone()),
                "image result '{}' not preserved",
                name
            );
        } else {
            panic!("unexpected fixture name '{}' in images.json", name);
        }
    }
}

#[test]
fn unknown_image_envelope_fields_are_rejected() {
    let injected = serde_json::json!({
        "callId": "i1",
        "authId": "a1",
        "auth": { "key": "k" },
        "provider": "openai",
        "model": "gpt-image-1",
        "prompt": "red sphere",
        "futureField": "nope"
    });
    let result: Result<ImageEnvelope, _> = serde_json::from_value(injected);
    let err = result.expect_err("unknown field must be rejected");
    assert!(err.to_string().contains("unknown") || err.to_string().contains("futureField"));
}

#[test]
fn transcription_envelopes_and_results_round_trip_losslessly() {
    let map = load_map("transcriptions.json");
    assert!(!map.is_empty(), "expected at least one transcription fixture");

    for (name, raw) in map {
        if name.starts_with("envelope-") {
            let parsed: TranscriptionEnvelope = serde_json::from_value(raw.clone())
                .unwrap_or_else(|e| panic!("parse transcription envelope {}: {}", name, e));
            let reserialized: Value = serde_json::to_value(&parsed).unwrap();
            assert_eq!(
                normalize(reserialized),
                normalize(raw.clone()),
                "transcription envelope '{}' not preserved",
                name
            );
        } else if name.starts_with("result-") {
            let parsed: TranscriptionResult = serde_json::from_value(raw.clone())
                .unwrap_or_else(|e| panic!("parse transcription result {}: {}", name, e));
            let reserialized: Value = serde_json::to_value(&parsed).unwrap();
            assert_eq!(
                normalize(reserialized),
                normalize(raw.clone()),
                "transcription result '{}' not preserved",
                name
            );
        } else {
            panic!("unexpected fixture name '{}' in transcriptions.json", name);
        }
    }
}

#[test]
fn unknown_transcription_envelope_fields_are_rejected() {
    let injected = serde_json::json!({
        "callId": "t1",
        "authId": "a1",
        "auth": { "key": "k" },
        "model": "groq/whisper-large-v3",
        "audio": { "fileUri": "file:///tmp/clip.wav", "mimeType": "audio/wav" },
        "futureField": "nope"
    });
    let result: Result<TranscriptionEnvelope, _> = serde_json::from_value(injected);
    let err = result.expect_err("unknown field must be rejected");
    assert!(err.to_string().contains("unknown") || err.to_string().contains("futureField"));
}

/// Same enforcement on the nested `AnswerResult` shape inside a
/// `done` event — catches extensions that try to bolt state onto
/// the result without going through the freeze contract.
#[test]
fn unknown_answer_result_fields_are_rejected() {
    let injected = serde_json::json!({
        "type": "done",
        "result": {
            "status": "completed",
            "output": "ok",
            "inputTokens": 1,
            "outputTokens": 1,
            "thinkingTokens": 0,
            "cost": 0.0,
            "timestamps": { "start": "0", "first": "0", "end": "0" },
            "ghostField": "should fail"
        }
    });
    let result: Result<Event, _> = serde_json::from_value(injected);
    let err = result.expect_err("unknown nested field must be rejected");
    assert!(
        err.to_string().contains("unknown") || err.to_string().contains("ghostField"),
        "expected 'unknown field' error, got: {err}"
    );
}
