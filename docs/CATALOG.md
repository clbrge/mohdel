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
| `inputFormat` | string[] | Subset of `["text", "image", "video", "audio"]`. Defaults to `["text"]`. Anything else is rejected by `mo check`. |

## Recommended fields

You can leave these out, but doing so disables features:

| Field | Without it… |
|---|---|
| `provider` | mohdel can't pick an adapter and the call fails. Defaults to the provider segment of the catalog key. |
| `sdk` | mohdel can't pick an SDK shape; some providers (Cerebras, Fireworks, xAI, DeepSeek) explicitly need it. |
| `inputPrice` / `outputPrice` | per-call `cost` returns `0`. |
| `contextTokenLimit` | callers can't bound input size. |
| `outputTokenLimit` | mohdel can't cap `outputBudget` — an over-limit request goes to the provider as given, and is either rejected or silently served short. |
| `label` | UIs (including `mo ls`) fall back to the catalog key. |

Prices are **USD per 1M tokens**. So `"inputPrice": 3` means $3 per million input tokens.

## Editing the catalog

You have four ways in:

```bash
mo curate <provider>             # interactive: fetch upstream model list, pick which to add
mo model add <provider>/<id>     # interactive: add one entry, prompts for each field
mo model set <id> <key> <value>  # set a single field (works for unknown/custom fields too)
mo model rm  <id> <key>          # remove a field
mo model apply <file>            # write reviewed entries from a file (see below)
```

After editing by hand, validate:

```bash
mo check                  # schema validation
mo check --json           # machine-readable
```

## Editing with a coding agent

OpenRouter is the one exception to everything in this section: its model list
carries per-token prices, so `mo curate openrouter` writes complete entries
with no pricing page to read and no agent involved. For every other provider:

A provider's API returns model ids. It does not return prices, context
windows, thinking budgets, or cache rates — those are published as prose on a
docs page, and they change. That gap is what `mo curate` cannot close and what
you would otherwise transcribe by hand.

`mo model instructions [provider]` prints a brief for whatever coding agent you
already use. It carries the field table with each field's meaning, the
provider's reference links, an existing entry for shape, and the two commands
below.

The brief goes to **stdout** and the hand-off recipe to **stderr**, so
redirecting gives you a clean file and still tells you what to do with it:

```bash
mo model instructions anthropic > mohdel-brief.md
```

Then start your agent on the prompt *read mohdel-brief.md, then add claude-haiku-5 to
my mohdel catalog*. These are the vendor-documented forms for opening a session
on an initial prompt:

| agent | launch |
|---|---|
| Claude Code | `claude "<prompt>"` |
| Codex CLI | `codex "<prompt>"` |
| Gemini CLI | `gemini -i "<prompt>"` |
| opencode | `opencode --prompt "<prompt>"` |
| Cursor CLI | `cursor-agent "<prompt>"` — installs as `agent` on some platforms, and that name collides with other tools |
| Aider | `aider --message "<prompt>"` — sends one message, then exits |

`mo --help`, `mo model --help` and `mo model instructions` all print this
table, marking whichever agent you told `mo` you use. One requirement: it must
be able to fetch a web page, since that is where the prices are. An agent
without that will stop, or guess — and a guessed price is indistinguishable
from a read one once it is in the catalog. Any other agent works too;
it only has to read a file and run a command.

A session, rather than a one-shot, lets you settle which model you want, and
what it costs, before anything is drafted. When you do want
one shot and no dialogue, pipe the brief in:

```bash
mo model instructions openai | claude -p "add gpt-5.6 to my catalog"
mo model instructions openai | codex exec -
```

The assistant writes a candidate file in catalog shape and checks it:

```bash
mo model check --entry mohdel-candidate.json          # validate + diff, never writes
mo model check --entry mohdel-candidate.json --json   # same, machine-readable
```

`--entry` reports what the candidate would change against your live catalog —
additions, edits, and every field the candidate would **remove**, since an
entry replaces the existing one wholesale. It exits non-zero while any error
stands, so an assistant can loop on it.

You run the write:

```bash
mo model apply mohdel-candidate.json          # prints the diff, then confirms
mo model apply mohdel-candidate.json --yes    # skip the prompt
```

`apply` refuses to write while validation reports an error, and refuses to
write unconfirmed when there is no terminal to prompt on. The previous catalog
is kept as `curated.json.prev` either way.

The candidate file was written by your agent, not by mohdel, so it is never
removed unasked: at a terminal `apply` offers to delete it once it has been
applied, `--rm` deletes it without asking, and anything else leaves it where
it is. A candidate that failed validation is always kept. Undo uses the
catalog's backups, never the candidate.

### Provenance

`source` is the URL the entry's numbers were read from; `sourcedAt` is the date
(`YYYY-MM-DD`) that page was last read. Neither affects dispatch or cost. They
are what lets you re-check a price later against the page it came from, which
matters because a stale price bills silently and forever.

```json
"anthropic/claude-haiku-4-5": {
  "inputPrice": 1,
  "outputPrice": 5,
  "source": "https://platform.claude.com/docs/en/about-claude/pricing",
  "sourcedAt": "2026-09-10"
}
```

### Local conventions

Your own services probably read fields the catalog schema does not define, and
your tags probably *do* something rather than just labelling. The brief cannot
know any of that, and an assistant filling in an entry will not invent it —
which is the failure you want, but not a useful one.

Declare it once in `~/.config/mohdel/catalog.local.json`. The file does not
exist by default and mohdel ships nothing in it:

```bash
mo model instructions --init-local     # scaffolds a commented template
```

