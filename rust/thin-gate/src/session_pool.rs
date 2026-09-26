//! Session subprocess pool.
//!
//! Holds N pre-warmed session subprocesses. Each session handles
//! calls serially (single-call-per-process at any given time) but
//! processes many calls over its lifetime, removing the per-call
//! Node startup cost.
//!
//! Protocol with session (established in `js/session/driver.js`):
//!   - thin-gate writes one CallEnvelope line to session stdin
//!   - session emits events (NDJSON) on stdout until a terminal
//!     event (`done` / `error`)
//!   - thin-gate reads until it sees the terminal, releases the
//!     session back to the pool for the next call
//!
//! Failure modes handled:
//!   - session spawn fails at pool init → pool creation returns Err
//!   - session dies mid-call (stdout EOF or IO error) → emit
//!     terminal `SESSION_DIED` error, respawn replacement
//!   - session emits non-Event line → emit terminal
//!     `SESSION_INVALID_EVENT` error, respawn replacement
//!   - client disconnects mid-call (body stream dropped) → send
//!     `abort`, drain to the terminal, release the session; kill and
//!     respawn only if the drain fails or times out

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use thiserror::Error;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::metrics;
use crate::protocol::{Event, TypedError};
use crate::server::{oneshot_exchange_typed, SessionConfig};

/// Timeout for the startup ping/pong readiness handshake.
pub const READINESS_TIMEOUT: Duration = Duration::from_secs(15);

/// Concurrency cap for the initial pool population. Spawning all N
/// sessions at once creates a fork-storm (N node subprocesses
/// competing for CPU, disk, and memory during their boot) that can
/// push individual-session readiness past `READINESS_TIMEOUT` on a
/// loaded host. Capping keeps wall-time close to `N / cap * spawn_time`
/// without starving any single spawn.
const INITIAL_SPAWN_CONCURRENCY: usize = 8;

/// Baseline delay for exponential respawn backoff. Actual delay is
/// `min(BACKOFF_BASE * 2^streak, BACKOFF_MAX)`.
const BACKOFF_BASE: Duration = Duration::from_millis(500);
/// Hard cap on the respawn delay — once hit, failed respawns keep
/// trying at this interval instead of backing off indefinitely.
const BACKOFF_MAX: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum PoolError {
    #[error("spawn session: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("session readiness check timed out after {0:?}")]
    ReadinessTimeout(Duration),
    #[error("session readiness check failed: {0}")]
    ReadinessFailed(String),
}

/// One pooled session with its I/O handles bundled so stdin/stdout
/// stay attached across calls.
pub struct PooledSession {
    /// Kept for `kill_on_drop` — if `PooledSession` is dropped,
    /// the subprocess is killed.
    pub child: Child,
    pub stdin: ChildStdin,
    pub reader: BufReader<ChildStdout>,
    /// Catalog version this session was last seeded with. Compared
    /// against `SessionPool::catalog_version` on every `acquire()`;
    /// stale sessions get a fresh `set_catalog` before hand-off.
    /// Sessions spawned before any `notify_catalog_changed()` start
    /// at 0.
    catalog_version: u64,
}

/// Environment the session is allowed to inherit.
///
/// Everything else is dropped, including every `*_API_SK` a host may hold.
/// `OTEL_*` is forwarded as a prefix so telemetry keeps working; note that
/// `OTEL_EXPORTER_OTLP_HEADERS` is the one forwarded variable that commonly
/// carries a credential of its own.
const FORWARDED_ENV: &[&str] = &[
    // process basics
    "PATH",
    "HOME",
    "TMPDIR",
    "TZ",
    "LANG",
    "LC_ALL",
    // node runtime and corporate TLS / proxy setups
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_ENV_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    // mohdel's own runtime dials
    "MOHDEL_VERBOSITY",
    "MOHDEL_LOG_LEVEL",
    "MOHDEL_MEDIA_ROOTS",
    // provider-specific attribution headers, not credentials
    "OPENROUTER_REFERER",
    "OPENROUTER_TITLE",
];

