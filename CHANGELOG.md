# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [0.108.2] — Fix package-lock sync in release flow

The release-it `after:bump` hook now refreshes `package-lock.json`
after the sub-package version bump, so CI's `npm ci` succeeds. No
runtime changes.

## [0.108.1] — Republish of 0.108.0

No code changes from 0.108.0. The 0.108.0 release was tagged but
never landed on the npm registry — the publish workflow was migrated
to npm trusted publishing (OIDC) mid-release and the original tag was
cut against the legacy token-based workflow. 0.108.1 is the first
version of the 0.108 line actually available on npm.

## [0.108.0] — Session log envelope: nested `span` for OTel-pino correlation

### Changed

- Session log lines now carry trace context as a nested
  `span: { traceId, spanId, traceFlags }` object instead of flat
  `traceId` / `spanId` fields at the root, matching the standard
  OpenTelemetry pino convention. The public `createLogger` API and the
  wire/event protocol are unchanged.
- `@anthropic-ai/sdk` ^0.96.0 → ^0.98.0
- `@google/genai` ^2.3.0 → ^2.6.0
- `openai` ^6.37.0 → ^6.39.0
- `lint-staged` ^17.0.4 → ^17.0.5 (dev)
- `vitest` ^4.1.6 → ^4.1.7 (dev)

## [0.107.0] — Onboarding UX: `mo doctor`, JSON Schema, friendly errors, docs

### Added

- `mo doctor` — single-command health check covering config dir, environment
  file, API keys per provider, `curated.json` parse + schema validation, and
  default-model resolution. Pretty output by default; `--json` for machine
  consumers. Exits 0 on success (warnings allowed) or 1 on errors.
- JSON Schema for `curated.json` at `config/curated.schema.json`. Editors that
  speak JSON Schema (VS Code, JetBrains, Helix, Neovim with `coc-json`) get
  autocomplete, inline type checking, and hover docs while editing the catalog.
  Two ways to wire it: an inline `$schema` pointer at the top of the file, or a
  `.vscode/settings.json` `json.schemas` mapping.
- `config/curated.example.json` — five worked entries (minimal, full-featured
  with thinking effort + cache pricing + leaderboard, deprecated stub, image
  generation, custom rate limits) with inline `$schema` pointer.
- `docs/CATALOG.md` — full reference for `curated.json`: required vs
  recommended vs capability fields, image entries, custom-field convention,
  editor support, and the `mo curate` / `mo model add` / `mo check` workflow.
- `docs/GLOSSARY.md` — short definitions for envelope, thin-gate, session,
  factory, creator vs provider, thinking effort, status, cooldown, and the
  rest of the recurring vocabulary.
- `docs/COOKBOOK.md` — six copy-paste recipes (summarize a file, stream to
  terminal, swap providers via env var, tool-use round trip, vision, batch
  with cost totals).
- `--help` for `mo model add` and `mo curate` (and the `mo curate` alias),
  each with concrete examples and pointers to the catalog docs.
- Friendly next-step hints in `mo ask` errors: model not in catalog →
  `mo curate <provider>` / `mo model add <id>`; API-key missing or rejected →
  `mo setup <provider>`; broken deprecation chain → `mo check`. Hints are
  pure pattern-match on `err.message`/`err.detail`, so the lib layer stays
  neutral.
- Top-level meta-key support in `curated.json`: keys starting with `$` (e.g.
  `$schema`) or `_` (e.g. `_comment`) are preserved on load/save but excluded
  from every iteration site (alias map, suggestion search, rank index,
  pickers, validation). Lets users embed a JSON Schema pointer or inline
  notes in the catalog without polluting downstream behaviour.
- New `src/lib/common.js` helpers: `isMetaKey`, `catalogEntries`,
  `catalogKeys`, `catalogValues` — used internally by every catalog
  iteration site so meta-key filtering stays consistent.

### Changed

