# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.95.0] — Tiered pricing in `computeCost`; parallel pool spawn

### Added

- **Tiered pricing support in `computeCost`.** Each of
  `inputPrice` / `outputPrice` / `thinkingPrice` may now be either
  a scalar number (flat per-million rate) or an object
  `{">N": number, ..., "default": number}` that switches rate by
  the call's `inputTokens`. The active rate is the one under the
  highest `>N` key the input strictly exceeds; falls back to
  `"default"` when nothing matches. Keys that aren't `">N"` or
  `"default"` are ignored. Scalar prices behave as before; mixed
  shapes (one field scalar, another tiered) work. `thinkingPrice`
  falls back to the *resolved* `outputPrice` tier when absent.

### Changed

- **`SessionPool::new` spawns sessions concurrently via
  `futures::try_join_all`** instead of a sequential loop. Cold-boot
  cost is now dominated by the single slowest spawn (~300–500 ms)
  instead of scaling linearly with pool size. A 32-slot pool that
  used to take ~10 s to come up now comes up in under a second.
  Failure semantics unchanged — any spawn failure during init still
  aborts pool creation fail-fast.

## [0.94.0] — Model-id unification; catalog guard; adapter wire-string fix

### Breaking

- **`CallEnvelope` and `ImageEnvelope` drop the `provider` field.**
  The `model` field is now the full mohdel id
  `"<provider>/<bare>[:<effort>]"` — same shape on the wire and
  in-process. PROTOCOL §3 already described this wire shape; the
  in-process struct now matches it. `normalize_routing` is removed;
  `split_model_id`, `provider_of`, `catalog_key` replace it as
  per-call helpers on the string. Embedders that read
  `envelope.provider` directly must switch to `provider_of(&env.model)`
  (Rust) or `providerOf(envelope.model)` (JS).
- **`RouteDecision` drops `provider`.** Only `model_id` remains for
  routing; provider is derived from it downstream.
- Mirror helpers exported on the JS side in a new `#core/model-id`
  module: `providerOf`, `bareOf`, `catalogKey`, `effortOf`,
  `parseModelId`. The `ModelId` branded string type keeps
  validation honest at the boundary without runtime cost.

### Fixed

- **`cost=0` for models where the catalog id differs from the SDK
  wire string.** The Anthropic / OpenAI / Gemini / chat-completions
  / image adapters were building the provider HTTP body with
  `envelope.model` *and* looking up pricing with the same value. For
  models like `anthropic/claude-haiku-4-5` whose catalog entry
  carries `spec.model: "claude-haiku-4-5-20251001"` (a dated provider
  string), the HTTP body was right but the pricing key was wrong —
  so `getSpec` missed and `costFor` returned 0 silently. Adapters
  now read `spec.model` for the wire body and `catalogKey(envelope.model)`
  for the spec lookup; the two concerns can diverge without drift.
- **Silent fallback when the catalog has no entry for the requested
  model.** `session/run.js` now hard-fails with
  `SESSION_UNKNOWN_MODEL` before any provider call, instead of
  proceeding with `spec?.rpmLimit` / `spec?.outputTokenLimit` /
  `costFor(...)` all optional-chaining into defaults. This catches
  upstream misconfiguration (catalog-push failure, rewritten
  `env.model` that no longer matches the pushed table) at the first
  call instead of leaking into production as wrong billing.

### Changed

- **Adapter `request.model` now uses `spec.model ?? bareOf(envelope.model)`.**
  The catalog's `spec.model` is the SDK wire string, used for the
  HTTP body only; it no longer double-serves as a catalog key.
- **Route policies pass `env.model` through unchanged** instead of
  rewriting it to `spec.model`. Aliasing, if still needed, must
  happen by rewriting the catalog key (the mohdel model id), never
  by swapping in a wire string — that conflation is what caused the
  cost regression.

## [0.93.0] — ToolCall.thoughtSignature round-trip

### Fixed

- **Gemini tool-use calls failed thin-gate parsing** with
  `"session emitted non-Event line: unknown field thoughtSignature,
  expected one of id, name, arguments"`. The Gemini adapter emits
  `thoughtSignature` alongside every function call — an opaque blob
  the model needs preserved across tool rounds to maintain thinking
  state continuity. The Rust `ToolCall` struct had
  `deny_unknown_fields` and no such field, so thin-gate rejected the
  session's terminal `done` event and the whole call failed.

  Added `thoughtSignature` as an optional field on `ToolCall`
  (`rust/thin-gate/src/protocol.rs`) and documented it on the JS
  `ToolCall` typedef (`js/core/events.js`). Flows through both the
  outbound `AnswerResult.toolCalls` path (session → client) and the
  inbound `Message.toolCalls` path (client replaying history), so
  one fix covers both directions of the tool-use round-trip.

  Non-Gemini providers ignore the field. Callers replaying tool
  results should pass the ToolCall back unchanged.

[0.95.0]: https://github.com/clbrge/mohdel/releases/tag/v0.95.0
[0.94.0]: https://github.com/clbrge/mohdel/releases/tag/v0.94.0
[0.93.0]: https://github.com/clbrge/mohdel/releases/tag/v0.93.0

## [0.92.0] — Catalog CLI rebuild, streaming-health metric

### Fixed

- **`mo curate` was broken.** The CLI browser loaded provider
  wrappers from `src/lib/sdk/*.js` — files deleted during the 0.90
  public release. Plain `fetch()` against each provider's `/models`
  endpoint, no extra SDK dependency. Inference adapters in
  `js/session/adapters/` are untouched.
- **Fireworks curated entries kept the `accounts/fireworks/models/`
  prefix.** The runtime adapter prepends it on call, so curated IDs
  should stay short. `catalog/fireworks.js` now strips the prefix in
  both `listModels` and `getModelInfo`, matching existing
  `fireworks/<short-id>` catalog entries.

### Added

- **Creator selector `Other…` escape hatch.** `promptMissingFields`
  now appends an `Other… (enter a name)` option to the closed
  `clack.select`, falling through to a free-text prompt. Unblocks
  multi-creator hosts (Fireworks, OpenRouter, Novita, Cerebras)
  without needing to widen every provider's hardcoded `creators`
  list.
- **`AnswerResult.maxInterFrameMs`.** The longest gap (ms) between
  adapter events within a call — from `startedAt` to the first
  frame, between consecutive frames, and from the last frame to the
  terminal. Surfaced on the `done` result and on spans as
  `mohdel.max_inter_frame_ms`. Direct signal for calibrating
  host-side idle-watchdog timeouts: a 15-min call streaming deltas
  every 30s is safe; a 5-min call with zero intermediate frames is
  dangerous.

[0.92.0]: https://github.com/clbrge/mohdel/releases/tag/v0.92.0

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
