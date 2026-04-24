//! Minimal embedder example — proves the crate can be used as a
//! library to compose a custom data-plane that adds routes alongside
//! mohdel's own `/v1/call` / `/v1/image`.
//!
//! This file doubles as a CI compile-check for the embedder surface.
//! Build it with:
//!
//!   cargo build --example embedder -p mohdel-thin-gate

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use mohdel_thin_gate::prelude::*;

/// Example custom `RoutePolicy` — in a real embedder this reads from
/// deployment-specific state (admin-pushed config, a file watcher,
/// a database). Here it's a passthrough.
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

/// Example custom `QuotaPolicy` — here a single permissive spec for
/// everyone. A real embedder looks up by `auth_id`.
struct PermissiveQuota;

#[async_trait]
impl QuotaPolicy for PermissiveQuota {
    async fn policy_for(&self, _auth_id: &str) -> Result<QuotaSpec, QuotaError> {
        Ok(QuotaSpec {
            rpm: None,
            tpm: None,
            cooldown_threshold: 3,
            cooldown_duration_ms: 60_000,
        })
    }
}

/// Embedder-added route. Demonstrates adding a handler alongside
/// mohdel's — e.g. a domain-specific orchestration endpoint backed by
/// the embedder's own subsystem.
async fn handle_custom(_req: Request<Incoming>) -> Response<Body> {
    let body = Full::new(Bytes::from_static(b"{\"hello\":\"embedder\"}\n")).boxed();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(body)
        .expect("response build")
}

/// Composed data-plane router — delegates to mohdel's public
/// handlers for mohdel routes, handles its own for the rest.
async fn custom_data_plane(
    req: Request<Incoming>,
    state: Arc<GateState>,
) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if method == Method::POST && path == "/v1/call" {
        handle_call(req, state).await
    } else if method == Method::POST && path == "/v1/image" {
        handle_image(req, state).await
    } else if method == Method::POST && path == "/v1/custom" {
        handle_custom(req).await
    } else {
        not_found_response(&method, &path)
    }
}

/// Minimal `main` — shows the assembly but doesn't bind sockets (so
/// the example builds in CI without side-effecting the environment).
/// A real embedder wires `serve_data_with_state` or an equivalent
/// hyper-served `custom_data_plane` bound to a unix socket.
#[allow(dead_code)]
fn main() {
    let _state = Arc::new(GateState {
        pool: None,
        route: Arc::new(PassthroughRoute),
        quota: Arc::new(PermissiveQuota),
        auth: Arc::new(mohdel_thin_gate::hooks::RequireInlineAuth),
        enforcer: Arc::new(Enforcer::new()),
    });

    // Real embedders: instantiate `SessionPool` for mohdel sessions
    // here via `SessionPool::spawn(&config)`, plug the `Some(pool)`
    // into `state.pool`, and call a hyper server loop that invokes
    // `custom_data_plane(req, state.clone()).await` per request.

    // Silence unused-fn warning for the composed router.
    let _ = custom_data_plane;

    // Metrics: for a real embedder, after calling your own init or
    // after a call that triggers mohdel's lazy init, use
    // `mohdel_thin_gate::metrics::meter_provider()` to build your
    // own instruments against the same OTLP exporter.
    let _ = mohdel_thin_gate::metrics::meter_provider;

    println!("embedder example built + wired; replace main() to run.");
}
