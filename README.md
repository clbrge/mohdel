# Mohdel

Self-hosted LLM gateway and SDK for Node — think LiteLLM, for the JS world. One `answer()` call for 13 providers or local inference; swap models by changing one string; get real per-call USD cost back on every result, with OpenTelemetry built in and process isolation when you need it. Your keys, your infra, no SaaS proxy in the path.

```bash
npm install -g mohdel
mo                                       # pick a provider, paste your key, pull its models
mo model instructions openai > mohdel-brief.md  # prices live on a docs page — hand it to your agent
mo ask openai/gpt-5.6-luna "why is the sky blue"
```

Almost no provider API returns prices, context limits or thinking budgets.
They live on a docs page, so mohdel writes a brief and the coding agent you
already run reads the page and drafts the entries. `mo` offers this at the end
of setup. Nothing runs on your key but that agent.

**No coding agent?** OpenRouter and Novita publish per-token prices in their
own model lists, so mohdel reads them directly. `mo curate openrouter` or `mo
curate novita` writes complete, priced entries on its own, and setup counts the
models that cost nothing and offers to add all of them in one keystroke. A
working catalog without a pricing page or a brief.

Providers: Anthropic, OpenAI, Gemini, Mistral, Groq, xAI, Cerebras, Fireworks, DeepSeek, Qwen Cloud, Xiaomi, OpenRouter, Novita. Node 22+, ES modules.

