//! Stress tests — pool under load, cancel storms, session death.
//!
//! These are correctness tests under concurrency, not perf
//! benchmarks. Each test uses the real `js/session/bin.js` to
//! exercise the full spawn + readiness + dispatch + event-stream
//! pipeline end-to-end. Surfaces deadlocks, session-death recovery
//! races, and cancel-mid-stream leaks that unit tests miss.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::UnixStream;
use tokio::sync::Semaphore;

use async_trait::async_trait;

use mohdel_thin_gate::enforcer::Enforcer;
use mohdel_thin_gate::hooks::{
    QuotaError, QuotaPolicy, QuotaSpec, RequireInlineAuth, RouteDecision, RouteError, RoutePolicy,
};
use mohdel_thin_gate::protocol::{CallEnvelope, Event, Status};
use mohdel_thin_gate::{serve_data_with_state, GateState, SessionConfig, SessionPool};

// ---------- Harness ----------

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_sock(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-stress-{}-{}.sock",
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

fn node_session_cfg() -> SessionConfig {
    let bin = session_bin();
    assert!(bin.exists(), "session bin missing: {}", bin.display());
    let catalog_source: mohdel_thin_gate::CatalogSource =
        std::sync::Arc::new(|| Some(r#"{"echo/m":{}}"#.to_string()));
    SessionConfig {
        command: "node".to_string(),
        args: vec![bin.to_string_lossy().into_owned()],
        catalog: Some(catalog_source),
    }
}

// Permissive route + quota — stress tests want to hammer the pool,
// not the enforcement hooks (which have their own tests).
struct PassthroughRoute;
#[async_trait]
impl RoutePolicy for PassthroughRoute {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        Ok(RouteDecision {
            model_id: env.model.clone(),
            session_pool: None,
        })
    }
}

struct UnboundedQuota;
#[async_trait]
impl QuotaPolicy for UnboundedQuota {
    async fn policy_for(&self, _user_id: &str) -> Result<QuotaSpec, QuotaError> {
        Ok(QuotaSpec {
            rpm: None,
            tpm: None,
            cooldown_threshold: 99,
            cooldown_duration_ms: 60_000,
        })
    }
}

fn stress_state(pool: SessionPool) -> GateState {
    GateState {
        pool: Some(pool),
        route: Arc::new(PassthroughRoute),
        quota: Arc::new(UnboundedQuota),
        auth: Arc::new(RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    }
}

async fn wait_for(path: &Path) {
    for _ in 0..100 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("socket not bound: {}", path.display());
}

fn envelope(call_id: &str) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&json!({
            "callId": call_id,
            "authId": "stress",
            "auth": { "key": "k" },
            "model": "echo/m",
            "prompt": "hi"
        }))
        .unwrap(),
    )
}

async fn post(path: &Path, body: Bytes) -> Response<Incoming> {
    let stream = UnixStream::connect(path).await.expect("connect");
    let io = TokioIo::new(stream);
    let (mut sender, conn) = http1::handshake(io).await.expect("handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("POST")
        .uri("/v1/call")
        .header("host", "unix")
        .header("content-type", "application/json")
        .body(Full::new(body))
        .expect("build");
    sender.send_request(req).await.expect("send")
}

async fn drain_events(res: Response<Incoming>) -> Vec<Event> {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    std::str::from_utf8(&bytes)
        .unwrap()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).expect("parse event"))
        .collect()
}

/// Read only the first frame then drop the body, simulating a client
/// disconnect mid-stream. Returns the first frame's bytes for sanity.
async fn read_first_and_drop(res: Response<Incoming>) -> Bytes {
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body();
    let frame = body.frame().await.expect("frame").expect("frame ok");
    let bytes = frame.into_data().expect("data");
    drop(body);
    bytes
}

// ---------- Test A: concurrent load ----------

