//! HTTP server for thin-gate — two planes on two unix sockets.
//!
//! **Data plane** (`serve_data`): inference traffic.
//!   - `POST /v1/call` — parses `CallEnvelope`, streams 3-event NDJSON
//!     (`delta` / `done` / `error`). With a `SessionPool`, dispatches
//!     to a pooled subprocess per call. Without a pool, synthetic
//!     fallback sequence (tests/demos).
//!   - Before dispatch: `RoutePolicy` rewrites `(provider, model)` or
//!     rejects; `QuotaPolicy` yields the per-user spec; the
//!     `Enforcer` checks cooldown + minute-bucket counters. Over-quota
//!     / cooldown calls resolve to `Event::Error` inside the stream,
//!     never reach the session.
//!   - Post-dispatch: `done` resets cooldown and records token usage;
//!     adapter error events feed `recordFailure` (immediate for
//!     `AUTH_INVALID`).
//!   - anything else → 404 + `TypedError`.
//!
//! **Admin plane** (`serve_admin`): `GET /v1/health`.
//!
//! `GateState` bundles pool + policies + enforcer. `serve_data(path,
//! pool)` is a convenience that builds the defaults; tests override
//! via `serve_data_with_state`.

use std::convert::Infallible;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::stream;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, LengthLimitError, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

use crate::defaults::{FileQuotaPolicy, FileRoutePolicy};
use crate::enforcer::{cooldown_key, Enforcer};
use crate::hooks::{AuthPolicy, QuotaPolicy, QuotaSpec, RequireInlineAuth, RoutePolicy};
use crate::metrics;
use crate::protocol::{
    AnswerResult, CallEnvelope, DeltaChunk, DeltaKind, Event, ImageEnvelope, ImageResult,
    Severity, Status, TypedError,
};
use crate::session_pool::{PooledSession, SessionPool};

pub type Body = BoxBody<Bytes, Infallible>;

#[derive(Clone, Default)]
pub struct SessionConfig {
    pub command: String,
    pub args: Vec<String>,
    /// Catalog source. When `Some`, thin-gate calls the closure once
    /// per session spawn, serializes the JSON string it returns as
    /// `{"op":"set_catalog","table":<...>}`, and writes it to the
    /// session's stdin right after readiness. Callback lets the
    /// embedder return a fresh snapshot each time (supporting admin-
    /// push style catalog updates) without thin-gate caching any
    /// catalog state.
    ///
    /// `None` = no injection, session falls back to its built-in
    /// disk load from `~/.config/mohdel/`. Suitable for the standalone
    /// CLI path.
    pub catalog: Option<CatalogSource>,
}

impl std::fmt::Debug for SessionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionConfig")
            .field("command", &self.command)
            .field("args", &self.args)
            .field("catalog", &self.catalog.as_ref().map(|_| "<CatalogSource>"))
            .finish()
    }
}

/// Callback returning the current catalog as a JSON string (top-level
/// object, keyed by `<provider>/<model>`). `None` from the callback
/// means "catalog not available right now" — thin-gate still spawns
/// the session but skips the `set_catalog` injection (gate-level
/// policy in the embedder should already be returning
/// `CONFIG_NOT_LOADED` to callers before a session is reached).
pub type CatalogSource = std::sync::Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// Shared gate state. Each HTTP connection task gets its own clone.
/// `route` / `quota` / `enforcer` are Arc-wrapped so all tasks see a
/// single coordinated view; `pool` already clones cheaply (Arc
/// internally).
#[derive(Clone)]
pub struct GateState {
    pub pool: Option<SessionPool>,
    pub route: Arc<dyn RoutePolicy>,
    pub quota: Arc<dyn QuotaPolicy>,
    pub auth: Arc<dyn AuthPolicy>,
    pub enforcer: Arc<Enforcer>,
}

impl GateState {
    /// Build a GateState wrapping the given pool with default
    /// passthrough route + permissive quota. Custom deployments
    /// override by constructing the state themselves with
    /// alternative hook impls and calling `serve_data_with_state`.
    pub fn with_defaults(pool: Option<SessionPool>) -> Self {
        Self {
            pool,
            route: Arc::new(FileRoutePolicy::new()),
            quota: Arc::new(FileQuotaPolicy::new()),
            auth: Arc::new(RequireInlineAuth),
            enforcer: Arc::new(Enforcer::new()),
        }
    }
}

#[derive(Debug, Error)]
pub enum ServeError {
    #[error("bind {path}: {source}")]
    Bind {
        path: String,
        source: std::io::Error,
    },
    #[error("accept: {0}")]
    Accept(std::io::Error),
}

pub async fn serve_data(path: &Path, pool: Option<SessionPool>) -> Result<(), ServeError> {
    serve_data_with_state(path, GateState::with_defaults(pool)).await
}

