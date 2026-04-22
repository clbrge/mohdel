//! Default standalone binary for mohdel-thin-gate.
//!
//! 0.90-alpha: binds two unix sockets (data plane + admin plane) and
//! maintains a pool of session subprocesses for `POST /v1/call`
//! dispatch. Without a session entry configured, data plane falls
//! back to a synthetic event sequence (demo / test mode).
//!
//! Configuration precedence (higher wins):
//!   1. CLI flags                    `--data`, `--admin`, `--session`, `--pool-size`
//!   2. Env vars                     `MOHDEL_SESSION_BIN`, `MOHDEL_SESSION_POOL_SIZE`
//!   3. TOML file                    `MOHDEL_THIN_GATE_CONFIG` or
//!                                   `~/.config/mohdel/thin-gate.toml`
//!   4. Built-in defaults            `/tmp/mohdel-thin-gate{,-admin}.sock`, no session
//!
//! Example TOML:
//!   [sockets]
//!   data  = "/run/mohdel/data.sock"
//!   admin = "/run/mohdel/admin.sock"
//!
//!   [session]
//!   command   = "node"
//!   args      = ["/opt/mohdel/js/session/bin.js"]
//!   pool_size = 4
//!
//! Example invocations:
//!   mohdel-thin-gate --help
//!   mohdel-thin-gate --session /opt/mohdel/js/session/bin.js
//!   mohdel-thin-gate --data /run/mohdel/data.sock --admin /run/mohdel/admin.sock

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;

use mohdel_thin_gate::defaults::TomlConfigSource;
use mohdel_thin_gate::hooks::{ConfigSource, PlatformConfig};
use mohdel_thin_gate::{SessionConfig, SessionPool};

/// CLI arg surface. Every flag is optional; unset flags fall through
/// to env, TOML config, and built-in defaults in that order.
#[derive(Parser, Debug)]
#[command(name = "mohdel-thin-gate", version, about, long_about = None)]
struct Args {
    /// Data-plane unix socket path (serves `POST /v1/call`).
    #[arg(long, value_name = "PATH")]
    data: Option<PathBuf>,

    /// Admin-plane unix socket path (serves `GET /v1/health`).
    #[arg(long, value_name = "PATH")]
    admin: Option<PathBuf>,

    /// Session subprocess entrypoint; the default runtime wraps this
    /// with `node <path>`. Without a session, the data plane returns
    /// synthetic events (demo / test mode).
    #[arg(long, value_name = "PATH")]
    session: Option<String>,

    /// Number of pre-warmed session subprocesses in the pool.
    #[arg(long = "pool-size", value_name = "N")]
    pool_size: Option<usize>,
}

