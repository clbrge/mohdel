use async_trait::async_trait;

use crate::hooks::{QuotaError, QuotaPolicy, QuotaSpec};

/// Static default quota: `cooldownThreshold: 3`,
/// `cooldownDuration: 60_000ms`. Rate limits are generous
/// placeholders; real file-driven impl lands post-scaffold.
pub struct FileQuotaPolicy;

impl FileQuotaPolicy {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FileQuotaPolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl QuotaPolicy for FileQuotaPolicy {
    async fn policy_for(&self, _user_id: &str) -> Result<QuotaSpec, QuotaError> {
        Ok(QuotaSpec {
            rpm: Some(60),
            tpm: Some(100_000),
            cooldown_threshold: 3,
            cooldown_duration_ms: 60_000,
        })
    }
}
