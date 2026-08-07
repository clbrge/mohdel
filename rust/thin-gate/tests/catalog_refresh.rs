//! Catalog refresh-on-acquire: `notify_catalog_changed` bumps a pool-
//! level version counter; the next `acquire()` of each stale session
//! re-injects `set_catalog` before handing the session out.
//!
//! The fake session used here is a few lines of inline JS: it pongs
//! readiness pings and, for every `set_catalog` op it receives on
//! stdin, appends one line to the file passed as its first argv. The
//! file is the only side-channel the test reads back.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use mohdel_thin_gate::session_pool::PooledSession;
use mohdel_thin_gate::{CatalogSource, SessionConfig, SessionPool};

fn trace_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-catalog-refresh-{}-{}.log",
        std::process::id(),
        name
    ))
}

fn fake_session_cfg(trace_file: &PathBuf, catalog: Option<CatalogSource>) -> SessionConfig {
    // One-file session emulator: pong on ping, log set_catalog table
    // size to argv[0]. argv[0] from `-e` lands at index 1 on
    // process.argv; we pass it after a `--` separator.
    SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            r#"
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const tracePath = process.argv[1]
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let o; try { o = JSON.parse(line) } catch { return }
  if (o?.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n')
  } else if (o?.op === 'set_catalog') {
    const size = o.table ? Object.keys(o.table).length : 0
    appendFileSync(tracePath, size + '\n')
  }
})
"#
            .to_string(),
            "--".to_string(),
            trace_file.to_string_lossy().into_owned(),
        ],
        catalog,
    }
}

struct TraceGuard(PathBuf);
impl Drop for TraceGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
impl TraceGuard {
    fn new(name: &str) -> (Self, PathBuf) {
        let path = trace_path(name);
        let _ = std::fs::remove_file(&path);
        (Self(path.clone()), path)
    }
    fn lines(&self) -> Vec<String> {
        match std::fs::read_to_string(&self.0) {
            Ok(s) => s.lines().map(str::to_owned).collect(),
            Err(_) => Vec::new(),
        }
    }
}

/// A swappable catalog cell the test mutates to drive the source
/// callback. Using a `Mutex` (not an `Arc<Mutex>`) keeps the callback
/// closure's signature simple: it clones an Arc of the cell once and
/// reads through it each call.
type CatalogCell = std::sync::Arc<Mutex<Option<String>>>;

fn make_source(cell: CatalogCell) -> CatalogSource {
    std::sync::Arc::new(move || cell.lock().expect("catalog cell lock").clone())
}

async fn wait_for_lines(guard: &TraceGuard, want: usize, label: &str) -> Vec<String> {
    // Async-yielding poll — `#[tokio::test]` is single-threaded by
    // default, so any detached tasks (e.g. `spawn_replacement`) only
    // make progress when we await. A sync sleep would deadlock the
    // replacement path.
    for _ in 0..100 {
        let lines = guard.lines();
        if lines.len() >= want {
            return lines;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "{label}: expected {want} trace lines, saw {} after wait: {:?}",
        guard.lines().len(),
        guard.lines()
    )
}

#[tokio::test]
async fn session_spawned_before_catalog_available_receives_nothing_at_spawn() {
    let (guard, trace) = TraceGuard::new("blank-boot");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(None));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell)));

    let pool = SessionPool::new(cfg, 2).await.expect("pool");
    // Catalog source returned None at spawn time → sessions should be
    // in-memory but without any set_catalog on the wire. Trace file
    // stays empty.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        guard.lines().is_empty(),
        "expected empty trace, got {:?}",
        guard.lines()
    );
    assert_eq!(pool.catalog_version(), 0);
    for _ in 0..2 {
        let sess = pool.acquire().await.expect("acquire");
        assert_eq!(
            sess.catalog_version(),
            0,
            "no catalog ever injected → version stays at 0"
        );
        // Drop without returning — we're tearing down anyway.
    }
}

#[tokio::test]
async fn notify_after_boot_triggers_injection_on_next_acquire() {
    let (guard, trace) = TraceGuard::new("notify-late");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(None));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell.clone())));

    // Pool of 2 spawned while catalog is None → both sessions land
    // catalog-less at version 0.
    let pool = SessionPool::new(cfg, 2).await.expect("pool");
    assert!(guard.lines().is_empty());

    // Admin push lands: populate the cell + bump the pool's version.
    *cell.lock().unwrap() = Some(r#"{"openai/gpt-5.4-mini":{"inputPrice":0.75,"outputPrice":4.5}}"#.to_string());
    pool.notify_catalog_changed();
    assert_eq!(pool.catalog_version(), 1);

    // Acquire each pooled session. The pool sees `session.version (0)
    // < pool.version (1)` and injects before handing out. After both
    // acquires, the trace file should have 2 lines (one per session),
    // each with "1" (catalog has 1 key).
    let mut acquired = Vec::new();
    for _ in 0..2 {
        let sess = pool.acquire().await.expect("acquire");
        assert_eq!(sess.catalog_version(), 1, "session tagged with current pool version");
        acquired.push(sess);
    }

    let lines = wait_for_lines(&guard, 2, "after notify + 2 acquires").await;
    assert_eq!(lines.len(), 2);
    for line in &lines {
        assert_eq!(line, "1", "expected catalog size=1 in each trace line");
    }

    drop(acquired);
}

