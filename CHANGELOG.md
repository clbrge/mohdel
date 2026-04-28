# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.98.0] — Catalog primitives + envelope fixes

### Added

- **`effectiveContextLimit(spec)`** public utility (in `src/lib/utils.js`,
  re-exported from package root). Returns
  `spec.contextTokenLimit − (spec.inputCeilingMargin ?? 0)` — the
  practical input ceiling once any empirically-derived reserve is
  subtracted. Reduces to `contextTokenLimit` unchanged when the margin
  field is unset, so existing catalog entries are unaffected.
- **Provider records gained two informational fields** in
  `src/lib/providers.js`:
  - `contextSemantics: 'shared' | 'separate'` — `separate` for `gemini`
    (distinct input/output budgets), `shared` for everyone else
    (`input + max_output ≤ context`).
  - `outputCapStrategy: 'error' | 'accept'` — `error` for `anthropic`
    and `novita` (reject when `max_tokens > outputTokenLimit`),
    `accept` for everyone else (silent cap or permissive). Per-model
    overrides live on the catalog spec when needed.
- **`gpt-tokenizer`** (`^3.4.0`) declared as a devDependency for
  maintainer tooling that needs exact tiktoken o200k/cl100k builds.
  Not loaded by runtime code.

### Fixed

- **`runAnswer` envelope now carries the mohdel catalog key**
  (`<provider>/<bare>`) instead of `${provider}/${spec.model}`.
  Previously, models whose bare segment differs from `spec.model`
  (e.g. `anthropic/claude-haiku-4-5` with `model:
  "claude-haiku-4-5-20251001"`) raised `SESSION_UNKNOWN_MODEL`
  because downstream `catalogKey(envelope.model)` couldn't resolve
  the spec. Adapters were already doing the right thing
  (`spec?.model ?? bareOf(envelope.model)`), so the upstream API
  call still uses the correct upstream id; only the envelope's
  catalog-lookup key is corrected.
- **TTFT now fires on `delta.reasoning_content`** in the chat
  completions adapter (`_chat_completions.js`). DeepSeek V4,
  `deepseek-reasoner`, and Cerebras reasoning models stream
  reasoning chunks before visible content; the first-token
  timestamp now reflects when the model actually starts producing
  output, not just when visible text begins.

### Changed

- **Fireworks model id convention.** `spec.model` now carries the
  full upstream id (`accounts/fireworks/models/<bare>`); the
  catalog key remains the short `fireworks/<bare>`. The runtime
  adapter forwards `spec.model` verbatim — no auto-prefixing — so
  what the catalog says is what the API receives.
- **`openai`** dependency bumped to `^6.35.0`.

### Breaking

- **Fireworks catalogs synced before this release contain stripped
  `model` values** (e.g. `"model": "kimi-k2p5"`). Re-run model
  discovery (`mo onboard fireworks` or equivalent) to repopulate
  the entries with full upstream ids
  (`"model": "accounts/fireworks/models/kimi-k2p5"`). Without that,
  Fireworks calls will fail because the adapter no longer
  re-attaches the prefix.

## [0.97.1] — Dependency updates

### Changed

- Dependencies refreshed to current versions in `package.json` and
  `Cargo.toml`. No runtime or API behavior change.

## [0.97.0] — Provider error classification by code

### Added

