use async_trait::async_trait;
use thiserror::Error;

use crate::protocol::CallEnvelope;

#[async_trait]
pub trait RoutePolicy: Send + Sync {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError>;
}

#[derive(Debug, Clone)]
pub struct RouteDecision {
    /// Full mohdel id `<provider>/<bare>[:<effort>]`. If the router
    /// chooses to rewrite the caller's model (aliasing, failover),
    /// this is the new id; otherwise it's the caller's `env.model`
    /// unchanged. Must be a valid full id — the provider part is
    /// read from it via `protocol::provider_of` downstream.
    pub model_id: String,
    pub session_pool: Option<String>,
}

#[derive(Debug, Error)]
pub enum RouteError {
    #[error("unknown model: {0}")]
    UnknownModel(String),
    #[error("provider unavailable: {0}")]
    ProviderUnavailable(String),
    #[error("config error: {0}")]
    Config(String),
}