/// Whether a variable survives `env_clear()`.
pub fn is_forwarded(key: &str) -> bool {
    FORWARDED_ENV.contains(&key) || key.starts_with("OTEL_")
}

impl PooledSession {
    pub fn spawn(cfg: &SessionConfig) -> Result<Self, PoolError> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // The session receives its provider key on every envelope, so it never
        // needs one from the environment. Inheriting the supervisor's
        // environment would hand a subprocess every other secret the host
        // happens to hold — provider keys for models it will never call, cloud
        // credentials, database URLs — none of which it has any use for. Start
        // from nothing and add back only what the runtime reads.
        cmd.env_clear();
        for (key, value) in std::env::vars() {
            if is_forwarded(&key) {
                cmd.env(key, value);
            }
        }

        // When the embedder has wired a catalog source, tell the
        // session to skip its disk fallback entirely. One source of
        // truth; no silent `~/.config/mohdel/` dependency inside a
        // supervised subprocess.
        if cfg.catalog.is_some() {
            cmd.env("MOHDEL_NO_CONFIG_DISK", "1");
        }

        let mut child = cmd.spawn().map_err(PoolError::Spawn)?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");

        // Drain stderr to eprintln in a background task. Exits when
        // the child's stderr closes (i.e. child exits).
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                // A session emitting a newline-less torrent on stderr
                // would otherwise grow this task's buffer without bound.
                // Over the cap, the line is dropped and reported rather
                // than relayed, so the drain keeps running.
                loop {
                    let mut line = String::new();
                    match crate::server::read_capped_line(
                        &mut reader,
                        &mut line,
                        crate::server::MAX_NDJSON_LINE_BYTES,
                    )
                    .await
                    {
                        Ok(0) => break,
                        Err(e) => {
                            eprintln!("session stderr drain stopped: {e}");
                            break;
                        }
                        Ok(_) => {}
                    }
                    let line = line.trim_end_matches(['\r', '\n']);
                    // Verbatim — mohdel session emits structured JSON;
                    // prefixing would break downstream log parsers
                    // (pino-pretty, fluent-bit, otel-collector).
                    eprintln!("{line}");
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            reader: BufReader::new(stdout),
            catalog_version: 0,
        })
    }

    /// Spawn + startup readiness check. Sends a `{op:"ping"}`
    /// control message and waits for a `{op:"pong"}` reply within
    /// `timeout`. A session that can't pong inside the window is
    /// considered broken (bad binary, hung startup, missing module,
    /// etc.) and the caller should discard it + retry.
    ///
    /// If a catalog source is wired and returns `Some(json)`, the
    /// session is seeded with it right after readiness and tagged
    /// with `seed_version` so `SessionPool::acquire` can tell whether
    /// it's still fresh. A `None` from the callback means no catalog
    /// is available yet (admin-push hasn't landed) — session stays in
    /// a catalog-less state at version 0 until the pool's bump and
    /// acquire-time refresh fill it in.
    pub async fn spawn_and_ready(
        cfg: &SessionConfig,
        timeout: Duration,
        seed_version: u64,
    ) -> Result<Self, PoolError> {
        let mut sess = Self::spawn(cfg)?;
        tokio::time::timeout(timeout, sess.ping())
            .await
            .map_err(|_| PoolError::ReadinessTimeout(timeout))?
            .map_err(|e| PoolError::ReadinessFailed(e.to_string()))?;
        if let Some(source) = cfg.catalog.as_ref() {
            if let Some(json) = source() {
                if let Err(e) = sess.send_catalog(&json).await {
                    return Err(PoolError::ReadinessFailed(format!(
                        "set_catalog injection failed: {e}"
                    )));
                }
                sess.catalog_version = seed_version;
            }
        }
        Ok(sess)
    }

    /// Current catalog version recorded on this session. 0 means no
    /// catalog was ever injected (spawned while `cfg.catalog` returned
    /// `None`).
    pub fn catalog_version(&self) -> u64 {
        self.catalog_version
    }

    async fn send_catalog(&mut self, table_json: &str) -> std::io::Result<()> {
        // Write `{"op":"set_catalog","table":<table_json>}` as one
        // NDJSON line. `table_json` is trusted — comes from the
        // embedder, not the network — so we splice it in directly
        // instead of re-serializing.
        //
        // Trusted is not the same as well-formed: a pretty-printed
        // snapshot splits this frame across lines, and the session
        // rejects the fragments as `SESSION_STDIN_MALFORMED` pointing
        // nowhere near the embedder that produced them.
        if table_json.contains('\n') || table_json.contains('\r') {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "catalog snapshot contains a newline; CatalogSource must return single-line JSON",
            ));
        }
        self.stdin
            .write_all(br#"{"op":"set_catalog","table":"#)
            .await?;
        self.stdin.write_all(table_json.as_bytes()).await?;
        self.stdin.write_all(b"}\n").await?;
        self.stdin.flush().await
    }

    /// Send `{op:"ping"}` and consume stdout until the matching
    /// `{op:"pong"}` appears. Any other unexpected line counts as a
    /// protocol violation.
    async fn ping(&mut self) -> std::io::Result<()> {
        self.stdin.write_all(b"{\"op\":\"ping\"}\n").await?;
        self.stdin.flush().await?;
        let mut buf = String::new();
        loop {
            buf.clear();
            let n = crate::server::read_capped_line(
                &mut self.reader,
                &mut buf,
                crate::server::MAX_NDJSON_LINE_BYTES,
            )
            .await?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "session closed stdout before pong",
                ));
            }
            let trimmed = buf.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                continue;
            }
            let val: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(e) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("invalid readiness line: {e}"),
                    ));
                }
            };
            if val.get("op").and_then(|v| v.as_str()) == Some("pong") {
                return Ok(());
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("unexpected readiness line: {trimmed}"),
            ));
        }
    }

    /// Send an abort control message for `call_id` and drain stdout
    /// until a terminal event or timeout. Returns `Ok(self)` if the
    /// session cleanly aborted and is ready for pool reuse;
    /// `Err` otherwise (caller should drop + respawn).
    pub async fn abort_and_drain(
        mut self,
        call_id: &str,
        timeout: Duration,
    ) -> Result<Self, ()> {
        if write_abort(&mut self.stdin, call_id).await.is_err() {
            return Err(());
        }

        let drain_result = tokio::time::timeout(timeout, async {
            loop {
                let mut buf = String::new();
                match crate::server::read_capped_line(
                    &mut self.reader,
                    &mut buf,
                    crate::server::MAX_NDJSON_LINE_BYTES,
                )
                .await
                {
                    Ok(0) => return Err(()),
                    Err(_) => return Err(()),
                    Ok(_) => {
                        let trimmed = buf.trim_end_matches(['\r', '\n']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Event>(trimmed) {
                            Ok(Event::Done { .. } | Event::Error { .. }) => return Ok(()),
                            Ok(Event::Delta { .. } | Event::Idle { .. }) => continue, // keep draining
                            Err(_) => return Err(()), // invalid line — session protocol broken
                        }
                    }
                }
            }
        })
        .await;

        match drain_result {
            Ok(Ok(())) => Ok(self),
            _ => Err(()),
        }
    }
}

