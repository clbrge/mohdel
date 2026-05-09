# Contributing

## Code Style

StandardJS — no semicolons, 2-space indent, single quotes. Enforced via `npm run lint`.

- **Environment:** Node.js 22+, ES modules
- **Modules:** `import`/`export` only, no `require`
- **Functions:** Prefer arrow functions
- **Quotes:** Single quotes, backticks for templates
- **Async:** `async/await`, no callbacks
- **Error variable:** `err` (not `e`, `error`, `ex`)
- **Comments:** Only explain *why*, never *what* — code is self-documenting
- **Functional style:** Prefer functional patterns, classes sparingly

### Module naming: `_`-prefix for shared internals

Files under `js/session/adapters/` (and a few neighboring dirs) that start with `_` (e.g. `_catalog.js`, `_pricing.js`, `_chat_completions.js`, `_cancelled.js`, `_lazy_json_cache.js`) are **shared internals** — helpers consumed by sibling files in the same directory, not part of the public module surface. The non-`_` files (`anthropic.js`, `openai.js`, etc.) are the public shape; `_`-prefixed modules may be refactored or removed without wire-level concern. Don't import `_`-prefixed files from outside their directory.

## CLI Design

The `mo` CLI follows the **noun-verb** pattern:

```
mo <noun> <verb> [args] [flags]
```

**Nouns:** `model`, `provider`, `creator`, `tag`, `ratelimit`
**Common verbs:** `list`, `show`, `set`, `rm`, `add`

### Rules

- New commands go under an existing noun or a new noun, never as top-level flat verbs
- Flat aliases are shortcuts for frequent commands only (`ls` → `model list`, `rl` → `ratelimit`)
- Aliases live in the `ALIASES` map in `src/cli/index.js`
- `show` commands that accept both model and provider names try model first, fall back to provider
- Help text groups commands by noun with blank line separators
- All list/show commands support `--json [fields]` — bare `--json` lists available fields (gh pattern)
- `--json` flag parsing uses `parseJsonFlag()` from `src/cli/json-output.js`

### Adding a new command

1. Add the verb handler in the noun's CLI file (e.g. `src/cli/model.js`)
2. Update the help text in the same file
3. Update the main help in `src/cli/index.js`
4. If it deserves an alias, add it to `ALIASES` and the aliases help section

## Schema & Custom Fields

**Reserved fields** — defined in `src/lib/schema.js` `fieldDefs`. Mohdel validates their types.