#[tokio::test]
async fn repeat_acquire_without_notify_does_not_reinject() {
    let (guard, trace) = TraceGuard::new("no-dupe");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(Some(
        r#"{"openai/gpt-5.4-mini":{"inputPrice":0.75,"outputPrice":4.5}}"#.to_string(),
    )));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell)));

    // Catalog present from the start → each session gets an
    // injection at spawn. Pool size = 1 for simpler counting.
    let pool = SessionPool::new(cfg, 1).await.expect("pool");
    let lines = wait_for_lines(&guard, 1, "after boot with catalog").await;
    assert_eq!(lines.len(), 1, "expected one injection at spawn");

    // Acquire + release several times without notify. Pool version
    // stays at 0, session version stays at 0 → no further injection.
    for _ in 0..3 {
        let sess = pool.acquire().await.expect("acquire");
        pool.release(sess);
    }

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        guard.lines().len(),
        1,
        "no notify ⇒ no extra injections, got: {:?}",
        guard.lines()
    );
}

#[tokio::test]
async fn multiple_notifies_inject_latest_snapshot_once_per_acquire() {
    let (guard, trace) = TraceGuard::new("multi-notify");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(None));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell.clone())));

    let pool = SessionPool::new(cfg, 1).await.expect("pool");

    // Three rapid-fire admin pushes before the caller acquires.
    // Session stays at version 0; pool bumps to 3. Only one
    // injection should happen on acquire — the pool re-reads the
    // latest snapshot, not each historical one.
    *cell.lock().unwrap() = Some(r#"{"a/one":{}}"#.to_string());
    pool.notify_catalog_changed();
    *cell.lock().unwrap() = Some(r#"{"a/one":{},"b/two":{}}"#.to_string());
    pool.notify_catalog_changed();
    *cell.lock().unwrap() = Some(r#"{"a/one":{},"b/two":{},"c/three":{}}"#.to_string());
    pool.notify_catalog_changed();
    assert_eq!(pool.catalog_version(), 3);

    let sess = pool.acquire().await.expect("acquire");
    assert_eq!(sess.catalog_version(), 3, "session caught up to latest");

    let lines = wait_for_lines(&guard, 1, "after 3 notifies + 1 acquire").await;
    assert_eq!(lines.len(), 1, "single injection per acquire");
    assert_eq!(lines[0], "3", "injected snapshot is the latest (3 keys)");

    drop(sess);
}

#[tokio::test]
async fn spawn_replacement_carries_current_version_so_first_acquire_skips_injection() {
    let (guard, trace) = TraceGuard::new("replacement-fresh");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(Some(
        r#"{"openai/gpt-5.4-mini":{"inputPrice":0.75}}"#.to_string(),
    )));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell)));

    let pool = SessionPool::new(cfg, 1).await.expect("pool");
    wait_for_lines(&guard, 1, "boot injection").await;

    // Bump the pool version, then queue a replacement. The
    // replacement pulls the catalog during its own spawn and is
    // tagged at the current pool version — the next acquire should
    // NOT trigger another injection on top of that.
    pool.notify_catalog_changed();
    assert_eq!(pool.catalog_version(), 1);

    // Drain the existing session (simulating a death) and wait for
    // spawn_replacement's background task to enqueue a fresh one.
    // Do this by acquiring + dropping so the slot reopens, then
    // calling spawn_replacement; the test runs on a single-threaded
    // runtime so we must yield via sleep for the detached task.
    let sess = pool.acquire().await.expect("first acquire");
    drop(sess); // kill_on_drop ends the subprocess; slot is now free
    pool.spawn_replacement();

    // Wait for the replacement to land + inject at spawn.
    wait_for_lines(&guard, 2, "replacement injection at spawn").await;

    // Acquire the replacement — should already be at version 1.
    let sess = pool.acquire().await.expect("replacement acquire");
    assert_eq!(
        sess.catalog_version(),
        1,
        "replacement seeded at current pool version, no re-inject"
    );
    // Confirm no extra inject line appeared.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        guard.lines().len(),
        2,
        "still just boot + replacement, no acquire-time re-inject"
    );
    drop(sess);
}

