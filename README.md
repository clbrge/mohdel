# Mohdel

One Node API and one CLI for 11 LLM providers — call any model with the same `answer()` shape, get tokens and per-call USD cost back, swap models by changing one string. Self-hosted: your keys, your infra, no SaaS proxy in the path.

```bash
npm install -g mohdel
mo                                     # interactive setup — pick a provider, paste your API key
mo ask gemini/gemini-3-flash-preview "why is the sky blue"
```

Providers: Anthropic, OpenAI, Gemini, Mistral, Groq, xAI, Cerebras, Fireworks, DeepSeek, OpenRouter, Novita. Node 22+, ES modules.

## Why mohdel

- **One interface across providers.** Same `answer()` call, same event stream, same `{ status, output, inputTokens, outputTokens, cost }` result. Switching from `anthropic/claude-sonnet-4-6` to `openai/gpt-5.4-mini` is one string change — adapter differences stay inside mohdel.
- **Real numbers on every call.** Token counts and per-call USD cost computed from your own pricing catalog (`curated.json`) — not estimates, not provider-specific shapes. See [docs/CATALOG.md](docs/CATALOG.md) for the catalog format.
- **Observability without instrumentation.** OpenTelemetry spans, trace-linked logs, and OTLP metrics over one endpoint. Set `OTEL_EXPORTER_OTLP_ENDPOINT`; everything else is wired.
- **Two integration paths, same API.** In-process factory for CLI tools, scripts, single-process services. Optional `thin-gate` subprocess for fault isolation, cross-process quota, and any-language HTTP callers — no code change to switch.
- **Self-hosted, no vendor in the path.** API keys live in `~/.config/mohdel/`. Mohdel calls provider APIs directly; nothing routes through a third party.

## Documentation

- [INTEGRATION.md](INTEGRATION.md) — JS library guide (factory, client, answer options, tools, streaming, vision, errors, OTel)
- [docs/COOKBOOK.md](docs/COOKBOOK.md) — copy-paste recipes (summarize a file, stream, swap providers, tools, vision, batch + cost)
- [docs/CATALOG.md](docs/CATALOG.md) — `curated.json` walkthrough with worked examples
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — short definitions for envelope, thin-gate, session, creator vs provider, status, …
- [ARCHITECTURE.md](ARCHITECTURE.md) — design rationale, three-plane architecture
- [PROTOCOL.md](PROTOCOL.md) — wire format for porting clients/sessions to other languages
- [LOGGING.md](LOGGING.md) — log levels, prefixes, pino integration

## Quick Start

The three lines at the top of this README are the whole onboarding: install, run `mo` to pick a provider and paste your API key, then `mo ask`. Gemini, Groq, and Cerebras all have free tiers — start there if you don't already have a paid key.

Model IDs always use the `<provider>/<model>` format:

```
gemini/gemini-3-flash-preview
anthropic/claude-sonnet-4-6
openai/gpt-5.4-mini
groq/llama-4-scout-17b-16e-instruct
```

## What mohdel is not

Scope-capping is deliberate. If you're shopping for any of the following, mohdel is the wrong layer — use it *alongside* your framework of choice, not instead of it.

- **Not an orchestrator.** No chains, no agents, no memory, no prompt templates, no retrieval. Wrap mohdel with LangChain, LangGraph, LlamaIndex, Vercel AI SDK, or your own tool loop — mohdel exposes the inference primitive, orchestration stays in your application.
- **Not a retry / fallback engine.** Errors are classified (`retryable`, `severity`, `type`) so the caller can decide, but mohdel never retries or swaps models silently. Silent model-swapping would conflict with existing multi-model logic upstream; the caller owns the retry budget and fallback choice.
- **Not a response cache.** The `cache: true` flag on envelopes is for provider-side prompt caching (Anthropic, OpenAI) — not mohdel-level memoization. Caching inference *results* is orchestration-policy territory and depends on invariants only the caller knows.
- **Not a context-window / token manager.** No pre-call token count, no projected-cost guard. The caller owns what goes in the prompt and is the source of truth for what counts.
- **Not a SaaS proxy.** Self-hosted. Your API keys, your infra. No routing through a third party, no vendor lock-in.

