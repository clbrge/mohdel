//! Minute-bucket rate limiter. Per-key counters for requests, tokens
//! and embedding inputs. Returns milliseconds to wait when the bucket
//! is exhausted; 0 means go ahead.
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
    inputs: u32,
}

/// The three dimensions a key can be capped on, as the quota policy
/// reports them.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    pub rpm: Option<u32>,
    pub tpm: Option<u64>,
    pub inpm: Option<u32>,
}

impl Limits {
    fn unset(&self) -> bool {
        self.rpm.is_none() && self.tpm.is_none() && self.inpm.is_none()
    }
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
    ///
    /// `rpm` and `tpm` gate on what the bucket already holds, since
    /// the size of the call ahead is not known until it returns.
    /// `inpm` gates on `pending_inputs`, the batch this call carries,
    /// which is exact before dispatch — so the call is admitted only
    /// if the whole batch fits. Mirrors `js/session/_rate_limiter.js`.
    pub fn check(&self, key: &str, limits: Limits, pending_inputs: u32) -> u64 {
        if limits.unset() {
            return 0;
        }
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");
        let minute = current_minute();
        if !admit(&mut buckets, key, minute) {
            return ms_until_next_minute(minute);
        }
        let b = buckets.entry(key.to_string()).or_default();
        if b.minute != minute {
            *b = Bucket { minute, count: 0, tokens: 0, inputs: 0 };
        }
        if let Some(rpm_cap) = limits.rpm {
            if b.count >= rpm_cap {
                return ms_until_next_minute(b.minute);
            }
        }
        if let Some(tpm_cap) = limits.tpm {
            if b.tokens >= tpm_cap {
                return ms_until_next_minute(b.minute);
            }
        }
        if let Some(inpm_cap) = limits.inpm {
            if inpm_cap == 0 {
                return ms_until_next_minute(b.minute);
            }
            // A batch larger than the whole allowance never fits, so waiting out
            // the minute buys nothing: send it and take the provider's answer.
            // Splitting it belongs to the caller, not the gate.
            if pending_inputs <= inpm_cap && b.inputs.saturating_add(pending_inputs) > inpm_cap {
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
            *b = Bucket { minute, count: 0, tokens: 0, inputs: 0 };
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
            *b = Bucket { minute, count: 0, tokens: 0, inputs: 0 };
        }
        b.tokens = b.tokens.saturating_add(tokens);
    }

    pub fn record_inputs(&self, key: &str, inputs: u32) {
        if inputs == 0 {
            return;
        }
        let mut buckets = self.buckets.lock().expect("rate limiter mutex poisoned");
        let minute = current_minute();
        if !admit(&mut buckets, key, minute) {
            return;
        }
        let b = buckets.entry(key.to_string()).or_default();
        if b.minute != minute {
            *b = Bucket { minute, count: 0, tokens: 0, inputs: 0 };
        }
        b.inputs = b.inputs.saturating_add(inputs);
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

    fn rpm(n: u32) -> Limits {
        Limits { rpm: Some(n), ..Default::default() }
    }

    fn tpm(n: u64) -> Limits {
        Limits { tpm: Some(n), ..Default::default() }
    }

    fn inpm(n: u32) -> Limits {
        Limits { inpm: Some(n), ..Default::default() }
    }

    #[test]
    fn check_allows_when_limits_unset() {
        let rl = RateLimiter::new();
        assert_eq!(rl.check("u1", Limits::default(), 0), 0);
    }

    #[test]
    fn check_blocks_when_rpm_reached() {
        let rl = RateLimiter::new();
        rl.record_request("u1");
        rl.record_request("u1");
        assert!(rl.check("u1", rpm(2), 0) > 0);
    }

    #[test]
    fn check_blocks_when_tpm_reached() {
        let rl = RateLimiter::new();
        rl.record_tokens("u1", 100);
        assert!(rl.check("u1", tpm(50), 0) > 0);
    }

    #[test]
    fn keys_are_independent() {
        let rl = RateLimiter::new();
        rl.record_request("u1");
        rl.record_request("u1");
        assert!(rl.check("u1", rpm(2), 0) > 0);
        assert_eq!(rl.check("u2", rpm(2), 0), 0);
    }

    /// `Some(0)` must deny all — killswitch semantics distinct
    /// from `None` / unset.
    #[test]
    fn check_denies_on_rpm_zero_killswitch() {
        let rl = RateLimiter::new();
        // No requests recorded yet; `Some(0)` still denies.
        assert!(rl.check("u1", rpm(0), 0) > 0);
    }

    #[test]
    fn check_denies_on_tpm_zero_killswitch() {
        let rl = RateLimiter::new();
        assert!(rl.check("u1", tpm(0), 0) > 0);
    }

    /// Mixed: rpm denies, tpm unset → denied (rpm wins).
    #[test]
    fn check_denies_when_any_dimension_is_zero() {
        let rl = RateLimiter::new();
        assert!(rl.check("u1", Limits { rpm: Some(0), tpm: Some(100), inpm: None }, 0) > 0);
        assert!(rl.check("u1", Limits { rpm: Some(100), tpm: Some(0), inpm: None }, 0) > 0);
    }

    fn fill(rl: &RateLimiter, minute: u64) {
        let mut buckets = rl.buckets.lock().unwrap();
        for i in 0..MAX_TRACKED_KEYS {
            buckets.insert(format!("k{i}"), Bucket { minute, count: 0, tokens: 0, inputs: 0 });
        }
    }

    /// Buckets from earlier minutes carry no information, so they are
    /// what the cap sweeps first.
    #[test]
    fn cap_sweeps_stale_buckets_to_make_room() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute() - 1);
        assert_eq!(rl.buckets.lock().unwrap().len(), MAX_TRACKED_KEYS);

        assert_eq!(rl.check("fresh", rpm(10), 0), 0);
        assert_eq!(rl.buckets.lock().unwrap().len(), 1);
    }