- README rewrite for clarity.
- Returning-user `mo` menu (when at least one provider is already
  configured) leads with `mo ask <model> "..."`, surfaces `mo doctor`, and
  includes `mo provider setup <p>` for adding a second key.
- `@anthropic-ai/sdk` ^0.95.2 → ^0.96.0
- `@google/genai` ^2.2.0 → ^2.3.0

## [0.106.0] — Idle heartbeat events + Xiaomi adapter

### Added

- OpenAI-compatible adapter for `xiaomi/*` models (reasoning_content,
  image input, tool calling).
- `mistral` creator entry (fixes a dangling reference from
  `providers.js`). Adapter and provider config were already present.
- `CallEnvelope.idleHeartbeatMs` (optional) — when set, the session
  emits a synthetic `{type:'idle', sinceMs}` event whenever the
  adapter has been silent for at least that many milliseconds, and
  re-emits every `idleHeartbeatMs` while the silence persists. The
  timer resets on every real event.
- `Event::Idle` variant on the wire (JS + Rust). Advisory only —
  mohdel never aborts on its own. Consumers decide whether to log,
  bump a watchdog, or trigger an external cancel. Omitting
  `idleHeartbeatMs` disables the feature and preserves the prior
  event stream byte-for-byte.
- Conformance fixtures: new `idle` event in
  `test/conformance/events.json`; `full-options` envelope gains
  `idleHeartbeatMs`.

## [0.105.2] — Anthropic phantom thinking tokens with outputEffort=none

### Fixed

- `anthropic` adapter reports `thinkingTokens: 0` when the caller set
  `outputEffort: 'none'`. The chars/4 gap fallback (for opus 4.7
  redacted thinking) was misfiring on disabled-thinking calls.

## [0.105.1] — Dependency bumps

### Changed

- `@anthropic-ai/sdk` ^0.95.1 → ^0.95.2
- `@google/genai` ^2.0.1 → ^2.2.0
- `groq-sdk` ^1.1.2 → ^1.2.0
- `@clack/prompts` ^1.3.0 → ^1.4.0
- `@opentelemetry/exporter-trace-otlp-grpc` ^0.217.0 → ^0.218.0
- `@opentelemetry/sdk-node` ^0.217.0 → ^0.218.0
- dev: `lint-staged` ^17.0.3 → ^17.0.4, `vitest` ^4.1.5 → ^4.1.6

## [0.105.0] — Finer-grained 429 classification

### Added

- `classifyProviderError` now splits 429 responses into
  `RATE_LIMIT_TIER` (caller quota exhausted — retrying inside the
  rate-limit window cannot succeed) and `RATE_LIMIT_LOAD` (provider
  shedding load for reasons unrelated to the caller's quota — the
  next attempt may succeed immediately). `RATE_LIMIT` (no suffix)
  remains as a fallback when the signal is ambiguous.
- New `opts.provider` parameter on `classifyProviderError` lets
  adapters opt into provider-specific 429 disambiguation. Generic
  `x-ratelimit-remaining-*` header detection covers OpenAI-compatible
  providers; per-provider overrides cover anthropic
  (`overloaded_error` vs `rate_limit_error`), gemini
  (`RESOURCE_EXHAUSTED`), and cerebras (generic "high traffic" body
  → LOAD).
- Adapter wiring done for openai, anthropic, gemini, and every
  provider going through `_chat_completions.js` (cerebras, xai,
  deepseek, mistral, fireworks, groq, novita, openrouter).

## [0.104.4] — Wire preserves cache marker on text parts

### Fixed

- `MessagePart::Text` on the thin-gate wire now carries optional
  `cache: "5m" | "1h"`. Previously the field was dropped at the gate,
  so caller-driven prompt caching never reached the adapter. New
  conformance fixtures lock the shape.

## [0.104.3] — Cache tokens on session.answer span

### Added

- `mohdel.cache_write_input_tokens` / `mohdel.cache_read_input_tokens`
  attributes on the `mohdel.session.answer` span (when non-zero), so
  cache activity is visible per call without inferring it from cost.

