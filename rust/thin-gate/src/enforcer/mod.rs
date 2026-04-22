//! Gate-level enforcement state.
//!
//! Wraps the per-user rate limiter and per-user+provider cooldown
//! tracker behind a single `Enforcer` handle. The server holds this
//! via `Arc<Enforcer>` so all connection tasks share a single
//! coordinated view.

pub mod cooldown;
pub mod rate_limiter;

pub use cooldown::{CooldownInfo, CooldownTracker};
pub use rate_limiter::RateLimiter;

#[derive(Debug, Default)]
pub struct Enforcer {
    pub rate: RateLimiter,
    pub cooldown: CooldownTracker,
}

impl Enforcer {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Build the composite cooldown key (`<user>|<provider>`). Failures
/// are tracked per user per provider so an outage at one provider
/// doesn't lock a user out of the others.
pub fn cooldown_key(auth_id: &str, provider: &str) -> String {
    format!("{auth_id}|{provider}")
}
