use async_trait::async_trait;
use thiserror::Error;

use crate::protocol::CallEnvelope;

#[async_trait]
pub trait RoutePolicy: Send + Sync {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError>;
}

#[derive(Debug, Clone)]
pub struct RouteDecision {
    pub provider: String,
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