## [0.104.2] — Schema cohesion: cancelledDone cache passthrough, Default impls, contributor checklist

### Fixed

- **`cancelledDone` now threads `cacheWriteInputTokens` /
  `cacheReadInputTokens`** captured pre-cancellation. Previously a
  mid-stream abort produced a terminal `done.result` with cache
  fields dropped, under-counting cost on cancelled calls.
- **`[mohdel:answer] done` debug log** surfaces `cacheW` / `cacheR`
  when present, so per-call cache activity is visible without
  attaching to the OTel span.

### Changed

- **`AnswerResult` / `Status` / `Timestamps` derive `Default`.**
  Test fixtures and stub-construction sites can now use
  `..Default::default()` instead of listing every field. New optional
  fields no longer break literal-construction sites at compile time.
- **Wire-field-add checklist** documented in `CONTRIBUTING.md`.
  Eight sites a new field touches (JS type, adapter, pricing, Rust
  struct, conformance fixture, JS allowlist, log summarizer,
  CHANGELOG framing) — captured so future field additions land in one
  PR rather than three.

## [0.104.1] — Rust gate accepts cache token fields

### Fixed

- **Rust `AnswerResult` rejected `cacheWriteInputTokens` /
  `cacheReadInputTokens`** under `deny_unknown_fields`. Both now
  declared as `Option<u32>`. Conformance fixtures added so future
  Rust↔JS schema drift fails in CI.

### Changed

- Wire-shape docs are provider-neutral (no "Anthropic-style" /
  "OpenAI-shape" framing).

## [0.104.0] — Prompt-cache plumbing across adapters and pricing

### Added

- **Anthropic prompt caching.** `splitPrompt` translates structured system
  messages with `cache: '5m' | '1h'` markers into Anthropic's typed
  `cache_control: { type: 'ephemeral', ttl?: '1h' }` blocks. The adapter
  now extracts `cache_creation_input_tokens` and `cache_read_input_tokens`
  from `message_start.usage` and surfaces them on `AnswerResult` and via
  `costFor`.
- **OpenAI / chat-completions cache reporting.** OpenAI Responses,
  cerebras, fireworks, and xAI adapters extract
  `prompt_tokens_details.cached_tokens` and convert the OpenAI "subset
  of prompt_tokens" convention into mohdel's additive
  `cacheReadInputTokens` field. Caller code sees one consistent shape
  regardless of provider semantics.
- **`AnswerResult.cacheWriteInputTokens` / `cacheReadInputTokens`**
  added to the type definition. Symmetric write/read pair matching
  catalog `cacheWritePrice`/`cacheReadPrice`; Anthropic's
  `cache_creation_input_tokens` is normalized into `cacheWriteInputTokens`
  at the adapter boundary.
- **`computeCost` honours `cacheWritePrice` and `cacheReadPrice`** in
  catalog specs, falling back to `inputPrice` when absent so non-caching
  providers degrade gracefully. Pricing is additive: `i*ip + cw*cwp +
  cr*crp + o*op + t*tp`.

### Changed

- Deps: `@google/genai ^2.0.0 → ^2.0.1`.

## [0.103.0] — Span/log canonical model id; redacted-thinking gap fallback

### Fixed

- **Suffix stripped from `envelope.model` when explicit `outputEffort`
  wins.** Previously the `:effort` shortcut leaked into
  `gen_ai.request.model`, the scoped logger, and the trace cache key.
- **`thinkingTokens` no longer reported as 0** when an Anthropic call
  emits `redacted_thinking` blocks (claude-opus-4-7 default). The
  adapter falls back to estimating thinking from the gap between
  Anthropic's `usage.output_tokens` and the visible streamed content
  (text + tool `input_json_delta`). Cost unchanged — the
  `thinkingPrice == outputPrice` invariant means redistribution only.

## [0.102.0] — `reasoning.effort` for xAI grok-4.3+ and per-provider `'none'` semantics

### Added