pub async fn serve_data_with_state(path: &Path, state: GateState) -> Result<(), ServeError> {
    let listener = bind(path)?;
    let state = Arc::new(state);
    loop {
        let (stream, _addr) = listener.accept().await.map_err(ServeError::Accept)?;
        let state = state.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let svc = service_fn(move |req| {
                let state = state.clone();
                async move { Ok::<_, Infallible>(handle_data(req, state).await) }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                eprintln!("data connection error: {e:?}");
            }
        });
    }
}

pub async fn serve_admin(path: &Path) -> Result<(), ServeError> {
    let listener = bind(path)?;
    let start = Instant::now();
    loop {
        let (stream, _addr) = listener.accept().await.map_err(ServeError::Accept)?;
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let svc = service_fn(move |req| async move {
                Ok::<_, Infallible>(handle_admin(req, start).await)
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                eprintln!("admin connection error: {e:?}");
            }
        });
    }
}

/// Bind a unix socket at `path` and chmod it to `0o600`
/// (owner-only). `UnixListener::bind` honors the process umask,
/// which on default shells is `0o022` and yields a world-connectable
/// socket — a local privilege-escalation vector on shared hosts.
/// `pub` so `tests/socket_cleanup.rs` can verify the mode directly.
pub fn bind(path: &Path) -> Result<UnixListener, ServeError> {
    use std::os::unix::fs::PermissionsExt;

    remove_stale_socket(path)?;
    let listener = UnixListener::bind(path).map_err(|e| ServeError::Bind {
        path: path.display().to_string(),
        source: e,
    })?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| ServeError::Bind {
            path: path.display().to_string(),
            source: e,
        })?;
    Ok(listener)
}

/// Remove a leftover unix socket at `path`, if one is there.
///
/// Refuses to touch anything else — a regular file, directory,
/// symlink, or other special file at this location likely belongs to
/// a different program and must not be silently overwritten. The
/// prior implementation called `remove_file` unconditionally which
/// could clobber a misconfigured path.
pub fn remove_stale_socket(path: &Path) -> Result<(), ServeError> {
    use std::os::unix::fs::FileTypeExt;

    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => {
            std::fs::remove_file(path).map_err(|e| ServeError::Bind {
                path: path.display().to_string(),
                source: e,
            })
        }
        Ok(_) => Err(ServeError::Bind {
            path: path.display().to_string(),
            source: std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "path exists but is not a unix socket — refusing to overwrite",
            ),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(ServeError::Bind {
            path: path.display().to_string(),
            source: e,
        }),
    }
}

// ---------- Data plane ----------

async fn handle_data(req: Request<Incoming>, state: Arc<GateState>) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if method == Method::POST && path == "/v1/call" {
        handle_call(req, state).await
    } else if method == Method::POST && path == "/v1/image" {
        handle_image(req, state).await
    } else {
        not_found_response(&method, &path)
    }
}

/// Maximum accepted `POST /v1/call` body size. Generous enough to
/// fit any realistic prompt including maxed-out Gemini 2M-token
/// contexts and multi-image inline workloads; tight enough that one
/// pathological caller can't OOM the gate and take down every tenant
/// sharing it. Raise this if provider context windows keep growing.
const MAX_CALL_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Per-line cap for NDJSON read from session stdout. A session that
/// emits 16 MiB without a newline is considered broken (runaway
/// serializer, missing newline, hung subprocess writing garbage).
/// The existing SESSION_IO_ERROR kill-and-replace path handles it.
const MAX_NDJSON_LINE_BYTES: usize = 16 * 1024 * 1024;

