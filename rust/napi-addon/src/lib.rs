//! Native addon for mohdel session hot loops.
//!
//! Scaffold only — currently exports `version()` for test pinning.
//! Real hot loops (SSE frame parse, tokenizer, cost calc) land here
//! when profiling shows they're worth the JS ↔ Rust FFI cost.
//!
//! # Why deferred
//!
//! Benchmark evidence (see `bench/bench.js`): in-process per-call JS
//! CPU is ~0.5 ms with `fake` volume=50. The via-gate path adds ~3 ms
//! p50, but that overhead is dominated by HTTP + NDJSON + subprocess
//! IPC — not by parsing. Porting SSE / JSON parsers to Rust wouldn't
//! meaningfully change either number.
//!
//! Reactivate this crate only if a future workload (longer tokens,
//! deeper tool loops, real adapters under heavy concurrency) shows
//! per-call CPU as the actual bottleneck. The scaffold stays in
//! place so that reactivation is cheap.

use napi_derive::napi;

#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_cargo_pkg_version() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}
