//! A one-shot handler future dropped mid-exchange leaves its session to
//! finish the call and return to the pool. The server here drives the
//! public handlers on connection tasks it can abort, the way an embedder
//! that drops its connection futures does.
//!
//! The fake session logs `<op> <pid> <callId>` for every envelope and
//! answers 500 ms later. Pool gauges are not readable in tests (metrics
//! are a no-op without an OTLP endpoint); the next call being served by
//! the same pid shows the session came back through `release`, the path
//! that balances them.

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1 as server_http1;
use hyper::service::service_fn;
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};

use mohdel_thin_gate::{
    handle_embed, handle_image, handle_transcription, GateState, SessionConfig, SessionPool,
};

const FAKE_SESSION: &str = r#"
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const tracePath = process.argv[1]
const timestamps = { start: '0', first: '0', end: '0' }
const replies = {
  embed: { type: 'embed_done', result: { status: 'completed', vectors: [[0.5]], dimensions: 1, inputType: null, inputTokens: 1, cost: 0, timestamps } },
  image: { type: 'image_done', result: { status: 'completed', images: [], seed: null, timestamps } },
  transcription: { type: 'transcription_done', result: { status: 'completed', text: 'hi', language: null, durationSeconds: null, cost: 0, timestamps } }
}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const o = JSON.parse(line)
  if (o.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n')
    return
  }
  appendFileSync(tracePath, `${o.op} ${process.pid} ${o.callId}\n`)
  setTimeout(() => process.stdout.write(JSON.stringify(replies[o.op]) + '\n'), 500)
})
"#;

fn fake_session_cfg(trace: &Path) -> SessionConfig {
    SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            FAKE_SESSION.to_string(),
            "--".to_string(),
            trace.to_string_lossy().into_owned(),
        ],
        catalog: None,
    }
}

struct FileGuard(PathBuf);
impl Drop for FileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_path(name: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-oneshot-abandon-{}-{}.{ext}",
        std::process::id(),
        name
    ))
}

fn trace_lines(trace: &Path) -> Vec<String> {
    match std::fs::read_to_string(trace) {
        Ok(s) => s.lines().map(str::to_owned).collect(),
        Err(_) => Vec::new(),
    }
}

async fn wait_for_lines(trace: &Path, n: usize) {
    for _ in 0..250 {
        if trace_lines(trace).len() >= n {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("session never received envelope {n}");
}

async fn serve_one(stream: UnixStream, state: Arc<GateState>) {
    let svc = service_fn(move |req: Request<Incoming>| {
        let state = state.clone();
        async move {
            let path = req.uri().path().to_string();
            let res = match path.as_str() {
                "/v1/embed" => handle_embed(req, state).await,
                "/v1/image" => handle_image(req, state).await,
                "/v1/transcription" => handle_transcription(req, state).await,
                other => panic!("unexpected route {other}"),
            };
            Ok::<_, Infallible>(res)
        }
    });
    let _ = server_http1::Builder::new()
        .serve_connection(TokioIo::new(stream), svc)
        .await;
}

async fn send(path: PathBuf, uri: &'static str, body: Value) -> StatusCode {
    let stream = UnixStream::connect(&path).await.expect("connect");
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .expect("handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("host", "unix")
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(serde_json::to_vec(&body).unwrap())))
        .expect("build");
    let res = sender.send_request(req).await.expect("send");
    let status = res.status();
    let _ = res.into_body().collect().await;
    status
}

async fn abandoned_exchange_returns_its_session(uri: &'static str, body: fn(&str) -> Value) {
    let name = uri.trim_start_matches("/v1/");
    let trace = temp_path(name, "log");
    let _trace_guard = FileGuard(trace.clone());
    let _ = std::fs::remove_file(&trace);
    let sock = temp_path(name, "sock");
    let _sock_guard = FileGuard(sock.clone());
    let _ = std::fs::remove_file(&sock);

    let pool = SessionPool::new(fake_session_cfg(&trace), 1).await.expect("pool");
    let state = Arc::new(GateState::with_defaults(Some(pool)));
    let listener = UnixListener::bind(&sock).expect("bind");

    let first = tokio::spawn(send(sock.clone(), uri, body("first")));
    let (stream, _) = listener.accept().await.expect("accept");
    let conn = tokio::spawn(serve_one(stream, state.clone()));
    wait_for_lines(&trace, 1).await;
    conn.abort();
    let _ = conn.await;
    first.abort();

    let second = tokio::spawn(send(sock.clone(), uri, body("second")));
    let (stream, _) = listener.accept().await.expect("accept");
    tokio::spawn(serve_one(stream, state.clone()));
    let status = tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .expect("the next call must not wait out the acquire timeout")
        .expect("join");
    assert_eq!(status, StatusCode::OK);

    let lines = trace_lines(&trace);
    assert_eq!(lines.len(), 2, "{lines:?}");
    let pid = |line: &str| line.split(' ').nth(1).map(str::to_owned);
    assert_eq!(
        pid(&lines[0]),
        pid(&lines[1]),
        "the abandoned call's session was released, not replaced: {lines:?}"
    );
}

#[tokio::test]
async fn abandoned_embed_returns_its_session_to_the_pool() {
    abandoned_exchange_returns_its_session("/v1/embed", |call_id| {
        json!({
            "callId": call_id,
            "authId": "a1",
            "auth": { "key": "k" },
            "model": "fake/m",
            "input": ["hi"]
        })
    })
    .await;
}

#[tokio::test]
async fn abandoned_image_returns_its_session_to_the_pool() {
    abandoned_exchange_returns_its_session("/v1/image", |call_id| {
        json!({
            "callId": call_id,
            "authId": "a1",
            "auth": { "key": "k" },
            "model": "fake/m",
            "prompt": "a cat"
        })
    })
    .await;
}

#[tokio::test]
async fn abandoned_transcription_returns_its_session_to_the_pool() {
    abandoned_exchange_returns_its_session("/v1/transcription", |call_id| {
        json!({
            "callId": call_id,
            "authId": "a1",
            "auth": { "key": "k" },
            "model": "fake/m",
            "audio": { "fileUri": "file:///tmp/clip.wav", "mimeType": "audio/wav" }
        })
    })
    .await;
}