/// `{op:"abort", callId}` on a session's stdin.
pub(crate) async fn write_abort(stdin: &mut ChildStdin, call_id: &str) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(&serde_json::json!({ "op": "abort", "callId": call_id }))?;
    line.push(b'\n');
    stdin.write_all(&line).await?;
    stdin.flush().await
}

type CallKey = (String, String);

#[derive(Default)]
struct AbortRegistry {
    next_id: u64,
    calls: HashMap<CallKey, Vec<(u64, oneshot::Sender<()>)>>,
}

/// A streaming call's entry in the pool's abort registry, removed on drop.
pub(crate) struct CallAbort {
    pool: SessionPool,
    key: CallKey,
    id: u64,
    requested: oneshot::Receiver<()>,
}

impl CallAbort {
    /// Resolves once `SessionPool::abort` names this call.
    pub(crate) async fn requested(&mut self) -> bool {
        (&mut self.requested).await.is_ok()
    }
}

impl Drop for CallAbort {
    fn drop(&mut self) {
        let mut registry = self.pool.inner.aborts.lock().expect("abort registry poisoned");
        if let Some(entries) = registry.calls.get_mut(&self.key) {
            entries.retain(|(id, _)| *id != self.id);
            if entries.is_empty() {
                registry.calls.remove(&self.key);
            }
        }
    }
}

