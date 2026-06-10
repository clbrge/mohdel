//! End-to-end tests: thin-gate spawns `js/session/bin.js` subprocesses,
//! dispatches calls via the pool, relays 3-event NDJSON responses.

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

use mohdel_thin_gate::{
    protocol::{Event, Status, TranscriptionResult, TypedError},
    SessionConfig, SessionPool,
};

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_sock_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-thin-gate-session-{}-{}.sock",
        std::process::id(),
        name
    ))
}

fn session_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("js")
        .join("session")
        .join("bin.js")
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

async fn send(path: &Path, method: &str, uri: &str, body: Bytes) -> Response<Incoming> {
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
        .expect("build");
    sender.send_request(req).await.expect("send")
}

fn envelope_bytes(call_id: &str) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&json!({
            "callId": call_id,
            "authId": "a1",
            "auth": { "key": "k" },
            "model": "echo/m",
            "prompt": "hi"
        }))
        .unwrap(),
    )
}

async fn read_event_stream(res: Response<Incoming>) -> (StatusCode, Vec<Event>) {
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let text = std::str::from_utf8(&bytes).unwrap();
    let events = text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str::<Event>(l).expect("parse event"))
        .collect();
    (status, events)
}

fn node_session_cfg() -> SessionConfig {
    let bin = session_bin();
    assert!(bin.exists(), "session bin not found at {}", bin.display());
    // Minimal catalog so run.js's catalog guard doesn't reject
    // `echo/m` as unknown. `echo` adapter reads no fields off the
    // spec, so an empty entry is enough.
    let catalog_source: mohdel_thin_gate::CatalogSource =
        std::sync::Arc::new(|| Some(r#"{"echo/m":{}}"#.to_string()));
    SessionConfig {
        command: "node".to_string(),
        args: vec![bin.to_string_lossy().into_owned()],
        catalog: Some(catalog_source),
    }
}

#[tokio::test]
async fn pool_dispatches_single_call() {
    let path = temp_sock_path("single");
    let _guard = SocketGuard(path.clone());

    let pool = SessionPool::new(node_session_cfg(), 1).await.expect("pool");
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, Some(pool)).await;
    });

    wait_for_socket(&path).await;
    let res = send(&path, "POST", "/v1/call", envelope_bytes("single-1")).await;
    let (status, events) = read_event_stream(res).await;

    assert_eq!(status, StatusCode::OK);
    assert!(events.len() >= 2, "expected delta(s) + done");

    match events.last().unwrap() {
        Event::Done { result } => assert_eq!(result.status, Status::Completed),
        other => panic!("last event should be done, got {other:?}"),
    }

    server.abort();
}

#[tokio::test]
async fn pool_reuses_session_across_calls() {
    let path = temp_sock_path("reuse");
    let _guard = SocketGuard(path.clone());

    // Pool size 1: forces reuse.
    let pool = SessionPool::new(node_session_cfg(), 1).await.expect("pool");
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, Some(pool)).await;
    });

    wait_for_socket(&path).await;

    for n in 1..=3 {
        let call_id = format!("reuse-{n}");
        let res = send(&path, "POST", "/v1/call", envelope_bytes(&call_id)).await;
        let (status, events) = read_event_stream(res).await;
        assert_eq!(status, StatusCode::OK);
        match events.last().unwrap() {
            Event::Done { result } => assert_eq!(result.status, Status::Completed),
            other => panic!("call {n}: last event not done: {other:?}"),
        }
    }

    server.abort();
}

#[tokio::test]
async fn pool_handles_concurrent_calls_up_to_pool_size() {
    let path = temp_sock_path("concurrent");
    let _guard = SocketGuard(path.clone());

    let pool = SessionPool::new(node_session_cfg(), 3).await.expect("pool");
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, Some(pool)).await;
    });

    wait_for_socket(&path).await;

    let send_call = |n: usize| {
        let path = path.clone();
        tokio::spawn(async move {
            let call_id = format!("concurrent-{n}");
            let res = send(&path, "POST", "/v1/call", envelope_bytes(&call_id)).await;
            let (status, events) = read_event_stream(res).await;
            (n, status, events)
        })
    };

    let results = [
        send_call(1).await.unwrap(),
        send_call(2).await.unwrap(),
        send_call(3).await.unwrap(),
    ];
    for (n, status, events) in results {
        assert_eq!(status, StatusCode::OK, "call {n} status");
        match events.last().unwrap() {
            Event::Done { result } => assert_eq!(result.status, Status::Completed),
            _ => panic!("call {n}: missing done"),
        }
    }

    server.abort();
}

#[tokio::test]
async fn pool_init_fails_when_session_bin_missing() {
    let bad_cfg = SessionConfig {
        command: "nonexistent-binary-that-definitely-is-not-on-path".to_string(),
        args: vec![],
        catalog: None,
    };
    let result = SessionPool::new(bad_cfg, 1).await;
    assert!(result.is_err(), "expected pool creation to fail");
}