/// HTTP handler for `POST /v1/call`. Embedders composing their own
/// data-plane router (e.g. to add routes alongside `/v1/call`) call
/// this directly; the default `serve_data_with_state` uses it via
/// `handle_data`.
pub async fn handle_call(req: Request<Incoming>, state: Arc<GateState>) -> Response<Body> {
    // We fully buffer the body before parsing. Moot in practice
    // because images/videos travel as `fileUri` references (not
    // inline payloads), so the envelope is small. Pipelining
    // body-read with policy load would shave a few ms on large
    // inline payloads but isn't worth the restructuring cost.
    let body = match Limited::new(req.into_body(), MAX_CALL_BODY_BYTES).collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => {
            let too_large = e.downcast_ref::<LengthLimitError>().is_some();
            return typed_error_response(
                if too_large { StatusCode::PAYLOAD_TOO_LARGE } else { StatusCode::BAD_REQUEST },
                Severity::Error,
                if too_large {
                    "request body exceeds maximum size"
                } else {
                    "failed to read request body"
                },
                &format!("{e}"),
                if too_large { "PROTOCOL_PAYLOAD_TOO_LARGE" } else { "PROTOCOL_READ_BODY" },
                false,
            );
        }
    };

    let mut envelope: CallEnvelope = match serde_json::from_slice::<CallEnvelope>(&body) {
        Ok(e) => {
            if crate::protocol::split_model_id(&e.model).is_none() {
                return typed_error_response(
                    StatusCode::BAD_REQUEST,
                    Severity::Error,
                    "invalid envelope",
                    &format!("model must be '<provider>/<id>' (got: {})", e.model),
                    "PROTOCOL_INVALID_ENVELOPE",
                    false,
                );
            }
            e
        }
        Err(e) => {
            // F48: `format!("{e}")` here is safe *because* stock serde
            // errors carry field names + line/column but not the
            // offending values. If this parse is ever routed through
            // `serde_path_to_error` or a custom deserializer that
            // echoes the input, sanitize before putting it in detail —
            // request bodies may contain auth keys.
            return typed_error_response(
                StatusCode::BAD_REQUEST,
                Severity::Error,
                "invalid envelope",
                &format!("{e}"),
                "PROTOCOL_INVALID_ENVELOPE",
                false,
            );
        }
    };

    // Gate-side span for the `/v1/call` handling — covers route +
    // auth + quota + session acquire + envelope forward. Rooted at
    // the envelope's W3C `traceparent`; drops at end of function.
    // No-op when no TracerProvider is registered globally.
    let _gate_span = {
        use opentelemetry::global;
        use opentelemetry::trace::{Span, Tracer};
        let parent = crate::tracing::parent_context(envelope.traceparent.as_deref());
        let mut s = global::tracer("mohdel-thin-gate")
            .start_with_context("mohdel.gate.call", &parent);
        s.set_attribute(opentelemetry::KeyValue::new(
            "auth.id",
            envelope.auth_id.clone(),
        ));
        s.set_attribute(opentelemetry::KeyValue::new(
            "mohdel.model",
            envelope.model.clone(),
        ));
        s
    };

    // RoutePolicy: rewrite or reject before we touch quota/enforcer.
    match state.route.resolve(&envelope).await {
        Ok(decision) => {
            envelope.model = decision.model_id;
        }
        Err(e) => {
            metrics::policy_error("ROUTE_REJECTED");
            return stream_error(
                "route rejected",
                Severity::Error,
                "ROUTE_REJECTED",
                false,
                Some(e.to_string()),
            );
        }
    }

    // AuthPolicy: if the caller didn't supply `auth` inline, ask the
    // configured policy to resolve one (typically from a provider →
    // key map pushed by a supervisor). Session subprocesses still
    // receive the resolved auth on the serialized envelope.
    if envelope.auth.is_none() {
        match state.auth.resolve(&envelope).await {
            Ok(resolved) => envelope.auth = Some(resolved),
            Err(e) => {
                metrics::policy_error("AUTH_UNAVAILABLE");
                return typed_error_response(
                    StatusCode::UNAUTHORIZED,
                    Severity::Error,
                    "auth unavailable",
                    &e.to_string(),
                    "AUTH_UNAVAILABLE",
                    false,
                );
            }
        }
    }

    // QuotaPolicy: per-user spec for rpm/tpm/cooldown thresholds.
    let spec = match state.quota.policy_for(&envelope.auth_id).await {
        Ok(s) => s,
        Err(e) => {
            metrics::policy_error("QUOTA_POLICY_ERROR");
            return stream_error(
                "quota policy error",
                Severity::Error,
                "QUOTA_POLICY_ERROR",
                false,
                Some(e.to_string()),
            );
        }
    };

    // Enforcer: cooldown check first (cheap fast-fail), then rpm/tpm.
    let provider = crate::protocol::provider_of(&envelope.model);
    let cd_key = cooldown_key(&envelope.auth_id, provider);
    if let Some(info) = state.enforcer.cooldown.cooling_down(&cd_key) {
        metrics::cooldown_rejected(provider);
        return stream_error(
            "provider in cooldown",
            Severity::Warn,
            "PROVIDER_COOLDOWN",
            true,
            Some(format!(
                "{} is in cooldown for {}s after {} consecutive failures ({})",
                provider, info.seconds_left, info.fail_count, info.reason
            )),
        );
    }

    let delay_ms = state
        .enforcer
        .rate
        .check(&envelope.auth_id, spec.rpm, spec.tpm);
    if delay_ms > 0 {
        metrics::quota_rejected();
        return stream_error(
            "rate limit exceeded",
            Severity::Warn,
            "QUOTA_EXCEEDED",
            true,
            Some(format!("retry after {delay_ms}ms")),
        );
    }

    state.enforcer.rate.record_request(&envelope.auth_id);

    match &state.pool {
        Some(pool) => dispatch_via_pool(pool.clone(), &envelope, spec, state.enforcer.clone()).await,
        None => synthetic_response(&envelope, spec, state.enforcer.clone()),
    }
}