struct PoolInner {
    sender: mpsc::Sender<PooledSession>,
    receiver: Mutex<mpsc::Receiver<PooledSession>>,
    cfg: SessionConfig,
    /// Consecutive spawn+readiness failures since the last success.
    /// Drives the exponential backoff. Cleared on a ready session.
    failure_streak: AtomicU32,
    /// Monotonic counter bumped by `notify_catalog_changed`. Each
    /// acquired session carries the version it was last seeded at;
    /// `acquire` re-injects the catalog when the session's version
    /// is behind the pool's. Starts at 0; sessions that were spawned
    /// before any catalog was available start at 0 too, matching —
    /// they stay in-sync until the first `notify`.
    catalog_version: AtomicU64,
    aborts: std::sync::Mutex<AbortRegistry>,
    instance: String,
}

/// Why `SessionPool::acquire` gave up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcquireError {
    /// Every session is busy and none freed up within the timeout.
    Timeout,
    /// The pool channel is closed — no session will ever arrive.
    Closed,
}

pub const DEFAULT_ACQUIRE_TIMEOUT_MS: u64 = 30_000;

/// `0` disables the bound, which is only ever right for a single-tenant
/// deployment that would rather block forever than fail a call.
pub fn acquire_timeout() -> Duration {
    let ms = std::env::var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_ACQUIRE_TIMEOUT_MS);
    if ms == 0 {
        Duration::MAX
    } else {
        Duration::from_millis(ms)
    }
}

/// Clone-cheap handle to a pool of sessions.
#[derive(Clone)]
pub struct SessionPool {
    inner: Arc<PoolInner>,
}

impl SessionPool {
    pub async fn new(cfg: SessionConfig, size: usize) -> Result<Self, PoolError> {
        assert!(size > 0, "pool size must be > 0");
        let (tx, rx) = mpsc::channel(size);

        // Spawn sessions with bounded concurrency. Done sequentially,
        // pool startup is linear in pool size — a 32-slot pool takes
        // ~10 s. Done with no cap, 32 simultaneous node forks compete
        // for CPU/disk/memory during their boot and individual
        // sessions trip `READINESS_TIMEOUT`. `buffer_unordered` keeps
        // a fixed number of spawns in flight at any time — wall-time
        // becomes ~ceil(N / cap) × spawn_time, each spawn gets the
        // full readiness budget without contention. Any failure in
        // the initial population is still fatal.
        // Scoped so `stream` drops (and releases its borrow of `cfg`)
        // before we move `cfg` into `PoolInner` below.
        {
            use futures::StreamExt;
            let mut stream = futures::stream::iter((0..size).map(|_| {
                let cfg = cfg.clone();
                async move {
                    // Seed at version 0. If the catalog source is already
                    // populated at boot, the session gets it here and stays
                    // in-sync with the pool. If not, the session starts
                    // blank and the first `notify_catalog_changed` +
                    // `acquire` pair fills it in before the next call.
                    PooledSession::spawn_and_ready(&cfg, READINESS_TIMEOUT, 0).await
                }
            }))
            .buffer_unordered(INITIAL_SPAWN_CONCURRENCY);

            while let Some(result) = stream.next().await {
                let sess = result?;
                metrics::session_alive_delta(1);
                tx.send(sess).await.expect("channel just created");
            }
        }

        Ok(Self {
            inner: Arc::new(PoolInner {
                sender: tx,
                receiver: Mutex::new(rx),
                cfg,
                failure_streak: AtomicU32::new(0),
                catalog_version: AtomicU64::new(0),
                aborts: std::sync::Mutex::new(AbortRegistry::default()),
                instance: new_instance_id(),
            }),
        })
    }

