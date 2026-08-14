# Catalog (`curated.json`)

The catalog is the source of truth for **what mohdel knows about each model** — its real upstream id, pricing, context window, capabilities, thinking-effort mapping, rate limits, tags. Mohdel uses it to dispatch calls, compute per-call USD cost, validate envelopes, and feed `mo ls` / `mo rank` / `mo show`.

The file lives at:

```
~/.config/mohdel/curated.json
```

It's a single JSON object whose keys are mohdel model ids in the form `<provider>/<model>`. A worked file with five representative entries ships at [`config/curated.example.json`](../config/curated.example.json) — copy it as a starting point and edit.

## The two entry shapes

Every entry is one of:

**A real model entry** — provider-routable, with at minimum `model`, `creator`, `inputFormat`:

```json
"anthropic/claude-haiku-4-5": {
  "model": "claude-haiku-4-5-20251001",
  "creator": "anthropic",
  "provider": "anthropic",
  "sdk": "anthropic",
  "label": "Claude Haiku 4.5",
  "inputFormat": ["text", "image"],
  "inputPrice": 1,
  "outputPrice": 5,
  "contextTokenLimit": 200000,
  "outputTokenLimit": 64000
}
```

**A deprecated stub** — a one-field redirect to the replacement id:

```json
"anthropic/claude-3-7-sonnet": {
  "deprecated": "anthropic/claude-sonnet-4-6"
}
```

Mohdel refuses to dispatch to a deprecated id and tells the caller which one to use instead. Stubs let you retire ids without breaking callers that still pin to the old string.

## Required fields

For a real model entry (not a deprecated stub), three fields are required:

| Field | Type | Meaning |
|---|---|---|
| `model` | string | The literal model id sent to the provider's API. Often different from the catalog key (e.g. catalog key `anthropic/claude-haiku-4-5`, provider id `claude-haiku-4-5-20251001`). |
| `creator` | string | The organization that trained the model (`anthropic`, `openai`, `alibaba`, `moonshotai`, …). Independent of `provider` — `cerebras` hosts Alibaba's Qwen. |
| `inputFormat` | string[] | Subset of `["text", "image", "video", "audio"]`. Defaults to `["text"]`. Anything else is rejected by the envelope validator. |

## Recommended fields

You can leave these out, but doing so disables features:

| Field | Without it… |
|---|---|
| `provider` | mohdel can't pick an adapter and the call fails. Defaults to the provider segment of the catalog key. |
| `sdk` | mohdel can't pick an SDK shape; some providers (Cerebras, Fireworks, xAI, DeepSeek) explicitly need it. |
| `inputPrice` / `outputPrice` | per-call `cost` returns `0`. |
| `contextTokenLimit` | callers can't bound input size. |
| `outputTokenLimit` | mohdel can't clamp `outputBudget`. |
| `label` | UIs (including `mo ls`) fall back to the catalog key. |

Prices are **USD per 1M tokens**. So `"inputPrice": 3` means $3 per million input tokens.

## Capability fields

| Field | Notes |
|---|---|
| `cacheWritePrice` / `cacheReadPrice` | Provider-side prompt caching. `cacheWritePrice` bills fresh cache-creation (5m TTL); `cacheReadPrice` bills tokens served from cache. Anthropic uses explicit breakpoints (`cache: '5m'\|'1h'` on a part); OpenAI and Gemini cache implicitly and their read counts are surfaced automatically. Each falls back to `inputPrice` when absent. |
| `cacheWrite1hPrice` | Anthropic only. Bills the 1h-TTL portion of cache-creation (2× input, vs 1.25× for 5m). Falls back to `cacheWritePrice` when absent — so omitting it prices all writes at the 5m rate. |
| `thinkingEffortLevels` | Object mapping `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "none"` → provider-native budget. Mohdel translates the caller's `outputEffort: 'medium'` to whatever the provider accepts (Anthropic budget tokens, OpenAI reasoning_effort, Gemini thinkingBudget, …). Set to `null` to disable thinking on this model. |
| `defaultThinkingEffort` | The level used when the envelope omits `outputEffort`. |
| `speeds` | Object mapping lane name → overlay. Service speed lanes this model sells. See *Service speeds* below. |
| `tags` | Free-form strings. `[a-zA-Z][a-zA-Z0-9._-]{0,31}`. Used by `mo bench --tag X`, `mo rank --tag X`, and your application's own model selection. |
| `leaderboard` | `[intelligence, speed, latency]` triple (numbers). Drives `mo rank`. Source it however you want — published benchmarks, your own evals, vibes. |
| `aliases` | Alternative ids that should resolve to this entry. |
| `supportsTools` | Boolean. Set `false` to mark a model as tool-less (used by `mo` for capability summaries and by callers selecting models). |