// ---------- Pool dispatch ----------

async fn dispatch_via_pool(
    pool: SessionPool,
    envelope: &CallEnvelope,
    spec: QuotaSpec,
    enforcer: Arc<Enforcer>,
) -> Response<Body> {
    let mut session = match pool.acquire().await {
        Some(s) => s,
        None => {
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Fatal,
                "session pool is closed",
                "pool returned None on acquire",
                "SESSION_POOL_CLOSED",
                false,
            );
        }
    };

    let envelope_bytes = match serde_json::to_vec(envelope) {
        Ok(b) => b,
        Err(e) => {
            pool.release(session);
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Error,
                "failed to serialize envelope",
                &format!("{e}"),
                "PROTOCOL_SERIALIZE",
                false,
            );
        }
    };

    let write_result = async {
        session.stdin.write_all(&envelope_bytes).await?;
        session.stdin.write_all(b"\n").await?;
        session.stdin.flush().await
    }
    .await;

    if let Err(e) = write_result {
        pool.discard(session);
        return typed_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            Severity::Error,
            "failed to write envelope to session stdin",
            &format!("{e}"),
            "SESSION_STDIN_WRITE_FAILED",
            true,
        );
    }

    let state = PoolStreamState {
        session: Some(session),
        pool,
        call_id: envelope.call_id.clone(),
        auth_id: envelope.auth_id.clone(),
        provider: crate::protocol::provider_of(&envelope.model).to_string(),
        spec,
        enforcer,
        stopped: false,
        started_at: Instant::now(),
        recorded: false,
    };
    let body_stream = stream::unfold(state, pool_stream_next);
    let body = StreamBody::new(body_stream).boxed();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .expect("response build")
}

const CANCEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

struct PoolStreamState {
    session: Option<PooledSession>,
    pool: SessionPool,
    call_id: String,
    auth_id: String,
    provider: String,
    spec: QuotaSpec,
    enforcer: Arc<Enforcer>,
    stopped: bool,
    started_at: Instant,
    recorded: bool,
}

impl Drop for PoolStreamState {
    fn drop(&mut self) {
        if let Some(sess) = self.session.take() {
            let pool = self.pool.clone();
            let call_id = self.call_id.clone();
            tokio::spawn(async move {
                match sess.cancel_and_drain(&call_id, CANCEL_DRAIN_TIMEOUT).await {
                    Ok(clean_sess) => pool.release(clean_sess),
                    Err(()) => {
                        // cancel_and_drain already consumed/dropped the
                        // session, so we can't route through `discard`
                        // — just balance the bookkeeping that `acquire`
                        // set up and queue a replacement.
                        metrics::pool_in_use_delta(-1);
                        metrics::session_alive_delta(-1);
                        pool.spawn_replacement();
                    }
                }
            });
        }
    }
}

/// Like `AsyncBufReadExt::read_line`, but bails with `io::ErrorKind::InvalidData`
/// once accumulated bytes exceed `cap` without a newline. Prevents a session
/// that stops emitting `\n` (serializer wedge, stuck write) from ballooning
/// the buffer to OOM.
async fn read_capped_line<R>(
    reader: &mut R,
    dst: &mut String,
    cap: usize,
) -> std::io::Result<usize>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        let available = match reader.fill_buf().await {
            Ok(b) => b,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            break;
        }
        if let Some(nl_pos) = available.iter().position(|&b| b == b'\n') {
            let take = nl_pos + 1;
            if bytes.len() + take > cap {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("session line exceeds {cap} bytes without newline"),
                ));
            }
            bytes.extend_from_slice(&available[..take]);
            reader.consume(take);
            break;
        }
        if bytes.len() + available.len() > cap {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("session line exceeds {cap} bytes without newline"),
            ));
        }
        bytes.extend_from_slice(available);
        let n = available.len();
        reader.consume(n);
    }
    if bytes.is_empty() {
        return Ok(0);
    }
    let s = String::from_utf8(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let n = s.len();
    dst.push_str(&s);
    Ok(n)
}

