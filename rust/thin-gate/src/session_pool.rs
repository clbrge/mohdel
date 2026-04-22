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
//!     event (`call.finish` / `call.error` / `call.cancelled`)
//!   - thin-gate reads until it sees the terminal, releases the
//!     session back to the pool for the next call
//!
//! Failure modes handled:
//!   - session spawn fails at pool init → pool creation returns Err
//!   - session dies mid-call (stdout EOF or IO error) → emit
//!     terminal `session.died` call.error, respawn replacement
//!   - session emits non-Event line → emit terminal
//!     `session.invalid_event`, respawn replacement
//!   - client disconnects mid-call (body stream dropped) → kill
//!     session (unrecoverable protocol state), respawn replacement

use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Mutex};

use crate::metrics;
use crate::protocol::Event;
use crate::server::SessionConfig;

/// Timeout for the startup ping/pong readiness handshake.
pub const READINESS_TIMEOUT: Duration = Duration::from_secs(3);

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
}

impl PooledSession {
    pub fn spawn(cfg: &SessionConfig) -> Result<Self, PoolError> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

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
                use tokio::io::AsyncBufReadExt;
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
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
        })
    }

    /// Spawn + startup readiness check. Sends a `{op:"ping"}`
    /// control message and waits for a `{op:"pong"}` reply within
    /// `timeout`. A session that can't pong inside the window is
    /// considered broken (bad binary, hung startup, missing module,
    /// etc.) and the caller should discard it + retry.
    pub async fn spawn_and_ready(
        cfg: &SessionConfig,
        timeout: Duration,
    ) -> Result<Self, PoolError> {
        let mut sess = Self::spawn(cfg)?;
        tokio::time::timeout(timeout, sess.ping())
            .await
            .map_err(|_| PoolError::ReadinessTimeout(timeout))?
            .map_err(|e| PoolError::ReadinessFailed(e.to_string()))?;
        // After readiness: if a catalog source is wired, pull a fresh
        // snapshot and inject it. Sessions treat this as an out-of-
        // band control message superseding any disk load (and disk
        // load is already skipped via MOHDEL_NO_CONFIG_DISK).
        //
        // A `None` from the callback means the embedder doesn't have
        // a catalog yet (e.g. admin-push hasn't landed). We still
        // spawn the session — gate-level routing should reject
        // `/v1/call` at the policy layer before this matters — but
        // skip the injection so the session stays in a consistent
        // "no catalog" state.
        if let Some(source) = cfg.catalog.as_ref() {
            if let Some(json) = source() {
                if let Err(e) = sess.send_catalog(&json).await {
                    return Err(PoolError::ReadinessFailed(format!(
                        "set_catalog injection failed: {e}"
                    )));
                }
            }
        }
        Ok(sess)
    }

    async fn send_catalog(&mut self, table_json: &str) -> std::io::Result<()> {
        // Write `{"op":"set_catalog","table":<table_json>}` as one
        // NDJSON line. `table_json` is trusted — comes from the
        // embedder, not the network — so we splice it in directly
        // instead of re-serializing.
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
            let n = self.reader.read_line(&mut buf).await?;
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

    /// Send a cancel control message for `call_id` and drain stdout
    /// until a terminal event or timeout. Returns `Ok(self)` if the
    /// session cleanly cancelled and is ready for pool reuse;
    /// `Err` otherwise (caller should drop + respawn).
    pub async fn cancel_and_drain(
        mut self,
        call_id: &str,
        timeout: Duration,
    ) -> Result<Self, ()> {
        let msg = serde_json::json!({ "op": "cancel", "callId": call_id });
        let line = match serde_json::to_vec(&msg) {
            Ok(b) => b,
            Err(_) => return Err(()),
        };
        if self.stdin.write_all(&line).await.is_err() {
            return Err(());
        }
        if self.stdin.write_all(b"\n").await.is_err() {
            return Err(());
        }
        if self.stdin.flush().await.is_err() {
            return Err(());
        }

        let drain_result = tokio::time::timeout(timeout, async {
            loop {
                let mut buf = String::new();
                match self.reader.read_line(&mut buf).await {
                    Ok(0) => return Err(()),
                    Err(_) => return Err(()),
                    Ok(_) => {
                        let trimmed = buf.trim_end_matches(['\r', '\n']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Event>(trimmed) {
                            Ok(Event::Done { .. } | Event::Error { .. }) => return Ok(()),
                            Ok(Event::Delta { .. }) => continue, // keep draining
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

struct PoolInner {
    sender: mpsc::Sender<PooledSession>,
    receiver: Mutex<mpsc::Receiver<PooledSession>>,
    cfg: SessionConfig,
    /// Consecutive spawn+readiness failures since the last success.
    /// Drives the exponential backoff. Cleared on a ready session.
    failure_streak: AtomicU32,
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
        for _ in 0..size {
            // Initial pool population fails fast — if the session
            // binary is broken at startup we want a clear error
            // before the gate starts serving traffic. Runtime
            // replacements get the backoff loop instead.
            let sess = PooledSession::spawn_and_ready(&cfg, READINESS_TIMEOUT).await?;
            metrics::session_alive_delta(1);
            tx.send(sess).await.expect("channel just created");
        }
        Ok(Self {
            inner: Arc::new(PoolInner {
                sender: tx,
                receiver: Mutex::new(rx),
                cfg,
                failure_streak: AtomicU32::new(0),
            }),
        })
    }

    /// Wait for an idle session and take ownership. Returns `None`
    /// if the pool is closed.
    pub async fn acquire(&self) -> Option<PooledSession> {
        self.inner.receiver.lock().await.recv().await
    }

    /// Return a healthy session to the pool for reuse. If the
    /// channel is full (shouldn't happen under normal flow), the
    /// session is dropped.
    pub fn release(&self, sess: PooledSession) {
        let _ = self.inner.sender.try_send(sess);
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
            match PooledSession::spawn_and_ready(&self.inner.cfg, READINESS_TIMEOUT).await {
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

    /// Current consecutive-failure count — for metrics / debug.
    pub fn failure_streak(&self) -> u32 {
        self.inner.failure_streak.load(Ordering::Relaxed)
    }
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
}