struct PathGuard(PathBuf);
impl Drop for PathGuard {
    fn drop(&mut self) {
        // Shutdown cleanup — only remove the path if it's still the
        // unix socket we bound to. A regular file at that location
        // would mean something external replaced it mid-run; don't
        // delete it and log instead.
        if let Err(e) = mohdel_thin_gate::remove_stale_socket(&self.0) {
            eprintln!("socket cleanup skipped: {e}");
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();

    mohdel_thin_gate::metrics::init();

    let cfg = load_config().await;

    let data_path = args
        .data
        .clone()
        .unwrap_or_else(|| cfg.sockets.data.clone());
    let admin_path = args
        .admin
        .clone()
        .unwrap_or_else(|| cfg.sockets.admin.clone());

    let session_bin = args
        .session
        .clone()
        .or_else(|| std::env::var("MOHDEL_SESSION_BIN").ok())
        .or_else(|| cfg.session.as_ref().and_then(session_command_line));

    let pool_size = args
        .pool_size
        .or_else(|| {
            std::env::var("MOHDEL_SESSION_POOL_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
        })
        .or_else(|| cfg.session.as_ref().map(|s| s.pool_size))
        .unwrap_or(2);

    eprintln!("mohdel-thin-gate {} listening", env!("CARGO_PKG_VERSION"));
    eprintln!("  data plane:  {}", data_path.display());
    eprintln!("  admin plane: {}", admin_path.display());

    let pool = match session_bin {
        Some(path) => {
            let cfg = SessionConfig {
                command: "node".to_string(),
                args: vec![path.clone()],
                catalog: None,
            };
            eprintln!("  session:     node {path} × {pool_size}");
            match SessionPool::new(cfg, pool_size).await {
                Ok(p) => Some(p),
                Err(e) => {
                    eprintln!("fatal: failed to spawn session pool: {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        None => {
            eprintln!("  session:     (none — synthetic fallback on /v1/call)");
            None
        }
    };

    let _data_guard = PathGuard(data_path.clone());
    let _admin_guard = PathGuard(admin_path.clone());

    tokio::select! {
        res = mohdel_thin_gate::serve_data(&data_path, pool) => {
            if let Err(e) = res {
                eprintln!("data plane fatal: {e}");
                return ExitCode::FAILURE;
            }
        }
        res = mohdel_thin_gate::serve_admin(&admin_path) => {
            if let Err(e) = res {
                eprintln!("admin plane fatal: {e}");
                return ExitCode::FAILURE;
            }
        }
        _ = tokio::signal::ctrl_c() => {
            eprintln!("received ctrl-c; shutting down");
        }
    }

    mohdel_thin_gate::metrics::shutdown();
    ExitCode::SUCCESS
}

async fn load_config() -> PlatformConfig {
    let src = TomlConfigSource::with_default_path();
    let path = src.path().to_path_buf();
    match src.load().await {
        Ok(cfg) => {
            if path.exists() {
                eprintln!("  config:      {}", path.display());
            }
            cfg
        }
        Err(e) => {
            eprintln!("warning: failed to read {}: {e}", path.display());
            PlatformConfig::default()
        }
    }
}

/// Flatten a `SessionConfig` from TOML into the single string the
/// existing env/CLI path expects (`MOHDEL_SESSION_BIN`). This keeps
/// `main.rs` logic simple: one code path downstream regardless of
/// whether the session was configured via CLI, env, or file.
fn session_command_line(s: &mohdel_thin_gate::hooks::SessionSpec) -> Option<String> {
    // The existing wiring invokes `node <arg>` and uses the first arg
    // as the session bin path. TOML `command="node", args=["/x.js"]`
    // collapses back to the same shape.
    let first_arg = s.args.first()?;
    if s.command == "node" {
        Some(first_arg.clone())
    } else {
        // Non-node interpreters aren't supported by the current
        // hard-coded `command = "node"` below; surface this instead
        // of silently dropping the config.
        eprintln!(
            "warning: session.command={:?} in config is not yet supported (only 'node')",
            s.command
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_flags() {
        let args = Args::try_parse_from([
            "mohdel-thin-gate",
            "--data", "/tmp/d.sock",
            "--admin", "/tmp/a.sock",
            "--session", "/opt/bin.js",
            "--pool-size", "4",
        ]).unwrap();
        assert_eq!(args.data.as_deref(), Some(PathBuf::from("/tmp/d.sock")).as_deref());
        assert_eq!(args.admin.as_deref(), Some(PathBuf::from("/tmp/a.sock")).as_deref());
        assert_eq!(args.session.as_deref(), Some("/opt/bin.js"));
        assert_eq!(args.pool_size, Some(4));
    }

    #[test]
    fn all_flags_optional() {
        // No args → every field is None; main.rs cascades to
        // env + TOML + defaults.
        let args = Args::try_parse_from(["mohdel-thin-gate"]).unwrap();
        assert!(args.data.is_none());
        assert!(args.admin.is_none());
        assert!(args.session.is_none());
        assert!(args.pool_size.is_none());
    }

    #[test]
    fn session_flag_alone_is_valid() {
        // The original positional CLI required data + admin before
        // session. With flags, setting session alone is valid.
        let args = Args::try_parse_from([
            "mohdel-thin-gate",
            "--session", "/opt/bin.js",
        ]).unwrap();
        assert_eq!(args.session.as_deref(), Some("/opt/bin.js"));
        assert!(args.data.is_none());
        assert!(args.admin.is_none());
    }

    #[test]
    fn unknown_flag_is_rejected() {
        let res = Args::try_parse_from([
            "mohdel-thin-gate",
            "--unknown-flag", "x",
        ]);
        assert!(res.is_err());
    }

    #[test]
    fn help_exits_cleanly() {
        // `--help` produces a DisplayHelp error (exit code 0), not
        // a parse failure. Confirms clap's auto-help is wired up.
        let err = Args::try_parse_from([
            "mohdel-thin-gate", "--help",
        ]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayHelp);
    }
}