async fn pool_stream_next(
    mut state: PoolStreamState,
) -> Option<(Result<Frame<Bytes>, Infallible>, PoolStreamState)> {
    if state.stopped {
        if let Some(sess) = state.session.take() {
            state.pool.release(sess);
        }
        return None;
    }

    let session = state.session.as_mut().expect("session held until terminal");
    let mut buf = String::new();
    let read = read_capped_line(&mut session.reader, &mut buf, MAX_NDJSON_LINE_BYTES).await;

    match read {
        Ok(0) => {
            kill_and_replace(&mut state);
            record_call_metric(&mut state, "error");
            state.stopped = true;
            Some((
                Ok(Frame::data(terminal_error_line(
                    "session subprocess exited mid-call",
                    Severity::Error,
                    "SESSION_DIED",
                    true,
                ))),
                state,
            ))
        }
        Err(e) => {
            kill_and_replace(&mut state);
            record_call_metric(&mut state, "error");
            state.stopped = true;
            Some((
                Ok(Frame::data(terminal_error_line(
                    &format!("error reading session stdout: {e}"),
                    Severity::Error,
                    "SESSION_IO_ERROR",
                    true,
                ))),
                state,
            ))
        }
        Ok(_) => {
            // F51: strip trailing CRLF in place instead of allocating
            // `trimmed.to_string()`. The buffer is then reused as the
            // outgoing frame (zero-copy via `Bytes::from(String)`).
            while buf.ends_with('\r') || buf.ends_with('\n') {
                buf.pop();
            }
            if buf.is_empty() {
                return Some((Ok(Frame::data(Bytes::new())), state));
            }

            // F52: delta fast-path. Most events in a streaming call
            // are deltas, and the gate does nothing with delta
            // content (`apply_enforcer_feedback` has an empty Delta
            // arm). Skip the full serde parse when we can identify
            // the shape by prefix. Requires: JS session emits `type`
            // as the first JSON key — formalized in
            // PROTOCOL.md §4.
            if buf.starts_with(DELTA_PREFIX) {
                buf.push('\n');
                return Some((Ok(Frame::data(Bytes::from(buf))), state));
            }

            match serde_json::from_str::<Event>(&buf) {
                Ok(event) => {
                    apply_enforcer_feedback(&mut state, &event);
                    let is_terminal = matches!(event, Event::Done { .. } | Event::Error { .. });
                    if is_terminal {
                        // Release the session in the SAME poll that emits the
                        // terminal. If we only set `stopped = true` and waited
                        // for the next poll to release, a client disconnect
                        // between the two polls would drop `PoolStreamState`
                        // with `session = Some`, triggering cancel_and_drain
                        // on an already-idle session — 2 s timeout + kill +
                        // respawn for nothing.
                        if let Some(sess) = state.session.take() {
                            state.pool.release(sess);
                        }
                        state.stopped = true;
                    }
                    buf.push('\n');
                    Some((Ok(Frame::data(Bytes::from(buf))), state))
                }
                Err(e) => {
                    kill_and_replace(&mut state);
                    record_call_metric(&mut state, "error");
                    state.stopped = true;
                    Some((
                        Ok(Frame::data(terminal_error_line(
                            &format!("session emitted non-Event line: {e}"),
                            Severity::Error,
                            "SESSION_INVALID_EVENT",
                            false,
                        ))),
                        state,
                    ))
                }
            }
        }
    }
}

/// Prefix of any serialized `Event::Delta`. Matches the JS emission
/// shape `{"type":"delta", ...}`. The JS session emits `type` first
/// by insertion order; if that ever breaks, the fast-path misses
/// (no correctness issue, just a perf regression).
const DELTA_PREFIX: &str = "{\"type\":\"delta\"";

/// Whether a `done` event's `result` represents genuine provider
/// recovery (i.e. should reset an accumulated cooldown streak).
/// Cancellation is the caller's action — it says nothing about
/// whether the provider is healthy — so don't clear failures on it.
pub(crate) fn done_signals_provider_recovery(result: &AnswerResult) -> bool {
    result.warning.as_deref() != Some("cancelled")
}

fn apply_enforcer_feedback(state: &mut PoolStreamState, event: &Event) {
    let cd_key = cooldown_key(&state.auth_id, &state.provider);
    match event {
        Event::Done { result } => {
            if done_signals_provider_recovery(result) {
                state.enforcer.cooldown.reset(&cd_key);
            }
            let total = result.input_tokens as u64
                + result.output_tokens as u64
                + result.thinking_tokens as u64;
            state.enforcer.rate.record_tokens(&state.auth_id, total);
            record_call_metric(state, status_label(&result.status));
        }
        Event::Error { error } => {
            let immediate = matches!(error.kind.as_deref(), Some("AUTH_INVALID"));
            if immediate || error.retryable {
                state.enforcer.cooldown.record_failure(
                    &cd_key,
                    state.spec.cooldown_threshold,
                    Duration::from_millis(state.spec.cooldown_duration_ms),
                    immediate,
                );
            }
            record_call_metric(state, "error");
        }
        Event::Delta { .. } => {}
    }
}

fn status_label(status: &Status) -> &'static str {
    match status {
        Status::Completed => "completed",
        Status::ToolUse => "tool_use",
        Status::Incomplete => "incomplete",
    }
}

fn record_call_metric(state: &mut PoolStreamState, status: &str) {
    if state.recorded {
        return;
    }
    state.recorded = true;
    let elapsed_ms = state.started_at.elapsed().as_secs_f64() * 1000.0;
    metrics::record_call(&state.provider, status, elapsed_ms);
}

