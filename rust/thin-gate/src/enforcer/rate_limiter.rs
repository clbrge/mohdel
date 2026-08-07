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

/// Cap on distinct keys held at once. `key` is the caller-supplied
/// `authId`, so without a cap a caller rotating it grows the map for
/// the process lifetime.
pub const MAX_TRACKED_KEYS: usize = 100_000;

/// Makes room for `key` if it isn't tracked yet, dropping buckets left
/// over from earlier minutes. Returns false when the map is full of
/// live current-minute keys and `key` is not one of them.
fn admit(buckets: &mut HashMap<String, Bucket>, key: &str, minute: u64) -> bool {
    if buckets.contains_key(key) || buckets.len() < MAX_TRACKED_KEYS {
        return true;
    }
    buckets.retain(|_, b| b.minute == minute);
    if buckets.len() >= MAX_TRACKED_KEYS {
        crate::metrics::enforcer_keyspace_full("rate");
        return false;
    }
    true
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
        if !admit(&mut buckets, key, minute) {
            return ms_until_next_minute(minute);
        }
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
        if !admit(&mut buckets, key, minute) {
            return;
        }
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
        if !admit(&mut buckets, key, minute) {
            return;
        }
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

    /// `Some(0)` must deny all — killswitch semantics distinct
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

    fn fill(rl: &RateLimiter, minute: u64) {
        let mut buckets = rl.buckets.lock().unwrap();
        for i in 0..MAX_TRACKED_KEYS {
            buckets.insert(format!("k{i}"), Bucket { minute, count: 0, tokens: 0 });
        }
    }

    /// Buckets from earlier minutes carry no information, so they are
    /// what the cap sweeps first.
    #[test]
    fn cap_sweeps_stale_buckets_to_make_room() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute() - 1);
        assert_eq!(rl.buckets.lock().unwrap().len(), MAX_TRACKED_KEYS);

        assert_eq!(rl.check("fresh", Some(10), None), 0);
        assert_eq!(rl.buckets.lock().unwrap().len(), 1);
    }

    /// Full of live current-minute keys: a new key is refused rather
    /// than tracked, and told to retry once the buckets roll over.
    #[test]
    fn cap_denies_new_key_when_full_of_live_buckets() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute());

        assert!(rl.check("fresh", Some(10), None) > 0);
        assert_eq!(rl.buckets.lock().unwrap().len(), MAX_TRACKED_KEYS);
        assert!(!rl.buckets.lock().unwrap().contains_key("fresh"));
    }

    #[test]
    fn cap_does_not_affect_already_tracked_keys() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute());

        assert_eq!(rl.check("k0", Some(2), None), 0);
        rl.record_request("k0");
        rl.record_request("k0");
        assert!(rl.check("k0", Some(2), None) > 0);
    }

    #[test]
    fn cap_blocks_record_paths_too() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute());

        rl.record_request("fresh");
        rl.record_tokens("fresh", 100);
        assert_eq!(rl.buckets.lock().unwrap().len(), MAX_TRACKED_KEYS);
    }
}