- **xAI `reasoning.effort` support (grok-4.3+).** xAI introduced a
  parametric `reasoning.effort` parameter on the Responses API
  (`none` / `low` / `medium` / `high`) — earlier xAI reasoning
  models had no such control, which is why mohdel previously
  skipped the field on xAI. The adapter now forwards `reasoning:
  { effort }` to xAI on the same path used for OpenAI gpt-5.x,
  including the literal `'none'` to disable reasoning per xAI's
  documented contract.
- **`outputEffort: 'none'` now reaches the wire.** When a model
  spec declares `'none'` in `thinkingEffortLevels`, the adapter
  emits the upstream-appropriate disable signal: OpenAI/xAI →
  `reasoning: { effort: 'none' }`; Cerebras zai →
  `disable_reasoning: true` (deprecated toggle, sunset
  2026-07-21); Fireworks zai → `reasoning_effort: 'none'`.
  Gated on `spec.thinkingEffortLevels[effort] != null` — models
  without `'none'` in their catalog skip the block as before.

### Changed

- **`temperature` preserved when reasoning is disabled** in the
  chat-completions builder (was unconditionally deleted inside the
  effort block).
- Deps: `@anthropic-ai/sdk ^0.91.1 → ^0.95.1`, `@google/genai
  ^1.51.0 → ^2.0.0`, `openai ^6.35.0 → ^6.37.0`,
  `@opentelemetry/{exporter-trace-otlp-grpc,sdk-node} ^0.216.0 →
  ^0.217.0`, `lint-staged ^16.4.0 → ^17.0.3` (dev).
  `@google/genai` 2.0 breaking changes are scoped to the new
  Interactions API; the `gemini` adapter is unaffected.

### Scope

- `gemini` and `anthropic` adapters still guard on `effort !==
  'none'`; their upstream-specific disable shapes are deferred to
  keep this release tight to the four models declaring `'none'`.

### Tests

- New `'none'` unit tests for openai/gpt-5.4, xai/grok-4.3+,
  cerebras/zai-glm-4.7, fireworks/zai-glm-5. The xAI test
  asserting the prior omit-`reasoning` behavior is updated to
  assert forwarding (now that grok-4.3 accepts the field). Full
  unit suite green.

## [0.101.0] — Disable undici body-idle timeout on streaming adapters

### Fixed

- **Long thinking-only streams no longer fail with
  `NET_ERROR / "terminated"` at ~5 minutes.** Node's global `fetch`
  (undici) closes a streaming response when no body chunk has
  arrived for `bodyTimeout` ms — 300 000 ms (5 min) by default.
  Reasoning models stream zero bytes during their thinking phase,
  so any non-trivial task on a thinking-capable provider tripped
  the limit mid-run and surfaced as a retryable upstream error
  with `detail: "terminated"`. Adapters now opt out via a shared
  undici `Agent` with `bodyTimeout: 0`, so the inter-chunk idle
  timeout no longer applies to streaming inference. Cancellation
  still comes from the caller's `AbortSignal`, the SDK's
  request-level timeout, and provider-side stream limits.
  Headers timeout stays bounded at 60 000 ms — connect plus first
  response must still be fast.

### Added

- **`js/session/adapters/_dispatcher.js`** — exports
  `streamingDispatcher()`, a lazy singleton undici `Agent`
  (`bodyTimeout: 0`, `headersTimeout: 60_000`) shared across all
  adapters that go through `globalThis.fetch`. One Agent per
  process keeps a single connection pool with the default
  per-origin keep-alive semantics.
- **`undici` declared as a direct dependency** (`^7.24.5`).
  Previously pulled in transitively; now an explicit dep because
  mohdel imports `undici.Agent` directly.

### Changed