fn kill_and_replace(state: &mut PoolStreamState) {
    if let Some(sess) = state.session.take() {
        state.pool.discard(sess);
    }
}

fn terminal_error_line(
    message: &str,
    severity: Severity,
    kind: &str,
    retryable: bool,
) -> Bytes {
    let event = Event::Error {
        error: TypedError {
            message: message.to_string(),
            detail: None,
            severity,
            retryable,
            kind: Some(kind.to_string()),
        },
    };
    let mut out = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
    out.push('\n');
    Bytes::from(out)
}

/// Policy or enforcer rejection emits a 200 OK with a single
/// `Event::Error` NDJSON line — matches the shape callers already see
/// for adapter-originated errors and keeps the streaming contract
/// uniform (one terminal event per call).
fn stream_error(
    message: &str,
    severity: Severity,
    kind: &str,
    retryable: bool,
    detail: Option<String>,
) -> Response<Body> {
    let event = Event::Error {
        error: TypedError {
            message: message.to_string(),
            detail,
            severity,
            retryable,
            kind: Some(kind.to_string()),
        },
    };
    let mut out = serde_json::to_vec(&event).unwrap_or_else(|_| b"{}".to_vec());
    out.push(b'\n');
    let body = Full::new(Bytes::from(out)).boxed();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .expect("response build")
}

// ---------- Image path ----------
//
// One-shot request/response: no streaming, no enforcer (cooldown /
// rate-limit skipped — images are low-frequency one-shots, see
// `js/session/run_image.js` for the matching session-side policy).
// Session-side dispatch is tagged with `op: "image"` on stdin so
// the driver can route to `runImage()`. Response line shape:
// `{type:"image_done", result}` on success, `{type:"error", error}`
// on adapter failure.

/// HTTP handler for `POST /v1/image`. See `handle_call` for the
/// composition use case.
pub async fn handle_image(req: Request<Incoming>, state: Arc<GateState>) -> Response<Body> {
    let body = match Limited::new(req.into_body(), MAX_CALL_BODY_BYTES).collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => {
            let too_large = e.downcast_ref::<LengthLimitError>().is_some();
            return typed_error_response(
                if too_large { StatusCode::PAYLOAD_TOO_LARGE } else { StatusCode::BAD_REQUEST },
                Severity::Error,
                if too_large { "request body exceeds maximum size" } else { "failed to read request body" },
                &format!("{e}"),
                if too_large { "PROTOCOL_PAYLOAD_TOO_LARGE" } else { "PROTOCOL_READ_BODY" },
                false,
            );
        }
    };

    let envelope: ImageEnvelope = match serde_json::from_slice::<ImageEnvelope>(&body) {
        Ok(e) => {
            if crate::protocol::split_model_id(&e.model).is_none() {
                return typed_error_response(
                    StatusCode::BAD_REQUEST,
                    Severity::Error,
                    "invalid envelope",
                    &format!("model must be '<provider>/<id>' (got: {})", e.model),
                    "PROTOCOL_INVALID_ENVELOPE",
                    false,
                );
            }
            e
        }
        Err(e) => {
            // F48: see note at the matching `CallEnvelope` parse site
            // above — do not switch to a value-echoing deserializer
            // without sanitizing detail here.
            return typed_error_response(
                StatusCode::BAD_REQUEST,
                Severity::Error,
                "invalid envelope",
                &format!("{e}"),
                "PROTOCOL_INVALID_ENVELOPE",
                false,
            );
        }
    };

    let pool = match &state.pool {
        Some(p) => p.clone(),
        None => {
            return typed_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                Severity::Error,
                "image path requires a session pool",
                "no pool configured",
                "SESSION_POOL_UNAVAILABLE",
                false,
            );
        }
    };

    dispatch_image_via_pool(pool, envelope).await
}

/// Wire form sent to the session over stdin: the ImageEnvelope plus a
/// `op: "image"` tag so the driver can dispatch to `runImage()`.
/// Internal protocol — not exposed over HTTP.
#[derive(Serialize)]
struct ImageDriverEnvelope<'a> {
    op: &'static str,
    #[serde(flatten)]
    inner: &'a ImageEnvelope,
}

/// Single line returned by the session on the image path.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ImageSessionLine {
    ImageDone { result: ImageResult },
    Error { error: TypedError },
}