## Rate-limit fields

`rpmLimit` (requests/minute) and `tpmLimit` (tokens/minute) override the provider-level defaults in `providers.json`. `rateLimitScope` controls how the budget is shared:

- `"provider"` — this model's traffic counts against the shared provider-level pool.
- `"model"` — this model has its own private budget.

Use `mo rl show <model-or-provider>` to inspect, `mo rl set <model> <rpm> <tpm>` to write.

## Service speeds

Some providers sell the same weights at more than one speed, selected by a
request parameter — OpenAI's `service_tier`, and equivalents elsewhere.
Faster lanes cost more; discount lanes are slower and cheaper. Declare the
lanes a model sells under `speeds`:

```jsonc
"openai/gpt-x": {
  "inputPrice": 3,
  "outputPrice": 15,
  "speeds": {
    "fast": { "inputPrice": 6, "outputPrice": 30 },
    "flex": { "inputPrice": 1.5, "outputPrice": 7.5 }
  }
}
```

Lane names come from the provider's own vocabulary — OpenAI sells `fast`,
`priority`, `flex`, and `scale`. An entry lists the ones that model
actually sells, and each carries only what differs from the base entry:
named fields replace, unnamed fields fall through. A lane that declares
nothing sells at base prices.

Nothing about the provider's protocol belongs here. How a lane name
reaches the wire, and how the served lane is read back, lives in the
adapter — it is the same for every model that provider serves, so
repeating it per entry would only be a constant waiting to drift. The
overlay is economics: prices and rate limits, nothing else.

Callers select a lane with `speed` on the envelope, or the `@lane` suffix
on the model id (`openai/gpt-x@fast`, or `gpt-x:high@fast`
alongside an effort suffix).

**There is no default lane and no fallback.** Omitting `speed` sends no
parameter at all. Requesting a lane the entry does not declare fails with
`SESSION_INVALID_SPEED`; requesting one the provider's adapter cannot emit
fails with `SESSION_SPEED_NOT_IMPLEMENTED`. Both fail before the provider
call, so nothing is billed.

That strictness is deliberate. Model support is three-state: a model may
honour the parameter, reject it, or accept it and silently run at standard
speed while billing standard rates. The third case is invisible from the
request side, so the catalog — not the provider's response — decides whether
a lane may be sent. A lane declared for a model that quietly ignores it would
bill every call at the overlay's rates for standard service.

A lane gets its own rate-limit bucket **only if it declares its own**
`rpmLimit`/`tpmLimit`. Otherwise its traffic counts against the bucket it
would have used anyway. Declare limits when the lane really is a separate
pool; leave them out when it shares the model's quota, as OpenAI's
`service_tier` does — a private bucket there would double the allowance
rather than protect it.

`mo check` rejects a lane the provider's adapter does not accept, naming
the ones it does, and warns about a lane that restates no prices.

## Image-generation entries

For image models, set `type: "image"` and fill in:

```json
"novita/flux-2-dev": {
  "model": "flux-2-dev",
  "creator": "bfl",
  "provider": "novita",
  "label": "Flux 2 Dev",
  "inputFormat": ["text"],
  "type": "image",
  "imagePrice": 0.012,
  "imageEndpoint": "flux-2-dev",
  "imageDefaultSize": "1024x1024"
}
```

`imagePrice` is per image (not per token). `imageEndpoint` is the provider-side endpoint name. `imageDefaultSize` is the size used when the envelope omits one.

