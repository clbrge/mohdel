//! End-to-end server tests with synthetic-only dispatch (pool=None).
//! Verifies the HTTP layer, routing, and the 3-event envelope shape.

use std::path::{Path, PathBuf};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::UnixStream;

use mohdel_thin_gate::protocol::{Event, Status, TypedError};

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_sock_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-thin-gate-test-{}-{}.sock",
        std::process::id(),
        name
    ))
}

async fn wait_for_socket(path: &Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("socket {} did not appear", path.display());
}

async fn send_request(
    path: &Path,
    method: &str,
    uri: &str,
    body: Bytes,
) -> Response<Incoming> {
    let stream = UnixStream::connect(path).await.expect("connect");
    let io = TokioIo::new(stream);
    let (mut sender, conn) = http1::handshake(io).await.expect("handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "unix")
        .header("content-type", "application/json")
        .body(Full::new(body))
        .expect("request build");
    sender.send_request(req).await.expect("send")
}

async fn read_typed_error(res: Response<Incoming>) -> (StatusCode, TypedError) {
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let err: TypedError = serde_json::from_slice(&bytes).expect("typed error body");
    (status, err)
}

fn minimal_envelope() -> Bytes {
    let env = json!({
        "callId": "c1",
        "authId": "a1",
        "auth": { "key": "sk-test" },
        "model": "openai/gpt-5",
        "prompt": "hi"
    });
    Bytes::from(serde_json::to_vec(&env).unwrap())
}

#[tokio::test]
async fn call_streams_three_event_ndjson() {
    let path = temp_sock_path("call");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, None).await;
    });

    wait_for_socket(&path).await;
    let res = send_request(&path, "POST", "/v1/call", minimal_envelope()).await;

    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get("content-type").and_then(|h| h.to_str().ok()),
        Some("application/x-ndjson")
    );

    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body = std::str::from_utf8(&bytes).unwrap();
    let events: Vec<Event> = body
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).expect("parse event"))
        .collect();

    assert!(events.len() >= 2, "expected at least delta + done");

    // First N events are deltas.
    for ev in &events[..events.len() - 1] {
        assert!(matches!(ev, Event::Delta { .. }), "non-terminal should be delta");
    }

    // Last event is done with status completed.
    match events.last().unwrap() {
        Event::Done { result } => {
            assert_eq!(result.status, Status::Completed);
            assert!(result.warning.is_none());
        }
        other => panic!("last event should be done, got {other:?}"),
    }

    server.abort();
}

#[tokio::test]
async fn invalid_envelope_returns_400_with_typed_error() {
    let path = temp_sock_path("invalid");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, None).await;
    });

    wait_for_socket(&path).await;
    let body = Bytes::from_static(b"{\"not\":\"an envelope\"}");
    let res = send_request(&path, "POST", "/v1/call", body).await;
    let (status, err) = read_typed_error(res).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(err.kind.as_deref(), Some("PROTOCOL_INVALID_ENVELOPE"));

    server.abort();
}

#[tokio::test]
async fn oversized_body_returns_413_with_payload_too_large() {
    let path = temp_sock_path("oversized");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, None).await;
    });

    wait_for_socket(&path).await;

    // 17 MiB of padding past the 16 MiB cap. The envelope shape is
    // irrelevant — Limited trips before serde even looks at it.
    let oversized = vec![b'a'; 17 * 1024 * 1024];
    let res = send_request(&path, "POST", "/v1/call", Bytes::from(oversized)).await;
    let (status, err) = read_typed_error(res).await;

    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(err.kind.as_deref(), Some("PROTOCOL_PAYLOAD_TOO_LARGE"));

    server.abort();
}

#[tokio::test]
async fn body_just_under_cap_still_parses_normally() {
    let path = temp_sock_path("under-cap");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, None).await;
    });

    wait_for_socket(&path).await;

    // Valid envelope padded to ~1 MiB with a long prompt. Well under
    // the 16 MiB cap; gate must accept and route normally (synthetic
    // fallback → 200 + Event stream).
    let pad = "x".repeat(1024 * 1024);
    let env = json!({
        "callId": "c-big",
        "authId": "a1",
        "auth": { "key": "sk-test" },
        "model": "openai/gpt-5",
        "prompt": pad
    });
    let body = Bytes::from(serde_json::to_vec(&env).unwrap());
    let res = send_request(&path, "POST", "/v1/call", body).await;
    assert_eq!(res.status(), StatusCode::OK);

    server.abort();
}

#[tokio::test]
async fn unknown_route_returns_404() {
    let path = temp_sock_path("unknown");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, None).await;
    });

    wait_for_socket(&path).await;
    let res = send_request(&path, "GET", "/nowhere", Bytes::new()).await;
    let (status, err) = read_typed_error(res).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err.kind.as_deref(), Some("PROTOCOL_NOT_FOUND"));

    server.abort();
}

// ---------- Admin plane ----------

#[tokio::test]
async fn admin_health_returns_ok_with_version_and_uptime() {
    let path = temp_sock_path("admin-health");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_admin(&serve_path).await;
    });

    wait_for_socket(&path).await;
    let res = send_request(&path, "GET", "/v1/health", Bytes::new()).await;

    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("parse health body");
    assert_eq!(body["status"], "ok");
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    assert!(body["uptime_ms"].is_u64());

    server.abort();
}

#[tokio::test]
async fn admin_unknown_route_returns_404() {
    let path = temp_sock_path("admin-unknown");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_admin(&serve_path).await;
    });

    wait_for_socket(&path).await;
    let res = send_request(&path, "POST", "/v1/health", Bytes::new()).await;
    let (status, err) = read_typed_error(res).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err.kind.as_deref(), Some("PROTOCOL_NOT_FOUND"));

    server.abort();
}

#[tokio::test]
async fn data_plane_has_no_health_endpoint() {
    let path = temp_sock_path("data-no-health");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, None).await;
    });

    wait_for_socket(&path).await;
    let res = send_request(&path, "GET", "/v1/health", Bytes::new()).await;
    let (status, err) = read_typed_error(res).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(err.kind.as_deref(), Some("PROTOCOL_NOT_FOUND"));

    server.abort();
}
