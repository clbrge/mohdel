//! Consecutive-failure cooldown tracker.
//!
//! Mirrors `js/session/_cooldown.js`:
//!   - `record_failure(.., immediate: true)` activates cooldown on the
//!     first failure (401/403 — auth broken, every subsequent call
//!     will fail).
//!   - Normal failures activate after `threshold` consecutive
//!     failures.
//!   - A success (`reset`) clears the counter.
//!   - `cooling_down` reports the remaining window in seconds.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct CooldownInfo {
    pub seconds_left: u64,
    pub fail_count: u32,
    pub reason: &'static str,
}

#[derive(Debug, Default, Clone)]
struct Entry {
    fail_count: u32,
    until_ms: u64,
    reason: &'static str,
}

#[derive(Debug, Default)]
pub struct CooldownTracker {
    entries: Mutex<HashMap<String, Entry>>,
}

impl CooldownTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns cooldown info when the key is currently cooling down.
    /// Expires and removes the entry when the window has passed.
    pub fn cooling_down(&self, key: &str) -> Option<CooldownInfo> {
        let mut entries = self.entries.lock().expect("cooldown mutex poisoned");
        let entry = entries.get(key)?.clone();
        if entry.until_ms == 0 {
            return None;
        }
        let now = now_ms();
        if now >= entry.until_ms {
            entries.remove(key);
            return None;
        }
        Some(CooldownInfo {
            seconds_left: (entry.until_ms - now + 999) / 1_000,
            fail_count: entry.fail_count,
            reason: entry.reason,
        })
    }

    /// Records a failure. Returns `true` only if this call caused a
    /// **fresh** cooldown activation — either past the threshold with
    /// no active window, or reactivating after a previously-expired
    /// window. Late failures during an active window increment
    /// `fail_count` (for diagnostics) but do **not** push the
    /// deadline forward; the cooldown is set-once, waited-out, reset
    /// on success. Without this, concurrent failures racing past
    /// the pre-dispatch check would keep sliding `until_ms` and the
    /// user would effectively never recover.
    pub fn record_failure(
        &self,
        key: &str,
        threshold: u32,
        duration: Duration,
        immediate: bool,
    ) -> bool {
        let mut entries = self.entries.lock().expect("cooldown mutex poisoned");
        let entry = entries.entry(key.to_string()).or_default();
        entry.fail_count = entry.fail_count.saturating_add(1);
        let should_trigger = immediate || entry.fail_count >= threshold;
        if should_trigger {
            let now = now_ms();
            if entry.until_ms == 0 || now >= entry.until_ms {
                entry.until_ms = now + duration.as_millis() as u64;
                entry.reason = if immediate { "auth" } else { "consecutive_failures" };
                return true;
            }
        }
        false
    }

    pub fn reset(&self, key: &str) {
        let mut entries = self.entries.lock().expect("cooldown mutex poisoned");
        entries.remove(key);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_cooldown_until_threshold() {
        let cd = CooldownTracker::new();
        assert_eq!(
            cd.record_failure("u|p", 3, Duration::from_secs(60), false),
            false
        );
        assert_eq!(
            cd.record_failure("u|p", 3, Duration::from_secs(60), false),
            false
        );
        assert!(cd.cooling_down("u|p").is_none());
    }

    #[test]
    fn threshold_triggers_cooldown() {
        let cd = CooldownTracker::new();
        for _ in 0..3 {
            cd.record_failure("u|p", 3, Duration::from_secs(60), false);
        }
        let info = cd.cooling_down("u|p").expect("should be cooling");
        assert_eq!(info.reason, "consecutive_failures");
        assert_eq!(info.fail_count, 3);
    }

    #[test]
    fn immediate_fires_on_first_failure() {
        let cd = CooldownTracker::new();
        assert!(cd.record_failure("u|p", 3, Duration::from_secs(60), true));
        assert_eq!(cd.cooling_down("u|p").unwrap().reason, "auth");
    }

    #[test]
    fn reset_clears_entry() {
        let cd = CooldownTracker::new();
        cd.record_failure("u|p", 3, Duration::from_secs(60), true);
        cd.reset("u|p");
        assert!(cd.cooling_down("u|p").is_none());
    }

    #[test]
    fn expired_cooldown_is_cleared_on_read() {
        let cd = CooldownTracker::new();
        cd.record_failure("u|p", 1, Duration::from_millis(1), true);
        std::thread::sleep(Duration::from_millis(5));
        assert!(cd.cooling_down("u|p").is_none());
    }

    /// F5 regression: late failures during an active cooldown must
    /// not push the deadline forward. Without this freeze, concurrent
    /// calls racing past the pre-dispatch check would keep extending
    /// the window and the user would effectively never recover.
    #[test]
    fn late_failures_do_not_extend_active_cooldown() {
        let cd = CooldownTracker::new();
        // 200ms window — long enough to be observable, short enough
        // to keep the test snappy.
        let window = Duration::from_millis(200);

        // First call: immediate activation. Returns true.
        assert!(cd.record_failure("u|p", 3, window, true));
        let first_until = cd
            .entries
            .lock()
            .unwrap()
            .get("u|p")
            .unwrap()
            .until_ms;
        assert!(first_until > 0);

        // Fire a handful of late failures that would otherwise all
        // "should_trigger". None should move the deadline.
        for _ in 0..5 {
            std::thread::sleep(Duration::from_millis(10));
            let activated = cd.record_failure("u|p", 3, window, false);
            assert!(!activated, "late failures must not report activation");
        }
        let later_until = cd
            .entries
            .lock()
            .unwrap()
            .get("u|p")
            .unwrap()
            .until_ms;
        assert_eq!(
            first_until, later_until,
            "cooldown deadline must be frozen across late failures"
        );

        // fail_count is still incrementing for diagnostics: 1 + 5 = 6
        let info = cd.cooling_down("u|p").unwrap();
        assert_eq!(info.fail_count, 6);
    }

    /// After the window expires, the next failure at/past threshold
    /// does set a fresh cooldown — we froze *active* windows, not
    /// the whole tracker.
    #[test]
    fn expired_window_allows_fresh_activation() {
        let cd = CooldownTracker::new();
        let tiny = Duration::from_millis(10);

        assert!(cd.record_failure("u|p", 1, tiny, false));
        std::thread::sleep(Duration::from_millis(20));
        // Window now expired.
        assert!(
            cd.record_failure("u|p", 1, Duration::from_millis(200), false),
            "expired window should re-activate on next failure"
        );
        // New deadline is set (non-zero and in the future)
        let info = cd.cooling_down("u|p").expect("freshly active");
        assert!(info.seconds_left <= 1);
    }
}
