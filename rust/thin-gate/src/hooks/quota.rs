use async_trait::async_trait;
use thiserror::Error;

#[async_trait]
pub trait QuotaPolicy: Send + Sync {
    async fn policy_for(&self, user_id: &str) -> Result<QuotaSpec, QuotaError>;
}

/// Per-user quota spec:
///   - `rpm` / `tpm` — minute-bucket rate limits (requests and tokens).
///     `None` means no limit configured for this dimension (the
///     common case when a deployment opts out of that bucket).
///     `Some(0)` explicitly means **deny all** requests — useful for
///     killswitches. `Some(n)` with `n > 0` throttles at `n`.
///   - `cooldown_threshold` — consecutive failures before cooldown triggers
///   - `cooldown_duration_ms` — how long the cooldown lasts
#[derive(Debug, Clone)]
pub struct QuotaSpec {
    pub rpm: Option<u32>,
    pub tpm: Option<u64>,
    pub cooldown_threshold: u32,
    pub cooldown_duration_ms: u64,
}

#[derive(Debug, Error)]
pub enum QuotaError {
    #[error("unknown user: {0}")]
    UnknownUser(String),
    #[error("config error: {0}")]
    Config(String),
}
