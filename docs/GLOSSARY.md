# Glossary

Short definitions for the terms that recur across mohdel's docs and CLI. Read top-to-bottom on first encounter; use the table of contents below later.

- [Architecture roles](#architecture-roles) — how the planes fit together
- [Catalog terms](#catalog-terms) — fields and concepts in `curated.json`
- [Call vocabulary](#call-vocabulary) — fields on a request and a response
- [Status, errors, control](#status-errors-control) — what mohdel returns and how it fails
- [Configuration](#configuration) — what lives where on disk

---

## Architecture roles

**Client** — the JS module callers `import` (`mohdel/client`). Opens a unix socket to `thin-gate`, sends a `CallEnvelope`, and yields events. Holds zero provider-SDK code.

**Thin-gate** — the Rust binary (`mohdel-thin-gate`) that owns the data socket, validates envelopes, dispatches to a pooled session subprocess, and relays events back. Also handles cancellation, quota, and OTLP metrics. Cross-process integrations go through here.

**Session** — the JS subprocess (one of N in a pool) that actually runs the provider SDK and emits events to stdout. Spawned and supervised by `thin-gate`.

**Factory** — the in-process shortcut: `import mohdel from 'mohdel'`. Skips `thin-gate` and runs the same session adapters inline. Right for CLI tools, scripts, single-process services.

**Adapter** — the per-provider code inside the session that maps a `CallEnvelope` to provider-native API calls and back. One file per provider in `js/session/adapters/`.

**SDK shape** — the family of provider APIs an adapter speaks. Many providers expose an OpenAI-shaped chat-completions API, so they share the `openai` SDK adapter (DeepSeek, Mistral, xAI, Novita, Xiaomi, Qwen Cloud…). Anthropic, Gemini, Cerebras, Fireworks, Groq, OpenRouter each have their own.

---

## Catalog terms

**Catalog** — `~/.config/mohdel/curated.json`. The local source of truth for which models exist and what mohdel knows about each one. See [CATALOG.md](CATALOG.md).

**Catalog key** — the top-level string of a catalog entry, in the form `<provider>/<model>` (e.g. `anthropic/claude-sonnet-4-6`). Mohdel routes calls by this key.

**`provider`** — the routing key. Picks which adapter handles the call. Independent of who trained the model.

**`creator`** — the organization that trained the model (`anthropic`, `openai`, `alibaba`, `moonshotai`, …). One creator can be hosted by many providers — Cerebras hosts Alibaba's Qwen, Novita hosts BFL's Flux, etc.

**`model`** — the literal id sent to the provider's API. Often differs from the catalog key (e.g. catalog `anthropic/claude-haiku-4-5`, upstream `claude-haiku-4-5-20251001`).

**Deprecated stub** — a one-field catalog entry, `{ "deprecated": "<replacement-id>" }`. Mohdel refuses to dispatch through it and points callers at the replacement. Lets you retire ids without breaking pinned callers.

**Tag** — free-form label on a catalog entry (`["chat", "tool-loop", "fast", "vision"]`). Used by `mo bench --tag`, `mo rank --tag`, and your application's own model selection logic. Must match `[a-zA-Z][a-zA-Z0-9._-]{0,31}`.

**Leaderboard** — the `[intelligence, speed, latency]` triple on an entry. Drives `mo rank`. Source the numbers however you like (published benchmarks, your own evals).

**Alias** — alternative id that resolves to the same entry. Useful for accepting common short names (`opus` → `anthropic/claude-opus-4-7`).

**Thinking effort** — symbolic level (`low`, `medium`, `high`, `xhigh`, `max`, `none`) that mohdel translates to the provider's native budget (Anthropic budget tokens, OpenAI `reasoning_effort`, Gemini `thinkingBudget`, …). Mapping lives in the entry's `thinkingEffortLevels`. The caller passes `outputEffort: 'medium'`; the entry decides what that means in upstream units.

---

## Call vocabulary

**`CallEnvelope`** — the request structure: model, prompt, optional tools/images/etc., plus transport metadata. The full surface is documented in [`js/core/envelope.js`](../js/core/envelope.js) and [PROTOCOL.md](../PROTOCOL.md).

**`callId`** — caller-assigned id for one specific call. Used to correlate logs, spans, and the cancel control message.

**`authId`** — caller-assigned id for the *user* (or workspace, or tenant) on whose behalf the call runs. Drives quota grouping and identifier mapping (e.g. Anthropic's `metadata.user_id`).

**`traceparent`** — W3C trace-context header (`00-<trace-id>-<span-id>-<flags>`). Mohdel parents `mohdel.session.answer` under the caller's span when present.

**`outputBudget`** — hard cap on output tokens. Mohdel clamps to the model's `outputTokenLimit` and forwards.

**`outputEffort`** — see *Thinking effort*. The symbolic level for reasoning models.

**`outputType`** — discriminator for response shape: `text` (default), `json`, `image`, …

**`outputStyle`** — additional response-style hint (e.g. GPT-5 verbosity).

**`cache: true`** — opt-in for *provider-side* prompt caching (Anthropic, OpenAI). Not a mohdel-level result cache.

**`AnswerResult`** — the terminal shape returned in a `done` event: `{ status, output, inputTokens, outputTokens, thinkingTokens, cost, timestamps, warning?, toolCalls? }`.

**`cost`** — single USD number for the call, computed from the entry's pricing fields. Returns `0` if the entry has no `inputPrice` / `outputPrice`.

---

## Status, errors, control

**`status`** — terminal outcome on `AnswerResult`:
- `completed` — model finished cleanly.
- `tool_use` — model wants to call a tool; the loop is the caller's responsibility.
- `incomplete` — output was truncated (provider-specific finish reasons for "max tokens reached" all map here). Look at `warning` for the reason.

**`warning`** — non-fatal qualifier on a successful result. Examples: `'insufficientOutputBudget'`, `'cancelled'`. Additive string union — new warnings can be added without breaking the wire.

**`TypedError`** — error event payload: `{ message, detail?, severity, retryable, type }`.
- `message` — stable machine-readable key (snake/camel string).
- `detail` — user-facing context, may include provider text.
- `severity` — `'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'`.
- `retryable` — boolean hint for the caller's retry policy. Mohdel never retries on its own.
- `type` — optional canonical tag (e.g. `'AUTH_INVALID'`, `'PROVIDER_COOLDOWN'`).

**Cooldown** — provider-wide circuit-breaker state in `thin-gate`. After a string of failures from one provider, new calls fast-fail with `PROVIDER_COOLDOWN` instead of hitting the wire. Visible as `mohdel.cooldown.rejections` in metrics and `mohdel.cooldown` on the call span.

**Cancel** — the caller aborts a call by closing the `AbortSignal` passed to `call()`. Thin-gate sends `{ op: "cancel", callId }` on session stdin; the adapter passes it down to the provider SDK. The session is reused on the pool.

---

## Configuration

**`environment` file** — `~/.config/mohdel/environment`, one `KEY=value` per line. Loaded automatically (`process.loadEnvFile`).

**`curated.json`** — the catalog (see above).

**`providers.json`** — provider-level rate limits (`rpmLimit`, `tpmLimit`). Per-model overrides go in `curated.json`.

**`default.json`** — the model `mo ask` falls back to when none is given. Set with `mo default`.

**`excluded.json`** — model ids `mo` should hide from `list`/`curate` results.

**XDG paths** — mohdel uses `env-paths`, so on Linux this is `$XDG_CONFIG_HOME/mohdel/…` (defaulting to `~/.config/mohdel/`); on macOS it's `~/Library/Preferences/mohdel/`; on Windows it's `%APPDATA%\mohdel\Config\`.

---

## See also

- [README.md](../README.md) — install, CLI, library usage
- [CATALOG.md](CATALOG.md) — `curated.json` field reference
- [INTEGRATION.md](../INTEGRATION.md) — JS library API
- [PROTOCOL.md](../PROTOCOL.md) — wire format
- [ARCHITECTURE.md](../ARCHITECTURE.md) — design rationale
