//! A one-shot handler future dropped mid-exchange leaves its session to
//! finish the call and return to the pool; a `dispatch_*` future dropped
//! before dispatch never reaches a session; a dispatched `Exchange` owns
//! its result. The server here drives the public handlers on connection
//! tasks it can abort, the way an embedder that drops its connection
//! futures does.
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
use tokio::sync::mpsc;

use mohdel_thin_gate::protocol::EmbedResult;
use mohdel_thin_gate::{
    dispatch_embed, handle_embed, handle_image, handle_transcription, Exchange, GateState,
    SessionConfig, SessionPool,
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

fn embed_body(call_id: &str) -> Value {
    json!({
        "callId": call_id,
        "authId": "a1",
        "auth": { "key": "k" },
        "model": "fake/m",
        "input": ["hi"]
    })
}

/// Serves `/v1/embed` through `dispatch_embed`: a dispatched `Exchange` is
/// handed to the test and the connection then waits to be aborted.
async fn serve_dispatch(stream: UnixStream, state: Arc<GateState>, exchanges: mpsc::UnboundedSender<Exchange>) {
    let svc = service_fn(move |req: Request<Incoming>| {
        let state = state.clone();
        let exchanges = exchanges.clone();
        async move {
            match dispatch_embed(req, state).await {
                Ok(exchange) => {
                    exchanges.send(exchange).expect("the test holds the receiver");
                    std::future::pending().await
                }
                Err(refused) => Ok::<_, Infallible>(refused),
            }
        }
    });
    let _ = server_http1::Builder::new()
        .serve_connection(TokioIo::new(stream), svc)
        .await;
}

struct Gate {
    trace: PathBuf,
    sock: PathBuf,
    pool: SessionPool,
    state: Arc<GateState>,
    listener: UnixListener,
    _guards: (FileGuard, FileGuard),
}

async fn gate(name: &str) -> Gate {
    let trace = temp_path(name, "log");
    let _ = std::fs::remove_file(&trace);
    let sock = temp_path(name, "sock");
    let _ = std::fs::remove_file(&sock);
    let pool = SessionPool::new(fake_session_cfg(&trace), 1).await.expect("pool");
    let state = Arc::new(GateState::with_defaults(Some(pool.clone())));
    let listener = UnixListener::bind(&sock).expect("bind");
    Gate {
        _guards: (FileGuard(trace.clone()), FileGuard(sock.clone())),
        trace,
        sock,
        pool,
        state,
        listener,
    }
}

async fn next_embed_is_served(gate: &Gate, call_id: &str) {
    let next = tokio::spawn(send(gate.sock.clone(), "/v1/embed", embed_body(call_id)));
    let (stream, _) = gate.listener.accept().await.expect("accept");
    tokio::spawn(serve_one(stream, gate.state.clone()));
    let status = tokio::time::timeout(Duration::from_secs(5), next)
        .await
        .expect("the next call must not wait out the acquire timeout")
        .expect("join");
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn dispatch_dropped_while_queued_never_reaches_the_session() {
    let gate = gate("dispatch-queued").await;
    let held = gate.pool.acquire().await.expect("hold the only session");

    let (exchanges, _unused) = mpsc::unbounded_channel();
    let client = tokio::spawn(send(gate.sock.clone(), "/v1/embed", embed_body("queued")));
    let (stream, _) = gate.listener.accept().await.expect("accept");
    let conn = tokio::spawn(serve_dispatch(stream, gate.state.clone(), exchanges));
    tokio::time::sleep(Duration::from_millis(300)).await;
    conn.abort();
    let _ = conn.await;
    client.abort();
    gate.pool.release(held);

    next_embed_is_served(&gate, "next").await;
    let lines = trace_lines(&gate.trace);
    assert_eq!(lines.len(), 1, "only the next call reached the session: {lines:?}");
    assert!(lines[0].ends_with(" next"), "{lines:?}");
}

#[tokio::test]
async fn dispatched_exchange_resolves_after_its_connection_is_gone() {
    let gate = gate("dispatch-detached").await;
    let (exchanges, mut dispatched) = mpsc::unbounded_channel();
    let client = tokio::spawn(send(gate.sock.clone(), "/v1/embed", embed_body("detached")));
    let (stream, _) = gate.listener.accept().await.expect("accept");
    let conn = tokio::spawn(serve_dispatch(stream, gate.state.clone(), exchanges));

    let exchange = dispatched.recv().await.expect("dispatched");
    conn.abort();
    let _ = conn.await;
    client.abort();

    let response = tokio::spawn(exchange).await.expect("join");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let result: EmbedResult = serde_json::from_slice(&bytes).expect("embed result");
    assert_eq!(result.vectors, vec![vec![0.5]]);

    next_embed_is_served(&gate, "next").await;
}

#[tokio::test]
async fn dispatched_exchange_dropped_returns_its_session() {
    let gate = gate("dispatch-dropped").await;
    let (exchanges, mut dispatched) = mpsc::unbounded_channel();
    let client = tokio::spawn(send(gate.sock.clone(), "/v1/embed", embed_body("dropped")));
    let (stream, _) = gate.listener.accept().await.expect("accept");
    let conn = tokio::spawn(serve_dispatch(stream, gate.state.clone(), exchanges));

    drop(dispatched.recv().await.expect("dispatched"));
    conn.abort();
    let _ = conn.await;
    client.abort();

    next_embed_is_served(&gate, "next").await;
    let lines = trace_lines(&gate.trace);
    assert_eq!(lines.len(), 2, "{lines:?}");
    let pid = |line: &str| line.split(' ').nth(1).map(str::to_owned);
    assert_eq!(pid(&lines[0]), pid(&lines[1]), "the session was released, not replaced: {lines:?}");
}
