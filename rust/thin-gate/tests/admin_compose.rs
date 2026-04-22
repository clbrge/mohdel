//! Proves custom admin wrappers can compose their own service using
//! thin-gate's public helpers (`health_handler`, `typed_error_response`,
//! `not_found_response`) without forking `serve_admin`.
//!
//! This is the extension mechanism embedders use to add
//! deployment-specific admin routes.

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1 as client_http1;
use hyper::server::conn::http1 as server_http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{UnixListener, UnixStream};

use mohdel_thin_gate::{
    health_handler, not_found_response, typed_error_response, Body,
};

struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn temp_sock_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-thin-gate-compose-{}-{}.sock",
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

/// Example custom admin handler demonstrating composition:
/// - `GET /v1/health` → thin-gate's built-in health_handler
/// - `POST /v1/custom` → handler-defined extra route
/// - `GET /v1/custom-error` → uses typed_error_response with a
///   deployment-specific error code
/// - anything else → thin-gate's not_found_response
async fn custom_admin(req: Request<Incoming>, start: Instant) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    match (method.as_str(), path.as_str()) {
        ("GET", "/v1/health") => health_handler(start),
        ("POST", "/v1/custom") => typed_error_response(
            StatusCode::OK,
            mohdel_thin_gate::protocol::Severity::Info,
            "custom endpoint acknowledged",
            "",
            "custom.ack",
            false,
        ),
        ("GET", "/v1/custom-error") => typed_error_response(
            StatusCode::FORBIDDEN,
            mohdel_thin_gate::protocol::Severity::Error,
            "pretend this is a policy check",
            "",
            "custom.forbidden",
            false,
        ),
        _ => not_found_response(&method, &path),
    }
}

async fn serve_custom(path: &Path) {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).expect("bind");
    let start = Instant::now();
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(p) => p,
            Err(_) => return,
        };
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let svc = service_fn(move |req| async move {
                Ok::<_, Infallible>(custom_admin(req, start).await)
            });
            let _ = server_http1::Builder::new().serve_connection(io, svc).await;
        });
    }
}

async fn send(path: &Path, method: &str, uri: &str) -> (StatusCode, Bytes) {
    let stream = UnixStream::connect(path).await.expect("connect");
    let io = TokioIo::new(stream);
    let (mut sender, conn) = client_http1::handshake(io).await.expect("handshake");
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "unix")
        .body(Full::new(Bytes::new()))
        .expect("build");
    let res = sender.send_request(req).await.expect("send");
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, bytes)
}

#[tokio::test]
async fn custom_wrapper_reuses_builtin_health() {
    let path = temp_sock_path("health-reuse");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move { serve_custom(&serve_path).await });

    wait_for_socket(&path).await;
    let (status, body) = send(&path, "GET", "/v1/health").await;

    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], "ok");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));

    server.abort();
}

#[tokio::test]
async fn custom_wrapper_adds_its_own_routes() {
    let path = temp_sock_path("custom-route");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move { serve_custom(&serve_path).await });

    wait_for_socket(&path).await;
    let (status, body) = send(&path, "POST", "/v1/custom").await;

    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["type"], "custom.ack");
    assert_eq!(json["retryable"], false);

    server.abort();
}

#[tokio::test]
async fn custom_wrapper_uses_typed_error_for_policy() {
    let path = temp_sock_path("policy-error");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move { serve_custom(&serve_path).await });

    wait_for_socket(&path).await;
    let (status, body) = send(&path, "GET", "/v1/custom-error").await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["type"], "custom.forbidden");

    server.abort();
}

#[tokio::test]
async fn custom_wrapper_falls_back_to_not_found() {
    let path = temp_sock_path("not-found");
    let _guard = SocketGuard(path.clone());

    let serve_path = path.clone();
    let server = tokio::spawn(async move { serve_custom(&serve_path).await });

    wait_for_socket(&path).await;
    let (status, body) = send(&path, "GET", "/v1/nowhere").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["type"], "PROTOCOL_NOT_FOUND");

    server.abort();
}

// Silence unused-import warnings in older rustc; `Method` is used via
// as_str match above.
#[allow(dead_code)]
fn _method_used(_m: Method) {}
