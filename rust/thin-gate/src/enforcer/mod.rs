//! Gate-level enforcement state.
//!
//! Wraps the per-user rate limiter and per-user+provider cooldown
//! tracker behind a single `Enforcer` handle. The server holds this
//! via `Arc<Enforcer>` so all connection tasks share a single
//! coordinated view.

pub mod cooldown;
pub mod rate_limiter;

use std::time::Duration;

pub use cooldown::{CooldownInfo, CooldownTracker};
pub use rate_limiter::{Limits, RateLimiter};

#[derive(Debug, Default)]
pub struct Enforcer {
    pub rate: RateLimiter,
    pub cooldown: CooldownTracker,
}

impl Enforcer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a caller-quota refusal for `(auth_id, model)`. The window
    /// lasts `stated_ms`, the wait the refusal carries, or `default_ms`
    /// when it carries none. Returns the wait the refusal must carry
    /// instead: what is left of a window already open, or the window's
    /// length when the refusal named none.
    pub fn record_tier_refusal(
        &self,
        auth_id: &str,
        model: &str,
        stated_ms: Option<u64>,
        default_ms: u64,
    ) -> Option<u64> {
        let key = tier_cooldown_key(auth_id, model);
        let window = Duration::from_millis(stated_ms.unwrap_or(default_ms));
        let fresh = self.cooldown.record_tier_refusal(&key, window);
        if fresh && stated_ms.is_some() {
            return None;
        }
        self.cooldown.cooling_down(&key).map(|info| info.seconds_left * 1_000)
    }
}

/// Build the composite cooldown key (`<user>|<provider>`). Failures
/// are tracked per user per provider so an outage at one provider
/// doesn't lock a user out of the others.
pub fn cooldown_key(auth_id: &str, provider: &str) -> String {
    format!("{auth_id}|{provider}")
}

/// Build the cooldown key a caller-quota refusal opens
/// (`<user>|<catalog key>`). Quotas are metered per model, so one
/// model's refusal leaves the provider's other models callable.
pub fn tier_cooldown_key(auth_id: &str, model: &str) -> String {
    format!("{auth_id}|{}", crate::protocol::catalog_key(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_refusal_with_a_stated_wait_keeps_it() {
        let enforcer = Enforcer::new();
        assert_eq!(enforcer.record_tier_refusal("u", "p/m", Some(5_000), 60_000), None);
        let info = enforcer.cooldown.cooling_down(&tier_cooldown_key("u", "p/m")).unwrap();
        assert_eq!(info.seconds_left, 5);
        assert!(enforcer.cooldown.cooling_down(&tier_cooldown_key("u", "p/other")).is_none());
        assert!(enforcer.cooldown.cooling_down(&cooldown_key("u", "p")).is_none());
        assert!(enforcer.cooldown.cooling_down(&tier_cooldown_key("v", "p/m")).is_none());
    }

    #[test]
    fn tier_refusal_without_a_wait_carries_the_default_window() {
        let enforcer = Enforcer::new();
        assert_eq!(enforcer.record_tier_refusal("u", "p/m", None, 60_000), Some(60_000));
    }

    #[test]
    fn tier_refusal_in_an_open_window_carries_what_is_left() {
        let enforcer = Enforcer::new();
        enforcer.record_tier_refusal("u", "p/m", Some(30_000), 60_000);
        assert_eq!(enforcer.record_tier_refusal("u", "p/m", Some(5_000), 60_000), Some(30_000));
    }

    #[test]
    fn tier_key_ignores_the_effort_suffix() {
        assert_eq!(tier_cooldown_key("u", "p/m:high"), tier_cooldown_key("u", "p/m"));
    }
}