/// Slow session that emits a call-start-like stub then waits for cancel,
/// used to test graceful-cancel on client disconnect.
const SLOW_SESSION_SCRIPT: &str = r#"
const { createInterface } = await import('node:readline');
const rl = createInterface({ input: process.stdin });
let active = null;
rl.on('line', (line) => {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o && o.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n');
    return;
  }
  if (o && o.op === 'cancel') {
    if (active && active === o.callId) {
      const end = String(process.hrtime.bigint());
      process.stdout.write(JSON.stringify({
        type: 'done',
        result: {
          status: 'incomplete',
          output: null,
          inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
          cost: 0,
          timestamps: { start: end, first: end, end },
          warning: 'cancelled'
        }
      }) + '\n');
      active = null;
    }
    return;
  }
  active = o.callId;
  process.stdout.write(JSON.stringify({
    type: 'delta',
    delta: { type: 'message', delta: '' }
  }) + '\n');
});
"#;

#[tokio::test]
async fn client_disconnect_gracefully_cancels_and_returns_session_to_pool() {
    let path = temp_sock_path("cancel-reuse");
    let _guard = SocketGuard(path.clone());

    let slow_cfg = SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            SLOW_SESSION_SCRIPT.to_string(),
        ],
        catalog: None,
    };

    let pool = SessionPool::new(slow_cfg, 1).await.expect("pool");
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, Some(pool)).await;
    });

    wait_for_socket(&path).await;

    // First call: read first frame then drop.
    {
        let stream = UnixStream::connect(&path).await.expect("connect");
        let io = TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
            .await
            .expect("handshake");
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let req = Request::builder()
            .method("POST")
            .uri("/v1/call")
            .header("host", "unix")
            .header("content-type", "application/json")
            .body(Full::new(envelope_bytes("first")))
            .expect("build");
        let res = sender.send_request(req).await.expect("send");
        assert_eq!(res.status(), StatusCode::OK);

        let mut body = res.into_body();
        let _ = body.frame().await.expect("frame").expect("ok");
        drop(body);
        drop(sender);
    }

    // Let graceful cancel complete.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Second call: pool size 1 → must reuse the session.
    let stream = UnixStream::connect(&path).await.expect("connect");
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .expect("handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("POST")
        .uri("/v1/call")
        .header("host", "unix")
        .header("content-type", "application/json")
        .body(Full::new(envelope_bytes("second")))
        .expect("build");
    let res = sender.send_request(req).await.expect("send");
    assert_eq!(res.status(), StatusCode::OK);

    let mut body = res.into_body();
    let frame = body.frame().await.expect("first frame").expect("ok");
    let data = frame.into_data().expect("data");
    let text = std::str::from_utf8(&data).unwrap();
    assert!(text.contains("\"type\":\"delta\""), "expected delta, got: {text}");

    drop(body);
    drop(sender);
    tokio::time::sleep(Duration::from_millis(200)).await;

    server.abort();
}

#[tokio::test]
async fn session_emitting_invalid_event_yields_terminal_error_and_replaces() {
    let path = temp_sock_path("bad-session");
    let _guard = SocketGuard(path.clone());

    // Session that passes the readiness ping but emits invalid JSON
    // on the first real envelope. Exercises the mid-call protocol
    // violation path; bad readiness is covered separately.
    let bad_cfg = SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            r#"
const { createInterface } = await import('node:readline');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o && o.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n');
    return;
  }
  process.stdout.write('not-json\n');
  process.exit(0);
});
"#.to_string(),
        ],
        catalog: None,
    };
    let pool = SessionPool::new(bad_cfg, 1).await.expect("pool");
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, Some(pool)).await;
    });

    wait_for_socket(&path).await;
    let res = send(&path, "POST", "/v1/call", envelope_bytes("bad")).await;
    let (status, events) = read_event_stream(res).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(events.len(), 1);
    match &events[0] {
        Event::Error { error } => {
            let k = error.kind.as_deref().unwrap_or("");
            assert!(
                k == "SESSION_INVALID_EVENT" || k == "SESSION_DIED",
                "expected SESSION_INVALID_EVENT or SESSION_DIED, got {k}"
            );
        }
        other => panic!("expected error event, got {other:?}"),
    }

    server.abort();
}

#[tokio::test]
async fn pool_dispatches_transcription() {
    let path = temp_sock_path("transcription");
    let _guard = SocketGuard(path.clone());

    let pool = SessionPool::new(node_session_cfg(), 1).await.expect("pool");
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = mohdel_thin_gate::serve_data(&serve_path, Some(pool)).await;
    });

    wait_for_socket(&path).await;
    // `fake` transcription adapter: scenario spec rides in `prompt`.
    let body = Bytes::from(
        serde_json::to_vec(&json!({
            "callId": "tr-e2e-1",
            "authId": "a1",
            "auth": { "key": "k" },
            "model": "fake/test",
            "audio": { "fileUri": "file:///tmp/clip.wav", "mimeType": "audio/wav" },
            "prompt": "{\"mode\":\"ok\",\"text\":\"hi from fake\"}"
        }))
        .unwrap(),
    );
    let res = send(&path, "POST", "/v1/transcription", body).await;

    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {}",
        String::from_utf8_lossy(&bytes)
    );
    let result: TranscriptionResult = serde_json::from_slice(&bytes).expect("parse result");
    assert_eq!(result.text, "hi from fake");

    server.abort();
}

#[allow(dead_code)]
fn _typed_error_unused(_e: TypedError) {}
