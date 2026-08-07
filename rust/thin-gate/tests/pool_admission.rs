//! Bounds on waiting for a session and on concurrently served
//! connections. Without them a `pool_size`-wide pool lets callers queue
//! without limit, each holding an already-read request body.

use std::time::{Duration, Instant};

use mohdel_thin_gate::session_pool::{acquire_timeout, AcquireError, DEFAULT_ACQUIRE_TIMEOUT_MS};
use mohdel_thin_gate::{SessionConfig, SessionPool};

fn idle_session_cfg() -> SessionConfig {
    SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            r#"
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let o; try { o = JSON.parse(line) } catch { return }
  if (o?.op === 'ping') process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n')
})
"#
            .to_string(),
        ],
        catalog: None,
    }
}

/// Cargo runs the tests in this binary on parallel threads of one
/// process, so every env reader and writer here contends for the same
/// environment. Each test holds this for its whole body.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn with_acquire_timeout_ms<T>(ms: &str, f: impl FnOnce() -> T) -> T {
    let _guard = lock_env();
    let prev = std::env::var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS").ok();
    unsafe { std::env::set_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS", ms) };
    let out = f();
    match prev {
        Some(p) => unsafe { std::env::set_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS", p) },
        None => unsafe { std::env::remove_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS") },
    }
    out
}

#[test]
fn acquire_timeout_defaults_and_parses() {
    let _guard = lock_env();
    let prev = std::env::var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS").ok();

    unsafe { std::env::remove_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS") };
    assert_eq!(
        acquire_timeout(),
        Duration::from_millis(DEFAULT_ACQUIRE_TIMEOUT_MS)
    );

    unsafe { std::env::set_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS", "1500") };
    assert_eq!(acquire_timeout(), Duration::from_millis(1500));

    // Explicit opt-out for deployments that prefer blocking to failing.
    unsafe { std::env::set_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS", "0") };
    assert_eq!(acquire_timeout(), Duration::MAX);

    unsafe { std::env::set_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS", "not-a-number") };
    assert_eq!(
        acquire_timeout(),
        Duration::from_millis(DEFAULT_ACQUIRE_TIMEOUT_MS)
    );

    match prev {
        Some(p) => unsafe { std::env::set_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS", p) },
        None => unsafe { std::env::remove_var("MOHDEL_POOL_ACQUIRE_TIMEOUT_MS") },
    }
}

#[test]
fn saturated_pool_times_out_instead_of_waiting_forever() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    with_acquire_timeout_ms("300", || {
        rt.block_on(async {
            let pool = SessionPool::new(idle_session_cfg(), 1).await.expect("pool");

            // Hold the only session so the next acquire cannot be served.
            let held = pool.acquire().await.expect("first acquire succeeds");

            let started = Instant::now();
            let second = pool.acquire().await;
            let waited = started.elapsed();

            match second {
                Err(e) => assert_eq!(e, AcquireError::Timeout),
                Ok(_) => panic!("acquire succeeded against a fully checked-out pool"),
            }
            assert!(
                waited >= Duration::from_millis(250),
                "returned before the timeout elapsed: {waited:?}"
            );
            assert!(
                waited < Duration::from_secs(5),
                "waited far past the timeout: {waited:?}"
            );

            drop(held);
        })
    });
}

#[test]
fn released_session_is_reacquired_within_the_timeout() {
    let rt = tokio::runtime::Runtime::new().expect("runtime");
    with_acquire_timeout_ms("5000", || {
        rt.block_on(async {
            let pool = SessionPool::new(idle_session_cfg(), 1).await.expect("pool");
            let first = pool.acquire().await.expect("first acquire");
            pool.release(first);
            let second = pool.acquire().await;
            assert!(second.is_ok(), "a released session must be reacquirable");
        })
    });
}
