# Architecture

Design and rationale behind mohdel. For the library guide see [INTEGRATION.md](INTEGRATION.md). For CLI usage see [README.md](README.md). For the wire protocol reference see [PROTOCOL.md](PROTOCOL.md). For logging see [LOGGING.md](LOGGING.md).

---

## Why three planes

An in-process SDK — one Node heap, one V8 event loop, N callers fanning into a single factory instance that owns API keys, rate limits, and cooldown state — works for a single-process consumer. It breaks down under three production pressures:

1. **Fault isolation** — a crashing adapter (OOM, native bug, infinite loop) takes the caller down with it. In a multi-caller server, one pathological call can kill a pool worker.
2. **Cross-language callers** — non-Node consumers (Python, Go, curl) can't participate: the only way to talk to the SDK is to link the JavaScript library.
3. **Shared state across processes** — N caller processes each have their own private rate-limit / cooldown tracker. A noisy tenant blows past quota N times, once per caller process, because none of them see each other.

Mohdel splits into three planes so those three pressures get real answers:

```
            ┌──────────┐ unix   ┌─────────────┐  stdin/stdout  ┌──────────┐
            │  client  │ socket │  thin-gate  │    NDJSON      │  session │  × N
 caller ──► │   (JS)   │ ─HTTP─►│   (Rust)    │ ─────────────► │   (JS)   │
            └──────────┘        └─────────────┘                └──────────┘
                                        │
                                        ▼ admin plane (GET /v1/health, OTLP metrics)
```

- **Fault isolation** — adapter crashes kill one session subprocess; the thin-gate pool respawns, the caller sees a single `SESSION_DIED` terminal error and continues. Demonstrated by `bench/isolation.js`.
- **Cross-language callers** — the gate speaks HTTP over a unix socket; any client that can POST and read NDJSON works.
- **Shared state** — the enforcer (rpm, tpm, cooldown) lives in the gate, so every caller process sees the same quota view.

Performance is *not* the justification for the split. The `bench/bench.js` throughput measurement shows the gate adds ~3ms p50 per call over direct in-process `run()` — negligible for real LLM workloads (100–1000ms per call). The gate is the recommended integration for anything production-shaped; the in-process factory exists for CLI, scripts, tests, and single-process services where the subprocess overhead is unjustified, not as a general-purpose production alternative.

## The three planes

### Client — `js/client`, package export `mohdel/client`

One function: `call(envelope, { socketPath, signal? })`. Connects to thin-gate over a unix socket, POSTs the envelope as an HTTP request body, returns an async iterable of `Event`s parsed from the NDJSON response stream. No provider SDK imports transit through this path — a Python or Go caller ships nothing more than their own HTTP client.

### Thin-gate — `rust/thin-gate`, crate `mohdel-thin-gate`, binary `mohdel-thin-gate`

Binds two unix sockets: a data plane (`POST /v1/call`) and an admin plane (`GET /v1/health`). Owns a pool of session subprocesses and the enforcer state.

Per-call pipeline (`src/server.rs::handle_call`):
1. Parse and strict-validate the envelope (`serde(deny_unknown_fields)` enforces the frozen shape).
2. `RoutePolicy::resolve(envelope)` — rewrites `(provider, model)` or rejects with `ROUTE_REJECTED`.
3. `QuotaPolicy::policy_for(authId)` — yields per-user `QuotaSpec {rpm, tpm, cooldown_threshold, cooldown_duration_ms}`.
4. Enforcer cooldown check — fast-fail with `PROVIDER_COOLDOWN` if the user+provider bucket is cooling.
5. Enforcer rate-limit check — fast-fail with `QUOTA_EXCEEDED` when rpm/tpm is exhausted, else `record_request`.
6. Acquire an idle session from the pool (blocks if none available).
7. Write the envelope line to session stdin.
8. Stream session stdout back as NDJSON. Intercept terminal events: on `done`, reset cooldown + record tokens; on `error`, `record_failure` (immediate for `AUTH_INVALID`).
9. Release the session to the pool, or respawn if it died / emitted an invalid event / the client disconnected mid-stream.

