//! Supervision tests: respawn backoff + readiness handshake.

use std::time::Duration;

use mohdel_thin_gate::session_pool::{PoolError, PooledSession, READINESS_TIMEOUT};
use mohdel_thin_gate::SessionConfig;

fn non_ponging_session() -> SessionConfig {
    // Session that reads stdin indefinitely but never writes anything
    // to stdout. Readiness ping should time out.
    SessionConfig {
        command: "node".to_string(),
        args: vec![
            "-e".to_string(),
            "process.stdin.on('data', () => {}); setInterval(() => {}, 3600000);".to_string(),
        ],
        catalog: None,
    }
}

#[tokio::test]
async fn readiness_ping_times_out_when_session_never_ponges() {
    let cfg = non_ponging_session();
    let result = PooledSession::spawn_and_ready(&cfg, Duration::from_millis(300), 0).await;
    match result {
        Err(PoolError::ReadinessTimeout(d)) => assert_eq!(d, Duration::from_millis(300)),
        Err(other) => panic!("expected ReadinessTimeout, got {other:?}"),
        Ok(_) => panic!("expected timeout, session unexpectedly ready"),
    }
}

#[tokio::test]
async fn readiness_fails_when_session_emits_garbage_instead_of_pong() {
    let cfg = SessionConfig {
        command: "node".to_string(),
        args: vec![
            "-e".to_string(),
            "process.stdin.on('data', () => { process.stdout.write('garbage\\n'); });".to_string(),
        ],
        catalog: None,
    };
    let result = PooledSession::spawn_and_ready(&cfg, READINESS_TIMEOUT, 0).await;
    match result {
        Err(PoolError::ReadinessFailed(msg)) => {
            assert!(msg.contains("invalid") || msg.contains("unexpected"), "got: {msg}");
        }
        Err(other) => panic!("expected ReadinessFailed, got {other:?}"),
        Ok(_) => panic!("expected failure, session unexpectedly ready"),
    }
}

#[tokio::test]
async fn readiness_succeeds_when_session_ponges() {
    // Minimal ping-responsive session: read stdin lines, echo `pong`
    // on `ping`, do nothing else.
    let cfg = SessionConfig {
        command: "node".to_string(),
        args: vec![
            "--input-type=module".to_string(),
            "-e".to_string(),
            r#"
const { createInterface } = await import('node:readline');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let o; try { o = JSON.parse(line); } catch { return; }
  if (o?.op === 'ping') {
    process.stdout.write(JSON.stringify({ op: 'pong' }) + '\n');
  }
});
"#
            .to_string(),
        ],
        catalog: None,
    };
    let sess = PooledSession::spawn_and_ready(&cfg, READINESS_TIMEOUT, 0)
        .await
        .expect("readiness should succeed");
    // If we got here the ping-pong handshake completed. Drop sess to
    // kill the subprocess.
    drop(sess);
}