## Transcription entries

For speech-to-text models, set `type: "transcription"` and price per audio **minute**:

```json
"groq/whisper-large-v3-turbo": {
  "model": "whisper-large-v3-turbo",
  "creator": "openai",
  "provider": "groq",
  "label": "Whisper Large v3 Turbo",
  "inputFormat": ["audio"],
  "type": "transcription",
  "transcriptionPrice": 0.000667
}
```

`transcriptionPrice` is USD per audio minute, applied to the duration the provider reports. Exception: OpenAI's `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` report token usage instead of duration — give those entries `inputPrice` / `outputPrice` (USD per 1M tokens) and omit `transcriptionPrice`. Supported providers: `groq`, `mistral`, `openai` (all the same OpenAI-compatible `/audio/transcriptions` endpoint).

## Custom fields

Mohdel preserves any field it doesn't recognize. Convention: namespace your own fields with your application or product prefix to avoid future collisions:

```json
"openai/gpt-5.4-mini": {
  "model": "gpt-5.4-mini",
  "creator": "openai",
  "provider": "openai",
  "inputFormat": ["text"],
  "myapp:internalLabel": "fast-default",
  "myapp:billingTier": "T2"
}
```

Custom fields round-trip through `mo` writes untouched — they survive `mo model set/rm`, `mo curate`, and editor passes.

## Editor support (JSON Schema)

A JSON Schema for `curated.json` ships at [`config/curated.schema.json`](../config/curated.schema.json). Editors that understand JSON Schema (VS Code, JetBrains, Helix, Neovim with `coc-json` or `vscode-json-languageserver`) will give you autocomplete on field names, inline type checking, and hover docs while you edit.

Two ways to wire it up:

**Inline (simplest)** — add a `$schema` key at the top of your `curated.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/clbrge/mohdel/main/config/curated.schema.json",
  "anthropic/claude-haiku-4-5": { ... }
}
```

Mohdel ignores top-level keys starting with `$` or `_`, so the pointer survives `mo` writes and never shows up as a model.

**Workspace mapping (VS Code)** — add to `.vscode/settings.json`:

```json
{
  "json.schemas": [
    { "fileMatch": ["**/curated.json"], "url": "https://raw.githubusercontent.com/clbrge/mohdel/main/config/curated.schema.json" }
  ]
}
```

The shipped [`config/curated.example.json`](../config/curated.example.json) already includes a relative `$schema` pointer, so opening that file in a JSON-Schema-aware editor gives you a working playground.

## Editing the catalog

You have three ways in:

```bash
mo curate <provider>             # interactive: fetch upstream model list, pick which to add
mo model add <provider>/<id>     # interactive: add one entry, prompts for each field
mo model set <id> <key> <value>  # set a single field (works for unknown/custom fields too)
mo model rm  <id> <key>          # remove a field
```

After editing by hand, validate:

```bash
mo check                  # schema validation + upstream drift check
mo check --local          # skip the upstream call
mo check --json           # machine-readable
```

`mo check` reports schema problems (missing required field, wrong type, malformed tag) as `error`s and gentler issues (deprecated subfield) as `warn`s. Custom (unknown) fields are preserved silently — namespace yours (e.g. `myapp:label`) so they stay distinct if mohdel adds new official fields later.

## Backups

`mo model backup` writes timestamped snapshots into `~/.config/mohdel/backups/`. Every catalog-mutating CLI command writes a `prev` backup first; rolling daily/weekly snapshots are kept too. List, diff, restore:

```bash
mo model backup list
mo model backup diff prev
mo model backup restore prev
```

## See also

- [`config/curated.example.json`](../config/curated.example.json) — copy-pasteable starting catalog
- [`config/curated.schema.json`](../config/curated.schema.json) — JSON Schema for editor autocomplete
- [GLOSSARY.md](GLOSSARY.md) — vocabulary for envelope, status, thinking effort, creator vs provider, …
- [README.md](../README.md) — install, CLI, library usage
- [INTEGRATION.md](../INTEGRATION.md) — JS library API
- `src/lib/schema.js` — canonical field list (what `mo check` enforces)
