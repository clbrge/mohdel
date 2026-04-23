# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.91.0] — Session-pool catalog refresh

### Fixed

- **Session pool sessions stayed catalog-less after a late admin
  push.** `SessionPool` pulled the `CatalogSource` snapshot exactly
  once per session — at spawn. When the host application populated
  its catalog *after* pool init (the normal order when catalog data
  arrives over a separate admin channel), all pre-spawned sessions
  kept running without one. Adapters then returned `cost: 0` on every
  call because `costFor(model, usage)` had no spec to price against.
  Sessions only picked up the catalog after a crash + respawn.

### Added

- **`SessionPool::notify_catalog_changed()`** — atomic version bump
  the host calls when a fresh catalog snapshot becomes available.
  O(1), no I/O on the caller.
- **Acquire-time catalog refresh.** `SessionPool::acquire()` now
  compares the pool's version to the session's seeded version; stale
  sessions get a fresh `set_catalog` injected before hand-off. On
  injection failure the session is discarded and a replacement is
  queued; the caller gets the next idle one.
- **`PooledSession::catalog_version()`** getter for introspection and
  testing. Sessions spawned while `CatalogSource` returned `None`
  start at version 0 and catch up on the first acquire after a bump.
- **Breaking:** `PooledSession::spawn_and_ready` signature gained a
  `seed_version: u64` parameter. Hosts that build their own pool
  wrappers must pass the current pool version (0 for fresh pools).

### Tests

- `tests/catalog_refresh.rs` — 6 integration tests covering the
  catalog-less-at-spawn case, notify-triggered injection, idempotent
  repeat acquires, collapsed multi-notify snapshots, and replacement
  version seeding.
- `npm test` now runs both JS (`vitest run test/unit`) and Rust
  (`cargo test` across `rust/thin-gate` and `rust/napi-addon`) so a
  Rust-only regression blocks release via the `prerelease` hook.

[0.91.0]: https://github.com/clbrge/mohdel/releases/tag/v0.91.0

## [0.90.0] — Initial public release

First public release on npm.

### Architecture

- **Three-plane split.** JS `client` over a unix socket, Rust `thin-gate`
  scheduler / state owner, JS `session` provider executor. See
  [ARCHITECTURE.md](ARCHITECTURE.md).
- **Frozen wire contract.** `CallEnvelope`, `Event` union, `AnswerResult`,
  `TypedError`, and the image-path equivalents are specified in
  [PROTOCOL.md](PROTOCOL.md) and mirrored between JS (JSDoc in `js/core/*.js`)
  and Rust (`rust/thin-gate/src/protocol.rs`). Cross-language round-trip
  tests enforce fidelity on both sides.
- **Distribution: npm only.** Main package `mohdel` declares
  `mohdel-thin-gate-<platform>` as an optional dependency; npm installs
  the right per-platform prebuilt binary automatically. Not published
  to crates.io.

### Providers (11)

Anthropic, OpenAI, Gemini, Groq, Cerebras, xAI, DeepSeek, Mistral,
OpenRouter, Fireworks, Novita.

### Features

- Streaming deltas, tool calling, thinking / reasoning control (per-model
  effort levels), image generation (OpenAI, Novita), vision and video input
  (Gemini).
- OpenTelemetry-native: `mohdel.session.answer` spans with GenAI semantic
  conventions, gate-side OTLP metrics, trace-linked structured logs. One
  `OTEL_EXPORTER_OTLP_ENDPOINT` covers spans + metrics.
- Process-isolated inference: adapter crashes stay in the session
  subprocess; the gate respawns and the caller sees a recoverable
  `SESSION_DIED` terminal event.
- Two-layer enforcement: cooldown + rate-limit checks run independently
  at the gate and at the session. Documented in
  [ARCHITECTURE.md §Two-layer enforcement](ARCHITECTURE.md#two-layer-enforcement-gate--session).

### Operator features

- `Auth.baseURL` — optional per-call override of the adapter's default
  provider endpoint. Lets operators point mohdel at a self-hosted
  deployment, regional endpoint, proxy, or test server without patching
  adapters. Threads through the JS factory (`configuration.baseURL`),
  the wire `Auth` struct, and every OpenAI-compatible adapter.
- Typed error `detail` — the 4xx / 5xx / NET error classifier preserves
  the provider's own rejection text on `TypedError.detail`, so callers
  debugging a schema reject see the real reason instead of a bare
  `"provider error 400"` machine-key label. 401 / 403 details stay
  opaque to avoid echoing API keys back on the wire.

### Integration paths

- **Client (cross-process, recommended default):** `mohdel/client`
  over unix-socket HTTP to a running `thin-gate`.
- **Factory (in-process shortcut):** `mohdel()` for CLI (`mo ask`),
  scripts, tests, single-process services.

### Binary platform support

- Linux x64 glibc (`mohdel-thin-gate-linux-x64-gnu`).
- More platforms are additive post-0.90 with no wire changes.

### Install footprint

- CLI-only dependencies (`chalk`, `@clack/prompts`) and OpenTelemetry
  SDK packages (`@opentelemetry/sdk-node`,
  `@opentelemetry/exporter-trace-otlp-grpc`) are `optionalDependencies`.
  Library consumers running `npm install --omit=optional` skip all of
  them and still get a working client + factory — the `silent` logger
  is the default and no-op tracer uses only `@opentelemetry/api`
  (mandatory, tiny). The `mo` CLI and OTLP trace export require the
  optional packages; `npm install` by default pulls them in.

### Supported runtimes

- Node.js 22+.

[0.90.0]: https://github.com/clbrge/mohdel/releases/tag/v0.90.0
