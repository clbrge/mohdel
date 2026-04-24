//! Gate-level OTel metrics (OTLP/gRPC).
//!
//! Push model via `opentelemetry-otlp` — same transport your session
//! spans use, so logs / spans / metrics all land in the same
//! collector (SigNoz/Honeycomb/etc.) under the same resource
//! attributes.
//!
//! Lazy init gated on `OTEL_EXPORTER_OTLP_ENDPOINT`. Without that
//! env, the module is a no-op: every `record_*` helper short-circuits
//! on the `OnceLock` being empty.
//!
//! ## Instruments
//!
//! | Name                                   | Kind         | Attributes         |
//! |----------------------------------------|--------------|--------------------|
//! | `mohdel.sessions.alive`                | UpDownCounter| –                  |
//! | `mohdel.sessions.respawned`            | Counter      | –                  |
//! | `mohdel.sessions.spawn_failures`       | Counter      | –                  |
//! | `mohdel.pool.in_use`                   | UpDownCounter| –                  |
//! | `mohdel.pool.acquire_wait_ms`          | Histogram    | –                  |
//! | `mohdel.calls`                         | Counter      | `provider`,`status`|
//! | `mohdel.call.duration_ms`              | Histogram    | `provider`,`status`|
//! | `mohdel.cooldown.rejections`           | Counter      | `provider`         |
//! | `mohdel.quota.rejections`              | Counter      | –                  |
//! | `mohdel.policy.errors`                 | Counter      | `kind`             |
//!
//! Pool saturation — idle = `alive - in_use`. When `in_use == alive`
//! every slot is busy and any new acquire has to wait for a release.
//! `acquire_wait_ms.p95` is the single most direct signal that a
//! host is undersized for its concurrency; a p95 above the typical
//! call `duration_ms.p50` means callers are routinely sitting in
//! the queue longer than calls actually take.

use std::sync::OnceLock;
use std::time::Duration;

use opentelemetry::global;
use opentelemetry::metrics::{Counter, Histogram, UpDownCounter};
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::runtime;
use opentelemetry_sdk::Resource;

struct Metrics {
    sessions_alive: UpDownCounter<i64>,
    sessions_respawned: Counter<u64>,
    sessions_spawn_failures: Counter<u64>,
    pool_in_use: UpDownCounter<i64>,
    pool_acquire_wait_ms: Histogram<f64>,
    calls: Counter<u64>,
    call_duration_ms: Histogram<f64>,
    cooldown_rejections: Counter<u64>,
    quota_rejections: Counter<u64>,
    policy_errors: Counter<u64>,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();
static PROVIDER: OnceLock<SdkMeterProvider> = OnceLock::new();

/// Initialize OTLP metrics export. Safe to call multiple times —
/// idempotent. No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is absent, so
/// dev runs and tests don't require a collector.
///
/// Must be called from inside a tokio runtime (the periodic reader
/// runs on `runtime::Tokio`).
pub fn init() {
    if METRICS.get().is_some() {
        return;
    }
    let Ok(endpoint) = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") else {
        return;
    };

    let exporter = match opentelemetry_otlp::MetricExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build()
    {
        Ok(e) => e,
        Err(e) => {
            eprintln!("metrics init: exporter build failed: {e}");
            return;
        }
    };

    // F56: export interval is env-tunable for short-lived processes
    // (tests, benchmarks) and operators who want tighter SLO windows.
    // Clamped to [50 ms, 600 s] to keep pathological values from
    // flooding the collector or effectively disabling exports.
    let interval = metrics_export_interval();
    let reader = PeriodicReader::builder(exporter, runtime::Tokio)
        .with_interval(interval)
        .build();

    let service_name = std::env::var("OTEL_SERVICE_NAME")
        .unwrap_or_else(|_| "mohdel-thin-gate".to_string());
    let resource = Resource::new(vec![KeyValue::new("service.name", service_name)]);

    let provider = SdkMeterProvider::builder()
        .with_reader(reader)
        .with_resource(resource)
        .build();
    global::set_meter_provider(provider.clone());

    let meter = global::meter("mohdel_thin_gate");
    let metrics = Metrics {
        sessions_alive: meter
            .i64_up_down_counter("mohdel.sessions.alive")
            .with_description("Session subprocesses currently in the pool")
            .build(),
        sessions_respawned: meter
            .u64_counter("mohdel.sessions.respawned")
            .with_description("Session subprocesses respawned after death")
            .build(),
        sessions_spawn_failures: meter
            .u64_counter("mohdel.sessions.spawn_failures")
            .with_description("Session spawn attempts that failed (readiness or exec)")
            .build(),
        pool_in_use: meter
            .i64_up_down_counter("mohdel.pool.in_use")
            .with_description("Sessions currently checked out of the pool (handling a call)")
            .build(),
        pool_acquire_wait_ms: meter
            .f64_histogram("mohdel.pool.acquire_wait_ms")
            .with_description("Wall time a caller waited for a free session slot")
            .with_unit("ms")
            .build(),
        calls: meter
            .u64_counter("mohdel.calls")
            .with_description("Calls dispatched through the gate")
            .build(),
        call_duration_ms: meter
            .f64_histogram("mohdel.call.duration_ms")
            .with_description("Call wall time from envelope receipt to terminal event")
            .with_unit("ms")
            .build(),
        cooldown_rejections: meter
            .u64_counter("mohdel.cooldown.rejections")
            .with_description("Calls rejected because the provider is cooling down")
            .build(),
        quota_rejections: meter
            .u64_counter("mohdel.quota.rejections")
            .with_description("Calls rejected for exceeding rpm/tpm quota")
            .build(),
        policy_errors: meter
            .u64_counter("mohdel.policy.errors")
            .with_description("Errors raised from RoutePolicy or QuotaPolicy")
            .build(),
    };
    let _ = METRICS.set(metrics);
    let _ = PROVIDER.set(provider);
}

