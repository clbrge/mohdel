//! Auth policy hook.
//!
//! When an envelope's `auth` is omitted by the caller, thin-gate asks
//! the configured `AuthPolicy` to resolve one, on every route — typically from a
//! provider → key map the embedder maintains out-of-band (e.g. an
//! admin-push surface). Lets operators centralize API keys instead of
//! threading them through every envelope.
//!
//! Embedders that don't need this can use the default `RequireInlineAuth`
//! policy, which errors if the envelope has no `auth`.

use async_trait::async_trait;
use thiserror::Error;

use crate::protocol::Auth;

#[async_trait]
pub trait AuthPolicy: Send + Sync {
    /// Resolve an `Auth` for an envelope's caller and model. Called
    /// only when the envelope's `auth` is `None`. Implementations
    /// typically look up keyed by `provider_of(model)` and/or `auth_id`.
    async fn resolve(&self, auth_id: &str, model: &str) -> Result<Auth, AuthError>;
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
/// historical contract where an envelope's `auth` was required.
pub struct RequireInlineAuth;

#[async_trait]
impl AuthPolicy for RequireInlineAuth {
    async fn resolve(&self, _auth_id: &str, _model: &str) -> Result<Auth, AuthError> {
        Err(AuthError::InlineRequired)
    }
}
