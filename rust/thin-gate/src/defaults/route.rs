use async_trait::async_trait;

use crate::hooks::{RouteDecision, RouteError, RoutePolicy};
use crate::protocol::CallEnvelope;

/// Passthrough routing — assumes callers already send resolved
/// provider-native model ids.
pub struct FileRoutePolicy;

impl FileRoutePolicy {
    pub fn new() -> Self {
        Self
    }
}

impl Default for FileRoutePolicy {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl RoutePolicy for FileRoutePolicy {
    async fn resolve(&self, env: &CallEnvelope) -> Result<RouteDecision, RouteError> {
        Ok(RouteDecision {
            model_id: env.model.clone(),
            session_pool: None,
        })
    }
}