- **All chat-completions adapters thread the dispatcher into
  `fetchOptions`.** `openai`, `fireworks`, `deepseek`, `mistral`,
  `openrouter`, `xai`, `anthropic`, `groq` — each adds
  `fetchOptions: { dispatcher: streamingDispatcher() }` to its
  no-DI client construction. SDKs spread `fetchOptions` into the
  underlying `fetch(url, opts)` call (verified in
  `openai/client.js:159`, `@anthropic-ai/sdk/client.js:74` + `:446`,
  and `groq-sdk/client.js:82` + `:388`), so the dispatcher reaches
  the wire without replacing the SDK's `fetch` or touching its
  internals. Tests passing an explicit `deps.client` are
  unaffected.

### Scope

- **`cerebras` adapter unaffected.** `@cerebras/cerebras_cloud_sdk`
  uses `node-fetch@^2`, a separate HTTP stack with no inter-chunk
  body timeout — the bug was undici-specific.
- **`gemini` adapter not yet patched.** `@google/genai` ships both
  `node-fetch@^3` and `undici@^7` and selects at runtime; its
  injection surface is `httpOptions`, not `fetchOptions`. Deferred
  to a follow-up release.

### Tests

- New `test/unit/dispatcher.test.js` — singleton identity and
  `Agent` instance check.
- `test/integration/provider.test.js` — switched the tool-use smoke
  test from `toolChoice: 'required'` to `'auto'`. DeepSeek's
  reasoner-backed models reject `'required'` (`'deepseek-reasoner
  does not support this tool_choice'`) even when the spec says
  `supportsTools`; the prompt itself forces the tool call, so the
  assertions still verify a real tool invocation under `'auto'`
  without fighting one provider's API surface.

## [0.100.0] — `reasoningContentPlaceholder` for resumed thinking-mode sessions

### Added

