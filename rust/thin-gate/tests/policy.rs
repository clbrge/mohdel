//! Policy enforcement tests — RoutePolicy + QuotaPolicy + Enforcer.
//!
//! Uses `serve_data_with_state` with custom mock policies to validate
//! that the gate actually calls the hooks and acts on their output
//! (rewrite / reject / throttle / cooldown).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::UnixStream;

use mohdel_thin_gate::enforcer::Enforcer;
use mohdel_thin_gate::hooks::{
    QuotaError, QuotaPolicy, QuotaSpec, RequireInlineAuth, RouteDecision, RouteError, RoutePolicy,
};
use mohdel_thin_gate::protocol::{CallEnvelope, Event};
use mohdel_thin_gate::{serve_data_with_state, GateState};

// ---------- Harness ----------

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_sock(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-policy-{}-{}.sock",
        std::process::id(),
        name
    ))
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
        .expect("request build");
    sender.send_request(req).await.expect("send")
}

fn envelope_bytes(auth_id: &str, provider: &str, model: &str) -> Bytes {
    let v = json!({
        "callId": "c1",
        "authId": auth_id,
        "auth": { "key": "sk" },
        "model": format!("{provider}/{model}"),
        "prompt": "hi"
    });
    Bytes::from(serde_json::to_vec(&v).unwrap())
}

async fn first_event(res: Response<Incoming>) -> Event {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body = std::str::from_utf8(&bytes).unwrap();
    let line = body.lines().find(|l| !l.is_empty()).expect("one event");
    serde_json::from_str(line).expect("parse event")
}

async fn last_event(res: Response<Incoming>) -> Event {
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body = std::str::from_utf8(&bytes).unwrap();
    let line = body
        .lines()
        .filter(|l| !l.is_empty())
        .last()
        .expect("at least one event");
    serde_json::from_str(line).expect("parse event")
}

// ---------- Mock policies ----------

struct RejectingRoute;
#[async_trait]
impl RoutePolicy for RejectingRoute {
    async fn resolve(&self, _env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        Err(RouteError::UnknownModel("not-in-catalog".into()))
    }
}

struct RewritingRoute;
#[async_trait]
impl RoutePolicy for RewritingRoute {
    async fn resolve(&self, _env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        Ok(RouteDecision {
            provider: "openai".into(),
            model_id: "gpt-5-mini".into(),
            session_pool: None,
        })
    }
}

struct PermissiveRoute;
#[async_trait]
impl RoutePolicy for PermissiveRoute {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        Ok(RouteDecision {
            provider: env.provider.clone(),
            model_id: env.model.clone(),
            session_pool: None,
        })
    }
}

struct FailingQuota;
#[async_trait]
impl QuotaPolicy for FailingQuota {
    async fn policy_for(&self, user_id: &str) -> Result<QuotaSpec, QuotaError> {
        Err(QuotaError::UnknownUser(user_id.into()))
    }
}

/// Returns a fixed QuotaSpec — useful for tight rpm/threshold tests.
struct FixedQuota(QuotaSpec);
#[async_trait]
impl QuotaPolicy for FixedQuota {
    async fn policy_for(&self, _user_id: &str) -> Result<QuotaSpec, QuotaError> {
        Ok(self.0.clone())
    }
}

fn permissive_quota() -> QuotaSpec {
    QuotaSpec {
        rpm: None,
        tpm: None,
        cooldown_threshold: 3,
        cooldown_duration_ms: 60_000,
    }
}

// ---------- Tests ----------