- **`classifyProviderError` inspects provider error codes and
  message text before falling back to HTTP-status buckets.** Three
  new `TypedError.type` tags surface from the unified adapter
  classifier:
  - `CONTEXT_OVERFLOW` (non-retryable, severity `warn`) — input
    exceeds the model's context window. Triggered by OpenAI
    `code: 'context_length_exceeded'`, Anthropic
    `error.type: 'context_length_exceeded'`, and a message-based
    fallback for providers that don't expose a dedicated code
    (Gemini, some compat gateways: "prompt is too long", "maximum
    context length", "too many tokens", etc.).
  - `QUOTA_EXHAUSTED` (non-retryable, severity `error`) — the org
    is out of credits/quota. Triggered by `insufficient_quota`,
    `billing_hard_limit_reached`, `account_deactivated`,
    `credit_balance_too_low`. Most commonly arrives as 429, where
    the previous status-only bucketing wrongly returned
    `RATE_LIMIT, retryable: true` and would burn retries on a
    permanent failure.
  - `CONTENT_BLOCKED` (non-retryable, severity `warn`) —
    triggered by `content_filter`, `content_policy_violation`,
    `safety`, `blocked`, `prohibited_content`.
- **`extractCode(err)` helper** in `js/session/adapters/_errors.js`
  reads provider error codes out of any of the four shapes the
  SDKs use (`err.code`, `err.error.code`, `err.error.error.type`,
  `err.response.data.error.code`), so the classifier picks up
  OpenAI-, Anthropic-, and OpenAI-compat-style codes uniformly.

### Changed

- **`INTEGRATION.md` error-types list** updated with
  `QUOTA_EXHAUSTED` and `CONTENT_BLOCKED`, with an explicit note
  that `CONTEXT_OVERFLOW`, `QUOTA_EXHAUSTED`, and `CONTENT_BLOCKED`
  are non-retryable (same input → same failure; recover at a
  higher layer by compacting the prompt, swapping models, or
  surfacing to the user).

### Removed

- **Dead helpers in `src/lib/errors.js`** that no live code path
  imported: `APIError`, `toTransportError`, `retryableWarn`,
  `reportRetryable`, `reportDefault`, `reportContextOverflow`,
  `isContextOverflowMessage`, and the private `isConnectionError`.
  These were the per-adapter classifier shape from before
  `js/session/adapters/_errors.js::classifyProviderError` became
  the single source of truth; only their own `errors.test.js`
  cases referenced them. The live surface — `MohdelError`,
  `Severity`, `getSeverityNumber` — is unchanged.

## [0.96.0] — Pool observability; bounded-concurrency spawn

### Added

- **Pool observability.** Two new OTLP instruments on the
  `mohdel_thin_gate` meter:
  - `mohdel.pool.in_use` (UpDownCounter) — sessions currently
    checked out. Combined with existing `mohdel.sessions.alive`,
    gives live saturation (`in_use == alive` → every slot busy).
  - `mohdel.pool.acquire_wait_ms` (Histogram) — wall time from
    acquire request to session handed out. Includes any internal
    retry (catalog-injection failure path). `p95` above the typical
    call `duration_ms.p50` is a direct signal that the host is
    undersized for its concurrency.

### Changed

- **`SessionPool::discard` helper** consolidates the "drop an
  acquired session + queue a replacement" flow into one call, so
  the `pool.in_use` and `sessions.alive` gauges stay balanced
  across every failure path (stdin wedge, mid-call EOF,
  invalid-event, cleanup failure). Callers that previously did
  `drop(sess) + session_alive_delta(-1) + spawn_replacement()`
  now use `pool.discard(sess)`.

### Fixed

- **`SessionPool::new` fork-storm on large pools.** The 0.95
  parallel-spawn change started N sessions simultaneously via
  `try_join_all`; on pools of ~16+ this produces a fork storm
  (many node subprocesses booting at once, competing for CPU and
  disk) that pushes individual-session readiness past the 3 s
  `READINESS_TIMEOUT`, so pool creation fails with
  `ReadinessTimeout` even on generously-provisioned hosts. Two
  changes:
  - Spawn concurrency is now bounded via `buffer_unordered` at
    `INITIAL_SPAWN_CONCURRENCY = 8`. Wall-time stays close to
    `ceil(N / 8) × spawn_time`; no single spawn competes with
    more than 7 others. Sequential behavior is preserved within
    each batch so individual readiness timeouts don't stack.
  - `READINESS_TIMEOUT` raised from 3 s to 15 s. Reasonable
    headroom on loaded hosts without masking real hangs — a
    session that still isn't ready in 15 s is broken, not slow.

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

[0.96.0]: https://github.com/clbrge/mohdel/releases/tag/v0.96.0
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