/// Shut down the meter provider, flushing any pending batches. Idempotent.
pub fn shutdown() {
    if let Some(p) = PROVIDER.get() {
        let _ = p.shutdown();
    }
}

/// Access the initialized `SdkMeterProvider`, if any. Embedders use
/// this to register their own instruments against the same OTLP
/// exporter and resource attributes mohdel uses, so embedder-owned
/// metrics and `mohdel.*` metrics land in the same collector under
/// one `service.name`.
///
/// Returns `None` when metrics are disabled (no
/// `OTEL_EXPORTER_OTLP_ENDPOINT`) or before `init()` ran.
pub fn meter_provider() -> Option<&'static SdkMeterProvider> {
    PROVIDER.get()
}

/// OTLP periodic-reader export interval. `MOHDEL_METRICS_INTERVAL_MS`
/// env overrides the 15 s default. Clamped to `[50, 600_000]` ms.
fn metrics_export_interval() -> Duration {
    const DEFAULT_MS: u64 = 15_000;
    const MIN_MS: u64 = 50;
    const MAX_MS: u64 = 600_000;

    let ms = std::env::var("MOHDEL_METRICS_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|n| n.clamp(MIN_MS, MAX_MS))
        .unwrap_or(DEFAULT_MS);
    Duration::from_millis(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cargo runs unit tests in parallel; mutating a process-global
    // env var in separate tests would race. Consolidated into one
    // test that saves + restores.
    #[test]
    fn metrics_interval_default_and_clamps() {
        let prev = std::env::var("MOHDEL_METRICS_INTERVAL_MS").ok();

        // Default: no env → 15 s
        // SAFETY: `env::remove_var` / `set_var` are unsafe in recent
        // std due to cross-thread races. This test block is the sole
        // mutator (parallel tests don't touch the same var) and
        // restores the prior value at the end.
        unsafe { std::env::remove_var("MOHDEL_METRICS_INTERVAL_MS") };
        assert_eq!(metrics_export_interval(), Duration::from_secs(15));

        // Below floor → clamped up to 50 ms
        unsafe { std::env::set_var("MOHDEL_METRICS_INTERVAL_MS", "10") };
        assert_eq!(metrics_export_interval(), Duration::from_millis(50));

        // Above ceiling → clamped down to 600 s
        unsafe { std::env::set_var("MOHDEL_METRICS_INTERVAL_MS", "9999999999") };
        assert_eq!(metrics_export_interval(), Duration::from_millis(600_000));

        // In-range passes through
        unsafe { std::env::set_var("MOHDEL_METRICS_INTERVAL_MS", "500") };
        assert_eq!(metrics_export_interval(), Duration::from_millis(500));

        // Non-numeric → ignored, falls through to default
        unsafe { std::env::set_var("MOHDEL_METRICS_INTERVAL_MS", "bogus") };
        assert_eq!(metrics_export_interval(), Duration::from_secs(15));

        match prev {
            Some(v) => unsafe { std::env::set_var("MOHDEL_METRICS_INTERVAL_MS", v) },
            None => unsafe { std::env::remove_var("MOHDEL_METRICS_INTERVAL_MS") },
        }
    }
}

// ---------- Record helpers ----------
//
// Each helper is a no-op when metrics are disabled. Hot paths pay
// only the cost of a `OnceLock::get()` on `None`.

pub fn session_alive_delta(delta: i64) {
    if let Some(m) = METRICS.get() {
        m.sessions_alive.add(delta, &[]);
    }
}

pub fn session_respawned() {
    if let Some(m) = METRICS.get() {
        m.sessions_respawned.add(1, &[]);
    }
}

pub fn session_spawn_failed() {
    if let Some(m) = METRICS.get() {
        m.sessions_spawn_failures.add(1, &[]);
    }
}

pub fn pool_in_use_delta(delta: i64) {
    if let Some(m) = METRICS.get() {
        m.pool_in_use.add(delta, &[]);
    }
}

pub fn pool_acquire_wait(ms: f64) {
    if let Some(m) = METRICS.get() {
        m.pool_acquire_wait_ms.record(ms, &[]);
    }
}

pub fn record_call(provider: &str, status: &str, duration_ms: f64) {
    if let Some(m) = METRICS.get() {
        let attrs = [
            KeyValue::new("provider", provider.to_string()),
            KeyValue::new("status", status.to_string()),
        ];
        m.calls.add(1, &attrs);
        m.call_duration_ms.record(duration_ms, &attrs);
    }
}

pub fn cooldown_rejected(provider: &str) {
    if let Some(m) = METRICS.get() {
        m.cooldown_rejections
            .add(1, &[KeyValue::new("provider", provider.to_string())]);
    }
}

pub fn quota_rejected() {
    if let Some(m) = METRICS.get() {
        m.quota_rejections.add(1, &[]);
    }
}

pub fn policy_error(kind: &str) {
    if let Some(m) = METRICS.get() {
        m.policy_errors
            .add(1, &[KeyValue::new("kind", kind.to_string())]);
    }
}