The gate ships as a prebuilt binary in the `mohdel-thin-gate-<platform>` npm sub-packages; that's the supported distribution. The crate is not published to crates.io. The hook traits exist primarily to keep the code testable (unit tests override them) and secondarily to make the source fork-friendly for deployments that genuinely need bespoke policy — in that case, vendor or git-dep the `rust/thin-gate` source.

### Session — `js/session`, package export `mohdel/session`, entrypoint `js/session/bin.js`

Long-lived Node subprocess. Reads envelopes from stdin, dispatches to the matching adapter, writes events to stdout. One process handles many calls over its lifetime (pool reuse). Logging goes to stderr so the stdout stream stays pure event NDJSON.

Each call inside a session (`js/session/run.js`):
1. Open a `mohdel.session.answer` OTel span under the envelope's remote `traceparent`.
2. Session-local cooldown fast-fail (complementary to the gate's per-user cooldown).
3. Session-local rate-limit throttle.
4. Dispatch to `js/session/adapters/<provider>.js`.
5. On terminal: reset session cooldown, record tokens, emit `[mohdel:answer] start/done/failed` log lines with trace context.

## Canonical wire types (frozen at 0.90.0)

Wire format is JSON-over-NDJSON, camelCase. Types are authored in `js/core/*.js` (JSDoc) and mirrored in `rust/thin-gate/src/protocol.rs` (serde).

- **`CallEnvelope`** — flat `answer()` options plus transport metadata. Required: `callId`, `authId`, `auth.key`, `provider`, `model`, `prompt`. Optional: `traceparent`, `baggage`, `outputBudget`, `outputType`, `outputStyle`, `outputEffort`, `images`, `videos`, `cache`, `tools`, `toolChoice`, `parallelToolCalls`, `identifier`, `providerOptions`.
- **`Event`** — three-variant discriminated union:
  - `{ type: 'delta', delta: {type: 'message'|'function_call', delta: string} }`
  - `{ type: 'done', result: AnswerResult }`
  - `{ type: 'error', error: TypedError }`
- **`AnswerResult`** — `status`, `output`, `inputTokens`, `outputTokens`, `thinkingTokens`, `cost` (single number), `timestamps`, `warning?`, `toolCalls?`.
- **`Status`** — `'completed' | 'tool_use' | 'incomplete'`.
- **`Warning`** — additive string union: `'insufficientOutputBudget'`, `'cancelled'`, ...
- **`TypedError`** — `{message, detail?, severity, retryable, type}`. `message` is a stable machine key; `detail` is user-facing context; `type` is an optional canonical tag.
- **Control messages** — `{op: 'cancel', callId}` on session stdin aborts the matching in-flight call. `{op: 'ping'}` → `{op: 'pong'}` is the pool readiness handshake.

### Enforcement of the freeze

Two layers guarantee the frozen contract:

1. **Rust parse-time strictness.** Every wire struct carries `#[serde(deny_unknown_fields)]`. A newer sender adding a field against an older gate fails at parse (`unknown field`) — not silently dropped. Enforced by `rust/thin-gate/tests/conformance.rs::unknown_envelope_fields_are_rejected` and the sibling test for `AnswerResult`.

2. **Cross-language round-trip.** `test/conformance/envelopes.json` and `events.json` are the source of truth. Both sides load the same fixtures: Rust asserts parse → serialize equals the original Value (with null-stripping and int↔float normalization); JS asserts the same fixtures contain only allowlisted fields at every nesting level. A field added on one side without the other fails both suites. 9 envelopes + 11 events cover the surface including structured prompts with `MessagePart[]`, assistant+`toolCalls` histories, tool_use terminals with multiple calls, all `OutputStyle` values, data-URI images, and all severity/retryable combinations on `TypedError`.

### What isn't frozen

The wire contract is the only freeze. Everything else is refinable across releases:

- Hook trait method sets (additions with default methods are fine; removals are breaking).
- Internal module layout inside `thin-gate`.
- The default binary's TOML config schema.
- Session-side internals (adapter registry shape, pool tuning, enforcer impl).
- Default-binary CLI args.

If you're embedding the crate or depending on internals, track `main`. If you're writing a client or a session, the wire contract is enough.

## Hook surface (Rust trait objects)

Thin-gate is a multiplexer with four extension points:

- **`RoutePolicy`** — `resolve(envelope) -> (provider, model_id, session_pool?)`. Default (`FileRoutePolicy`) passes through unchanged. Custom deployments rewrite aliases, enforce model allowlists, or route to provider-specific pools.
- **`QuotaPolicy`** — `policy_for(auth_id) -> QuotaSpec { rpm, tpm, cooldown_threshold, cooldown_duration_ms }`. Default (`FileQuotaPolicy`) returns generous static values. Wrappers plug in per-user / per-plan quotas from their own storage.
- **`ConfigSource`** — `load() -> PlatformConfig` + optional `watch()` stream. Default (`TomlConfigSource`) reads `~/.config/mohdel/thin-gate.toml` (or `MOHDEL_THIN_GATE_CONFIG`). PlatformConfig carries socket paths, session spec (command + args + pool size), provider registry, and default timeouts.
- **`CachePolicy`** — optional content cache. No-op default; here for future prompt/response caching.

A custom wrapper implements one or more and passes the bundled `GateState` into `serve_data_with_state(path, state)`. Shape:

```rust
pub struct GateState {
    pub pool: Option<SessionPool>,
    pub route: Arc<dyn RoutePolicy>,
    pub quota: Arc<dyn QuotaPolicy>,
    pub enforcer: Arc<Enforcer>,
}
```

The bundled `serve_data(path, pool)` convenience builds a state with defaults — the OSS binary's startup path.

## Embedding as a library

The thin-gate crate is designed to be consumed as a library by custom binaries that compose their own supervisor, routes, or policies around mohdel's session pool. Since the crate isn't published to crates.io, embedders depend on it via git-dep pinned to a release tag:

```toml
[dependencies]
mohdel-thin-gate = { git = "https://github.com/clbrge/mohdel", tag = "v0.90.0" }
```

Pin to a tag, not a branch. Each mohdel release tag carries stable wire types + stable embedder surface; tracking `main` invites drift.

### Prelude

`use mohdel_thin_gate::prelude::*;` imports the sanctioned embedder API: hook traits, wire types, public handlers (`handle_call`, `handle_image`), the `SessionPool` abstraction, supervision primitives, and `GateState`. See `rust/thin-gate/examples/embedder.rs` for a minimal reference embedder that compiles in CI on every PR.

### Composing custom routes

Embedders that want to add routes alongside `/v1/call` and `/v1/image` bypass `serve_data_with_state` and build their own hyper service that calls the public handlers directly:

```rust
match (method, path) {
    (&Method::POST, "/v1/call")   => mohdel::handle_call(req, state).await,
    (&Method::POST, "/v1/image")  => mohdel::handle_image(req, state).await,
    (&Method::POST, "/v1/custom") => my_handler(req, state).await,
    _ => mohdel::not_found_response(&method, &path),
}
```

Same pattern as the admin plane (`tests/admin_compose.rs`).

### Reusing `SessionPool` for non-mohdel subprocesses

`SessionPool` is generic: it spawns subprocesses that speak the NDJSON stdin/stdout protocol (envelope in, events out, `{op: "ping"}`/`{op: "pong"}` readiness, `{op: "cancel"}` cancellation). Embedders can instantiate a second `SessionPool` with a different `SessionConfig` to supervise their own subprocess type under the same respawn/backoff/cancel-drain semantics — e.g. a pool of orchestration workers alongside the mohdel session pool.

### Shared metrics

`mohdel_thin_gate::metrics::meter_provider()` returns the initialized `SdkMeterProvider` so embedders can register their own instruments against the same OTLP exporter mohdel uses — an embedder's own metrics and mohdel's `mohdel.*` metrics land in one collector under one `service.name`. `None` before mohdel's metrics init runs or when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset.

### Embedder-surface stability

The four hook traits (`RoutePolicy`, `QuotaPolicy`, `ConfigSource`, `CachePolicy`) plus the prelude re-exports are the **embedder contract**. Between minor releases (0.90.x → 0.91.x): additions with default methods are additive; removals or signature changes are breaking. The "What isn't frozen" note above covers the wire story; this paragraph extends it to the library API used by embedders.

## Session supervision

The pool is not a naive blocking queue. Three properties on top of "N pre-warmed subprocesses":

1. **Startup readiness.** `PooledSession::spawn_and_ready(cfg, 3s)` sends a `{op:"ping"}` control message right after spawn and waits for `{op:"pong"}`. A broken-on-boot session (wrong path, syntax error, missing native module, hung init) fails readiness and feeds into backoff — the pool never serves traffic from a session that hasn't proven it can round-trip a frame.

2. **Respawn backoff.** On session death (stdout EOF, IO error, invalid event, cancel-and-drain timeout, readiness failure), the gate queues a replacement. Consecutive spawn failures back off exponentially: 500ms → 1s → 2s → … → 30s cap. Successful spawn resets the streak. Protects against tight respawn loops when the session binary is genuinely broken.

3. **OTel metrics on the admin plane.** When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the gate pushes metrics via OTLP/gRPC to whatever collector takes the session spans (SigNoz, Honeycomb, Jaeger-based stacks). Instruments:
   - `mohdel.sessions.alive` (UpDownCounter)
   - `mohdel.sessions.respawned` / `spawn_failures` (Counter)
   - `mohdel.calls{provider,status}` (Counter)
   - `mohdel.call.duration_ms{provider,status}` (Histogram)
   - `mohdel.cooldown.rejections{provider}` / `quota.rejections` / `policy.errors{kind}` (Counter)

   No separate scrape endpoint; metrics, spans, and logs all land in the same collector under the same service resource attributes. Choice rationale vs Prometheus-style scraping: stack alignment — the session subprocess already exports spans via OTLP, so reusing the transport avoids standing up another Prometheus.

Cancel-mid-stream handling (`server.rs::PoolStreamState::drop`): when the client disconnects, the gate sends `{op:"cancel", callId}` on session stdin and drains events until the session emits a terminal. Clean drain → session released back to the pool. Timeout or error → session killed, replacement spawned.

## Adapter contract (session side)

An adapter is a plain async generator:

```js
async function * <provider> (envelope, { client?, signal?, log?, span? }) {
  // 1. Optionally emit delta events as the model streams.
  // 2. Honor signal?.aborted — pass to the SDK, return silently on abort.
  // 3. On SDK error: check signal first (cancellation is not an error);
  //    else yield { type: 'error', error: classifyProviderError(e) }.
  // 4. Yield exactly one terminal: done (completed / incomplete / tool_use) or error.
}
```

Adapters never own cooldown, rate limiting, or OTel spans — those live in `run.js`. Each adapter handles one call from envelope to terminal. Shared cross-adapter helpers live under `js/session/adapters/_*.js` (images, videos, tools, errors, pricing, catalog).

Registered adapters (`js/session/adapters/index.js`): anthropic, openai, gemini, groq, cerebras, xai, deepseek, mistral, openrouter, fireworks, novita (image-only), plus `echo` and `fake` as test/dev tools. Six of the provider adapters (groq, cerebras, deepseek, mistral, openrouter, fireworks) share `_chat_completions.js` — a single core that handles the OpenAI-compatible Chat Completions shape with flavor hooks for tool-choice mapping, DSML parsing (DeepSeek), reasoning field mapping (Cerebras zai models), and arg mutation (Fireworks model prefix, OpenRouter routing).

## The `mohdel()` factory — in-process path via the factory bridge

The `mohdel()` factory, `.use().answer()`, `.image()` surface is the library's Promise-returning in-process API. Callers using `import mohdel from 'mohdel'` (and the `mo` CLI) hit this path. Under the hood it routes through `js/factory/bridge.js`:

```js
// src/lib/index.js (abbreviated)
.answer = async (prompt, options) => runAnswer({
  provider, model, modelKey, configuration, prompt, options
}, { cooldown, limiter, resolveProviderLimits })
```

The bridge (`runAnswer`) builds a `CallEnvelope` from the prompt + options, drives `run()` from `js/session/` in-process (no subprocess, no gate — the factory still runs in the caller's process), drains events (piping `delta` payloads through `createRealtimeDeltaBuffer` when a `realtimeHandler` is set), and assembles the final `AnswerResult`. Error events become thrown `MohdelError`. OTel spans and lifecycle callbacks stay in the factory layer.

Three factory-era options are deliberately not carried into the envelope:
- **`parentSpan`** — replaced by `traceparent` (a W3C string is serializable across process boundaries; an OTel Span object isn't).
- **`maybeThrowHandler`** — removed as dead API.
- **`configuration.baseURL` / `defaultHeaders` / …** — adapters bake in baseURL. Only `configuration.apiKey` is threaded through. Non-apiKey configuration keys throw `CONFIGURATION_UNSUPPORTED` rather than silently dropping, since a dropped baseURL could leak traffic to an unintended provider (see AUDIT2 F24).

The full option mapping is documented in the `runAnswer` docstring so a future auditor doesn't re-open these as regressions.

## The `fake` provider — scenario-driven testing

`js/session/adapters/fake.js` is a first-class test adapter: register `provider: "fake"` in an envelope with a JSON scenario in `prompt` and the adapter drives behavior deterministically. Eight modes:

| mode | behavior |
|------|----------|
| `echo` | one short delta + done (default fallback for non-JSON prompts) |
| `slow` | emit N deltas with configurable delay |
| `volume` | emit N deltas as fast as possible — throughput stress |
| `tool` | terminal `tool_use` with a configured tool call |
| `incomplete` | `done` with `status: incomplete` + warning |
| `error` | yield typed error event with caller-chosen type / retryable |
| `hang` | never emit a terminal (caller aborts via signal) |
| `crash` | `process.exit(code)` — kills whichever process is running the adapter |
| `cancel_after` | emit N deltas then wait for `signal.aborted` |

Every mode honors `AbortSignal`. The benchmarks in `bench/` use this to pin adapter-side work to a fixed scenario so gate / isolation measurements aren't contaminated by real-provider variance.

## Design principles

### Mohdel is a thin SDK, not an orchestrator

Mohdel normalizes the interface to LLM providers: one `answer()` shape, unified tool format, streaming, error classification, pricing. It does **not** own prompt assembly, context management, tool loops, retry, fallback, or business logic.

- **You** — orchestration, context budgets, tool loops, prompt assembly, retry policy
- **Mohdel** — provider abstraction, streaming, error normalization, cost reporting
- **Provider APIs** — definitive validation, token counting, rate limits

### No pre-call context-window guard

Mohdel does not count input tokens or reject oversized prompts. Trim or reject before calling. Provider APIs return clear 400s; duplicating that check here would require a tokenizer dependency, add latency, and create a third error source.

### No projected-cost precheck

Mohdel reports `result.cost` from curated pricing but does not enforce budgets. Spending policy is caller-side.

### No automatic tool loop

Mohdel returns `status: 'tool_use'` with `toolCalls`. Execute the tools and re-call `answer()` yourself. Keeps the SDK stateless and composable.

### No response caching

Mohdel does not cache responses. Some prompts must never be cached, some must always be. Caller controls the strategy.

### Client-side rate limiting lives in mohdel

Rate limits are per-API-key, not per-caller-process. Two concurrent consumers sharing a key don't know about each other, but the gate sees all requests. A 429 wastes a round-trip; a small preemptive delay is cheaper than error + retry + backoff.

Limits are per-account (different plans → different limits), so they live in user config:

- **Provider-level:** `~/.config/mohdel/providers.json`, or the equivalent `QuotaPolicy` for custom deployments
- **Model-level:** curated entries (`rpmLimit`, `tpmLimit`, `rateLimitScope`) — override provider config

Throttle, don't reject: the enforcer returns ms-to-wait when over limit.

### Two-layer enforcement: gate + session

Cooldown and rate-limit checks run on **two independent layers** in the gate path. This is by design, not a bug, but callers often expect a single chokepoint so it's worth spelling out.

**Gate layer** (`rust/thin-gate/src/server.rs`, active only when the caller uses `mohdel/client`):
- Cooldown key: `(authId, provider)` — per-user, per-provider.
- Rate-limit key: `authId` — per-user aggregate.
- Source of truth for `rpm`/`tpm`: the deployment's `QuotaPolicy::policy_for(authId)`.

**Session layer** (`js/session/run.js`, always active):
- Cooldown key: `provider` — per-provider only (the session has no authId context; a subprocess serves one user's calls).
- Rate-limit key: `provider` or `provider/model` (depending on `spec.rateLimitScope`).
- Source of truth for `rpm`/`tpm`: curated-catalog entry (`spec.rpmLimit`/`tpmLimit`) or `providers.json` (`QuotaPolicy` fallback).

Consequences:

| Path                              | Layers active                    | Notes                                                                                            |
|-----------------------------------|----------------------------------|--------------------------------------------------------------------------------------------------|
| `mohdel/client` → gate → session  | Both (different keyspaces)       | Gate rejects fast on per-user quota; session still runs its own check before touching the SDK.   |
| `mohdel` factory → session (bridge, no gate) | Session only                     | The only enforcer. Rate-limiter is instance-scoped; honors the factory's in-process state.       |
| Custom supervisor → session       | Session only                     | Supervisor may layer its own enforcement but the session's checks always fire.                   |

Why keep both layers instead of short-circuiting the session when a gate is upstream?

- **Safety.** The session binary is a supported entry point for standalone supervisors (not just thin-gate). Stripping its enforcement when "a supervisor exists" would require a trusted handshake; simpler to keep the session self-sufficient.
- **Different keyspaces catch different failure modes.** The gate's per-user check protects the multi-tenant hosting shape; the session's per-provider check protects the single-key call path the bridge still takes.
- **Cheap.** Both are in-process lookups; neither touches the network.

Open question (deferred): under heavy gate load, a flag/header to signal "upstream already enforced, skip session check" would eliminate the double work on the hot path. No concrete evidence this is load-bearing today; revisit if profiling says otherwise.

### Error classification without retry or fallback

Mohdel classifies errors (`retryable`, `severity`, `type`) but does not retry or fall back. Caller owns the retry budget and fallback model choice — mohdel silently swapping models would conflict with existing multi-model logic.

Clear signals in: `retryable: true`, `type: 'PROVIDER_COOLDOWN'`, severity levels. Caller acts on them.

### OTel spans, not a callback system

One `mohdel.session.answer` span per call, child of the envelope's remote parent (`traceparent`). Attributes: `gen_ai.request.model`, `gen_ai.system`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `mohdel.status`, `mohdel.cost`, `mohdel.time_to_first_token_ms`, `mohdel.cooldown` on fast-fail. Stderr logs carry `traceId` + `spanId` so collectors stitch logs to spans even when no exporter is wired.

### Standalone SDK per provider, shared chat-completions core

Providers with meaningfully different APIs get their own adapter file (`anthropic`, `openai`, `gemini` each own their quirks). Providers speaking OpenAI-compatible chat completions (groq, cerebras, deepseek, mistral, openrouter, fireworks) share `_chat_completions.js` with per-provider flavor hooks — code sharing without coupling. xAI reuses the `openai` adapter entirely with a custom baseURL, since both serve the Responses API.

## Non-goals

| Not in mohdel | Why |
|---------------|-----|
| Prompt assembly / context management | Caller concern — see "thin SDK, not orchestrator" |
| Automatic tool loops | Stateless composability; caller re-issues after `tool_use` |
| Retry / fallback | Caller owns budget and fallback strategy |
| Response caching | Caller owns policy |
| Sub-5s session startup | Pool pre-warms; cold start isn't on the hot path |
| Token counting before dispatch | Provider does it authoritatively |
| Per-call provider config override beyond `apiKey` | Schema extension when a real consumer needs it |

## FAQ / design choices

Questions readers predictably ask that aren't answered by reading the code.

### Why does the gate spawn a JS session subprocess instead of calling provider HTTP APIs directly from Rust?

Three hard reasons, in rough order of weight:

1. **Provider ecosystems favor JS SDKs structurally.** OpenAI, Anthropic, Gemini, Groq, Cerebras, DeepSeek, Mistral, Fireworks, OpenRouter, xAI, Novita — every one ships a first-class TypeScript/JavaScript SDK, usually on API release day. Rust SDKs are community-maintained, months behind, and often DIY around `reqwest`. That asymmetry doesn't close — vendor priority follows their customers (JS + Python). Pegging on the vendor JS SDKs means we inherit new-API support for free.

2. **Fault isolation is the tagline.** "Process-isolated inference" falls apart if adapter code (which runs untrusted provider SDK logic) lives inside the gate process. An adapter OOM, hang, or panic today takes down one session subprocess; the gate respawns and the caller sees a recoverable `SESSION_DIED`. A Rust monolith would collapse that boundary — a bad adapter kills the gate serving every other tenant.

3. **The IPC cost is irrelevant in practice.** `bench/bench.js` measures ~3 ms p50 gate overhead. Real LLM calls take 100–1000 ms, so that's <1% of wall time. The overhead is dominated by HTTP + NDJSON framing + subprocess IPC, not by anything a Rust rewrite would change.

### Can client and session be implemented in other languages?

**Yes — that's the protocol promise.** The wire types in `PROTOCOL.md` plus the JSDoc in `js/core/*.js` plus the Rust structs in `rust/thin-gate/src/protocol.rs` are the contract. Anything that speaks the contract is a first-class implementation. The JS stuff in this repo is the *first* implementation, not the *only* one.

**Client in language X:** low-effort and actively encouraged. A client does `POST /v1/call` over a unix socket (or TCP) and parses NDJSON events as they stream. Any HTTP-capable runtime works — Python, Go, Ruby, Swift, C#, Elixir, curl + jq. This is an excellent starter contribution: everything you need is in `PROTOCOL.md §3–§4` plus a test fixture in `test/conformance/events.json` to validate your parser. The canonical `js/client/` is ~100 LOC; a port in most languages lands in a similar range. (Disclosure: the author writes JS daily, which is why JS got the first client, not a principled choice.)

**Session in language X:** possible but weighs against the reasons in the previous question — vendor SDKs ship JS first-class; the fault-isolation story depends on the subprocess boundary, not on the language inside it. Where a second-type session makes sense:

- **Adapters with no vendor SDK to track.** Local model runners (vLLM, TGI, Ollama), custom inference servers, self-hosted endpoints. Just HTTP + SSE, nothing upstream changes out from under you. A Rust or Go session wins on memory (~10 MB RSS vs ~50–100 MB for Node) and startup (~20 ms vs ~200 ms) with zero maintenance drift.
- **Embedded / edge deployments** where shipping Node alongside is unwanted.
- **High-concurrency bulk workloads** where `pool_size × per-session-RSS` binds. Rust at pool=100 is ~1 GB; Node at pool=100 is 5–10 GB.

Where a second-language session **wouldn't** pay off: duplicating the existing JS provider adapters. That forfeits the SDK-reuse argument without a compensating win.

The gate doesn't care what language the session is written in. `SessionConfig` takes a `command` + `args`; spawn whatever you like, as long as it reads envelopes on stdin and writes events on stdout per `PROTOCOL.md`.

### Why not port the hot loops to Rust via napi-rs?

Tried, deferred. The `rust/napi-addon/` scaffold is kept for future reactivation. `bench/bench.js` shows in-process per-call JS CPU is ~0.5 ms; the via-gate overhead is IPC + framing, not parsing. Porting SSE / JSON parsers to Rust wouldn't meaningfully change either number. Reactivate only if a future workload surfaces per-call CPU as the bottleneck.

### Why not call the session in-process from the gate via FFI / embedded V8?

Defeats the isolation win (same process = same crash domain) and adds a heavyweight runtime embedding problem without removing the SDK-maintenance one. Process boundary is cheap (~3 ms) and gives you true fault isolation, cross-language callers, and OS-level sandboxing (Landlock / seccomp). Keep the boundary.

## See also

- [PROTOCOL.md](PROTOCOL.md) — wire protocol reference
- [INTEGRATION.md](INTEGRATION.md) — library embedding guide
- [LOGGING.md](LOGGING.md) — log levels, prefixes, pino / OTel integration
- `bench/bench.js` — throughput benchmark source
- `bench/isolation.js` — fault-isolation demo source
- `test/conformance/` — JS↔Rust shape fixtures