- **`reasoningContentPlaceholder` model-spec field (chat-completions
  adapter family).** When a model spec carries a string value
  (including `''`), every assistant message in the request that has
  no extractable `reasoning_content` gets the placeholder string
  attached as `reasoning_content`. This unblocks resuming a
  multi-turn session on a thinking model when the prior assistant
  turns came from a non-thinking model (or from a storage path that
  didn't preserve thinking metadata) and the provider's API rejects
  the request with *"reasoning_content in thinking mode must be
  passed back"*.
  - Verified: `deepseek/deepseek-v4-pro` and
    `deepseek/deepseek-v4-flash` accept `''` and the resumed
    transcript goes through.
  - Default behaviour unchanged when the field is absent: no
    `reasoning_content` is synthesized, matching pre-0.100.0 wire
    output.

### Scope

- **Chat-completions adapter only** (`_chat_completions.js`,
  i.e. providers using the OpenAI Chat Completions wire format:
  Groq, Cerebras, DeepSeek, Mistral, OpenRouter, Fireworks). The
  field is silently ignored on Gemini and Anthropic specs — those
  adapters have their own thinking-mode roundtrip rules
  (`thoughtSignature` and `thinking` content blocks respectively).

## [0.99.0] — AUTH_INVALID detail + verbatim-key masking

### Added

- **`classifyProviderError(e, key?)`** accepts an optional second
  argument: the API key the call was made with. When supplied, every
  verbatim occurrence of that key in the resulting `TypedError.detail`
  is replaced with a masked form before it returns:
  - **Length ≥ 16:** `<first4>…<last4>` (the dashboard idiom used by
    OpenAI, Anthropic, Stripe, AWS — keeps a recognizable prefix and
    suffix so a caller can distinguish which key the request used
    without exposing the secret).
  - **Length 8–15:** `<redacted>` (too short to safely show 8 chars).
  - **Length < 8:** treated as not-a-key, no scrub — guards against
    pathological replacements on empty or fixture values.
  All built-in adapters (`anthropic`, `openai`, `gemini`,
  `_chat_completions`, `image/openai`, `image/novita`, `run_image`)
  now thread `envelope.auth?.key` through, so any provider body that
  echoes the rejected key never reaches downstream consumers as
  plaintext.

### Changed

- **`AUTH_INVALID` now carries the provider's `detail`.** Previously
  `classifyProviderError` deliberately omitted detail for 401/403 to
  avoid echoing keys that provider bodies sometimes include in their
  error messages. That defense moved one layer inward: the SDK now
  masks the key bytes verbatim (it has the context to do that
  deterministically), so consumers receive a detail that is safe to
  log and that callers are free to display, redact further, or drop
  according to their own policy.
- **Module documentation on `js/session/adapters/_errors.js`**
  rewritten to spell out the new layering: the SDK masks the key
  value; what to do with the already-masked detail is the caller's
  policy.

### Breaking

- **`AUTH_INVALID` consumers that asserted `out.detail === undefined`
  will see a string.** Existing callers should already have been
  treating `detail` as an optional, length-capped field
  (`DETAIL_CAP = 500`); this release just makes the field reliably
  populated when the provider returned anything. The
  `session-errors` unit test that pinned the no-detail behavior has
  been flipped to assert preservation and verbatim-key masking. No
  public API rename.

## [0.98.2] — Dependency refresh

### Changed

- **`@google/genai`** bumped to `^1.51.0` (was `^1.50.1`).
- **OpenTelemetry Node tooling** bumped to `^0.216.0` (was `^0.215.0`)
  for both `@opentelemetry/sdk-node` and
  `@opentelemetry/exporter-trace-otlp-grpc`. Optional dependencies —
  consumers that don't ship OTel exporters in the runtime image are
  unaffected.
- **`@clack/prompts`** bumped to `^1.3.0` (was `^1.2.0`). The new
  release requires Node ≥ 20.12; mohdel itself already requires
  Node ≥ 22, so no runtime impact. CLI-only optional dep.
- **`mohdel-thin-gate-linux-x64-gnu`** lockfile pin advanced from
  `0.97.1` to `0.98.1` to match the thin-gate release that ships
  the reasoning-content additions from `0.98.1`.

No source changes. No behavior changes for consumers.

## [0.98.1] — Reasoning content roundtrip

### Added

- **`result.reasoning` (string, optional) on `AnswerResult`** — captures
  `reasoning_content` from chat-completions providers that return it
  (DeepSeek V4, deepseek-reasoner, Cerebras reasoning models). Surfaces
  in both streaming and non-streaming paths. Token count remains in
  `thinkingTokens` from `usage.completion_tokens_details.reasoning_tokens`.
  The Rust `AnswerResult` (in `mohdel-thin-gate`) gains the matching
  `reasoning: Option<String>` field for HTTP-over-unix-socket consumers.
- **Reasoning roundtrip on the wire.** When an assistant `Message` is
  sent back with `content` as a `MessagePart[]` containing
  `{type:'reasoning', text}`, the chat-completions adapter extracts it
  and emits `reasoning_content` alongside `content` and `tool_calls`.
  Multi-turn DeepSeek V4 calls now succeed: V4 hard-rejects assistant
  history that lacks `reasoning_content` when thinking is enabled
  (default).

### Changed

- **Multi-turn integration test (`test:multiturn`)** now skips two
  cases on DeepSeek that reflect upstream limitations rather than
  bugs:
  - `constructed tool history` (synthetic assistant turn cannot
    supply real `reasoning_content`); same skip as gemini's
    `thoughtSignature` exemption.
  - `tool round-trip` (DeepSeek V4 inherits the deepseek-reasoner
    restriction against `tool_choice: 'required'`).

- **Six new unit tests** in `test/unit/session-chat-completions.test.js`
  cover the reasoning capture + roundtrip without requiring a live
  provider or an external consumer (mocked SDK):
  - non-streaming `message.reasoning_content` → `result.reasoning`
  - missing reasoning_content → `result.reasoning` omitted
  - streaming `delta.reasoning_content` chunks accumulate into
    `result.reasoning`
  - assistant `MessagePart{type:'reasoning'}` content emits
    `reasoning_content` on the wire
  - roundtrip works alongside `toolCalls` on the same assistant turn
  - plain-string assistant content does not emit `reasoning_content`

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