See [ARCHITECTURE.md §Design principles](ARCHITECTURE.md#design-principles) for the full rationale behind each.

## CLI

```bash
# One-shot inference — pipeable
mo ask anthropic/claude-sonnet-4-6 "explain monads"
cat article.txt | mo ask openai/gpt-5.4 "summarize in 3 bullets"
echo "hello" | mo ask gemini/gemini-3-flash-preview --json | jq .cost

# Streaming
mo ask anthropic/claude-sonnet-4-6 --stream "write a haiku about recursion"

# With thinking effort
mo ask anthropic/claude-opus-4-6 --effort high "prove P != NP"

# Browse the model catalog
mo ls                                  # list all curated models
mo ls --sort price                     # sorted by input price
mo search sonnet                       # filter by name/label
mo show anthropic/claude-sonnet-4-6    # model details
mo stats                               # catalog summary
mo providers                           # providers with key status & rate limits

# Rank models by benchmarks
mo rank                                # curated models, balanced weights
mo rank --use-case tool-loop           # weighted for tool reliability
mo rank --json                         # machine-readable

# Manage the catalog
mo curate anthropic                    # add new models from a provider
mo setup anthropic                     # configure API key
mo model add fireworks/deepseek-r1     # add a model manually
mo model set <model> <key> <value>     # set any field on a model
mo model rm <model> <key>              # remove a field
mo check                               # validate schema + upstream drift

# Rate limits
mo rl show anthropic                   # provider or model limits
mo rl set anthropic/claude-sonnet-4-6 60 100000

# Benchmark with live inference
mo bench anthropic/claude-sonnet-4-6   # single model
mo bench --tag fast --effort low       # suite by tag
```

All list/show commands support `--json [fields]` — bare `--json` lists available fields (like `gh`).

## Library Usage

Two integration paths: the **client** (primary, cross-process) and the **factory** (in-process shortcut).

### Client — cross-process (recommended)

```js
import { call } from 'mohdel/client'

const envelope = {
  callId: 'c-1', authId: 'u-1', auth: { key: process.env.ANTHROPIC_API_SK },
  model: 'anthropic/claude-haiku-4-5', prompt: 'Hello'
}

for await (const ev of call(envelope, { socketPath: '/tmp/mohdel-data.sock' })) {
  if (ev.type === 'delta') process.stdout.write(ev.delta.delta)
  else if (ev.type === 'done') console.log('\n→', ev.result.cost)
}
```

Requires a running `thin-gate` subprocess. See [INTEGRATION.md §Client](INTEGRATION.md#client-cross-process--primary-production-integration) for setup.

### Factory — in-process shortcut

```js
import mohdel from 'mohdel'

const mo = await mohdel()
const result = await mo.use('anthropic/claude-sonnet-4-6').answer('Hello')
console.log(result.output, result.cost)
```

No subprocess; the factory runs the same session adapters inline. Right for CLI (`mo ask`), scripts, tests, single-process services.

For the full API — initialization, alias resolution, answer options, response shape, tool use, streaming, vision, error handling, OpenTelemetry, sub-path exports — see **[INTEGRATION.md](INTEGRATION.md)**.

## Observability

Every call emits:

- **OpenTelemetry span** (`mohdel.session.answer`) under the caller's `traceparent`, with GenAI semantic-convention attributes (`gen_ai.request.model`, `gen_ai.system`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) plus mohdel's own (`mohdel.status`, `mohdel.cost`, `mohdel.thinking_tokens`, `mohdel.time_to_first_token_ms`, `mohdel.cooldown` on fast-fail).
- **Trace-linked logs** — every stderr log line carries `{traceId, spanId, callId, authId, provider, model}`. Dump logs + traces into the same collector (SigNoz, Honeycomb, Jaeger + Loki) and they're correlated for free. No per-call instrumentation code.
- **Gate-side OTLP metrics** (when running `thin-gate`): `mohdel.sessions.{alive,respawned,spawn_failures}`, `mohdel.calls{provider,status}`, `mohdel.call.duration_ms`, `mohdel.cooldown.rejections`, `mohdel.quota.rejections`, `mohdel.policy.errors`.

One endpoint for everything: set `OTEL_EXPORTER_OTLP_ENDPOINT` and spans + metrics flow to it over gRPC. No-op when unset — zero overhead for callers who aren't wired. See [INTEGRATION.md §OpenTelemetry](INTEGRATION.md#opentelemetry) and [LOGGING.md](LOGGING.md) for details.

The OTel SDK packages (`@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-grpc`) are **`optionalDependencies`** — installed by default, but `npm install --omit=optional` skips them (along with their gRPC transitive tree). If you do that and later want trace export, install them explicitly:

```bash
npm install @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-grpc
```

`@opentelemetry/api` stays in `dependencies` — the no-op tracer needs it regardless of whether export is wired.

## Architecture

Mohdel splits into three planes that can be deployed independently:

```
            ┌──────────┐ unix   ┌─────────────┐  stdin/stdout  ┌──────────┐
            │  client  │ socket │  thin-gate  │    NDJSON      │  session │  × N
 caller ──► │   (JS)   │ ─HTTP─►│   (Rust)    │ ─────────────► │   (JS)   │
            └──────────┘        └─────────────┘                └──────────┘
                                        │
                                        ▼ admin plane (unix socket, HTTP)
                                  GET /v1/health
```

- **`mohdel/client`** (JS) — thin stub that callers import. Opens a unix socket to thin-gate, sends a `CallEnvelope`, receives an async-iterable of `Event`s. Zero transitive provider-SDK imports — caller-side code stays light.
- **`mohdel-thin-gate`** (Rust binary, prebuilt and shipped via the `mohdel-thin-gate-<platform>` npm sub-packages) — scheduler / state owner / supervisor. Binds the data-plane socket, validates the envelope, dispatches to a pooled session subprocess, relays events back, handles graceful cancellation on client disconnect. Binds the admin plane for `GET /v1/health`. Pushes OTLP metrics (sessions alive/respawned, calls by provider/status, call-duration histogram, cooldown / quota / policy rejections) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Internal trait hooks (`RoutePolicy`, `QuotaPolicy`, `ConfigSource`, `CachePolicy`) make the crate testable and fork-friendly for deployments that need bespoke policy — not a published-library surface.
- **`mohdel/session`** (JS subprocess) — provider executor. Spawned by thin-gate, reads envelopes from stdin, dispatches to the matching adapter, writes events to stdout. A napi-rs addon was scoped for hot-loop optimization but current benchmarks show per-call JS CPU is not the bottleneck; the stub stays under `rust/napi-addon/` for future reactivation.

### Running thin-gate

```bash
cargo run --bin mohdel-thin-gate /tmp/mohdel-data.sock /tmp/mohdel-admin.sock /path/to/js/session/bin.js

# or with a pre-built release binary:
./target/release/mohdel-thin-gate /tmp/mohdel-data.sock /tmp/mohdel-admin.sock ./js/session/bin.js
```

Positional args are optional (data socket, admin socket, session bin). Env overrides:
- `MOHDEL_SESSION_BIN` — path to session entrypoint (defaults to none; if unset, data plane returns synthetic events)
- `MOHDEL_SESSION_POOL_SIZE` — pre-warmed sessions (default 2)

With no session-bin configured, thin-gate runs in demo mode: `POST /v1/call` returns a synthetic echo event sequence. Useful for health-checking the HTTP layer without a runtime dependency on Node.

### Calling from JS

The client snippet under [Library Usage](#library-usage) above is the full surface: `call(envelope, { socketPath, signal? })` returns an async iterable of events. Pass an `AbortSignal` to cancel in flight; thin-gate forwards a cancel control message to the session and reuses it on the pool. The envelope is the flat `answer(prompt, options)` surface plus transport metadata (`callId`, `authId`, `auth.key`, optional `traceparent`); see [`js/core/envelope.js`](js/core/envelope.js) for the full field list.

### Canonical types (frozen wire contract)

Wire format is JSON over NDJSON frames, camelCase. Types are defined in `js/core/` (JSDoc) and mirrored in `rust/thin-gate/src/protocol.rs` (serde). Cross-language conformance tests enforce round-trip fidelity. The session-side protocol (envelopes in, events out, cancel control messages) is specified in [PROTOCOL.md](PROTOCOL.md) — read that to implement a session in another language.

- **`CallEnvelope`** — flat `answer()` options plus transport metadata: `callId`, `authId`, `auth.key`, `traceparent?`, `baggage?`, `provider`, `model`, `prompt`, `outputBudget?`, `outputType?`, `outputStyle?`, `outputEffort?`, `images?`, `videos?`, `cache?`, `tools?`, `toolChoice?`, `parallelToolCalls?`, `identifier?`.
- **`Event`** — three-variant union discriminated on `type`:
  - `{ type: 'delta', delta: { type: 'message' | 'function_call', delta: string } }`
  - `{ type: 'done', result: AnswerResult }`
  - `{ type: 'error', error: TypedError }`
- **`AnswerResult`** — `status`, `output`, `inputTokens`, `outputTokens`, `thinkingTokens`, `cost` (single number), `timestamps`, `warning?`, `toolCalls?`.
- **`Status`** — `'completed' | 'tool_use' | 'incomplete'`.
- **`Warning`** — additive string union: `'insufficientOutputBudget'`, `'cancelled'`, ...
- **`TypedError`** — `{ message, detail?, severity, retryable, type }`. `message` is a stable machine key; `detail` is user-facing context; `severity` is `'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'`; `type` is an optional canonical tag (e.g. `'AUTH_INVALID'`, `'PROVIDER_COOLDOWN'`).

A `cancel` control message `{ op: "cancel", callId }` on session stdin aborts the matching in-flight call.

Extending the frozen wire types is breaking — additive changes only on trait method sets and non-frozen internals. See [ARCHITECTURE.md §What isn't frozen](ARCHITECTURE.md#what-isnt-frozen) for the refinable-vs-frozen split.

### Adding a new provider adapter

See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-session-adapter-090). Short version:

1. Create `js/session/adapters/<provider>.js` exporting `async function* <provider>(envelope, { client?, signal? })`.
2. Map provider-native events to the canonical Event union.
3. Pass `{ signal }` to the SDK's streaming method so cancellation aborts in-flight HTTP.
4. On SDK throw: if `signal?.aborted`, return silently (run() emits call.cancelled); else yield `call.error` via `classifyProviderError(e)` from `./_errors.js`.
5. Register in `js/session/adapters/index.js`.
6. Write unit tests with a dependency-injected mock client.
7. Optionally add a gated live test in `test/live/<provider>.live.test.js`.

## Configuration

API keys live in `~/.config/mohdel/environment` (one `KEY=value` per line, loaded automatically):

```
ANTHROPIC_API_SK=sk-ant-...
OPENAI_API_SK=sk-...
GEMINI_API_SK=AI...
GROQ_API_SK=gsk_...
XAI_API_SK=xai-...
CEREBRAS_API_SK=csk-...
MISTRAL_API_SK=...
FIREWORKS_API_SK=fw_...
DEEPSEEK_API_SK=sk-...
OPENROUTER_API_SK=sk-or-...
NOVITA_API_SK=...
```

Only set keys for providers you use. Run `mo` with no arguments for interactive setup.

### File locations

| Path | Purpose |
|------|---------|
| `~/.config/mohdel/environment` | API keys |
| `~/.config/mohdel/default.json` | Default model selection |
| `~/.config/mohdel/curated.json` | Model catalog with metadata, tags, pricing |
| `~/.config/mohdel/providers.json` | Provider-level rate limits |
| `~/.config/mohdel/excluded.json` | Excluded models |
| `~/.cache/mohdel/uploaded-files.json` | Gemini file upload cache |

Paths follow the [XDG convention](https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html) via `env-paths`.

## Provider Matrix

What each provider supports through mohdel's unified interface:

| Provider | Streaming | Tools | Vision | Video | Thinking | Notes |
|----------|-----------|-------|--------|-------|----------|-------|
| Anthropic | Yes | Yes | Yes | No | Yes (adaptive / budget) | `identifier` → `metadata.user_id` |
| OpenAI | Yes | Yes | Yes | No | Yes (o-series) | GPT-5 verbosity via `outputStyle` |
| Gemini | Yes | Yes | Yes | Yes | Yes (`thinkingLevel` / `thinkingBudget`) | Auto-uploads large videos; content-hashed cache |
| Cerebras | No | Yes | Yes | No | Yes (`reasoning_effort` or zai `disable_reasoning`) | Non-streaming chat completions |
| Groq | No | Yes | Yes | No | No | Non-streaming; shared chat-completions path |
| xAI | Yes | Yes | Yes | No | Auto | OpenAI Responses API over `api.x.ai/v1` |
| DeepSeek | No | Yes | Yes | No | No | DSML tool-call fallback when model emits tags in content |
| Fireworks | Yes | Yes | Yes | No | Yes (`reasoning_effort`) | OpenAI SDK + `baseURL`; model id auto-prefixed |
| Mistral | No | Yes | Yes | No | No | `tool_choice: "any"` = required |
| OpenRouter | Yes | Yes | Yes | No | Varies | Meta-provider; `providerOptions.openrouter` for routing prefs |
| Novita | No | No | No | No | No | Image generation only |

Adapter capability ≠ model capability — whether a given model accepts images, tools, or thinking effort depends on the model spec in `curated.json`. The adapter passes through what the envelope supplies; the provider rejects unsupported combos.

## Local Development

```bash
git clone <repo> && cd mohdel
npm install
npm test                          # unit tests, no API keys
```

### Rust tests

```bash
cargo test --workspace            # thin-gate + napi-addon
cargo build --release --bin mohdel-thin-gate
```

Test files under `rust/thin-gate/tests/`:

| File | Coverage |
|------|----------|
| `conformance.rs` | JS↔Rust protocol round-trip |
| `protocol.rs` | serde (de)serialization of envelope/events/results |
| `server.rs` | HTTP layer, synthetic dispatch, 404/400 paths |
| `session_dispatch.rs` | real `node js/session/bin.js` spawn + dispatch + graceful cancel |
| `policy.rs` | `RoutePolicy` + `QuotaPolicy` + `Enforcer` end-to-end |
| `config.rs` | TOML `ConfigSource` parsing, defaults, malformed, env override |
| `supervision.rs` | readiness ping/pong + readiness timeout + garbage-response handling |
| `stress.rs` | 100 concurrent calls, cancel storm, session-death-under-load |

Spawning tests require `node` in PATH.

### Provider integration tests

These hit real provider APIs. Models are drawn from your local `curated.json` — one per provider. Each provider block is skipped automatically when its API key is missing.

```bash
npm run test:provider             # all providers via the factory path
TAG=fast npm run test:provider    # filter by model tag
npm run test:multiturn            # multi-turn conversation tests (incl. tool round-trip)
npm run test:vision               # image input tests
```

### Live adapter tests

Exercise the session adapters directly against real provider APIs. Gated on env keys; skipped cleanly when keys are absent. See `test/live/README.md` for details.

```bash
ANTHROPIC_API_SK=sk-ant-... npm run test:live
OPENAI_API_SK=sk-... npm run test:live
```

### Scenario-driven testing (the `fake` provider)

For deterministic stress, benchmark, and bug-repro work, register `provider: "fake"` in the envelope with a JSON `prompt` that drives the scenario:

```js
{ mode: 'volume',       tokens: 1000 }              // throughput stress
{ mode: 'slow',         tokens: 50, delayMs: 100 }  // streaming cadence
{ mode: 'error',        type: 'AUTH_INVALID' }      // error classification
{ mode: 'hang' }                                    // cancel / timeout plumbing
{ mode: 'tool',         name: 'f', args: { x: 1 } } // tool round-trip
{ mode: 'incomplete' }                              // status contract
{ mode: 'crash' }                                   // process isolation (exits the adapter process)
{ mode: 'cancel_after', tokens: 5 }                 // cancel mid-stream
```

All modes honor `AbortSignal`. The benchmarks in `bench/` use this to pin adapter work to a fixed shape and isolate what's being measured — see `bench/bench.js` (throughput) and `bench/isolation.js` (crash containment).

### npm scripts

| Command | Description |
|---------|-------------|
| `npm test` | Unit tests (vitest) |
| `npm run test:provider` | Provider integration via the factory — real API calls |
| `npm run test:live` | Live session-adapter tests (env-key gated) |
| `npm run lint` | StandardJS lint |
| `npm run cli` | Interactive model picker |
| `cargo test --workspace` | Rust tests (thin-gate + protocol + policy + stress + ...) |
| `node bench/bench.js` | In-process vs via-gate throughput benchmark |
| `node bench/isolation.js` | Crash-isolation demo (in-process dies, via-gate contains) |

## Contributing

Fork the repository and submit a pull request. Code style: Node 22+, ES modules, no semicolons, 2-space indent, single quotes (StandardJS). See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

**Mohdel's wire is language-agnostic.** The JS client is the first implementation, not the only one — a Python / Go / Ruby / Swift / Elixir / ... client is a great starter contribution. See [CONTRIBUTING.md §Porting a client to another language](CONTRIBUTING.md#porting-a-client-to-another-language) and [PROTOCOL.md](PROTOCOL.md).

## License

MIT. See `LICENSE`.