    /// Signal that the catalog source now returns newer data than
    /// what live sessions were seeded with. Bumps the pool's version
    /// counter; the next `acquire()` of each stale session will pull
    /// a fresh snapshot from `cfg.catalog` and inject it via
    /// `set_catalog` before handing the session out. Cheap: just one
    /// atomic bump, no I/O on the caller.
    pub fn notify_catalog_changed(&self) {
        self.inner.catalog_version.fetch_add(1, Ordering::Release);
    }

    /// Current pool-level catalog version. Primarily for tests and
    /// debug introspection; production code should rely on `acquire`
    /// to do the comparison.
    pub fn catalog_version(&self) -> u64 {
        self.inner.catalog_version.load(Ordering::Acquire)
    }

    /// Wait for an idle session and take ownership, giving up after
    /// `acquire_timeout()`. The pool is `pool_size` wide; an unbounded
    /// wait lets callers queue without limit against it, and the queue
    /// holds their already-read request bodies.
    ///
    /// When the session's seeded catalog version is behind the pool's,
    /// the latest snapshot is fetched from `cfg.catalog` and injected
    /// on a task of its own, which returns the session to the channel;
    /// the caller waits for the next session there. On injection failure
    /// the session is discarded and a replacement is queued.
    pub async fn acquire(&self) -> Result<PooledSession, AcquireError> {
        // Full wait time from caller's perspective — includes any
        // internal loop iterations that discard a session and retry
        // (e.g. catalog injection failure).
        let waited_since = Instant::now();
        let outcome = tokio::time::timeout(acquire_timeout(), self.acquire_inner()).await;
        let waited_ms = waited_since.elapsed().as_secs_f64() * 1000.0;
        metrics::pool_acquire_wait(waited_ms);
        match outcome {
            Ok(Some(sess)) => {
                metrics::pool_in_use_delta(1);
                Ok(sess)
            }
            Ok(None) => Err(AcquireError::Closed),
            Err(_) => {
                metrics::pool_acquire_timeout();
                Err(AcquireError::Timeout)
            }
        }
    }

    async fn acquire_inner(&self) -> Option<PooledSession> {
        loop {
            let mut sess = self.inner.receiver.lock().await.recv().await?;
            let pool_ver = self.inner.catalog_version.load(Ordering::Acquire);
            if sess.catalog_version >= pool_ver {
                return Some(sess);
            }
            let Some(source) = self.inner.cfg.catalog.as_ref() else {
                // No source wired — bump-without-source is a
                // misconfiguration, but don't block the call over
                // it. Tag the session at the new version so we
                // don't retry on every acquire.
                sess.catalog_version = pool_ver;
                return Some(sess);
            };
            let Some(json) = source() else {
                // Source wired but returned None despite a bump.
                // Same handling as above — tag and move on.
                sess.catalog_version = pool_ver;
                return Some(sess);
            };
            let pool = self.clone();
            tokio::spawn(async move { pool.refresh_and_requeue(sess, &json, pool_ver).await });
        }
    }

