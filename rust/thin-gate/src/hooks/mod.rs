//! Hook surface for custom thin-gate wrappers.
//!
//! Four traits. The default binary wires file-driven impls from
//! `crate::defaults`. Embedders override one or more traits to plug
//! in their own catalog / quota / config / cache sources without
//! forking the crate.

pub mod auth;
pub mod cache;
pub mod config;
pub mod quota;
pub mod route;

pub use auth::{AuthError, AuthPolicy, RequireInlineAuth};
pub use cache::{CacheKey, CachePolicy, CachedResponse};
pub use config::{ConfigError, ConfigSource, PlatformConfig, ProviderConfig, SessionSpec, SocketsConfig};
pub use quota::{QuotaError, QuotaPolicy, QuotaSpec};
pub use route::{RouteDecision, RouteError, RoutePolicy};