    /// Full of live current-minute keys: a new key is refused rather
    /// than tracked, and told to retry once the buckets roll over.
    #[test]
    fn cap_denies_new_key_when_full_of_live_buckets() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute());

        assert!(rl.check("fresh", rpm(10), 0) > 0);
        assert_eq!(rl.buckets.lock().unwrap().len(), MAX_TRACKED_KEYS);
        assert!(!rl.buckets.lock().unwrap().contains_key("fresh"));
    }

    #[test]
    fn cap_does_not_affect_already_tracked_keys() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute());

        assert_eq!(rl.check("k0", rpm(2), 0), 0);
        rl.record_request("k0");
        rl.record_request("k0");
        assert!(rl.check("k0", rpm(2), 0) > 0);
    }

    #[test]
    fn cap_blocks_record_paths_too() {
        let rl = RateLimiter::new();
        fill(&rl, current_minute());

        rl.record_request("fresh");
        rl.record_tokens("fresh", 100);
        assert_eq!(rl.buckets.lock().unwrap().len(), MAX_TRACKED_KEYS);
    }

    /// Inputs are known before dispatch, so the batch is admitted only
    /// when the whole of it fits — unlike rpm/tpm, which gate on what
    /// the bucket already holds.
    #[test]
    fn check_admits_a_batch_only_when_it_fits_whole() {
        let rl = RateLimiter::new();
        assert_eq!(rl.check("u1", inpm(100), 96), 0);
        rl.record_inputs("u1", 96);
        assert!(rl.check("u1", inpm(100), 96) > 0);
        assert_eq!(rl.check("u1", inpm(100), 4), 0);
    }

    /// A batch larger than the entire allowance can never fit, so
    /// waiting is pointless: it goes, and the provider answers.
    #[test]
    fn check_lets_an_oversized_batch_through() {
        let rl = RateLimiter::new();
        assert_eq!(rl.check("u1", inpm(50), 96), 0);
    }

    #[test]
    fn check_denies_on_inpm_zero_killswitch() {
        let rl = RateLimiter::new();
        assert!(rl.check("u1", inpm(0), 0) > 0);
    }

    #[test]
    fn inputs_accumulate_and_are_keyed_like_the_others() {
        let rl = RateLimiter::new();
        rl.record_inputs("u1", 40);
        rl.record_inputs("u1", 40);
        assert!(rl.check("u1", inpm(100), 40) > 0);
        assert_eq!(rl.check("u2", inpm(100), 40), 0);
    }

    /// Requests, tokens and inputs are three counters on one bucket:
    /// an embed call must not spend the chat allowance or vice versa.
    #[test]
    fn dimensions_do_not_bleed_into_each_other() {
        let rl = RateLimiter::new();
        rl.record_inputs("u1", 1_000);
        assert_eq!(rl.check("u1", rpm(1), 0), 0);
        assert_eq!(rl.check("u1", tpm(1), 0), 0);
        rl.record_request("u1");
        assert_eq!(rl.check("u1", inpm(2_000), 500), 0);
    }
}
