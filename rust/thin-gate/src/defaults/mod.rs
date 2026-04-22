//! Default hook implementations for the standalone binary.
//!
//! File-driven, minimal. Suitable for deployments where consumers
//! send already-resolved provider+model ids and per-user quota
//! comes from a config file. Embedders supply their own impls
//! against richer data sources by overriding the hook traits.

pub mod cache;
pub mod config;
pub mod quota;
pub mod route;

pub use cache::NoopCachePolicy;
pub use config::{default_path as default_config_path, FileWatchConfigSource, TomlConfigSource};
pub use quota::FileQuotaPolicy;
pub use route::FileRoutePolicy;