async fn dispatch_image_via_pool(
    pool: SessionPool,
    envelope: ImageEnvelope,
) -> Response<Body> {
    let mut session = match pool.acquire().await {
        Some(s) => s,
        None => {
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Fatal,
                "session pool is closed",
                "pool returned None on acquire",
                "SESSION_POOL_CLOSED",
                false,
            );
        }
    };

    let tagged = ImageDriverEnvelope { op: "image", inner: &envelope };
    let envelope_bytes = match serde_json::to_vec(&tagged) {
        Ok(b) => b,
        Err(e) => {
            pool.release(session);
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Error,
                "failed to serialize envelope",
                &format!("{e}"),
                "PROTOCOL_SERIALIZE",
                false,
            );
        }
    };

    let write_result = async {
        session.stdin.write_all(&envelope_bytes).await?;
        session.stdin.write_all(b"\n").await?;
        session.stdin.flush().await
    }
    .await;

    if let Err(e) = write_result {
        pool.discard(session);
        return typed_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            Severity::Error,
            "failed to write envelope to session stdin",
            &format!("{e}"),
            "SESSION_STDIN_WRITE_FAILED",
            true,
        );
    }

    // Read exactly one line. Image path has no streaming — the session
    // emits a single terminal `image_done` or `error`.
    let mut buf = String::new();
    let read = read_capped_line(&mut session.reader, &mut buf, MAX_NDJSON_LINE_BYTES).await;

    let line = match read {
        Ok(0) => {
            pool.discard(session);
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Error,
                "session subprocess exited mid-call",
                "EOF before image response",
                "SESSION_DIED",
                true,
            );
        }
        Err(e) => {
            pool.discard(session);
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Error,
                "error reading session stdout",
                &format!("{e}"),
                "SESSION_IO_ERROR",
                true,
            );
        }
        Ok(_) => buf,
    };

    let trimmed = line.trim_end_matches(['\r', '\n']);
    let parsed: ImageSessionLine = match serde_json::from_str(trimmed) {
        Ok(p) => p,
        Err(e) => {
            pool.discard(session);
            return typed_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Severity::Error,
                "session emitted unexpected line",
                &format!("{e}"),
                "SESSION_INVALID_EVENT",
                false,
            );
        }
    };

    // Session is clean after one-shot terminal → release.
    pool.release(session);

    match parsed {
        ImageSessionLine::ImageDone { result } => {
            let body_bytes = serde_json::to_vec(&result).unwrap_or_else(|_| b"{}".to_vec());
            let body = Full::new(Bytes::from(body_bytes)).boxed();
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .body(body)
                .expect("response build")
        }
        ImageSessionLine::Error { error } => {
            let status = match error.kind.as_deref() {
                Some("AUTH_INVALID") => StatusCode::UNAUTHORIZED,
                Some("SESSION_UNKNOWN_PROVIDER") => StatusCode::BAD_REQUEST,
                _ => StatusCode::BAD_GATEWAY,
            };
            let body_bytes = serde_json::to_vec(&error).unwrap_or_else(|_| b"{}".to_vec());
            let body = Full::new(Bytes::from(body_bytes)).boxed();
            Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(body)
                .expect("response build")
        }
    }
}

// ---------- Synthetic fallback (no SessionPool) ----------

fn synthetic_events() -> Vec<Event> {
    vec![
        Event::Delta {
            delta: DeltaChunk {
                r#type: DeltaKind::Message,
                delta: "Hello".into(),
            },
        },
        Event::Delta {
            delta: DeltaChunk {
                r#type: DeltaKind::Message,
                delta: ", world.".into(),
            },
        },
        Event::Done {
            result: AnswerResult {
                output: Some("Hello, world.".into()),
                input_tokens: 5,
                output_tokens: 3,
                ..Default::default()
            },
        },
    ]
}

fn synthetic_response(
    envelope: &CallEnvelope,
    _spec: QuotaSpec,
    enforcer: Arc<Enforcer>,
) -> Response<Body> {
    // Synthetic path is a success — feed the final event back through
    // the enforcer so behavior matches the pool dispatch flow (reset
    // cooldown, record tokens).
    let started = Instant::now();
    let provider = crate::protocol::provider_of(&envelope.model);
    let cd_key = cooldown_key(&envelope.auth_id, provider);
    enforcer.cooldown.reset(&cd_key);
    enforcer.rate.record_tokens(&envelope.auth_id, 8);

    let events = synthetic_events();
    let frames = events.into_iter().map(|ev| {
        let mut buf = serde_json::to_vec(&ev).expect("serialize event");
        buf.push(b'\n');
        Ok::<_, Infallible>(Frame::data(Bytes::from(buf)))
    });
    let body = StreamBody::new(stream::iter(frames)).boxed();

    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    metrics::record_call(provider, "completed", elapsed_ms);

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .expect("response build")
}

// ---------- Admin plane ----------

#[derive(Debug, Serialize)]
struct HealthBody {
    status: &'static str,
    version: &'static str,
    uptime_ms: u64,
}

async fn handle_admin(req: Request<Incoming>, start: Instant) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if method == Method::GET && path == "/v1/health" {
        health_handler(start)
    } else {
        not_found_response(&method, &path)
    }
}

// ---------- Public helpers ----------

