use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;
use futures::stream::BoxStream;
use serde::Deserialize;
use thiserror::Error;

#[async_trait]
pub trait ConfigSource: Send + Sync {
    async fn load(&self) -> Result<PlatformConfig, ConfigError>;
    fn watch(&self) -> BoxStream<'static, PlatformConfig>;
}

/// Deployment configuration for a thin-gate instance. Sockets and
/// session settings are what the standalone binary needs to serve
/// traffic; `providers` describes known upstreams for hooks (routing
/// policies, etc.).
///
/// All fields are `#[serde(default)]`-friendly so a partial TOML
/// file just overlays the sections it cares about.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PlatformConfig {
    pub sockets: SocketsConfig,
    #[serde(default)]
    pub session: Option<SessionSpec>,
    pub providers: HashMap<String, ProviderConfig>,
    pub default_timeouts_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SocketsConfig {
    pub data: PathBuf,
    pub admin: PathBuf,
}

impl Default for SocketsConfig {
    fn default() -> Self {
        Self {
            data: PathBuf::from("/tmp/mohdel-thin-gate.sock"),
            admin: PathBuf::from("/tmp/mohdel-thin-gate-admin.sock"),
        }
    }
}

/// Session subprocess spec from TOML. Named distinctly from the
/// runtime `server::SessionConfig` (which carries the pre-parsed
/// command+args the pool uses) to avoid confusion between the config
/// shape and the runtime shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSpec {
    /// Interpreter or binary to invoke. `"node"` for the bundled JS
    /// session; any other executable works too.
    pub command: String,
    /// Arguments passed after `command`. For the JS session this is
    /// the path to `js/session/bin.js`.
    pub args: Vec<String>,
    /// Number of pre-warmed session subprocesses.
    #[serde(default = "default_pool_size")]
    pub pool_size: usize,
}

fn default_pool_size() -> usize {
    2
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub endpoint: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("parse: {0}")]
    Parse(String),
}