```jsonc
{
  "fields": {
    "perTurnBudget": {
      "type": "number",
      "description": "What one turn of this model is allowed to consume.",
      "measured": "the command that produces this value",
      "readBy": "which of your services read it"
    }
  },
  "tags": {
    "rotation": {
      "description": "Routes the model into the serving rotation.",
      "requires": ["perTurnBudget"],
      "severity": "error"
    }
  },
  "adding": {
    "field": "How a new custom field is introduced here.",
    "tag": "How a new tag is introduced here."
  },
  "notes": "Anything else the assistant should know."
}
```

**Values still live in the entries**, in `curated.json`, exactly as before.
This file only *describes* them — it never holds a value, and nothing about how
your catalog is stored or distributed changes.

What each part buys you:

| part | effect |
|---|---|
| `fields` | the brief grows a **Local fields** table; `mo check` type-checks them instead of reporting "unknown field" |
| `fields[].measured` | the brief tells the assistant this value comes from running that command — there is no page to read it off, and it must not be guessed |
| `tags` | the brief grows a **Local tags** table, so a tag reads as a routing decision rather than a label |
| `tags[].requires` | `mo check` and `mo model check --entry` reject an entry carrying the tag without those fields |
| `tags[].severity` | `error` (default) or `warn`, per tag — set `warn` while you work off a backlog the rule exposes |
| `adding` | the brief grows *Adding a new field* / *Adding a new tag* |
| `notes` | appended to the section verbatim |

`severity` is worth a thought before you turn a rule on. If the rule describes
something already true of every entry, `error` costs nothing. If it exposes a
backlog, `error` makes `mo check` permanently red and you will start ignoring
it — declare `warn`, work the list down, then promote it.

#### Adding a new field or tag

`adding` is prose because the procedure is yours, and it is the part an
assistant is most likely to get wrong: writing the field into `curated.json` is
rarely the whole job. If a value only counts once it has been pushed to a
registry, generated into a package, or picked up by a reload, name that step —
a field that exists on disk and nowhere else is the failure mode this section
prevents.

Both keys are optional. Declared, they appear in the brief under their own
headings, so an assistant that needs a field which does not exist yet reads
your procedure instead of inventing one.

#### When the file is wrong

A `catalog.local.json` that exists but does not parse stops every command with
the parse error. It is not treated as "no conventions declared" — that would
silently switch off every local rule at once, which is precisely when you would
not notice.

### Reference links

Each provider in `src/lib/providers.js` carries a `references` block —
`pricing`, `models`, `rateLimits` where the provider publishes one. That is
what the brief hands the assistant, and what `mo model add` points you at when
a field is missing.

`mo check` reports schema problems (missing required field, wrong type, malformed tag) as `error`s and gentler issues (deprecated subfield) as `warn`s. Custom (unknown) fields are preserved silently — namespace yours (e.g. `myapp:label`) so they stay distinct if mohdel adds new official fields later.

## Self-hosted (`local/`) entries

`local/` routes each model to the OpenAI-compatible server named by its own entry — `baseURL` is required on `local/` entries and rejected on every other provider's. There is no default endpoint and no per-call override. A catalog key never contains `:` (mohdel reads it as the `:effort` suffix), so a server tag such as `llama3.1:8b` goes in `model` and the key carries a dash instead:

```json
"local/llama3.1-8b": {
  "model": "llama3.1:8b",
  "baseURL": "http://127.0.0.1:11434/v1",
  "creator": "meta",
  "provider": "local",
  "sdk": "openai",
  "inputFormat": ["text"]
}
```

Two servers are two entries with different `baseURL`s. Leave prices out for a free-running server (`cost` is `0`) or set them to an operator rate. `contextTokenLimit` is what the server is configured to serve (Ollama: `num_ctx`), not the model's nominal window. Write `local/` entries by hand: `mo model add` pre-fills `model` with the key segment and does not ask for `baseURL`.

## Output budget and the cap

`outputBudget` on a call is what the caller asks for; `outputTokenLimit` on the
entry is what the model will give. Mohdel sends `min(budget, limit)` — the cap
is applied after any thinking headroom the adapter adds, because the sum is
what reaches the provider.

That only works if the entry carries `outputTokenLimit`. Without it there is
nothing to cap against, the caller's number is sent unchanged, and you get one
of two provider behaviours:

| `outputCapStrategy` | what the provider does with an over-limit request |
|---|---|
| `error` | rejects the call |
| `accept` | silently serves fewer tokens and says nothing |

The second is the reason the cap exists: a short answer with no signal is
indistinguishable from a model that simply stopped early.

`outputCapStrategy` is set per provider in mohdel and may be overridden on an
entry when one model of a provider behaves differently. It is **informational**
— mohdel caps either way. It is published for embedders that build their own
provider requests instead of going through a session, so they don't have to
rediscover the behaviour one 400 at a time. The input-side equivalent is
`contextSemantics` on the provider (`separate` = independent input and output
budgets, as Gemini; `shared` = `input + max_output ≤ context`).

`inputCeilingMargin` is the input-side counterpart to a limit that is smaller
than advertised: `effectiveContextLimit(spec)` returns
`contextTokenLimit − inputCeilingMargin`, for a model whose usable window is
narrower than the number the provider publishes.

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
| `outputCapStrategy` | `'error'` or `'accept'` — overrides the provider default for one model. See *Output budget and the cap* above. |
| `inputCeilingMargin` | Tokens held back from `contextTokenLimit` by `effectiveContextLimit()`, for a model whose usable window is narrower than the published one. |
| `reasoningContentPlaceholder` | Filler sent in place of an empty assistant reasoning turn, for OpenAI-compatible providers that reject one. |

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

Model support is three-state: a model may honour the parameter, reject it, or
accept it and silently run at standard speed while billing standard rates. The
third case is invisible from the
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
