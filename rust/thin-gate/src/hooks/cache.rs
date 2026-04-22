use async_trait::async_trait;

#[async_trait]
pub trait CachePolicy: Send + Sync {
    async fn lookup(&self, key: &CacheKey) -> Option<CachedResponse>;
    async fn store(&self, key: CacheKey, resp: CachedResponse);
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct CacheKey {
    pub provider: String,
    pub model: String,
    pub content_hash: String,
}

#[derive(Debug, Clone)]
pub struct CachedResponse {
    pub body: Vec<u8>,
}