// Prove `PooledSession::catalog_version` is wired through — mostly a
// guard against signature drift that would otherwise only show up in
// integration.
#[tokio::test]
async fn pooled_session_reports_its_seeded_version() {
    let (_guard, trace) = TraceGuard::new("version-getter");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(Some(r#"{"x/y":{}}"#.to_string())));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell)));

    let sess = PooledSession::spawn_and_ready(&cfg, Duration::from_secs(3), 7)
        .await
        .expect("session");
    assert_eq!(sess.catalog_version(), 7);
    drop(sess);
}

/// Logs every raw stdin line, so the trace shows what actually reached
/// the session rather than only what parsed. A frame split across lines
/// is invisible to a parser-only trace: each fragment fails JSON.parse
/// and is dropped.
fn raw_echo_session_cfg(trace_file: &PathBuf) -> SessionConfig {
    SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            r#"
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const tracePath = process.argv[1]
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let o; try { o = JSON.parse(line) } catch { o = null }
  if (o?.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n')
    return
  }
  appendFileSync(tracePath, line.slice(0, 40) + '\n')
})
"#
            .to_string(),
            "--".to_string(),
            trace_file.to_string_lossy().into_owned(),
        ],
        catalog: None,
    }
}

/// A pretty-printed snapshot would split the `set_catalog` frame across
/// lines, and the session would reject the fragments with an error
/// naming nothing the operator can act on. The pool rejects it instead,
/// and — because the fault is the embedder's, not the session's —
/// serves the stale catalog rather than destroying a session per
/// acquire against a snapshot that will not improve.
#[tokio::test]
async fn multiline_catalog_snapshot_is_rejected_without_burning_sessions() {
    let (guard, trace) = TraceGuard::new("multiline-catalog");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(Some(
        r#"{"openai/gpt-5":{"inputPrice":1}}"#.to_string(),
    )));
    let mut cfg = raw_echo_session_cfg(&trace);
    cfg.catalog = Some(make_source(cell.clone()));

    let pool = SessionPool::new(cfg, 1).await.expect("pool");
    wait_for_lines(&guard, 1, "initial seed").await;

    // Pretty-printed: valid JSON, invalid as one NDJSON frame.
    *cell.lock().unwrap() = Some("{\n  \"openai/gpt-5\": {\n    \"inputPrice\": 1\n  }\n}".to_string());
    pool.notify_catalog_changed();

    for _ in 0..3 {
        let sess = pool.acquire().await.expect("session still served");
        pool.release(sess);
    }

    // Only the boot-time injection ever reached the wire; the pool
    // never spliced the multi-line snapshot into a frame.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        guard.lines().len(),
        1,
        "nothing beyond the boot frame should have reached stdin, saw {:?}",
        guard.lines()
    );

    // A session survives and is still usable.
    let sess = pool.acquire().await.expect("session available after rejection");
    pool.release(sess);
}

/// `release` into a full channel used to drop the session on the floor:
/// no replacement, no `session_alive_delta(-1)`, so the pool shrank
/// permanently and the gauge drifted. It now routes through `discard`.
///
/// The replacement it queues cannot be asserted on: the channel is
/// still full, so that session is refused and killed on drop, usually
/// before its subprocess reads anything. What is observable — and what
/// regressed the pool — is that the release neither wedges nor loses
/// the pool's ability to serve.
#[tokio::test]
async fn release_into_a_full_channel_leaves_the_pool_serviceable() {
    let (guard, trace) = TraceGuard::new("release-full");
    let cell: CatalogCell = std::sync::Arc::new(Mutex::new(Some(
        r#"{"openai/gpt-5":{"inputPrice":1}}"#.to_string(),
    )));
    let cfg = fake_session_cfg(&trace, Some(make_source(cell)));

    let pool = SessionPool::new(cfg, 1).await.expect("pool");
    wait_for_lines(&guard, 1, "initial spawn").await;

    // Hold the only session, then refill the single channel slot so the
    // release below lands on a full channel.
    let sess = pool.acquire().await.expect("acquire");
    pool.spawn_replacement();
    wait_for_lines(&guard, 2, "replacement spawned").await;
    // The trace line is written during readiness injection, which
    // happens before the session is handed to the channel. Let that
    // send land, otherwise the release below finds the slot empty.
    tokio::time::sleep(Duration::from_millis(200)).await;

    pool.release(sess);

    let again = pool
        .acquire()
        .await
        .expect("pool still serves after a full-channel release");
    pool.release(again);
}
