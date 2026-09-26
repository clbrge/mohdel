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
    AuthError, AuthPolicy, QuotaError, QuotaPolicy, QuotaSpec, RequireInlineAuth, RouteDecision,
    RouteError, RoutePolicy,
};
use mohdel_thin_gate::protocol::{Auth, CallEnvelope, Event};
use mohdel_thin_gate::secret::SecretString;
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
    post_to(path, "/v1/call", body).await
}

async fn post_to(path: &Path, uri: &str, body: Bytes) -> Response<Incoming> {
    let stream = UnixStream::connect(path).await.expect("connect");
    let io = TokioIo::new(stream);
    let (mut sender, conn) = http1::handshake(io).await.expect("handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("host", "unix")
        .header("content-type", "application/json")
        .body(Full::new(body))
        .expect("request build");
    sender.send_request(req).await.expect("send")
}

fn embed_bytes(auth_id: &str, inputs: usize) -> Bytes {
    let v = json!({
        "callId": "c1",
        "authId": auth_id,
        "auth": { "key": "sk" },
        "model": "cohere/embed-v4.0",
        "input": vec!["x"; inputs],
    });
    Bytes::from(serde_json::to_vec(&v).unwrap())
}

/// One-shot routes answer with a single JSON body rather than an event
/// stream, so the status carries as much as the payload.
async fn oneshot_error(res: Response<Incoming>) -> (StatusCode, String) {
    let status = res.status();
    let body = res.into_body().collect().await.expect("body").to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&body).expect("json body");
    let kind = v.get("type").and_then(|k| k.as_str()).unwrap_or_default().to_string();
    (status, kind)
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
            model_id: "openai/gpt-5-mini".into(),
            session_pool: None,
        })
    }
}

struct PermissiveRoute;
#[async_trait]
impl RoutePolicy for PermissiveRoute {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        Ok(RouteDecision {
            model_id: env.model.clone(),
            session_pool: None,
        })
    }
}

/// Resolves a key for `acme` and nothing else, so a test can tell a
/// route that consulted the policy from one that never asked.
struct AcmeOnlyAuth;
#[async_trait]
impl AuthPolicy for AcmeOnlyAuth {
    async fn resolve(&self, _auth_id: &str, model: &str) -> Result<Auth, AuthError> {
        match model.split('/').next() {
            Some("acme") => Ok(Auth {
                key: SecretString::new("sk-acme"),
            }),
            _ => Err(AuthError::ProviderNotConfigured(model.into())),
        }
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
        inpm: None,
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
            inpm: None,
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
            inpm: None,
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


/// `/v1/embed` dispatched straight to the pool once, with no quota and
/// no cooldown: a caller out of allowance on `/v1/call` could keep
/// embedding. The guard runs before the pool check, so a gate with no
/// pool still shows which of the two refused the call.
#[tokio::test]
async fn embed_route_enforces_quota() {
    let path = temp_sock("embed-quota");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(QuotaSpec {
            rpm: Some(1),
            tpm: None,
            inpm: None,
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

    let (status, kind) = oneshot_error(post_to(&path, "/v1/embed", embed_bytes("u1", 1)).await).await;
    assert_eq!(kind, "SESSION_POOL_UNAVAILABLE", "first call passes the guard");
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    let (status, kind) = oneshot_error(post_to(&path, "/v1/embed", embed_bytes("u1", 1)).await).await;
    assert_eq!(kind, "QUOTA_EXCEEDED");
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    server.abort();
}

/// Inputs per minute: the batch is admitted only when the whole of it
/// fits, which is what an endpoint metered in inputs rather than
/// requests needs.
#[tokio::test]
async fn embed_inpm_admits_only_a_batch_that_fits() {
    let path = temp_sock("embed-inpm");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(QuotaSpec {
            rpm: None,
            tpm: None,
            inpm: Some(100),
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

    let (_, kind) = oneshot_error(post_to(&path, "/v1/embed", embed_bytes("u1", 96)).await).await;
    assert_eq!(kind, "SESSION_POOL_UNAVAILABLE", "96 of 100 fits");

    let (status, kind) = oneshot_error(post_to(&path, "/v1/embed", embed_bytes("u1", 96)).await).await;
    assert_eq!(kind, "QUOTA_EXCEEDED", "another 96 does not");
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    let (_, kind) = oneshot_error(post_to(&path, "/v1/embed", embed_bytes("u2", 96)).await).await;
    assert_eq!(kind, "SESSION_POOL_UNAVAILABLE", "another caller has its own bucket");

    server.abort();
}

/// A batch larger than the entire allowance cannot be made to fit by
/// waiting, so it is sent rather than refused.
#[tokio::test]
async fn embed_oversized_batch_is_sent_not_refused() {
    let path = temp_sock("embed-oversized");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(QuotaSpec {
            rpm: None,
            tpm: None,
            inpm: Some(50),
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

    let (_, kind) = oneshot_error(post_to(&path, "/v1/embed", embed_bytes("u1", 96)).await).await;
    assert_eq!(kind, "SESSION_POOL_UNAVAILABLE");

    server.abort();
}

/// The other one-shot routes share the same guard.
#[tokio::test]
async fn image_route_enforces_quota() {
    let path = temp_sock("image-quota");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(QuotaSpec {
            rpm: Some(0),
            tpm: None,
            inpm: None,
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

    let image = json!({
        "callId": "c1",
        "authId": "u1",
        "auth": { "key": "sk" },
        "model": "openai/gpt-image-1",
        "prompt": "a cat"
    });
    let body = Bytes::from(serde_json::to_vec(&image).unwrap());
    let (status, kind) = oneshot_error(post_to(&path, "/v1/image", body).await).await;
    assert_eq!(kind, "QUOTA_EXCEEDED", "rpm 0 is a killswitch on every route");
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);

    server.abort();
}

/// Every route resolves a missing `auth` through the policy, not only
/// `/v1/call`: an embed or an image without inline auth reached the
/// session keyless.
#[tokio::test]
async fn oneshot_routes_resolve_auth_through_the_policy() {
    let path = temp_sock("oneshot-auth");
    let _g = SocketGuard(path.clone());

    let state = GateState {
        pool: None,
        route: Arc::new(PermissiveRoute),
        quota: Arc::new(FixedQuota(permissive_quota())),
        auth: Arc::new(AcmeOnlyAuth),
        enforcer: Arc::new(Enforcer::new()),
    };
    let serve_path = path.clone();
    let server = tokio::spawn(async move {
        let _ = serve_data_with_state(&serve_path, state).await;
    });
    wait_for(&path).await;

    let keyless = |model: &str, extra: serde_json::Value| {
        let mut v = json!({ "callId": "c1", "authId": "u1", "model": model });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        Bytes::from(serde_json::to_vec(&v).unwrap())
    };

    let (status, kind) = oneshot_error(
        post_to(&path, "/v1/embed", keyless("other/embed", json!({ "input": ["x"] }))).await,
    )
    .await;
    assert_eq!(kind, "AUTH_UNAVAILABLE", "embed asks the policy");
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (_, kind) = oneshot_error(
        post_to(&path, "/v1/embed", keyless("acme/embed", json!({ "input": ["x"] }))).await,
    )
    .await;
    assert_eq!(kind, "SESSION_POOL_UNAVAILABLE", "a resolved key passes on to dispatch");

    let (status, kind) = oneshot_error(
        post_to(&path, "/v1/image", keyless("other/image", json!({ "prompt": "a cat" }))).await,
    )
    .await;
    assert_eq!(kind, "AUTH_UNAVAILABLE", "image asks the policy");
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    server.abort();
}