**Custom fields** — any key not in `fieldDefs`. Stored in `curated.json`, passed through to consumers, not validated by mohdel. Use a namespace prefix (typically your app's short name) to avoid collisions:

```
<yourapp>:label        — display name in your UI
<yourapp>:billingKey   — cost-accounting parameter
<yourapp>:effort       — your app's default thinking effort
```

Set via `mo model set <model> <key> <value>`. `stripUnknown()` preserves custom fields.

## Porting a client to another language

**Great starter contribution.** Mohdel's wire protocol is language-agnostic — the JS client in `js/client/` is the first implementation, not the only one. A Python / Go / Ruby / Swift / Elixir / etc. client is welcome and low-effort.

A client does two things:

1. `POST /v1/call` (or `POST /v1/image`) over a unix socket with a `CallEnvelope` body.
2. Reads the NDJSON response body and yields parsed `Event`s (`delta` / `done` / `error`) to the caller.

All the types are specified in [PROTOCOL.md](PROTOCOL.md) and have Rust + JSDoc mirrors that round-trip through fixtures under `test/conformance/`. Use those fixtures to validate your parser — a third-language implementation that round-trips `events.json` and `envelopes.json` cleanly is correct by construction.

The canonical `js/client/` is ~100 LOC. A port in most languages lands in a similar range. Naming: `mohdel-client-<lang>` (e.g. `mohdel-client-python`, `mohdel-client-go`), in the repo or as a satellite — your call.

## Adding a session adapter

Adapters live under `js/session/adapters/`. They are async generators that take a `CallEnvelope` and yield canonical `Event`s. They do not run in-process with the caller — thin-gate spawns session subprocesses that load these adapters.

> See [PROTOCOL.md](PROTOCOL.md) for the authoritative wire-level specification (envelope shape, event grammar, control messages, state invariants, canonical error types, compliance checklist). The rest of this section is the JS-adapter-specific layer on top of that protocol.

### Contract

```js
// js/session/adapters/myprovider.js
import SDK from 'my-provider-sdk'
import {
  STATUS_COMPLETE,
  STATUS_INCOMPLETE,
  WARNING_INSUFFICIENT_OUTPUT_BUDGET
} from '#core/status.js'
import { classifyProviderError } from './_errors.js'

export async function * myprovider (envelope, deps = {}) {
  const client = deps.client ?? new SDK({ apiKey: envelope.auth.key })
  const signal = deps.signal
  const callId = envelope.call_id

  // 1. Translate envelope.messages/params to provider request shape
  const request = buildRequest(envelope)

  // 2. Emit call.start
  yield {
    type: 'call.start',
    call_id: callId,
    locked: { model: envelope.model, params: envelope.params ?? {} }
  }

  let inputTokens = 0, outputTokens = 0, finishReason = 'stop'
  let status = STATUS_COMPLETE
  let warning

  // 3. Stream provider events → canonical events
  try {
    const stream = await client.chat.stream(request, { signal })
    for await (const event of stream) {
      if (signal?.aborted) return                           // cancellation
      // map event.type → yield { type: 'content.delta', ... }
      // track usage, finish_reason, max_tokens-style truncation
    }
  } catch (e) {
    if (signal?.aborted) return                             // run() emits call.cancelled
    yield { type: 'call.error', call_id: callId, error: classifyProviderError(e) }
    return
  }

  if (signal?.aborted) return

  // 4. Emit terminal call.finish
  yield {
    type: 'call.finish',
    call_id: callId,
    finish_reason: finishReason,
    status,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost: { usd: 0 },
    ...(warning ? { warning } : {})
  }
}
```

### Rules

- **Emit exactly one terminal event** (`call.finish` / `call.error` / `call.cancelled`) per call. `run()` emits `session.adapter_no_terminal` if you forget.
- **Honor `signal`.** Pass to the SDK's streaming method. In the catch block, check `signal?.aborted` before yielding `call.error` — on abort, return silently and let `run()` emit `call.cancelled`.
- **Classify errors via `./_errors.js::classifyProviderError`.** Provider SDKs expose a `.status` property; the shared helper maps it to canonical TypedError shapes (401/403 → `auth.invalid`, 429 → `provider.rate_limit`, 5xx → `provider.unavailable`).
- **Never echo provider response bodies** on error (they may reflect the API key back). Use the generic messages from `classifyProviderError`.
- **Status contract** — `max_tokens`-style truncation is `status: 'incomplete'` + `warning: 'insufficientOutputBudget'` + `finish_reason: 'length'`. Per-provider mapping documented in the adapter files.
- **System messages** are adapter-specific: Anthropic takes top-level `system`, OpenAI Responses takes `instructions`, etc. Split before building the provider request.
- **Message content** may be string or array of `MessagePart`. Map text parts; reject other types with a clear error until vision/audio is in scope.

### Registration

Add the adapter to the frozen registry:

```js
// js/session/adapters/index.js
import { myprovider } from './myprovider.js'

export const adapters = Object.freeze({
  anthropic,
  echo,
  myprovider,              // alphabetical
  openai
})
```

### Tests

- **Unit tests** in `test/unit/session-<provider>.test.js` using a dependency-injected mock client (see `session-anthropic.test.js` for the pattern). Cover:
  - Happy path → expected event sequence, usage
  - Truncation → incomplete + warning
  - System messages → correct field mapping
  - Params → correct provider names (`max_tokens` vs `max_output_tokens`)
  - 401 / 429 / 5xx error classification
  - Empty stream degenerate case
- **Live tests** — add an entry to the `SPECS` map in `test/live/adapters.live.test.js` (`defaultModel`, `streams`, optional `truncateBudget`). The suite auto-gates on the matching `<PROVIDER>_API_SK` env var (from `src/lib/providers.js::apiKeyEnv`). See `test/live/README.md`.

### Running

```bash
npm test                                       # unit tests, no keys needed
ANTHROPIC_API_SK=... npm run test:live        # live tests, gated on keys
cargo test --workspace                         # Rust side (protocol conformance)
```

## Testing

```bash
npx vitest run test/unit/        # unit tests (fast, no API keys)
npm run test:provider             # integration (real API calls, needs keys)
npm run test:multiturn            # multi-turn integration (incl. tool round-trip)
npm run lint                      # standardjs
```

### Unit test conventions

- One test file per source module: `test/unit/<name>.test.js`
- Import from vitest: `{ describe, test, expect, vi, beforeEach }`
- Mock external dependencies, test pure logic
- `interpretError` tests use `mockErr(status, message)` helper pattern
- Use `vi.useFakeTimers()` / `vi.useRealTimers()` for time-dependent tests

### What to test

- Every `interpretError` status code mapping (per provider)
- Rate limiter and cooldown behavior
- Tool/message format conversions
- Error reporters and classifiers
- Schema validation

## Release

Releases are cut by creating a GitHub Release against a `v<version>` tag. `.github/workflows/publish.yml` fires on release creation and:

1. Builds `thin-gate` for Linux x64 glibc (`cargo build --release --target x86_64-unknown-linux-gnu`).
2. Stages the stripped binary into `packages/thin-gate-linux-x64-gnu/bin/`.
3. Publishes the sub-package first (so the optional dep exists when main lands).
4. Publishes the main `mohdel` package.

More platforms are additive — add a new sub-package under `packages/` and a matching CI step; no wire changes needed.

## Configuration

All under `~/.config/mohdel/` (XDG via `env-paths`):

| File | Purpose |
|------|---------|
| `environment` | API keys (`KEY=value`, loaded automatically) |
| `curated.json` | Model catalog |
| `providers.json` | Provider-level rate limits |
| `default.json` | Default model selection |

Cache under `~/.cache/mohdel/` (benchmark rankings, file uploads).


## Adding a wire-protocol field

`AnswerResult`, `CallEnvelope`, `Event`, and the other types in
`js/core/events.js` ↔ `rust/thin-gate/src/protocol.rs` form a frozen
contract. Adding or changing a field touches every site below — miss
one and you ship a release that crashes embedders.

1. **JS type** — add the field to the JSDoc in `js/core/events.js`.
2. **JS adapter(s)** — produce the field in `js/session/adapters/*.js`,
   including the `cancelledDone` path in `_cancelled.js` if the field
   should survive mid-stream cancellation.
3. **JS pricing** — extend `_pricing.js` `computeCost` if the field
   contributes to cost.
4. **Rust struct** — add to `protocol.rs` as `Option<...>` with
   `#[serde(default, skip_serializing_if = "Option::is_none")]`.
   `AnswerResult` derives `Default` so struct literals using
   `..Default::default()` absorb the field automatically; explicit
   literals still need updating.
5. **Conformance fixtures** — add at least one variant to the matching
   `test/conformance/*.json` file that USES the field. The
   cross-language conformance tests
   (`rust/thin-gate/tests/conformance.rs` +
   `test/unit/core-conformance.test.js`) only catch Rust↔JS drift on
   exercised fields; an absent variant means an unexercised schema.
6. **JS conformance allowlist** — add the field name to the relevant
   `*_ALLOWED` set in `test/unit/core-conformance.test.js`. The
   per-fixture key-set assertion fails closed on unknown keys.
7. **Log shape** — extend `summarizeDone` in `js/session/run.js` if
   the field belongs in the `[mohdel:answer] done` debug summary.
8. **CHANGELOG** — describe what the field represents (semantic),
   not which provider it came from. Catalog edits are out of scope
   for the package CHANGELOG (those live with curated.json).