    /// Owns a stale session through its `set_catalog` write, so an
    /// `acquire` dropped or timed out meanwhile cannot kill it, then puts
    /// it back in the channel for the next waiter.
    async fn refresh_and_requeue(&self, mut sess: PooledSession, json: &str, pool_ver: u64) {
        match sess.send_catalog(json).await {
            Ok(()) => sess.catalog_version = pool_ver,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                // The snapshot was rejected before anything reached
                // stdin, so the session is healthy and the fault is
                // the embedder's. Discarding here would destroy a
                // session per acquire and never converge, since the
                // next snapshot is equally bad. Serve the stale
                // catalog and keep reporting.
                eprintln!("acquire: rejected catalog snapshot ({e}); serving stale catalog");
                sess.catalog_version = pool_ver;
            }
            Err(e) => {
                // Injection failed — stdin is now in an
                // indeterminate state. Kill this session (drop
                // triggers kill_on_drop) and spawn a replacement.
                eprintln!("acquire: set_catalog refresh failed ({e}); discarding session");
                drop(sess);
                metrics::session_alive_delta(-1);
                self.spawn_replacement();
                return;
            }
        }
        match self.inner.sender.try_send(sess) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(sess)) => {
                eprintln!("acquire: pool channel full after catalog refresh; discarding session and replacing");
                drop(sess);
                metrics::session_alive_delta(-1);
                self.spawn_replacement();
            }
            Err(mpsc::error::TrySendError::Closed(sess)) => {
                drop(sess);
                metrics::session_alive_delta(-1);
            }
        }
    }

    /// Return a healthy session to the pool for reuse. Balances the
    /// `pool_in_use_delta(+1)` that `acquire` emitted.
    ///
    /// The channel has one slot per session and a released session
    /// came out of it, so a full channel means the pool's accounting
    /// is already wrong. Dropping the session there shrinks the pool
    /// permanently and leaves `sessions_alive` overstated, so route it
    /// through `discard` instead: gauges stay balanced, a replacement
    /// is queued, and the anomaly is reported rather than silent.
    pub fn release(&self, sess: PooledSession) {
        match self.inner.sender.try_send(sess) {
            Ok(()) => metrics::pool_in_use_delta(-1),
            Err(mpsc::error::TrySendError::Full(sess)) => {
                eprintln!(
                    "release: pool channel full at capacity {}; discarding session and replacing",
                    self.inner.sender.max_capacity()
                );
                self.discard(sess);
            }
            Err(mpsc::error::TrySendError::Closed(sess)) => {
                // Shutdown: no replacement, the pool is going away.
                drop(sess);
                metrics::pool_in_use_delta(-1);
                metrics::session_alive_delta(-1);
            }
        }
    }

    /// Drop an acquired session that's no longer healthy (died
    /// mid-call, stdin wedged, protocol violation) and queue a
    /// replacement. Balances the `pool_in_use_delta(+1)` from
    /// `acquire` AND the `session_alive_delta(+1)` that this session
    /// originally contributed when it was first spawned — use this
    /// instead of bare `drop(sess) + spawn_replacement()` so the
    /// pool gauges stay consistent.
    pub fn discard(&self, sess: PooledSession) {
        drop(sess);
        metrics::pool_in_use_delta(-1);
        metrics::session_alive_delta(-1);
        self.spawn_replacement();
    }

    /// Queue a replacement spawn. Returns immediately; the actual
    /// spawn + readiness check + backoff retry happens on a detached
    /// task so the caller (usually the stream teardown path) never
    /// blocks.
    pub fn spawn_replacement(&self) {
        let pool = self.clone();
        tokio::spawn(async move { pool.spawn_with_backoff().await });
    }

    /// Internal: loop-spawn until a session comes up healthy.
    async fn spawn_with_backoff(&self) {
        loop {
            // Seed the replacement at the pool's current version so
            // it's considered fresh on first acquire (the catalog
            // snapshot pulled during `spawn_and_ready` is whatever
            // `cfg.catalog` returns *now*, so by construction the
            // session is in-sync with the latest bump).
            let seed = self.inner.catalog_version.load(Ordering::Acquire);
            match PooledSession::spawn_and_ready(&self.inner.cfg, READINESS_TIMEOUT, seed).await {
                Ok(sess) => {
                    self.inner.failure_streak.store(0, Ordering::Relaxed);
                    // Only commit to the alive counter if the session
                    // actually lands in the pool. A `try_send` failure
                    // (channel closed on pool drop, or unexpectedly
                    // full) means `sess` is about to be dropped and
                    // kill_on_drop ends it — so claiming +1 alive
                    // would drift the metric permanently.
                    match self.inner.sender.try_send(sess) {
                        Ok(()) => {
                            metrics::session_respawned();
                            metrics::session_alive_delta(1);
                        }
                        Err(e) => {
                            eprintln!("spawn_replacement: failed to enqueue session: {e}");
                        }
                    }
                    return;
                }
                Err(e) => {
                    let streak = self.inner.failure_streak.fetch_add(1, Ordering::Relaxed) + 1;
                    let delay = backoff_delay(streak);
                    metrics::session_spawn_failed();
                    eprintln!(
                        "session respawn failed (streak={streak}): {e}; retrying in {:?}",
                        delay
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    /// Random per pool; `/v1/call` sends it as `GATE_HEADER` and
    /// `/v1/abort` checks it.
    pub(crate) fn instance(&self) -> &str {
        &self.inner.instance
    }

    pub(crate) fn register_abort(&self, call_id: &str, auth_id: &str) -> CallAbort {
        let (tx, rx) = oneshot::channel();
        let key = (call_id.to_string(), auth_id.to_string());
        let mut registry = self.inner.aborts.lock().expect("abort registry poisoned");
        let id = registry.next_id;
        registry.next_id += 1;
        registry.calls.entry(key.clone()).or_default().push((id, tx));
        drop(registry);
        CallAbort { pool: self.clone(), key, id, requested: rx }
    }

    /// Abort the streaming calls in flight under `(call_id, auth_id)`:
    /// each session is sent `{op:"abort"}` and its stream stays open
    /// until the session's aborted `done`. `false` when none is in
    /// flight, including one whose terminal has already been read.
    pub fn abort(&self, call_id: &str, auth_id: &str) -> bool {
        let key = (call_id.to_string(), auth_id.to_string());
        let entries = self
            .inner
            .aborts
            .lock()
            .expect("abort registry poisoned")
            .calls
            .remove(&key)
            .unwrap_or_default();
        let found = !entries.is_empty();
        for (_, tx) in entries {
            let _ = tx.send(());
        }
        found
    }

    /// Current consecutive-failure count — for metrics / debug.
    pub fn failure_streak(&self) -> u32 {
        self.inner.failure_streak.load(Ordering::Relaxed)
    }

    /// The catalog entry a call with `model` would run on, from the
    /// catalog the sessions hold: `None` for a model they do not know,
    /// the call's own error for an effort or speed lane the entry
    /// cannot take. Asked of a session, never over HTTP: the catalog
    /// flows down to sessions and the gate keeps none of it.
    pub async fn info(&self, model: &str) -> Result<Option<serde_json::Value>, TypedError> {
        let call_id = format!("info-{}", INFO_SEQ.fetch_add(1, Ordering::Relaxed));
        let request = InfoRequest {
            op: "info",
            call_id: &call_id,
            model,
        };
        match oneshot_exchange_typed::<InfoSessionLine>(self, &request, "info").await? {
            InfoSessionLine::InfoDone { result } => Ok(result),
            InfoSessionLine::Error { error } => Err(error),
        }
    }
}

static INFO_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_instance_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let hasher = std::collections::hash_map::RandomState::new().build_hasher();
    format!("{:016x}", hasher.finish())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InfoRequest<'a> {
    op: &'static str,
    call_id: &'a str,
    model: &'a str,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InfoSessionLine {
    InfoDone { result: Option<serde_json::Value> },
    Error { error: TypedError },
}

/// Exponential backoff: `BACKOFF_BASE * 2^(streak-1)`, capped at
/// `BACKOFF_MAX`. Streak-based so repeated failures slow down while
/// intermittent ones recover quickly.
fn backoff_delay(streak: u32) -> Duration {
    if streak == 0 {
        return Duration::ZERO;
    }
    // Guard against shift overflow once streak is absurdly high
    // (somewhere north of ~32 on a 32-bit multiplier).
    let shift = streak.saturating_sub(1).min(16);
    let scaled = BACKOFF_BASE.saturating_mul(1 << shift);
    if scaled > BACKOFF_MAX {
        BACKOFF_MAX
    } else {
        scaled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_schedule_matches_exponential_curve() {
        assert_eq!(backoff_delay(0), Duration::ZERO);
        assert_eq!(backoff_delay(1), Duration::from_millis(500));
        assert_eq!(backoff_delay(2), Duration::from_millis(1_000));
        assert_eq!(backoff_delay(3), Duration::from_millis(2_000));
        assert_eq!(backoff_delay(4), Duration::from_millis(4_000));
        assert_eq!(backoff_delay(5), Duration::from_millis(8_000));
        assert_eq!(backoff_delay(6), Duration::from_millis(16_000));
    }

    #[test]
    fn backoff_saturates_at_max() {
        assert_eq!(backoff_delay(7), BACKOFF_MAX);
        assert_eq!(backoff_delay(20), BACKOFF_MAX);
        assert_eq!(backoff_delay(u32::MAX), BACKOFF_MAX);
    }

    // The full behavioural test — that `notify_catalog_changed` +
    // `acquire` actually injects `set_catalog` into the session —
    // lives in `tests/catalog_refresh.rs` because it needs a real
    // subprocess. These unit tests cover the purely-atomic slice of
    // the contract that doesn't require one.

    #[test]
    fn catalog_version_counter_increments_on_notify() {
        let counter = AtomicU64::new(0);
        assert_eq!(counter.load(Ordering::Acquire), 0);
        counter.fetch_add(1, Ordering::Release);
        assert_eq!(counter.load(Ordering::Acquire), 1);
        counter.fetch_add(1, Ordering::Release);
        counter.fetch_add(1, Ordering::Release);
        assert_eq!(counter.load(Ordering::Acquire), 3);
    }
}

#[cfg(test)]
mod env_forwarding_tests {
    use super::is_forwarded;

    #[test]
    fn provider_keys_are_never_forwarded() {
        for key in [
            "ANTHROPIC_API_SK",
            "OPENAI_API_SK",
            "GEMINI_API_SK",
            "MOHDEL_LOCAL_API_SK",
            "AWS_SECRET_ACCESS_KEY",
            "DATABASE_URL",
            "GITHUB_TOKEN",
        ] {
            assert!(!is_forwarded(key), "{key} must not reach the session");
        }
    }

    #[test]
    fn the_runtime_still_gets_what_it_reads() {
        for key in [
            "PATH",
            "HOME",
            "MOHDEL_VERBOSITY",
            "MOHDEL_LOG_LEVEL",
            "MOHDEL_MEDIA_ROOTS",
            "OPENROUTER_REFERER",
            "NODE_EXTRA_CA_CERTS",
            "HTTPS_PROXY",
        ] {
            assert!(is_forwarded(key), "{key} is read by the session");
        }
    }

    #[test]
    fn telemetry_is_forwarded_by_prefix() {
        assert!(is_forwarded("OTEL_EXPORTER_OTLP_ENDPOINT"));
        assert!(is_forwarded("OTEL_SERVICE_NAME"));
        assert!(!is_forwarded("OTELLO_SECRET"));
    }
}