#[tokio::test]
async fn one_hundred_concurrent_calls_all_complete() {
    let path = temp_sock("concurrent-100");
    let _g = SocketGuard(path.clone());

    let pool = SessionPool::new(node_session_cfg(), 4)
        .await
        .expect("pool");
    let serve = path.clone();
    let state = stress_state(pool);
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve, state).await;
    });
    wait_for(&path).await;

    let started = Instant::now();
    // Semaphore bounds in-flight connections to avoid hitting fd
    // limits on the test host; the pool itself serializes to 4.
    let sem = Arc::new(Semaphore::new(64));
    let mut handles = Vec::with_capacity(100);
    for n in 0..100 {
        let path = path.clone();
        let sem = sem.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore");
            let res = post(&path, envelope(&format!("c{n}"))).await;
            drain_events(res).await
        }));
    }

    let mut completed = 0usize;
    for h in handles {
        let events = h.await.expect("task");
        match events.last().expect("at least one event") {
            Event::Done { result } => {
                assert_eq!(result.status, Status::Completed);
                completed += 1;
            }
            other => panic!("unexpected terminal: {other:?}"),
        }
    }
    assert_eq!(completed, 100);
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(15),
        "100 calls took {:?}, expected <15s",
        elapsed
    );

    server.abort();
}

// ---------- Test B: cancel storm ----------

#[tokio::test]
async fn cancel_storm_followed_by_healthy_calls() {
    let path = temp_sock("cancel-storm");
    let _g = SocketGuard(path.clone());

    let pool = SessionPool::new(node_session_cfg(), 2)
        .await
        .expect("pool");
    let serve = path.clone();
    let state = stress_state(pool);
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve, state).await;
    });
    wait_for(&path).await;

    // Fire a batch of requests that each disconnect after the first
    // frame. With pool size 2 and 20 cancels, cancel_and_drain /
    // spawn_replacement paths get hammered.
    for n in 0..20 {
        let res = post(&path, envelope(&format!("cancel-{n}"))).await;
        let _bytes = read_first_and_drop(res).await;
    }

    // Give graceful cancel + any respawns a moment to settle.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Now fire a batch of normal calls — all must complete, proving
    // the pool is healthy.
    for n in 0..10 {
        let res = post(&path, envelope(&format!("recover-{n}"))).await;
        let events = drain_events(res).await;
        match events.last().expect("terminal") {
            Event::Done { result } => assert_eq!(result.status, Status::Completed),
            other => panic!("recover-{n} non-done: {other:?}"),
        }
    }

    server.abort();
}

// ---------- Test C: session death under load ----------

/// Session that ponges once then exits on the first real envelope —
/// simulates a session crashing mid-call. Each subsequent spawn does
/// the same, so the pool is forced through the respawn-backoff +
/// readiness path repeatedly.
const SUICIDE_SESSION: &str = r#"
const { createInterface } = await import('node:readline');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o && o.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n');
    return;
  }
  // Real envelope — emit one delta then abruptly exit.
  process.stdout.write(JSON.stringify({
    type: 'delta',
    delta: { type: 'message', delta: 'x' }
  }) + '\n');
  process.exit(1);
});
"#;

#[tokio::test]
async fn session_death_triggers_respawn_and_later_calls_work() {
    let path = temp_sock("death");
    let _g = SocketGuard(path.clone());

    let cfg = SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            SUICIDE_SESSION.to_string(),
        ],
        catalog: None,
    };

    let pool = SessionPool::new(cfg, 2).await.expect("pool");
    let serve = path.clone();
    let state = stress_state(pool);
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve, state).await;
    });
    wait_for(&path).await;

    // Fire 5 sequential calls. Each session handles exactly one call
    // before dying, so every call should:
    //   1. get the adapter delta,
    //   2. then see a SESSION_DIED terminal error.
    // After each death, the pool respawns via the backoff path (no
    // failure → zero delay on success). Subsequent calls keep working
    // thanks to respawn.
    for n in 0..5 {
        let res = post(&path, envelope(&format!("die-{n}"))).await;
        let events = drain_events(res).await;
        let terminal = events.last().expect("terminal");
        match terminal {
            Event::Error { error } => {
                assert_eq!(
                    error.kind.as_deref(),
                    Some("SESSION_DIED"),
                    "call {n} terminal: {terminal:?}"
                );
            }
            other => panic!("call {n}: expected SESSION_DIED error, got {other:?}"),
        }
    }

    server.abort();
}