#[tokio::test]
async fn route_rejection_yields_route_rejected_event() {
    let path = temp_sock("route-reject");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(RejectingRoute),
        quota: Arc::new(FixedQuota(permissive_quota())),
        auth: Arc::new(RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    let res = post(&path, envelope_bytes("u1", "fake", "fake-model")).await;
    assert_eq!(res.status(), StatusCode::OK);
    match first_event(res).await {
        Event::Error { error } => {
            assert_eq!(error.kind.as_deref(), Some("ROUTE_REJECTED"));
            assert!(error.detail.as_deref().unwrap().contains("not-in-catalog"));
        }
        other => panic!("expected error event, got {other:?}"),
    }
    server.abort();
}

#[tokio::test]
async fn quota_policy_error_yields_quota_policy_error_event() {
    let path = temp_sock("quota-err");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FailingQuota),
        auth: Arc::new(RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    let res = post(&path, envelope_bytes("unknown-user", "openai", "gpt-5")).await;
    match first_event(res).await {
        Event::Error { error } => {
            assert_eq!(error.kind.as_deref(), Some("QUOTA_POLICY_ERROR"));
        }
        other => panic!("expected error event, got {other:?}"),
    }
    server.abort();
}

#[tokio::test]
async fn rpm_exhaustion_yields_quota_exceeded() {
    let path = temp_sock("rpm");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(QuotaSpec {
            rpm: Some(1),
            tpm: None,
            cooldown_threshold: 99,
            cooldown_duration_ms: 60_000,
        })),
        auth: Arc::new(RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    // First call succeeds (synthetic path).
    let res = post(&path, envelope_bytes("u1", "openai", "gpt-5")).await;
    match last_event(res).await {
        Event::Done { .. } => {}
        other => panic!("first call should succeed, got {other:?}"),
    }

    // Second call within the same minute is blocked.
    let res = post(&path, envelope_bytes("u1", "openai", "gpt-5")).await;
    match first_event(res).await {
        Event::Error { error } => {
            assert_eq!(error.kind.as_deref(), Some("QUOTA_EXCEEDED"));
        }
        other => panic!("expected QUOTA_EXCEEDED, got {other:?}"),
    }
    server.abort();
}

#[tokio::test]
async fn rpm_isolation_between_users() {
    let path = temp_sock("rpm-iso");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(QuotaSpec {
            rpm: Some(1),
            tpm: None,
            cooldown_threshold: 99,
            cooldown_duration_ms: 60_000,
        })),
        auth: Arc::new(RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    let _ = post(&path, envelope_bytes("u1", "openai", "gpt-5")).await;
    let res = post(&path, envelope_bytes("u2", "openai", "gpt-5")).await;
    match last_event(res).await {
        Event::Done { .. } => {}
        other => panic!("u2 should not share u1's bucket, got {other:?}"),
    }
    server.abort();
}

#[tokio::test]
async fn primed_cooldown_fast_fails_before_dispatch() {
    let path = temp_sock("cooldown");
    let _g = SocketGuard(path.clone());

    let enforcer = Arc::new(Enforcer::new());
    // Prime cooldown for (auth=u1, provider=openai) via an auth failure.
    enforcer.cooldown.record_failure(
        "u1|openai",
        3,
        Duration::from_secs(60),
        true, // immediate
    );

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(permissive_quota())),
        auth: Arc::new(RequireInlineAuth),
        enforcer: enforcer.clone(),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    let res = post(&path, envelope_bytes("u1", "openai", "gpt-5")).await;
    match first_event(res).await {
        Event::Error { error } => {
            assert_eq!(error.kind.as_deref(), Some("PROVIDER_COOLDOWN"));
            assert!(error.retryable);
        }
        other => panic!("expected PROVIDER_COOLDOWN, got {other:?}"),
    }

    // Different provider for the same user is unaffected.
    let res = post(&path, envelope_bytes("u1", "anthropic", "claude")).await;
    match last_event(res).await {
        Event::Done { .. } => {}
        other => panic!("anthropic should be independent, got {other:?}"),
    }
    server.abort();
}

#[tokio::test]
async fn successful_call_resets_cooldown_counter() {
    let path = temp_sock("cd-reset");
    let _g = SocketGuard(path.clone());

    let enforcer = Arc::new(Enforcer::new());
    // Record two failures — below threshold=3.
    enforcer.cooldown.record_failure(
        "u1|openai",
        3,
        Duration::from_secs(60),
        false,
    );
    enforcer.cooldown.record_failure(
        "u1|openai",
        3,
        Duration::from_secs(60),
        false,
    );

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(permissive_quota())),
        auth: Arc::new(RequireInlineAuth),
        enforcer: enforcer.clone(),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    // Synthetic success resets via apply_enforcer_feedback.
    let _ = post(&path, envelope_bytes("u1", "openai", "gpt-5")).await;

    // Two more failures would hit threshold=3 from stale counter, but
    // after reset they should not activate the cooldown.
    enforcer.cooldown.record_failure(
        "u1|openai",
        3,
        Duration::from_secs(60),
        false,
    );
    enforcer.cooldown.record_failure(
        "u1|openai",
        3,
        Duration::from_secs(60),
        false,
    );
    assert!(
        enforcer.cooldown.cooling_down("u1|openai").is_none(),
        "reset should have cleared the counter"
    );

    server.abort();
}

#[tokio::test]
async fn route_rewrite_reaches_downstream_envelope() {
    // With pool=None we can't observe the rewritten envelope directly,
    // but we can at least confirm the synthetic path runs to
    // completion after the rewrite (not rejected).
    let path = temp_sock("rewrite");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(RewritingRoute),
        quota: Arc::new(FixedQuota(permissive_quota())),
        auth: Arc::new(RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    let res = post(&path, envelope_bytes("u1", "anything", "anything")).await;
    match last_event(res).await {
        Event::Done { .. } => {}
        other => panic!("rewrite path should reach done, got {other:?}"),
    }
    server.abort();
}
