//! Unit tests on serde formatting for the 3-event protocol.

use mohdel_thin_gate::protocol::{
    AnswerResult, DeltaChunk, DeltaKind, Event, Severity, Status, Timestamps, TypedError,
};
use serde_json::json;

#[test]
fn status_serializes_to_canonical_0_86_strings() {
    assert_eq!(serde_json::to_string(&Status::Completed).unwrap(), "\"completed\"");
    assert_eq!(serde_json::to_string(&Status::Incomplete).unwrap(), "\"incomplete\"");
    assert_eq!(serde_json::to_string(&Status::ToolUse).unwrap(), "\"tool_use\"");
}

#[test]
fn severity_serializes_lowercase() {
    assert_eq!(serde_json::to_string(&Severity::Error).unwrap(), "\"error\"");
    assert_eq!(serde_json::to_string(&Severity::Warn).unwrap(), "\"warn\"");
}

#[test]
fn delta_event_wire_shape() {
    let e = Event::Delta {
        delta: DeltaChunk {
            r#type: DeltaKind::Message,
            delta: "Hi".into(),
        },
    };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v, json!({
        "type": "delta",
        "delta": { "type": "message", "delta": "Hi" }
    }));
}

#[test]
fn delta_function_call_kind_serializes_snake_case() {
    let e = Event::Delta {
        delta: DeltaChunk {
            r#type: DeltaKind::FunctionCall,
            delta: "{\"x\":1}".into(),
        },
    };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["delta"]["type"], "function_call");
}

#[test]
fn done_event_carries_answer_result_in_camel_case() {
    let e = Event::Done {
        result: AnswerResult {
            output: Some("Hi.".into()),
            input_tokens: 10,
            output_tokens: 5,
            cost: 0.001,
            timestamps: Timestamps {
                start: "1".into(),
                first: "2".into(),
                end: "3".into(),
            },
            ..Default::default()
        },
    };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "done");
    assert_eq!(v["result"]["status"], "completed");
    assert_eq!(v["result"]["inputTokens"], 10);
    assert_eq!(v["result"]["outputTokens"], 5);
    assert_eq!(v["result"]["cost"], 0.001);
    assert_eq!(v["result"]["timestamps"]["start"], "1");
    assert!(v["result"].get("warning").is_none(), "warning must be absent when None");
}

#[test]
fn done_event_accepts_cache_write_1h_input_tokens() {
    let line = serde_json::to_string(&json!({
        "type": "done",
        "result": {
            "status": "completed",
            "output": "Hi.",
            "inputTokens": 10,
            "outputTokens": 5,
            "thinkingTokens": 0,
            "cacheWriteInputTokens": 200,
            "cacheWrite1hInputTokens": 120,
            "cacheReadInputTokens": 40,
            "cost": 0.001,
            "timestamps": { "start": "1", "first": "2", "end": "3" }
        }
    })).unwrap();

    let e: Event = serde_json::from_str(&line).unwrap();
    let Event::Done { result } = e else { panic!("expected done") };
    assert_eq!(result.cache_write1h_input_tokens, Some(120));
    assert_eq!(result.cache_write_input_tokens, Some(200));

    let v = serde_json::to_value(&result).unwrap();
    assert_eq!(v["cacheWrite1hInputTokens"], 120);
}

#[test]
fn done_event_omits_cache_write_1h_when_absent() {
    let result = AnswerResult {
        input_tokens: 10,
        output_tokens: 5,
        cost: 0.001,
        timestamps: Timestamps { start: "1".into(), first: "2".into(), end: "3".into() },
        ..Default::default()
    };
    let v = serde_json::to_value(&result).unwrap();
    assert!(v.get("cacheWrite1hInputTokens").is_none());
}

#[test]
fn typed_error_uses_type_on_wire_via_kind_rename() {
    let e = TypedError {
        message: "rpm".into(),
        detail: None,
        severity: Severity::Warn,
        retryable: true,
        kind: Some("PROVIDER_COOLDOWN".into()),
    };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "PROVIDER_COOLDOWN");
    assert_eq!(v["severity"], "warn");
    assert_eq!(v["retryable"], true);
}

#[test]
fn error_event_wire_shape() {
    let e = Event::Error {
        error: TypedError {
            message: "bad".into(),
            detail: Some("more info".into()),
            severity: Severity::Error,
            retryable: false,
            kind: None,
        },
    };
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["type"], "error");
    assert_eq!(v["error"]["message"], "bad");
    assert_eq!(v["error"]["detail"], "more info");
}
