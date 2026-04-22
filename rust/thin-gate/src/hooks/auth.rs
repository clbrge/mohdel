//! Auth policy hook.
//!
//! When `CallEnvelope.auth` is omitted by the caller, thin-gate asks
//! the configured `AuthPolicy` to resolve one — typically from a
//! provider → key map the embedder maintains out-of-band (e.g. an
//! admin-push surface). Lets operators centralize API keys instead of
//! threading them through every envelope.
//!
//! Embedders that don't need this can use the default `RequireInlineAuth`
//! policy, which errors if the envelope has no `auth`.

use async_trait::async_trait;
use thiserror::Error;

use crate::protocol::{Auth, CallEnvelope};

#[async_trait]
pub trait AuthPolicy: Send + Sync {
    /// Resolve an `Auth` for this envelope. Called only when
    /// `envelope.auth` is `None`. Implementations typically look up
    /// keyed by `envelope.provider` and/or `envelope.auth_id`.
    async fn resolve(&self, env: &CallEnvelope) -> Result<Auth, AuthError>;
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("no auth available for provider: {0}")]
    ProviderNotConfigured(String),
    #[error("auth required — caller must supply `auth` inline")]
    InlineRequired,
    #[error("auth policy error: {0}")]
    Other(String),
}

/// Default policy: reject calls without inline auth. Preserves the
/// historical contract where `CallEnvelope.auth` was required.
pub struct RequireInlineAuth;

#[async_trait]
impl AuthPolicy for RequireInlineAuth {
    async fn resolve(&self, _env: &CallEnvelope) -> Result<Auth, AuthError> {
        Err(AuthError::InlineRequired)
    }
}
