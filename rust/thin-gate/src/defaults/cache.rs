use async_trait::async_trait;

use crate::hooks::{CacheKey, CachePolicy, CachedResponse};

/// Caching disabled. Custom wrappers supply their own impl.
pub struct NoopCachePolicy;

impl NoopCachePolicy {
    pub fn new() -> Self {
        Self
    }
}

impl Default for NoopCachePolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CachePolicy for NoopCachePolicy {
    async fn lookup(&self, _key: &CacheKey) -> Option<CachedResponse> {
        None
    }

    async fn store(&self, _key: CacheKey, _resp: CachedResponse) {}
}
