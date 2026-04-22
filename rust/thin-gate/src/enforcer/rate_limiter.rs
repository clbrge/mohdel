//! Minute-bucket rate limiter. Per-key counters for requests and
//! tokens. Returns milliseconds to wait when the bucket is exhausted;
//! 0 means go ahead.
//!
//! Matches the semantics of `js/session/_rate_limiter.js` so the gate
//! can enforce across sessions (cross-session/per-user aggregation)
//! while each session still enforces locally.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default)]
struct Bucket {
    minute: u64,
    count: u32,
    tokens: u64,
}

#[derive(Debug, Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns ms to wait before sending. 0 means the call is within
    /// bounds and may proceed.
    ///
    /// Semantics:
    ///   - `None` on a dimension → no limit configured, skipped.
    ///   - `Some(0)` → **deny all**. Any call is blocked. Useful as
    ///     a killswitch; callers get `ms_until_next_minute()`.
    ///   - `Some(n)` with `n > 0` → throttle at `n`.
    pub fn check(&self, key: &str, rpm: Option<u32>, tpm: Option<u64>) -> u64 {
        if rpm.is_none() && tpm.is_none() {
            return 0;
        }
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");
        let minute = current_minute();
        let b = buckets.entry(key.to_string()).or_default();
        if b.minute != minute {
            *b = Bucket { minute, count: 0, tokens: 0 };
        }
        if let Some(rpm_cap) = rpm {
            if b.count >= rpm_cap {
                return ms_until_next_minute(b.minute);
            }
        }
        if let Some(tpm_cap) = tpm {
            if b.tokens >= tpm_cap {
                return ms_until_next_minute(b.minute);
            }
        }
        0
    }

    pub fn record_request(&self, key: &str) {
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");
        let minute = current_minute();
        let b = buckets.entry(key.to_string()).or_default();
        if b.minute != minute {
            *b = Bucket { minute, count: 0, tokens: 0 };
        }
        b.count = b.count.saturating_add(1);
    }

    pub fn record_tokens(&self, key: &str, tokens: u64) {
        if tokens == 0 {
            return;
        }
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");
        let minute = current_minute();
        let b = buckets.entry(key.to_string()).or_default();
        if b.minute != minute {
            *b = Bucket { minute, count: 0, tokens: 0 };
        }
        b.tokens = b.tokens.saturating_add(tokens);
    }
}

fn current_minute() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 60)
        .unwrap_or(0)
}

fn ms_until_next_minute(minute: u64) -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let next = (minute + 1) * 60_000;
    next.saturating_sub(now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_allows_when_limits_unset() {
        let rl = RateLimiter::new();
        assert_eq!(rl.check("u1", None, None), 0);
    }

    #[test]
    fn check_blocks_when_rpm_reached() {
        let rl = RateLimiter::new();
        rl.record_request("u1");
        rl.record_request("u1");
        assert!(rl.check("u1", Some(2), None) > 0);
    }

    #[test]
    fn check_blocks_when_tpm_reached() {
        let rl = RateLimiter::new();
        rl.record_tokens("u1", 100);
        assert!(rl.check("u1", None, Some(50)) > 0);
    }

    #[test]
    fn keys_are_independent() {
        let rl = RateLimiter::new();
        rl.record_request("u1");
        rl.record_request("u1");
        assert!(rl.check("u1", Some(2), None) > 0);
        assert_eq!(rl.check("u2", Some(2), None), 0);
    }

    /// F6: `Some(0)` must deny all — killswitch semantics distinct
    /// from `None` / unset.
    #[test]
    fn check_denies_on_rpm_zero_killswitch() {
        let rl = RateLimiter::new();
        // No requests recorded yet; `Some(0)` still denies.
        assert!(rl.check("u1", Some(0), None) > 0);
    }

    #[test]
    fn check_denies_on_tpm_zero_killswitch() {
        let rl = RateLimiter::new();
        assert!(rl.check("u1", None, Some(0)) > 0);
    }

    /// Mixed: rpm denies, tpm unset → denied (rpm wins).
    #[test]
    fn check_denies_when_any_dimension_is_zero() {
        let rl = RateLimiter::new();
        assert!(rl.check("u1", Some(0), Some(100)) > 0);
        assert!(rl.check("u1", Some(100), Some(0)) > 0);
    }
}
