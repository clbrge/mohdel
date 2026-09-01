mod common;

use futures::StreamExt;
use mohdel_client::Client;
use mohdel_protocol::{Event, ImageEnvelope, MediaRef, Status, TranscriptionEnvelope};

#[tokio::test]
async fn call_streams_events_and_sends_the_envelope() {
    let (client, transport) = common::client(common::fixture("call-200-stream.raw"), 5);
    let events: Vec<Event> = client
        .call(&common::envelope())
        .await
        .unwrap()
        .map(|e| e.unwrap())
        .collect()
        .await;
    assert_eq!(events.len(), 5);
    assert!(matches!(&events[0], Event::Delta { delta } if delta.delta == "The"));
    let Event::Done { result } = &events[4] else { panic!() };
    assert_eq!(result.output.as_deref(), Some("The sky is blue"));

    let requests = transport.requests.lock().unwrap();
    let (socket, request) = &requests[0];
    assert_eq!(socket.to_str(), Some("/tmp/data.sock"));
    let text = String::from_utf8(request.clone()).unwrap();
    assert!(text.starts_with("POST /v1/call HTTP/1.1\r\n"));
    let body = text.split("\r\n\r\n").nth(1).unwrap();
    let sent: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(sent["model"], "local/llama3.1-8b");
    assert_eq!(sent["auth"]["key"], "");
    assert_eq!(sent["outputBudget"], 4);
    assert!(sent.get("outputType").is_none());
}

#[tokio::test]
async fn collect_returns_the_done_result() {
    let (client, _) = common::client(common::fixture("call-200-stream.raw"), 64);
    let result = client.collect(&common::envelope()).await.unwrap();
    assert_eq!(result.output_tokens, 4);
    assert_eq!(result.status, Status::Incomplete);
}

#[tokio::test]
async fn collect_returns_the_error_event() {
    let (client, _) = common::client(common::fixture("call-200-error-event.raw"), 64);
    let error = client.collect(&common::envelope()).await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("SESSION_UNKNOWN_MODEL"));
}

#[tokio::test]
async fn non_200_is_the_gate_typed_error() {
    let (client, _) = common::client(common::fixture("call-400-invalid-envelope.raw"), 64);
    let error = client.call(&common::envelope()).await.err().unwrap();
    assert_eq!(error.kind.as_deref(), Some("PROTOCOL_INVALID_ENVELOPE"));
    assert!(!error.retryable);
}

#[tokio::test]
async fn non_json_non_200_is_protocol_http_error() {
    let bytes = b"HTTP/1.1 503 Service Unavailable\r\ncontent-length: 4\r\n\r\nbusy".to_vec();
    let (client, _) = common::client(bytes, 64);
    let error = client.collect(&common::envelope()).await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("PROTOCOL_HTTP_ERROR"));
    assert!(error.retryable);
}

#[tokio::test]
async fn non_event_line_is_protocol_invalid_event() {
    let bytes = b"HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n\r\n{\"hello\":\"world\"}\n".to_vec();
    let (client, _) = common::client(bytes, 64);
    let error = client.collect(&common::envelope()).await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("PROTOCOL_INVALID_EVENT"));
}

#[tokio::test]
async fn truncated_chunked_body_is_protocol_http_error() {
    let bytes = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\n{\"type\":".to_vec();
    let (client, _) = common::client(bytes, 64);
    let error = client.collect(&common::envelope()).await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("PROTOCOL_HTTP_ERROR"));
}

#[tokio::test]
async fn dropping_the_stream_early_is_a_clean_cancel() {
    let (client, transport) = common::client(common::fixture("call-200-stream.raw"), 64);
    let mut events = client.call(&common::envelope()).await.unwrap();
    assert!(matches!(events.next().await, Some(Ok(Event::Delta { .. }))));
    drop(events);
    let result = client.collect(&common::envelope()).await.unwrap();
    assert_eq!(result.status, Status::Incomplete);
    assert_eq!(transport.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn empty_response_is_net_error() {
    let (client, _) = common::client(Vec::new(), 64);
    let error = client.collect(&common::envelope()).await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("NET_ERROR"));
    assert!(error.retryable);
}

fn image_envelope() -> ImageEnvelope {
    ImageEnvelope {
        call_id: "i-1".into(),
        auth_id: "u-1".into(),
        auth: None,
        traceparent: None,
        baggage: None,
        model: "novita/flux-2-dev".into(),
        prompt: "a red cube".into(),
        size: None,
        seed: None,
    }
}

#[tokio::test]
async fn image_returns_the_result() {
    let body = r#"{"status":"completed","images":[{"mimeType":"image/png","url":"https://cdn.example/abc.png"}],"seed":42,"timestamps":{"start":"1","first":"3","end":"3"}}"#;
    let (client, transport) = common::client(common::json_response(body), 64);
    let result = client.image(&image_envelope()).await.unwrap();
    assert_eq!(result.images.len(), 1);
    assert_eq!(result.images[0].url.as_deref(), Some("https://cdn.example/abc.png"));
    assert_eq!(result.seed, Some(42));
    let text = String::from_utf8(transport.requests.lock().unwrap()[0].1.clone()).unwrap();
    assert!(text.starts_with("POST /v1/image HTTP/1.1\r\n"));
}

#[tokio::test]
async fn image_malformed_is_protocol_invalid_event() {
    let (client, _) = common::client(common::json_response(r#"{"status":"completed"}"#), 64);
    let error = client.image(&image_envelope()).await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("PROTOCOL_INVALID_EVENT"));
}

#[tokio::test]
async fn transcription_returns_the_result() {
    let body = r#"{"status":"completed","text":"Bonjour tout le monde.","language":"fr","durationSeconds":12.5,"cost":0.0000834,"timestamps":{"start":"1","first":"3","end":"3"}}"#;
    let (client, _) = common::client(common::json_response(body), 64);
    let envelope = TranscriptionEnvelope {
        call_id: "t-1".into(),
        auth_id: "u-1".into(),
        auth: None,
        traceparent: None,
        baggage: None,
        model: "groq/whisper-large-v3-turbo".into(),
        audio: MediaRef { file_uri: "file:///tmp/a.wav".into(), mime_type: "audio/wav".into() },
        language: None,
        prompt: None,
    };
    let result = client.transcription(&envelope).await.unwrap();
    assert_eq!(result.text, "Bonjour tout le monde.");
    assert_eq!(result.duration_seconds, Some(12.5));
}

#[tokio::test]
async fn health_uses_the_admin_socket() {
    let (client, transport) = common::client(common::fixture("health-200.raw"), 64);
    let health = client.health().await.unwrap();
    assert_eq!(health.status, "ok");
    let requests = transport.requests.lock().unwrap();
    assert_eq!(requests[0].0.to_str(), Some("/tmp/admin.sock"));
    assert!(requests[0].1.starts_with(b"GET /v1/health HTTP/1.1\r\n"));
}

#[tokio::test]
async fn health_without_admin_socket() {
    let error = Client::new("/tmp/data.sock").health().await.unwrap_err();
    assert_eq!(error.kind.as_deref(), Some("CONFIGURATION_MISSING"));
}

#[test]
fn envelope_serializes_camel_case_and_round_trips() {
    let text = serde_json::to_string(&common::envelope()).unwrap();
    assert_eq!(
        text,
        r#"{"callId":"c-1","authId":"u-1","auth":{"key":""},"model":"local/llama3.1-8b","prompt":"why is the sky blue","outputBudget":4}"#
    );
    let back: mohdel_protocol::CallEnvelope = serde_json::from_str(&text).unwrap();
    assert_eq!(back.model, "local/llama3.1-8b");
}