Mohdel runs the inference layer of production stacks, among them [docAnalyzer](https://docanalyzer.ai), a document analysis and chat platform serving hundreds of thousands of users.

## Why mohdel

- **Real numbers on every call.** Token counts and per-call USD cost computed from your own pricing catalog (`curated.json`) — not estimates, not provider-specific shapes. Bill tenants, alert on spend, reconcile invoices. Your own catalog means your negotiated rates and your own tags, and it is not a spreadsheet you maintain: `mo model instructions` hands the provider's docs page to your coding agent, which drafts the entries for you to review. See [docs/CATALOG.md](docs/CATALOG.md).
- **One interface across providers.** Same `answer()` call, same event stream, same `{ status, output, inputTokens, outputTokens, cost }` result. Switching from `anthropic/claude-sonnet-4-6` to `openai/gpt-5.4-mini` is one string change — adapter differences stay inside mohdel.
- **Self-hosted, no vendor in the path.** API keys live in `~/.config/mohdel/`. Mohdel calls provider APIs directly; nothing routes through a third party, nothing marks up your tokens, no extra hop of availability risk.
- **Nothing to compromise.** No network listener, no credential store, no tool execution. Mohdel runs a model call and returns the result; it cannot read a file, run a command, or hand back a key. See [Attack surface](#attack-surface).
- **Observability without instrumentation.** OpenTelemetry spans, trace-linked logs, and OTLP metrics over one endpoint. Set `OTEL_EXPORTER_OTLP_ENDPOINT`; everything else is wired.
- **Fully typed.** Declarations are generated from the source's own JSDoc and ship with the package — `CallEnvelope`, `Event`, `AnswerResult` and `MohdelError` are the frozen wire contract, typed as such. No `@types` package, no separate TypeScript build to keep in sync.
- **Two integration paths, same API.** In-process factory for CLI tools, scripts, single-process services. Optional `thin-gate` subprocess for fault isolation, cross-process quota, and any-language HTTP callers — no code change to switch.

## How it compares

**LiteLLM** is the closest analog but lives in Python. **Vercel AI SDK** is an
application toolkit, not an infra layer. **OpenRouter** is the same one-API
promise as a SaaS in your request path. **Raw provider SDKs** are N different
shapes with no cost accounting.

|  | mohdel | LiteLLM | Vercel AI SDK | OpenRouter | Raw SDKs |
|---|---|---|---|---|---|
| Runs in a Node stack natively | yes | Python service | yes | n/a (SaaS) | yes |
| Per-call USD cost on the result | yes | yes | no | yes | no |
| Self-hosted, keys never leave your infra | yes | yes | yes | no | yes |
| Provider-SDK process isolation | yes (thin-gate) | proxy only | no | n/a | no |
| OTel spans + metrics out of the box | yes | via callbacks | no | no | no |
| UI streaming helpers, structured output, agents | no | no | yes | no | varies |

- **vs LiteLLM** — same core promise (unified calls, cost tracking,
  self-hosted gateway), but Node-native: if your stack is JS, there's no
  Python sidecar to deploy, version, and monitor. LiteLLM's proxy exposes an
  OpenAI-compatible endpoint and admin features (virtual keys, budgets);
  thin-gate speaks its own [wire protocol](PROTOCOL.md), so callers use the JS
  client or implement the protocol. LiteLLM also ships a central price map you
  inherit, where mohdel has you keep your own — your negotiated rates,
  per-model tuning and the tags your code selects on, authored by a coding
  agent from a brief.
- **vs Vercel AI SDK** — a different layer. The AI SDK is an application
  toolkit (UI streaming, structured outputs, agent loops) with no per-call
  cost, no gateway, no process isolation. It sits above mohdel, which is the
  inference primitive underneath.
- **vs OpenRouter** — the self-hosted version of the same idea. With a SaaS
  router you accept their uptime, their markup, and your prompts transiting
  their infra. Mohdel goes direct to providers with your keys — and ships an
  `openrouter` adapter for when you want both.
- **vs raw provider SDKs** — mohdel's envelope is flat and close to the SDKs
  underneath, and `cost` / `tokens` come back normalized, so there are not five
  usage shapes to parse.

## Documentation

- [INTEGRATION.md](INTEGRATION.md) — JS library guide (factory, client, answer options, tools, streaming, vision, transcription, errors, OTel)
- [docs/COOKBOOK.md](docs/COOKBOOK.md) — copy-paste recipes (summarize a file, stream, swap providers, tools, vision, batch + cost)
- [docs/CATALOG.md](docs/CATALOG.md) — `curated.json` walkthrough with worked examples
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — short definitions for envelope, thin-gate, session, creator vs provider, status, …
- [ARCHITECTURE.md](ARCHITECTURE.md) — design rationale, three-plane architecture
- [PROTOCOL.md](PROTOCOL.md) — wire format for porting clients/sessions to other languages
- [LOGGING.md](LOGGING.md) — log levels, prefixes, pino integration

## Quick Start

Install, run `mo` to pick a provider and paste your API key, then `mo ask`. Gemini, Groq, Mistral and OpenRouter all have free tiers that need no card, and `mo` lists them first if you have no paid key set.

`cost` stays `0` until the catalog carries prices. `mo` pulls the provider's model list, but that list carries ids, not prices. `mo model instructions <provider>` writes a brief carrying the field reference, the provider's own pricing and rate-limit links, and the commands that verify a draft; hand it to the coding agent you already run:

```bash
mo model instructions openai > mohdel-brief.md
claude "read mohdel-brief.md, then add gpt-5.6-luna to my mohdel catalog"
```

The agent drafts `mohdel-candidate.json` and loops on `mo model check --entry mohdel-candidate.json` until it reports no errors. You run `mo model apply mohdel-candidate.json`, which prints the full diff — including any field the draft would remove — before writing anything. Entries carry `source` and `sourcedAt`, so a price can be traced back to the page it came from.

By hand: `mo curate <provider>` with the worked entries in [`config/curated.example.json`](config/curated.example.json), and `mo model set <id> <key> <value>` a field at a time.

Model IDs always use the `<provider>/<model>` format:

```
openai/gpt-5.6-luna
anthropic/claude-sonnet-4-6
openai/gpt-5.4-mini
groq/llama-4-scout-17b-16e-instruct
```

## Attack surface

Anthropic's 2026 threat report describes actors compromising LLM wrapper
services through prompt injection, exfiltrating the production API keys held
in their cloud containers. That attack needs two things: keys sitting where a
process can read them, and a component that injected content can steer into
reading them. Mohdel is built so neither is present.

- **Nothing executes.** No `eval`, no `new Function`, no `child_process`
  anywhere in the session, factory or library, and no automatic tool loop. A
  prompt-injected response cannot make mohdel read a file, run a shell, or make
  a call of its own. Tool execution belongs to the caller, in the caller's
  process.
- **No network listener.** `thin-gate` binds **unix sockets**, not TCP, for
  both its data and admin planes, and chmods them `0600` — the default umask
  would otherwise leave them world-connectable. There is no port to reach.
- **No credential store.** The provider key rides on each call envelope and
  goes straight to the SDK client. Mohdel never accumulates a pool of tenant
  keys, because it never holds one.
- **The session subprocess starts from an empty environment.** It is given
  back only what the runtime reads — `PATH`, proxy and TLS settings, mohdel's
  own dials, `OTEL_*`. Every `*_API_SK`, cloud credential and database URL the
  host happens to hold is dropped at the process boundary. The session gets
  its key from the envelope, so it has no reason to see any other.
- **Keys are scrubbed and wiped.** Provider error text has the key removed
  before it reaches `detail`, so a 401 body cannot carry your credential into
  your logs. In Rust, envelope bytes are zeroized after each call.

What this does **not** cover: if you run an agent loop, injection can still
bite there — mohdel moves that risk into your process rather than removing it.
And `mo` does keep keys on disk in `~/.config/mohdel/environment` (mode
`0600`), which is a key store, for a developer machine.

Report a vulnerability per [SECURITY.md](SECURITY.md).

## What mohdel is not

For any of the following, mohdel is the wrong layer. Use it alongside a framework that does them, not instead of one.

- **Not an orchestrator.** No chains, no agents, no memory, no prompt templates, no retrieval. Wrap mohdel with LangChain, LangGraph, LlamaIndex, Vercel AI SDK, or your own tool loop — mohdel exposes the inference primitive, orchestration stays in your application.
- **Not a retry / fallback engine.** Errors are classified (`retryable`, `severity`, `type`) for the caller to decide on. Mohdel never retries and never swaps models; the retry budget and the fallback choice are the caller's.
- **Not a response cache.** The `cache: true` flag on envelopes is for provider-side prompt caching (Anthropic, OpenAI), not mohdel-level memoization of results.
- **Not a context-window / token manager.** No pre-call token count, no projected-cost guard. The caller owns what goes in the prompt and is the source of truth for what counts.
- **Not a SaaS proxy.** Self-hosted. Your API keys, your infra. No routing through a third party, no vendor lock-in.
- **Not an AI wrapper.** `mo model instructions` prints a brief — text. It drives no model, ships no prompts, and spends nothing. The agent that reads it is one you already run, on your own tokens, and it never writes your catalog: `mo model apply` shows you the diff and waits.

See [ARCHITECTURE.md §Design principles](ARCHITECTURE.md#design-principles) for the full rationale behind each.

## CLI

```bash
# One-shot inference — pipeable
mo ask anthropic/claude-sonnet-4-6 "explain monads"
cat article.txt | mo ask openai/gpt-5.4 "summarize in 3 bullets"
echo "hello" | mo ask openai/gpt-5.6-luna --json | jq .cost
mo ask openai/gpt-5.6-luna -q "…" 2>err.log   # stderr carries failures only

# Streaming
mo ask anthropic/claude-sonnet-4-6 --stream "write a haiku about recursion"

# With thinking effort
mo ask anthropic/claude-opus-4-6 --effort high "prove P != NP"

# On a faster service lane, when the model sells one
mo ask openai/gpt-5.6-luna@fast "triage this alert"

# Speech → text from an audio file
mo transcribe groq/whisper-large-v3-turbo meeting.mp3
mo transcribe mistral/voxtral-mini-transcribe interview.wav --language fr

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
mo check                               # validate the catalog

# Let a coding agent write the entry
mo model instructions anthropic        # brief: fields, doc links, review commands
mo model check --entry mohdel-candidate.json  # validate + diff, no write
mo model apply mohdel-candidate.json          # write, after showing the diff

# Rate limits
mo rl show anthropic                   # provider or model limits
mo rl set anthropic/claude-sonnet-4-6 60 100000

# Benchmark with live inference
mo bench anthropic/claude-sonnet-4-6   # single model
mo bench --tag fast --effort low       # suite by tag
```

All list/show commands support `--json [fields]` — bare `--json` lists available fields (like `gh`).

### Tab completion

```bash
source <(mo completion bash)      # add to ~/.bashrc
```

Completes model ids from your catalog, provider names, field names for
`mo model set`, tags, and the commands themselves — `mo ask gemini/gemini-3.<TAB>`.
Deprecated ids are left out: they exist so old pins keep resolving, not to be
picked fresh. Completion reads the catalog directly and never loads the
inference stack, so a tab press costs about 90ms rather than half a second.

### Catalog entries, written by an assistant

Provider APIs return model *ids*, not prices — OpenRouter alone publishes
them, and `mo curate openrouter` fills a catalog unaided. Everything that makes cost
accounting work — prices, context and output limits, thinking budgets, cache
rates — is published as prose on a docs page and changes often. `mo model
instructions` prints a brief that hands your coding agent the field table, the
provider's reference links, and a verifier it can run in a loop:

```bash
mo model instructions openai > mohdel-brief.md
```

Then start whichever agent you already run on the prompt *read mohdel-brief.md, then
add gpt-5.6 to my mohdel catalog*:

| agent | launch |
|---|---|
| Claude Code | `claude "<prompt>"` |
| Codex CLI | `codex "<prompt>"` |
| Gemini CLI | `gemini -i "<prompt>"` |
| opencode | `opencode --prompt "<prompt>"` |
| Cursor CLI | `cursor-agent "<prompt>"` (installs as `agent` on some platforms) |

`mo` asks which one you use and remembers it. It has to be able to fetch a web
page, because that is where the prices are. Mohdel ships no agent of its own;
Claude Code, Codex CLI and opencode all install from npm. A session, rather
than a one-shot, lets you settle which model you want before anything is
drafted. For a one-shot, pipe instead —
`mo model instructions openai | claude -p "add gpt-5.6 to my catalog"`, or
`| codex exec -`.

The agent writes `mohdel-candidate.json` and runs `mo model check --entry` until it
reports no errors; you run `mo model apply`, which prints the full diff —
including any field the candidate would remove — before writing. Entries carry
`source` and `sourcedAt` so a price can be traced back to the page it came
from. See [docs/CATALOG.md](docs/CATALOG.md#editing-with-a-coding-agent).

## Library Usage

Two integration paths, same adapters underneath: start with the in-process **factory**; graduate to the cross-process **client** when you want gateway-grade isolation.

### Factory — in-process (start here)

```js
import mohdel from 'mohdel'

const mo = await mohdel()
const result = await mo.use('anthropic/claude-sonnet-4-6').answer('Hello')
console.log(result.output, result.cost)
```

No subprocess, no setup beyond your API key. Right for CLI tools (`mo ask`), scripts, tests, and single-process services — which is most projects. Pass an `AbortSignal` as `answer(prompt, { signal })` to cancel in flight.

The factory reads the catalog from `~/.config/mohdel/curated.json` and keys from the environment, the same defaults a gate session starts from. `mohdel({ models })` replaces the catalog for the process, factory and session runtime alike, the way `set_catalog` replaces it in a gate session. `mohdel({ configurations: { openai: { apiKey } } })` overrides the key per provider.

### Client — cross-process (the production gateway)

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

Same API, but inference runs in a pooled subprocess behind the `thin-gate` supervisor (Rust): a crashing provider SDK can't take your service down, quota is enforced across processes, and non-JS callers can speak the same wire. Switching from factory to client is a configuration change, not a rewrite. See [INTEGRATION.md §Client](INTEGRATION.md#calling-from-javascript) for setup.

For the full API — initialization, alias resolution, answer options, response shape, tool use, streaming, vision, error handling, OpenTelemetry, sub-path exports — see **[INTEGRATION.md](INTEGRATION.md)**.

## Observability

Every call emits:

- **OpenTelemetry span** (`mohdel.session.answer`) under the caller's `traceparent`, with GenAI semantic-convention attributes (`gen_ai.request.model`, `gen_ai.system`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) plus mohdel's own (`mohdel.status`, `mohdel.cost`, `mohdel.thinking_tokens`, `mohdel.time_to_first_token_ms`, `mohdel.cooldown` on fast-fail).
- **Trace-linked logs** — every stderr log line carries `{traceId, spanId, callId, authId, provider, model}`. Dump logs + traces into the same collector (SigNoz, Honeycomb, Jaeger + Loki) and they're correlated for free. No per-call instrumentation code.
- **Gate-side OTLP metrics** (when running `thin-gate`): `mohdel.sessions.{alive,respawned,spawn_failures}`, `mohdel.calls{provider,status}`, `mohdel.call.duration_ms`, `mohdel.cooldown.rejections`, `mohdel.quota.rejections`, `mohdel.policy.errors`, `mohdel.enforcer.keyspace_full{map}`. The `provider` attribute is folded to `other` for anything outside mohdel's provider set, so a caller can't mint metric series by varying the model prefix.

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
- `MOHDEL_POOL_ACQUIRE_TIMEOUT_MS` — wait for a free session before `503 SESSION_POOL_BUSY` (default 30000)
- `MOHDEL_MAX_CONNECTIONS` — concurrently served data-plane connections (default 64)

With no session-bin configured, thin-gate runs in demo mode: `POST /v1/call` returns a synthetic echo event sequence. Useful for health-checking the HTTP layer without a runtime dependency on Node.

### Calling from JS

The client snippet under [Library Usage](#library-usage) above is the full surface: `call(envelope, { socketPath, signal?, headers? })` returns an async iterable of events. `headers` go with the request, for a router in front of the gate that authenticates its callers. Pass an `AbortSignal` to cancel in flight; thin-gate forwards a cancel control message to the session and reuses it on the pool, and the client ends the stream with the same cancelled `done` the in-process path returns (status `incomplete`, warning `cancelled`, the partial output it relayed, zero tokens). The envelope is the flat `answer(prompt, options)` surface plus transport metadata (`callId`, `authId`, `auth.key`, optional `traceparent`); see [`js/core/envelope.js`](js/core/envelope.js) for the full field list.

### Other languages

The gate's HTTP surface is specified in [PROTOCOL.md §10](PROTOCOL.md#10-gate-http-surface-clients); `test/conformance/` holds the fixtures a client round-trips. Reference clients live under `clients/`:

- **Lua** — [`clients/lua`](clients/lua): Lua 5.1+ / LuaJIT, transports over LuaSocket or `curl`. `cd clients/lua && luarocks make`.
- **Gleam** — [`clients/gleam`](clients/gleam): Erlang target, typed events and results, `gen_tcp` over the unix socket. Path dependency until it is on Hex.
- **Rust** — [`clients/rust`](clients/rust): async (tokio), uses the gate's own wire types from the `mohdel-protocol` crate. Path dependency until it is on crates.io.
- **OCaml** — [`clients/ocaml`](clients/ocaml): synchronous, stdlib `Unix` transport, `yojson`; OCaml 4.14+. `opam pin` until it is on opam.

```lua
local mohdel = require('mohdel')
local c = mohdel.connect{ socket = '/tmp/mohdel-data.sock' }
for ev in c:call(envelope):events() do
  if ev.type == 'delta' then io.write(ev.delta.delta) end
end
```

### Canonical types (frozen wire contract)

Wire format is JSON over NDJSON frames, camelCase. Types are defined in `js/core/` (JSDoc) and mirrored in `rust/protocol/src/protocol.rs` (serde, the `mohdel-protocol` crate). Cross-language conformance tests enforce round-trip fidelity. The session-side protocol (envelopes in, events out, cancel control messages) is specified in [PROTOCOL.md](PROTOCOL.md) — read that to implement a session in another language.

- **`CallEnvelope`** — flat `answer()` options plus transport metadata: `callId`, `authId`, `auth.key`, `traceparent?`, `baggage?`, `provider`, `model`, `prompt`, `outputBudget?`, `outputType?`, `outputStyle?`, `outputEffort?`, `images?`, `videos?`, `cache?`, `tools?`, `toolChoice?`, `parallelToolCalls?`, `identifier?`.
- **`Event`** — three-variant union discriminated on `type`:
  - `{ type: 'delta', delta: { type: 'message' | 'function_call', delta: string } }`
  - `{ type: 'done', result: AnswerResult }`
  - `{ type: 'error', error: TypedError }`
- **`AnswerResult`** — `status`, `output`, `inputTokens`, `outputTokens`, `thinkingTokens`, `cost` (single number), `timestamps`, `warning?`, `toolCalls?`.
- **`Status`** — `'completed' | 'tool_use' | 'incomplete'`.
- **`Warning`** — additive string union: `'insufficientOutputBudget'`, `'cancelled'`, ...
- **`TypedError`** — `{ message, detail?, severity, retryable, type }`. `type` is the canonical tag callers branch on (e.g. `'AUTH_INVALID'`, `'PROVIDER_COOLDOWN'`), optional on the wire; `message` is a short human-readable label; `detail` is the provider's own rejection text; `severity` is `'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'`.

A `cancel` control message `{ op: "cancel", callId }` on session stdin aborts the matching in-flight call.

Extending the frozen wire types is breaking — additive changes only on trait method sets and non-frozen internals. See [ARCHITECTURE.md §What isn't frozen](ARCHITECTURE.md#what-isnt-frozen) for the refinable-vs-frozen split.

### Adding a new provider adapter

See [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-session-adapter). Short version:

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
QWEN_API_SK=sk-...
XIAOMI_API_SK=...
COHERE_API_SK=...
MOHDEL_LOCAL_API_SK=...
```

Only set keys for providers you use. Run `mo` with no arguments for interactive setup.

`local/` routes each model to the `baseURL` of its catalog entry — any OpenAI-compatible chat-completions server (Ollama, vLLM, llama.cpp server, LM Studio). There is no default endpoint and no per-call override: an entry without `baseURL` fails `mo model check`, a call to it fails with `CONFIGURATION_MISSING`, so a call never falls through to a cloud provider. `MOHDEL_LOCAL_API_SK` is an optional bearer token. Entry format in [docs/CATALOG.md](docs/CATALOG.md#self-hosted-local-entries).

### File locations

| Path | Purpose |
|------|---------|
| `~/.config/mohdel/environment` | API keys |
| `~/.config/mohdel/default.json` | Default model, and the coding agent you chose |
| `~/.config/mohdel/curated.json` | Model catalog with metadata, tags, pricing |
| `~/.config/mohdel/catalog.local.json` | This installation's own fields and tags, declared for the agent |
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
| Cerebras | Yes | Yes | Yes | No | Yes (`reasoning_effort` or zai `disable_reasoning`) | Shared chat-completions path |
| Groq | Yes | Yes | Yes | No | No | Shared chat-completions path |
| xAI | Yes | Yes | Yes | No | Auto | OpenAI Responses API over `api.x.ai/v1` |
| DeepSeek | No | Yes | Yes | No | No | Non-streaming: the DSML tool-call fallback is only parsed off a complete response |
| Fireworks | Yes | Yes | Yes | No | Yes (`reasoning_effort`) | OpenAI SDK + `baseURL`; model id auto-prefixed |
| Mistral | Yes | Yes | Yes | No | No | `tool_choice: "any"` = required |
| Qwen Cloud | Yes | Yes | No | No | Yes (`enable_thinking` + `thinking_budget`) | Alibaba DashScope intl; hybrid models think by default — effort `none` sends explicit off |
| Xiaomi | Yes | Yes | Yes | No | Auto | MiMo; shared chat-completions path, `reasoning_content` captured |
| OpenRouter | Yes | Yes | Yes | No | Varies | Meta-provider; `providerOptions.openrouter` for routing prefs |
| Local | Yes | Yes | Yes | No | No | Any OpenAI-compatible server; endpoint is the catalog entry's `baseURL` |
| Cohere | n/a | n/a | n/a | n/a | n/a | Embeddings only: no chat models reach mohdel through it |
| Novita | Yes | Yes | Yes | No | Yes (`reasoning_content`) | Prices in the model list; text via the shared chat-completions path, separate image adapter |

Adapter capability ≠ model capability — whether a given model accepts images, tools, or thinking effort depends on the model spec in `curated.json`. The adapter passes through what the envelope supplies; the provider rejects unsupported combos.

**Service speeds** are the exception to that pass-through rule. Where a provider sells the same weights at several speeds (OpenAI's `service_tier`, and equivalents elsewhere), the lanes a model sells are declared in its `curated.json` entry under `speeds`, with their own prices and rate limits. Select one with `speed` or the `@lane` id suffix. There is no default lane and no fallback: an undeclared lane fails the call before it is sent, because a model that silently ignores an unsupported lane would otherwise be billed at the lane's rates for standard service. See [docs/CATALOG.md](docs/CATALOG.md#service-speeds).

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
