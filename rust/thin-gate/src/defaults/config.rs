//! TOML-backed default `ConfigSource`.
//!
//! Loads `~/.config/mohdel/thin-gate.toml` (or any path) into a
//! `PlatformConfig`. Missing file → zero-filled defaults (same shape
//! the standalone binary falls back to when nothing is configured).
//! Malformed TOML → `ConfigError::Parse`.
//!
//! Hot-reload via `watch()` is deferred; stream is empty.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use futures::stream::{self, BoxStream};

use crate::hooks::{ConfigError, ConfigSource, PlatformConfig};

pub struct TomlConfigSource {
    path: PathBuf,
}

impl TomlConfigSource {
    /// Build from an explicit path. Nothing is read until `load()`.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Use `MOHDEL_THIN_GATE_CONFIG` if set, else
    /// `$XDG_CONFIG_HOME/mohdel/thin-gate.toml` (via `dirs::config_dir`),
    /// else `/etc/mohdel/thin-gate.toml`.
    pub fn with_default_path() -> Self {
        Self::new(default_path())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn default_path() -> PathBuf {
    if let Ok(explicit) = std::env::var("MOHDEL_THIN_GATE_CONFIG") {
        return PathBuf::from(explicit);
    }
    if let Some(cfg_dir) = dirs::config_dir() {
        return cfg_dir.join("mohdel").join("thin-gate.toml");
    }
    PathBuf::from("/etc/mohdel/thin-gate.toml")
}

#[async_trait]
impl ConfigSource for TomlConfigSource {
    async fn load(&self) -> Result<PlatformConfig, ConfigError> {
        let text = match tokio::fs::read_to_string(&self.path).await {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Absent file is not an error — deployers can run the
                // gate with zero configuration and rely on positional
                // args / env overrides.
                return Ok(PlatformConfig::default());
            }
            Err(e) => return Err(ConfigError::Io(e)),
        };
        toml::from_str::<PlatformConfig>(&text)
            .map_err(|e| ConfigError::Parse(e.to_string()))
    }

    fn watch(&self) -> BoxStream<'static, PlatformConfig> {
        Box::pin(stream::empty())
    }
}

// Legacy re-export to keep any external references compiling; prefer
// `TomlConfigSource` in new code.
pub type FileWatchConfigSource = TomlConfigSource;