pub fn health_handler(start: Instant) -> Response<Body> {
    let resp = HealthBody {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        uptime_ms: start.elapsed().as_millis() as u64,
    };
    let body_bytes = serde_json::to_vec(&resp).unwrap_or_else(|_| b"{}".to_vec());
    let body = Full::new(Bytes::from(body_bytes)).boxed();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(body)
        .expect("response build")
}

/// Build a `TypedError` HTTP response for protocol-level errors.
pub fn typed_error_response(
    status: StatusCode,
    severity: Severity,
    message: &str,
    detail: &str,
    kind: &str,
    retryable: bool,
) -> Response<Body> {
    let err = TypedError {
        message: message.to_string(),
        detail: if detail.is_empty() { None } else { Some(detail.to_string()) },
        severity,
        retryable,
        kind: Some(kind.to_string()),
    };
    let body_bytes = serde_json::to_vec(&err).unwrap_or_else(|_| b"{}".to_vec());
    let body = Full::new(Bytes::from(body_bytes)).boxed();

    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(body)
        .expect("response build")
}

pub fn not_found_response(method: &Method, path: &str) -> Response<Body> {
    typed_error_response(
        StatusCode::NOT_FOUND,
        Severity::Error,
        "unknown route",
        &format!("{method} {path}"),
        "PROTOCOL_NOT_FOUND",
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_result(warning: Option<&str>) -> AnswerResult {
        AnswerResult {
            output: Some("ok".into()),
            warning: warning.map(|w| w.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn completed_done_signals_provider_recovery() {
        assert!(done_signals_provider_recovery(&make_result(None)));
    }

    #[test]
    fn incomplete_with_budget_warning_still_signals_recovery() {
        // Truncation is still a real provider response — the model
        // ran, emitted tokens, and hit the max_tokens limit. That's
        // evidence the provider is healthy.
        assert!(done_signals_provider_recovery(&make_result(Some(
            "insufficientOutputBudget"
        ))));
    }

    #[test]
    fn cancelled_done_does_not_signal_recovery() {
        // Caller aborted; the provider never completed. No health
        // signal, so the cooldown streak must NOT reset.
        assert!(!done_signals_provider_recovery(&make_result(Some("cancelled"))));
    }

    // F18: per-line cap on session NDJSON reads.

    #[tokio::test]
    async fn read_capped_line_reads_normal_line() {
        let input: &[u8] = b"{\"kind\":\"ok\"}\n";
        let mut reader = tokio::io::BufReader::new(input);
        let mut out = String::new();
        let n = read_capped_line(&mut reader, &mut out, 1024).await.unwrap();
        assert_eq!(n, input.len());
        assert_eq!(out, "{\"kind\":\"ok\"}\n");
    }

    #[tokio::test]
    async fn read_capped_line_reads_line_split_across_fills() {
        // BufReader's fill_buf returns whatever the underlying reader gave.
        // Using a small stdin reader to simulate chunked delivery is overkill
        // here — fill_buf's single-call semantics already exercise the
        // `no newline yet in available` path when bytes span multiple fills.
        let input: Vec<u8> = b"aaaa\nbbbb\n".to_vec();
        let mut reader = tokio::io::BufReader::new(&input[..]);
        let mut out = String::new();
        read_capped_line(&mut reader, &mut out, 1024).await.unwrap();
        assert_eq!(out, "aaaa\n");
        out.clear();
        read_capped_line(&mut reader, &mut out, 1024).await.unwrap();
        assert_eq!(out, "bbbb\n");
    }

    #[tokio::test]
    async fn read_capped_line_errors_on_overshoot() {
        // 20 MiB without any newline; cap = 16 MiB should trip.
        let mut input = vec![b'x'; 20 * 1024 * 1024];
        input.push(b'\n'); // in case the cap logic is wrong, still terminates
        let mut reader = tokio::io::BufReader::new(&input[..]);
        let mut out = String::new();
        let err = read_capped_line(&mut reader, &mut out, 16 * 1024 * 1024)
            .await
            .expect_err("must overshoot cap");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("exceeds"));
    }

    #[tokio::test]
    async fn read_capped_line_accepts_exactly_cap_bytes() {
        // cap bytes + '\n' — fits exactly, must succeed.
        let cap: usize = 1024;
        let mut input = vec![b'x'; cap - 1];
        input.push(b'\n');
        let mut reader = tokio::io::BufReader::new(&input[..]);
        let mut out = String::new();
        let n = read_capped_line(&mut reader, &mut out, cap).await.unwrap();
        assert_eq!(n, cap);
    }

    #[tokio::test]
    async fn read_capped_line_eof_returns_zero() {
        let input: &[u8] = b"";
        let mut reader = tokio::io::BufReader::new(input);
        let mut out = String::new();
        let n = read_capped_line(&mut reader, &mut out, 1024).await.unwrap();
        assert_eq!(n, 0);
    }
}
