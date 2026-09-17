# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/).

## [1.3.2] — Fix: priced models shown as free

### Fixed

- `mo model list` read only `inputPrice`/`outputPrice`, so every model billed on
  another dimension — embeddings, image generation, transcription — printed as
  `free`. Each now shows its own price, with the unit where it is not per-token.

## [1.3.1] — Feat: the brief covers rate limits

### Added

- `mo rl set` / `rm` / `show` take a `<model>@<lane>` target, so the quota a
  service speed lane sells separately no longer has to be hand-edited into
  `curated.json`. A lane outranks the entry and carries rpm and tpm only; `inpm`
  on a lane is refused.
- `mo model instructions` covers rate limits: a hard rule that some published
  numbers describe the key rather than the model, and a section that walks an
  agent from the provider's limits page to the right level for each number —
  entry, provider pool, per-endpoint, or speed lane. It also states that a
  request which would change the catalog ends in a candidate plus
  `mo model apply` or an exact `mo` command, never findings alone.

## [1.3.0] — Feat: embeddings respect rate limits / Feat: every gate route is enforced

### Fixed

- `mo rl show` reported a limit of `0` — the documented killswitch — as no limit
  at all, and attributed it to the provider rather than the entry that set it.

### Added

- `embed()` honours rate limits. `run_embedding.js` consults the same limiter
  the chat path uses, keyed on the provider or — with
  `rateLimitScope: "model"` — the catalog key.
- Catalog field `inpmLimit`: inputs per minute, for an embedding endpoint a
  provider meters in inputs rather than requests or tokens. Checked before
  dispatch against the batch size; a batch larger than the whole allowance is
  sent rather than delayed.
- Gate: `QuotaSpec.inpm` and an inputs counter in the enforcer, matching the
  session's `inpmLimit` — a batch is admitted only when the whole of it fits in
  the minute, and one larger than the allowance is sent rather than delayed.
- Gate: `/v1/embed`, `/v1/image` and `/v1/transcription` run the quota,
  cooldown and rate-limit sequence that `/v1/call` already ran. They dispatched
  to the pool unguarded, so a caller out of allowance on `/v1/call` could keep
  working through them. Route and auth policy stay `/v1/call` only; both hooks
  are typed on `CallEnvelope`.
- Gate: one-shot routes answer `QUOTA_EXCEEDED` with 429 and `PROVIDER_COOLDOWN`
  with 503 instead of 502.
- `mo rl rm <model> [limit …]` and `mo rl provider rm <provider> [limit …]`
  drop named limits; with none named they clear all, as before. `rateLimitScope`
  goes with the last limit off the entry.
- `mo rl set` and `mo rl provider set` take limits by name —
  `mo rl set cohere/embed-v4.0 inpm 2000`, `… rpm 15 tpm 1000000` — which
  reaches every limit, including one on its own. The positional
  `<rpm> [tpm]` form stays as a shortcut.

## [1.2.0] — Feat: embeddings

### Added

- `embed()` beside `answer()` and `transcribe()`:
  `mo.use('openai/text-embedding-3-small').embed(['a', 'b'])` returns
  `{ vectors, dimensions, inputType, inputTokens, cost, timestamps }`, one
  vector per input in request order. OpenAI, Gemini, Cohere and `local`;
  `callEmbedding` from `mohdel/client` for the gate's `POST /v1/embed`.
- Catalog fields `embeddingPrice`, `dimensions`, `dimensionsSelectable`,
  `maxBatch`, `maxInputTokens`, `inputTypes` and `defaultInputType`.
  `inputTypes` maps a symbolic role (`query`, `document`, …) to the
  provider's vocabulary; an entry declaring none rejects `inputType` rather
  than dropping it. A batch over `maxBatch` fails before dispatch.
- Cohere, for embeddings only. It has no chat models.

### Fixed

- A catalog field declared `boolean` always failed validation; `schema.js`
  had no checker for the type.
- `cost` rounds to ten decimals rather than six, which reported a short
  embedding as 0.

## [1.1.0] — Feat: six more providers stream

### Changed

- Cerebras, Groq, Mistral, Novita, Qwen Cloud and Xiaomi stream. Each was
  checked against the live API first: their SSE honours
  `stream_options.include_usage`, so token counts still arrive in the final
  chunk and cost is unaffected. Novita also gets the `streamingDispatcher` the
  other chat-completions adapters use. DeepSeek stays non-streaming: its DSML
  tool-call fallback is parsed only off a complete response.
- `test/live/specs.js` holds the per-provider live-test facts, shared by the
  live suite and `probes/provider-capability.mjs`. Xiaomi gains a spec, and
  the stale Fireworks and Novita model ids are corrected.

## [1.0.3] — Feat: Novita prices itself

### Added

- Novita joins OpenRouter as a provider mohdel prices from its own API.
  `mo curate novita` reads input, output and cache-read prices, context and
  output limits, modalities and tool support from `api.novita.ai/openai/v1`,
  so its entries need no brief and no pricing page.
- `catalogClient` on a provider record selects a catalog client by name rather
  than by `sdk`, so a provider on the shared `openai` SDK can read its own
  richer model list.

### Fixed

- The README Provider Matrix listed Novita as image-generation only, which
  predates its text adapter.

### Chore

- `@clack/prompts` `^1.8.0` → `^1.8.1`
- `release-it` `^21.0.2` → `^21.0.3`

### Tests

- `test/unit/catalog-novita.test.js`, `test/unit/provider-matrix.test.js` —
  the matrix, the live specs and the adapters agree on streaming, and every
  adapter has a live spec.

## [1.0.2] — Fix: `mo` was uninstallable since 1.0.0

### Fixed

- `@clack/prompts` was pinned to `^1.8.8`, which does not exist. An
  unsatisfiable optional dependency is skipped silently, so `mo` died with
  `ERR_MODULE_NOT_FOUND` on a clean install of 1.0.0 and 1.0.1. Now `^1.8.0`,
  and a regular dependency, since three modules import it at load time.

### Tests

- `test/unit/dependency-declarations.test.js` — a shipped module's load-time
  imports are declared, and not optional.

## [1.0.1] — Fix: atomic catalog writes / Fix: Qwen Cloud reference links

### Fixed

- Catalog writes are atomic: the save goes to a sibling temp file and is
  renamed over the target. An interrupted write left `curated.json` truncated.
  Covers `excluded.json`, `providers.json` and `default.json`, which share the
  write path.
- Qwen Cloud `references` point at `docs.qwencloud.com` for pricing and rate
  limits and `qwencloud.com/models` for the model list. `baseURL` unchanged.

## [1.0.0] — Feat: agent-authored catalog / Feat: free models in one step / Security: session environment cleared

### Stability

`1.0.0` fixes the public API under SemVer:

- the library API — `mohdel()`, `answer()`, the factory and the client;
- the `CallEnvelope`, `Event` and `AnswerResult` shapes, and the single
  `MohdelError` type;
- the NDJSON wire protocol between client, gate and session, frozen since
  `0.90.0` and enforced by the cross-language parity tests.

Catalog entries, the `curated.json` field set and the JSON Schema are additive.
CLI flags are deprecated before removal.

### Security

- The session subprocess starts from `env_clear()` and receives only `PATH`,
  `HOME`, `TMPDIR`, locale, Node runtime and TLS/proxy settings, mohdel's own
  dials, the OpenRouter attribution headers, and `OTEL_*`. Every `*_API_SK` is
  dropped at the process boundary; the session takes its key from the envelope.
  `OTEL_EXPORTER_OTLP_HEADERS` is forwarded and commonly carries a credential.

### Added

- `mo model instructions [provider]` — a brief for a coding agent editing the
  catalog: field table generated from the validator, meanings from
  `config/curated.schema.json`, the provider's reference links, an existing
  entry for shape, and the review commands. At a terminal it writes
  `mohdel-brief.md` and prints the launch line; redirected or piped, the brief
  goes to stdout and the recipe to stderr. `--print` forces stdout.
  `--init-local` scaffolds `catalog.local.json` and refuses to overwrite one.
- `mo model check --entry <file|->` — validates candidate entries in
  curated.json shape and reports what they would change against the catalog,
  including every field a candidate would remove. Never writes; exits non-zero
  while an error stands. `--json` for the machine-readable form.
- `mo model apply <file|->` — writes reviewed entries after printing the diff.
  Refuses on a validation error, and refuses unconfirmed with no terminal to
  prompt on unless `--yes`. Offers to delete the candidate once applied; `--rm`
  deletes without asking; a candidate that failed validation is kept.
- `mo provider models <provider> [--json]` — the model ids a key can reach,
  read from the provider and written nowhere.
- `mo completion bash` — completes model ids, provider names, `mo model set`
  field names, tags, and commands and their aliases, resolving an alias the way
  the router does. Deprecated ids excluded. Backed by a hidden `mo __complete`
  routed before any other import: about 90ms per tab press.
- Free models in one step. Where a provider publishes prices in its own model
  list (`pricesFromApi`, which is OpenRouter), first-run setup offers *Add the
  free models (N)* as its first option and writes the entries without
  prompting, creator derived from the id. `mo curate` offers the same set as a
  preselected multiselect ahead of its search prompt. `listModels()` carries
  `inputPrice` / `outputPrice` where the provider publishes them.
- Local conventions: `~/.config/mohdel/catalog.local.json` declares the custom
  fields and tags an installation adds to its own catalog. Absent by default.
  `fields` are type-checked by `mo check` and no longer reported as unknown;
  `tags[].requires` rejects an entry carrying a tag without the fields that tag
  needs, at a per-tag `severity` of `error` (default) or `warn`; `adding` and
  `notes` are prose. All of it renders into the brief, with a rule against
  guessing a `measured` value or applying a tag whose requirements are unmet.
  Values stay in `curated.json`; the file only describes them.
- TypeScript declarations ship with the package: generated from the source's
  JSDoc by `npm run build:types`, emitted beside each module, wired into
  `prerelease`, and listed in `files`. Every `exports` subpath carries a `types`
  condition. `js/core` types exactly (6 `any` across 1019 lines, none in
  `js/client`); the factory's Proxy surface stays loose.
- `mo default <model>` sets the default without the picker.
- `mo ask -q` / `--quiet` — nothing on stderr but failures.
- First-run `mo` asks which coding agent you use and stores it in
  `~/.config/mohdel/default.json`. `mo --help`, `mo model instructions` and the
  hand-off name that agent; one mohdel has no entry for — anything taking a
  prompt as one argument — is accepted by name. `mo doctor` shows the choice.
- The hand-off recipe in `mo --help`, `mo model --help` and
  `mo model instructions`, with a launch line for Claude Code, Codex CLI,
  Gemini CLI, opencode and Cursor CLI (Aider in the long form), marking those
  found on `PATH`. Launch forms are the vendor-documented ones for opening a
  session on an initial prompt. It states that the agent must be able to fetch
  a web page, and the brief tells an agent without web access to stop rather
  than fill the entry in. Where nothing on `PATH` looks like an agent, mohdel
  names three that install from npm.
- The brief states which providers have a free tier and that the paid rates are
  what to record. With an empty catalog it gains a section telling the agent to
  read `mo provider models`, price from the docs page, and propose a starter set
  for confirmation. Its workflow opens with `mo provider models <provider>
  --json`.
- `references` on each provider in `src/lib/providers.js` — `pricing`, `models`
  and `rateLimits` doc URLs. `local` and `xiaomi` ship none.
- Catalog fields `source` (URL the numbers were read from) and `sourcedAt`
  (`YYYY-MM-DD`).
- `src/lib/catalog-review.js` — per-entry review, entry diffing and candidate
  parsing, shared by `mo check` and `mo model check --entry`.
- `src/lib/assistants.js`, `src/lib/local-conventions.js`, `src/cli/local.js`,
  `src/lib/provider-info.js` (moved from `src/cli/onboard.js`), `buildBrief()`
  exported from `src/cli/instructions.js`, and `tildePath` / `portablePath` in
  `src/lib/common.js`. A `catalog.local.json` that exists but does not parse
  stops the command instead of reading as "no conventions declared".

### Changed

- One name for the agent that writes catalog entries: a coding agent.
  `docs/GLOSSARY.md` defines *Coding agent*, *Brief*, *Candidate file* and
  `catalog.local.json`.
- Adapters load one at a time. `run()` and `runImage()` resolve an adapter by
  dynamic import keyed on the provider name, checked against a known list
  first. Catalog validation reads speed lanes from `adapters/_registry.js`, and
  `isImageProvider` moved there. `mo ls` 455ms → 117ms; importing the factory
  350ms → 45ms. The `adapters` map exported from `mohdel/session` is unchanged.
- `outputBudget` is capped to the model's `outputTokenLimit` before the provider
  call, on every adapter, after any thinking headroom the adapter adds. A spec
  with no `outputTokenLimit` is sent as given.
- `mo model add` and `mo curate` preselect a creator guessed from the model id
  — vendor namespace, then family prefix, matching only on a token boundary. An
  unrecognised id offers no default. 46 of 46 correct on a 130-model catalog.
  `creators.js` entries carry `prefixes`; the module exports
  `creatorFromModelId(bare)`.
- `mo model add` no longer auto-assigns a creator from a provider record. The
  prompt always appears, offering the creators that provider already serves in
  your catalog first.
- Bare `mo` on a configured install prints the providers, the catalog size and
  how many entries have no price, then the commands that follow from that
  state. It also notices a brief already in the working directory and offers
  the launch line.
- First-run `mo` asks how to fill the catalog once, instead of offering curate
  and the brief as separate prompts. The hand path names what it did not do.
- `mo doctor` names the count of unset provider keys rather than a row each;
  `mo doctor --all` restores the list.
- `mo curate <provider>` builds only the requested provider's client, and an
  absent key for another provider is no longer announced.
- `mo ask` carries the resolved model id on a stderr spinner that clears when
  the answer arrives. Without a terminal the id prints only when it differs
  from what was typed. `--json` prints neither, and stdout is untouched.
- The brief is `mohdel-brief.md` and the candidate `mohdel-candidate.json`. A
  brief mohdel wrote before is replaced; a file it did not write is left alone
  and the brief goes to `mohdel-brief-2.md`.
- The sentence pasted to an agent names the provider instead of a literal
  `<model>` placeholder.
- `mo curate` and `mo model add` end by naming the provider's pricing page and
  `mo model instructions <provider>`.
- `config/curated.schema.json` drops `tokenizerHeadroom`, which no code reads;
  adds `source`, `sourcedAt`, `inputCeilingMargin`,
  `reasoningContentPlaceholder` and `outputCapStrategy`; every field the
  validator knows carries a description.
- `outputCapStrategy` is a validated catalog field (`'error' | 'accept'`),
  overriding the provider-level default per model. Informational, published for
  embedders that build their own provider requests; documented in
  `ARCHITECTURE.md` and `docs/CATALOG.md`.
- Removed: `js/session/adapters/image/index.js` and `getImageAdapter`;
  `exampleAgent` from `src/lib/assistants.js`; `initializeAPIs` from
  `src/lib/select.js`, replaced by `providerApi(name)` and
  `providersWithKeys()`. None was a package export.
- Removed: `creators` on provider records in `src/lib/providers.js`, part of the
  `mohdel/providers` export. It drifted on 5 of 14 providers and duplicated a
  fact the catalog holds.

### Fixed

- `mo provider --help` and `mo creator --help` printed an error instead of
  help, and `mo default --help` opened the interactive picker. All three print
  a help screen.
- The environment block in `mo --help` listed 11 of 13 provider keys. It is
  generated from the provider table now, so `QWEN_API_SK`, `XIAOMI_API_SK` and
  `MOHDEL_LOCAL_API_SK` appear. The npm description had the same drift and said
  "11 providers".
- `mo model --help` listed `model check` twice, the second row advertising a
  `--local` flag that does not exist and an upstream-drift check removed in
  0.90. `mo ask --help` omitted the `xhigh` and `max` effort levels.
- `resolveGateBinary()` and `MOHDEL_GATE_BINARY` were advertised and unwired.
  The prebuilt binary is on `PATH` as `mohdel-thin-gate` after an install;
  `INTEGRATION.md` said to build it with cargo. `resolveGateBinary()` is
  exported from `mohdel/client`, and `MOHDEL_GATE_BINARY` overrides the
  resolved path.
- The `logger` passed to `mohdel()` never reached the session runtime: the
  bridge forwarded none, so `run()` fell back to its module default at `warn`
  and wrote pino-shape JSON to stderr. `buildHandlers` exposes `withContext`
  and the factory passes the handlers through. A logger implementing
  `withContext` receives the per-call context; one that does not keeps its own
  levels. `runImage` and `runTranscription` log nothing and were unaffected.
- `mo default` set a model nothing used: `mo ask` required the id as its first
  argument. `mo ask "…"` uses the default when the first argument carries no
  provider segment; an explicit id wins. The library, session and gate never
  read it, and a test asserts that.
- `mo default` replaced the whole config file, erasing the stored coding-agent
  choice. It merges now, and no longer writes an `apiKeyInfo` note nothing read.
- `mo curate` hung forever when the model list could not be fetched — the
  spinner was created inside the `try`. It stops the spinner, prints the
  provider's message with the two commands that check a key, and exits 1.
  `processModels` reports failure.
- `mo model add`: the upstream metadata lookup imported `../lib/sdk/<sdk>.js`,
  which does not exist, inside a `catch {}`. It imports `../lib/catalog/` and
  reports a failed lookup.
- `--json` reached no delegated `model` subcommand: the router consumed the
  flag before dispatching, so `mo check --json`, `mo model rank --json`,
  `mo model bench --json` and `mo model backup --json` printed human output.
- `mo ask --json` no longer writes the usage summary to stderr; the numbers are
  in the payload. `mo ask` runs no spinner under `--verbose`.
- `mo doctor` printed warnings only when there were no errors. Both print now.
  An empty catalog is a warning rather than a tick, and config paths render as
  `~/…`.
- A library caller on a fresh install got `Model '…' not found in catalog.` and
  nothing else. An empty catalog names both ways out: `mo curate` /
  `mo model instructions`, or `mohdel({ models })`.
- `mo provider list` built its list from the catalog, so a fresh install
  reported no providers while telling the user to run `mo curate <name>`. It
  lists every provider mohdel can route to, with model counts and key status.
- `mo ls`, `mo creator list` and `mo tag list` printed nothing on an empty
  catalog. They name the state and the two commands that fix it.
- `mo ask` on a model not in the catalog names `mo model instructions
  <provider>` alongside the two manual ways to add it.
- Xiaomi was missing from `PROVIDER_INFO`, so first-run `mo` offered 12 of the
  13 providers that take a key.
- The free-tier flags in first-run setup were wrong both ways: OpenRouter has a
  no-card free tier and was marked paid; Cerebras is $5 of expiring starter
  credit and was marked free.
- Provider descriptions in first-run setup named model generations and had gone
  stale. They describe capability and commercial terms, and a test rejects any
  digit in a description.
- `inputCeilingMargin` is a known catalog field. `effectiveContextLimit()`
  always subtracted it from `contextTokenLimit`; it was in neither the validator
  nor the JSON Schema.
- `reasoningContentPlaceholder` is a known catalog field. The chat-completions
  adapter always read it off the entry; it was in neither the validator nor the
  JSON Schema, so `mo check` called it unknown.
- `mo check`: a catalog key carrying a `:effort` or `@speed` suffix is an error
  — those are call-time suffixes, never entry keys.
- `mo check`: an `inputFormat` entry outside `text`, `image`, `video`, `audio`
  is an error. `docs/CATALOG.md` claimed the envelope validator rejected it;
  nothing did.

### Docs

- `README.md`: four-line opening fence; cost bullet answers the objection it
  raises; LiteLLM comparison covers central price map versus your own catalog;
  *What mohdel is not* gains "not an AI wrapper"; two dead anchors repointed.
- `CONTRIBUTING.md`: how providers and creators are named, and why neither
  records the other.
- `docs/CATALOG.md`: *Editing the catalog* and *Editing with a coding agent* move
  above the field reference.

### Chore

- `@anthropic-ai/sdk` `^0.123.0` → `^0.125.0`
- `@google/genai` `^2.21.0` → `^2.22.0`
- `openai` `^7.9.0` → `^7.15.0`
- `@clack/prompts` `^1.7.0` → `^1.8.8`
- `lint-staged` `^17.4.1` → `^17.5.1`
- `typescript` `^7.0.2` added, for the declaration build

### Tests

- `test/unit/onboard-env-write.test.js` — every keyed provider is offered by
  first-run setup, no description carries a version number, every entry has the
  fields the picker renders.
- `test/unit/session-output-cap.test.js` — the cap on all three request
  builders, thinking headroom not pushing a capped budget back over the limit,
  and a spec without `outputTokenLimit` passing through.
- `test/unit/catalog-review.test.js` — entry review, catalog walk, entry
  diffing, candidate parsing and classification, and that the validator's
  fields and the JSON Schema's describe the same set.
- `test/unit/cli-instructions.test.js` — brief content and per-provider
  narrowing, provider link coverage, and the hand-off recipe on stderr.
- `test/unit/curate-free.test.js`, `test/unit/public-claims.test.js`,
  `test/unit/package-exports.test.js`.

## [0.125.0] — Fix: abort on OpenAI-compatible adapters ends with the cancelled `done` / Chore: bump dependencies

### Fixed

- OpenAI-compatible adapters (`_chat_completions.js`): an abort mid-stream or
  before the first byte now ends with the cancelled `done` (status `incomplete`,
  warning `cancelled`) instead of a clean completion with zero tokens, or an
  error event.

### Changed

- `client/call`: a caller abort ends the event stream with the cancelled
  `done` (status `incomplete`, warning `cancelled`, partial output, zero
  tokens) instead of throwing `aborted`; an already-aborted signal yields it
  without connecting. Same terminal as the in-process path.
- `@google/genai` `^2.20.0` → `^2.21.0`

### Tests

- `test/unit/session-chat-completions.test.js` — abort at each runner
  checkpoint: SDK stream ending silently, SDK stream still yielding after
  abort, SDK stream throwing after abort, and the non-streaming request
  throwing under an aborted signal.
- `test/unit/session-driver.test.js` — a `{op:"cancel"}` line arriving on
  stdin while an adapter is streaming aborts it and stdout ends with the
  cancelled `done`. Previously only pre-dequeue cancel was covered.
- `test/unit/factory-bridge.test.js` — a mid-stream abort resolves
  `answer()` with the cancelled result and partial output rather than
  throwing.
- `test/unit/session-openai.test.js`, `session-anthropic.test.js`,
  `session-gemini.test.js` — first cancel coverage for these adapters:
  mid-stream abort and SDK throw under an aborted signal.
- `test/unit/client-call.test.js` — abort mid-stream, before connecting,
  after the terminal, and while response headers are pending.

## [0.124.0] — Feat: `models` replaces the catalog end to end / Feat: `answer()` `signal` / Chore: bump dependencies

### Added

- `signal` option on `answer()`: an `AbortSignal` passed to `run()` and the
  adapter. Listed in the bridge's option-mapping table.

### Changed

- Factory `models` and `configurations` are independent options. `models`
  replaces the catalog for `use()`, `list()` and the session runtime.
  `configurations[provider]` overrides the env key for that provider.
- Factory init reads `~/.config/mohdel/.env` and `providers.json` regardless
  of options. Loading a config file does not create `~/.config/mohdel/`.
- `use()` reports an unknown model as `not found in catalog`.
- `@anthropic-ai/sdk` `^0.122.0` → `^0.123.0`
- `openai` `^7.8.0` → `^7.9.0`

## [0.123.0] — Feat: Lua, Gleam, Rust and OCaml clients / Refactor: `mohdel-protocol` crate

### Added

- Lua client (`clients/lua`): `mohdel.connect{ socket }` → `call` (event
  stream, `collect()`, `close()` cancels), `image`, `transcription`,
  `health`; transports over LuaSocket or `curl`; Lua 5.1+ / LuaJIT;
  rockspec `mohdel-scm-1`. CI runs luacheck + busted on 5.1, 5.4 and LuaJIT.
- Gleam client (`clients/gleam`): `mohdel.connect(socket)` → `call`
  (callback, `Stop` cancels), `fold`, `collect`, `image`, `transcription`,
  `health`; typed `Event` / `AnswerResult` / `TypedError` decoders;
  `envelope` builder; `gen_tcp` unix-socket FFI. CI runs
  `gleam format --check` + `gleam test` on OTP 27 / Gleam 1.18.
- Rust client (`clients/rust`, crate `mohdel-client`): `Client::new(socket)`
  → `call` (a `Stream` of events; dropping it cancels), `collect`, `image`,
  `transcription`, `health`; async on tokio; `Transport` trait for tests;
  wire types come from `mohdel-protocol`.
- OCaml client (`clients/ocaml`, package `mohdel`): `Mohdel.connect` →
  `call` (stream with `next`/`iter`; `close` cancels), `collect`, `image`,
  `transcription`, `health`; synchronous over the stdlib `Unix` socket;
  `yojson`; `Envelope` builder. CI runs `dune build @fmt` + `dune test` on
  OCaml 5.3.
- `mohdel-protocol` crate (`rust/protocol`): the gate's wire types
  (`protocol.rs`, `secret.rs`) moved out of `mohdel-thin-gate`, which
  re-exports them at the same paths. `TypedError` implements `Display` and
  `std::error::Error`.
- `PROTOCOL.md` §10: the gate's HTTP surface for clients.
- Captured gate responses under `test/conformance/gate/`, shared by all four
  client test suites.

## [0.122.0] — Feat: `local/` provider / Removed: per-call `auth.baseURL`

### Added

- `local/` provider: streaming OpenAI-compatible chat completions against
  the server named by the catalog entry.
- Catalog field `baseURL`: required on `local/` entries, rejected on other
  providers'. A `local/` call whose entry has no `baseURL` fails with
  `CONFIGURATION_MISSING`.
- `MOHDEL_LOCAL_API_SK`: optional bearer token for `local/`. Unset → no
  `Authorization` header.
- `local/` catalog keys carry no `:`; the server tag goes in `model`
  (`local/llama3.1-8b` → `"model": "llama3.1:8b"`). Example entry in
  `config/curated.example.json`; field notes in `docs/CATALOG.md`.
- Live smoke suite for `local`, gated on `MOHDEL_LIVE_LOCAL_BASE_URL`;
  `MOHDEL_LIVE_LOCAL_MODEL` sets the server tag (default `llama3.1:8b`).
- `local` in `KNOWN_PROVIDERS` (`metrics.rs`).

### Removed

- `auth.baseURL` (`Auth.base_url`, wire `baseUrl`): removed from
  `protocol.rs`, the envelope typedef, and every adapter. `Auth` is `{ key }`.
- Factory `configuration.baseURL`: rejected with `CONFIGURATION_UNSUPPORTED`.
- `createConfiguration()` no longer returns `baseURL`; the provider-level
  `baseURL` in `providers.js` is read by the catalog fetchers only.

### Changed

- `mo doctor` counts only providers with an API key env var.

## [0.121.2] — Chore: bump dependencies

### Changed

- `@anthropic-ai/sdk` `^0.120.0` → `^0.122.0`
- `@google/genai` `^2.18.0` → `^2.20.0`
- `groq-sdk` `^1.5.0` → `^1.6.0`
- `openai` `^7.5.0` → `^7.8.0`
- `@opentelemetry/exporter-trace-otlp-grpc` `^0.221.0` → `^0.222.0` (optional)
- `@opentelemetry/sdk-node` `^0.221.0` → `^0.222.0` (optional)
- `gpt-tokenizer` `^3.4.0` → `^4.0.0` (dev; the major only drops the UMD/unpkg bundles)
- `lint-staged` `^17.3.0` → `^17.4.1` (dev)

### Notes

- Dependency maintenance only; no adapter or protocol changes.

## [0.121.1] — Fix: Gemini tool results that aren't objects / Chore: bump dependencies

### Fixed

- **A tool result that parsed to a number, string, boolean, null or array
  400'd the Gemini call.** `function_response.response` is a
  `google.protobuf.Struct`, so it takes a JSON object and nothing else.
  `safeParseToolResult` wrapped the value in `{result}` only when
  `JSON.parse` threw, which let every other non-object shape through
  unwrapped. A `calc` tool returning `398678330` — valid JSON, not an object
  — produced `Invalid value at 'contents[2].parts[0].function_response.response'`
  and killed the run after the tools had already succeeded. The wrap now keys
  off the parsed shape rather than the throw. Prose results are unaffected;
  they never parsed in the first place.

### Changed

- `@anthropic-ai/sdk` `^0.117.1` → `^0.120.0`
- `@google/genai` `^2.17.1` → `^2.18.0`
- `openai` `^7.4.0` → `^7.5.0`
- `vitest` `^4.1.10` → `^4.1.11` (dev)

### Notes

- Dependency maintenance only; no adapter or protocol changes beyond the
  fix above.

## [0.121.0] — OpenAI speed lanes, priced from what was served

### Added

- **OpenAI is the first provider wired for speed lanes.** The adapter owns
  the protocol: it accepts the lane names `fast`, `priority`, `flex`, and
  `scale`, puts them on `service_tier`, and reads the served tier back. A
  catalog entry lists the lanes a model sells and their prices; nothing about
  the wire appears in the entry.

- **Cost follows the lane the provider says it served, not the one that was
  requested.** OpenAI reports `service_tier` on the response and documents
  serving Standard instead above its ramp rate limit, so a `fast` request
  under load is legitimately answered at standard speed. Billing the request
  would charge premium rates for standard service. Reconciling the two takes
  the request as well as the echo, since OpenAI answers `priority` to a
  granted request for either premium lane. The served lane rides on
  `AnswerResult.servedSpeed` (`null` when downgraded) and the
  `mohdel.served_speed` span attribute, and a downgrade is logged rather than
  absorbed. When a lane was requested and the provider reported nothing back,
  the request is billed and the gap is logged.

- **Adapters advertise the lanes they accept** on `speedLanes`. Absence of
  the property declares an adapter handles none, which is what the dispatch
  guard reads — so `SESSION_SPEED_NOT_IMPLEMENTED` now names the lanes the
  provider does accept, and `mo check` rejects an unaccepted lane name at
  authoring time.

### Fixed

- **A `done` event carrying `speed` was rejected by the gate.** `run.js` has
  stamped `AnswerResult.speed` since 0.120.0, but the Rust `AnswerResult` is
  `deny_unknown_fields` and the gate parses every session event line, so the
  first lane call over the wire would have failed as a broken session. The
  field is now on both sides, with conformance fixtures round-tripping it.
  Unreachable before now because no catalog entry declared `speeds`.

- **A lane no longer gets a private rate-limit bucket unless it declares its
  own quota.** 0.120.0 gave every active lane its own bucket on the assumption
  that a lane means separate capacity. OpenAI's `service_tier` shares the
  model's TPM/RPM pool with standard traffic, so that handed lane traffic a
  second full allowance instead of protecting it. A lane now buckets
  separately only when it sets `rpmLimit` or `tpmLimit`.

- **Tiered prices are accepted for the cache fields.** `cacheReadPrice`,
  `cacheWritePrice`, and `cacheWrite1hPrice` were declared scalar-only in
  `curated.schema.json` while `resolveTier` has always handled the `{">N": …}`
  form, which several entries already use. Both the base entry and lane
  overlays now accept either shape, and the three fields are known to
  `mo check` rather than reported as unknown.

### Changed

- `@anthropic-ai/sdk` 0.115 → 0.117.1
- `@google/genai` 2.16 → 2.17.1
- `release-it` 21.0.1 → 21.0.2 (dev)

## [0.120.0] — Service speed lanes

### Added

- **Service speed lanes (`speeds` / `speed` / `@lane`).** Providers have begun
  selling the same weights at different speeds behind a request parameter
  (Anthropic `speed: "fast"`). A catalog entry now declares the lanes a model
  sells under `speeds`, each carrying the provider-native `wire` value plus the
  prices and rate limits that differ from the base entry. Callers select one
  with `speed` on the envelope or the `@lane` suffix on the model id
  (`anthropic/claude-x@fast`, or `claude-x:high@fast` alongside an effort
  suffix), in the factory, the CLI, and on the wire.

  Lanes are unordered — a lane may be slower and cheaper as readily as faster
  and dearer — so there is no `defaultSpeed` and no fallback. Omitting `speed`
  sends no parameter. Naming a lane the entry does not declare raises
  `SESSION_INVALID_SPEED`; naming one the provider's adapter cannot emit raises
  `SESSION_SPEED_NOT_IMPLEMENTED`. Both fire before the provider call, so a
  rejected lane costs nothing. The strictness exists because model support is
  three-state: a model may honour the parameter, reject it, or accept it and
  silently run at standard speed while billing standard rates — the last of
  which is invisible from the request side and would bill every such call at
  the lane's rates.

  An active lane is priced from its own overlay and gets its own rate-limit
  bucket regardless of `rateLimitScope`, and rides on `AnswerResult.speed` and
  the `mohdel.speed` span attribute so cost can be attributed per (model, lane).
  `mo check` rejects an entry declaring `speeds` for a provider with no adapter
  support.

### Changed

- **`costFor(model, usage)` now takes the envelope: `costFor(envelope, usage)`.**
  Pricing resolves through the envelope's effective spec so an active lane bills
  at the lane's rates without each adapter merging the overlay for itself.

- **Suffix splitting resolves the whole model id against the catalog first.**
  A bare provider-native id that itself contains `:` or `@` — an OpenRouter
  variant id, a version-pinned Vertex id — is a catalog key in its own right and
  is no longer mistaken for a suffixed one.

- **`cacheWrite1hPrice` is in the catalog schema.** `_pricing.js` already read
  it; the field was missing from `curated.schema.json`.

## [0.119.1] — Fix: `detail` carried a JSON document instead of a sentence on Gemini errors

### Fixed

- **A Gemini rejection reached consumers as a JSON blob rather than the
  provider's sentence.** `@google/genai` sets `ApiError.message` to
  `JSON.stringify({error: {message, code, status}})`, and the body it wraps
  is itself Gemini's JSON error document — so `classifyProviderError` put two
  nested envelopes on `detail`, which every consumer treats as a user-facing
  string. `extractDetail` now peels up to two JSON envelopes, yielding
  `Thinking level MINIMAL is not supported for this model. Please retry with
  other thinking level.` Plain sentences, JSON without a message field, and
  bodies nested deeper than two levels are returned unchanged.

## [0.119.0] — Security: gate resource bounds, secret hygiene, dependency advisories / Fix: OpenRouter factory path, session framing, corrupt-config errors

### Security

- **A pasted API key containing `$` was silently corrupted on save.**
  `appendToEnvFile` passed the key as a `String.replace` *replacement
  string*, where `$&`, `` $` ``, `$'` and `$$` are expanded — so on the
  update path (an existing entry for that provider) `sk-$&-tail` was stored
  as `sk-OPENAI_API_SK=sk-original-tail`, and `` sk-$`-tail `` as
  `sk--tail`. The key then failed to authenticate with no indication that
  the file did not contain what was typed. The first-write path was never
  affected. The replacement is now a function, and the env var name is
  escaped before being interpolated into the matching regex.

- **The gate retained `auth.key` in freed heap after dispatch.**
  `SecretString` zeroizes on `Drop`, but serializing an envelope for session
  stdin materialized the key into a plain `Vec<u8>` that was dropped without
  wiping, so a gate core dump could contain every recently-dispatched key.
  Both dispatch sites now zeroize that buffer once the write completes.
  This narrows the window rather than closing it: `serde_json` grows the
  buffer by reallocation and those intermediate allocations are freed
  unzeroed. PROTOCOL.md §3.1 now says so explicitly, and warns that `Auth`'s
  `#[serde(transparent)]` `Serialize` emits the key in cleartext even though
  `Debug` redacts it — so an envelope must never be serialized for
  diagnostics.

- **Gemini catalog fetch sent the API key in the query string.**
  `src/lib/catalog/gemini.js` set `?key=<apiKey>`, which proxies, CDNs and
  server access logs record verbatim — the one fetcher of seven not already
  using a header. It now sends `x-goog-api-key`.
  `test/unit/catalog-key-transport.test.js` asserts no catalog fetcher puts
  its key in the URL, so a future provider module cannot reintroduce it;
  these modules previously had no coverage at all.

- **Publish workflow ran third-party actions by moving tag in an OIDC job.**
  `publish.yml` holds `id-token: write` for npm trusted publishing while using
  `dtolnay/rust-toolchain@stable` and `Swatinem/rust-cache@v2`, either of which
  could be repointed by its owner to code that mints a publishing token and
  signs provenance for this package. Both are now pinned to full commit SHAs,
  and `npm ci` runs with `--ignore-scripts` so dependency lifecycle scripts no
  longer execute with those privileges. Nothing in the job runs the installed
  tree: the build is cargo, and neither package declares a
  prepack/prepublish script.

- **Pool acquire waited forever and the accept loop had no admission
  cap.** `SessionPool::acquire` blocked until a session freed up, `handle_call`
  imposed no bound, and `serve_data_with_state` spawned a task per accepted
  connection. Against the default two-session pool, callers queued without
  limit and each queued request held its already-read body, so gate memory
  grew with the queue.
  `acquire` now takes `MOHDEL_POOL_ACQUIRE_TIMEOUT_MS` (default 30000) and
  answers `503` with a retryable `SESSION_POOL_BUSY` when it expires;
  `mohdel.pool.acquire_timeouts` counts those. The accept loop holds a
  semaphore of `MOHDEL_MAX_CONNECTIONS` permits (default 64), taken *before*
  `accept` so that at capacity the gate stops accepting and callers wait in
  the kernel backlog rather than each costing a task and a body read.
  `acquire` returns `Result<PooledSession, AcquireError>` instead of
  `Option`, so a closed pool and an exhausted timeout are distinguishable at
  the call site.

- **`idleHeartbeatMs` had no floor and the heartbeat leaked promise
  reactions.** One request could set `idleHeartbeatMs: 1` and turn adapter
  silence into ~1000 serialized `idle` events per second through the gate —
  unbounded output amplification from a single caller-supplied integer. The
  same loop re-raced the in-flight `iterator.next()` on every timer firing,
  attaching two more reaction records per tick to a promise that, during a
  stall, does not settle: 6 idle ticks produced 7 subscriptions to one
  pending promise.
  `idleHeartbeatMs` is now raised to `MIN_IDLE_HEARTBEAT_MS` (250 ms), and
  the continuation is attached once at creation, parking its result for the
  loop to observe instead of re-subscribing. Both transports are covered:
  `withIdleHeartbeat` is the only producer of `idle` events and every path
  reaches it through `js/session/run.js`. The session logs a `warn` naming
  the requested and applied values when it raises a value.

- Cleared all three high-severity advisories in the production dependency
  tree; `npm audit --omit=dev` now reports zero.
  - **`undici` `^7.24.5` → `^7.29.0`** (5 CVEs: downstream response
    desynchronization via the retry interceptor, cross-user information
    disclosure and parse-time crash on degenerate private cache directives,
    CRLF injection via a blob-like body `type`, cross-user disclosure via
    whitespace in `Cache-Control`, cookie attribute injection). This is the
    one that needed a declared-range change: `undici` is a direct dependency
    driving `js/session/adapters/_dispatcher.js`, so it carries every
    streaming provider call, and a consumer resolving `^7.24.5` could land on
    a vulnerable 7.28.0 regardless of this repo's lockfile.
  - `ws` 8.20.0 → 8.21.2 (uninitialized memory disclosure, memory-exhaustion
    DoS) and `form-data` 4.0.5 → 4.0.6 (CRLF injection), both transitive and
    both already permitted by their parents' ranges — lockfile only.

### Fixed

- **A missing `chalk` took the whole CLI down instead of dropping colour.**
  `chalk` is an `optionalDependency` — npm skips it on an engine mismatch or
  `--no-optional`, silently — but `src/cli/colors.js` and
  `colored-logger.js` imported it statically, so the ten CLI modules
  depending on them failed at load. Both now resolve it through
  `src/cli/_chalk.js`, which falls back to an uncoloured stand-in that stays
  callable and chainable (`dim('x')`, `bold.red('x')`). `isColorAvailable`
  reports which one is in use.

- **A reused `AbortSignal` accumulated a listener per call.**
  `js/client/transport.js` registered an `abort` listener with
  `{ once: true }`, which releases on abort but not on a call that ends
  normally, so a caller holding one long-lived `AbortController` across many
  calls retained one closure — and its `ClientRequest` — per call. The
  listener is now removed when the request closes, rather than when the
  promise resolves: resolve happens at response headers and cancellation has
  to stay live for the streaming body.

- **The video upload cache had no TTL or bound.**
  `~/.cache/mohdel/uploaded-files.json` retained every entry forever, keyed
  by content hash and mtime so each re-save of a file added another. The
  correctness half matters more than the size: provider handles expire
  server-side (Gemini's Files API keeps an upload about 48h) while the entry
  did not, so a re-sent file could skip the upload and hand the provider a
  URI it no longer knows. Entries now expire after 24h and are capped at 500,
  most-recent first, pruned on both read and write.

- **Corrupt config degraded silently to empty.** `_lazy_json_cache.js` and
  `common.js` both caught everything on load and returned `{}`, so a typo in
  `curated.json` was indistinguishable from the file being absent: every call
  then failed with `Unknown model 'x' — not in catalog` and nothing named the
  real cause. `common.js` was worse — its `moduleLogger.warn` defaults to
  `silent`, so no diagnostic was emitted at all.
  A missing file still resolves to the default, which is a real runtime
  branch. A file that exists but does not parse now throws, naming the path
  and the parse position; `common.js` raises a `ConfigParseError` carrying
  the original `SyntaxError` as `cause`. Non-object files are unchanged and
  still normalize to the default.

- **A parseable but unusable stdin line killed the session with no terminal
  event.** `driver.js` enqueued any JSON without a recognized `op` as an
  envelope, so a line of `null`, `[1,2,3]`, `42` or `"hello"` reached the
  dispatch loop and threw on `envelope.callId` — `main().catch` then exited
  the process, violating PROTOCOL.md §3's requirement of a terminal `error`
  for unusable stdin. The gate recovered by respawning, so this cost a
  session rather than a call. Lines are now shape-checked before enqueue and
  a missing string `callId` is rejected the same way, both emitting
  `SESSION_STDIN_MALFORMED`.

- **No backpressure on session stdout.** The driver ignored every
  `stdout.write` return value, so a fast-streaming adapter feeding a slow
  gate reader grew Node's internal write buffer without bound: with the pipe
  blocked, a 12-event call buffered 1015 bytes where one frame (60) should
  have been in flight. Frames on the dispatch path now await `drain` when the
  pipe reports full, which propagates the pause back through `for await` to
  the adapter. Control frames (`pong`, the malformed-stdin error) still write
  synchronously — they are single small frames emitted from sync callbacks.

- **Framing caps were inconsistent across the NDJSON readers.** The gate
  capped what it read from a session at 16 MiB, but the session capped
  nothing on stdin, and three Rust readers — the readiness ping, the
  post-cancel drain, and the stderr relay — used uncapped `read_line` /
  `lines()`. All now share `read_capped_line` at the same 16 MiB bound;
  an over-cap stderr line is reported and the drain stops rather than
  growing its task buffer.
  On the JS side `parseNDJSON` measured the *accumulated buffer* rather than
  the current unterminated line, so a single chunk carrying more than 16 MiB
  of already-framed events was rejected as a runaway line, and it counted
  UTF-16 units while its error said "bytes" — a 3-byte-per-character line was
  accepted at up to three times the gate's limit. Both the client and the
  session driver now use `js/core/framing.js`, which bounds one line in UTF-8
  bytes to match the gate.

- **A multi-line catalog snapshot silently corrupted the session frame.**
  `send_catalog` spliced the embedder's JSON string straight into
  `{"op":"set_catalog","table":<json>}`, so a pretty-printed snapshot split
  the frame across lines and the session rejected the fragments as
  `SESSION_STDIN_MALFORMED` — an error naming nothing the operator could
  act on. The snapshot is now rejected before anything reaches stdin, with a
  message naming the `CatalogSource` contract. At acquire time a rejected
  snapshot serves the stale catalog rather than discarding the session:
  the session is healthy, the embedder is at fault, and the next snapshot
  would be equally bad, so discarding would destroy one session per acquire
  and never converge.

- **`release` into a full channel dropped the session silently.** No
  replacement was queued and no `session_alive_delta(-1)` was emitted, so
  the pool shrank permanently and `sessions_alive` stayed overstated. A
  released session came out of that channel, so a full channel means the
  accounting is already wrong: it now routes through `discard`, which
  balances both gauges and queues a replacement, and reports the anomaly.
  Channel closure (pool shutdown) is handled separately — gauges are
  balanced, no replacement is spawned.

- `providers.openrouter.createConfiguration()` returned a `defaultHeaders` key
  unconditionally — the `OPENROUTER_REFERER` / `OPENROUTER_TITLE` guards chose
  what went *inside* the object, not whether it existed. The factory bridge
  allowlists `apiKey` and `baseURL` only, so **every** `mohdel().use('openrouter/…')
  .answer()` and `mo ask` against an OpenRouter model threw
  `CONFIGURATION_UNSUPPORTED` before reaching the network, whether or not the
  attribution vars were set. The gate/client path was unaffected.
  `js/session/adapters/openrouter.js` already builds these headers from the
  same env vars and additionally runs them through `sanitizeHeader()`, so the
  removed copy was both unreachable and the less safe of the two.

### Added

- `keywords` in `package.json` — npm registry search matches on this field
  and the package declared none.
- `test/unit/client-transport.test.js`,
  `test/unit/session-video-cache.test.js` and
  `test/unit/cli-chalk-optional.test.js` — none of these modules had
  coverage.

### Removed

- The upload-cache half of `src/lib/cache.js` (`FILE_CACHE_PATH`,
  `loadFileCache`, `saveFileCache`, `getCachedFileData`,
  `setCachedFileData`). It was a factory-era duplicate writing the same
  `uploaded-files.json` as `js/session/adapters/_videos.js` with a different
  shape and no expiry, and had no caller. `CACHE_DIR` remains.
- `rust/thin-gate/tests/pool_admission.rs` — a saturated pool returns
  `AcquireError::Timeout` within the configured bound rather than hanging,
  a released session is still reacquirable, and the timeout env var parses
  (default, explicit, `0`, garbage).
- `test/unit/session-idle-heartbeat.test.js` — the module had no coverage at
  all, which is how both defects survived. Counts subscriptions to the
  in-flight `next()` across many idle ticks, and pins the floor against both
  a sub-floor and an above-floor request.
- `test/unit/provider-config-bridge.test.js` — feeds every provider's
  `createConfiguration()` output through the bridge's real `configToAuth()`.
  Both sides of this join were already tested in isolation, which is why the
  break shipped; the new test fails the moment any provider emits a config key
  the bridge does not accept.

## [0.118.0] — Security: local-media confinement, bounded enforcer state / Breaking: one error type

### Security

- **Arbitrary local file read via `fileUri`.** `_images.js`, `_videos.js` and
  `transcription/openai_compatible.js` read any `file://` path with no
  allowlist, canonicalization or size cap and shipped it to the provider;
  `_videos.js` accepted a bare path with no scheme. All three now resolve
  through `js/session/adapters/_media.js`: scheme required, `fileURLToPath` →
  `realpath` → confinement check on the resolved path (via `path.relative`, so
  `/srv/media-evil` fails for root `/srv/media`), `isFile()` before the size
  check (`/dev/zero` reports `size: 0`), 64 MiB cap. The streaming video
  upload path is exempt.
  Default is deny. In-process envelopes (factory, CLI) are marked trusted with
  a module-private `Symbol`, which `JSON.parse` cannot produce, so no wire
  envelope can grant itself local reads. `MOHDEL_MEDIA_ROOTS` confines every
  caller, in-process included.
  Residual: `realpath` and the following `stat`/`readFile` are separate
  syscalls, so a symlink swapped between them wins the race. Closing it needs
  `O_NOFOLLOW`/`openat2`, which Node does not expose.
- **Unbounded, caller-keyed enforcer state.** `RateLimiter` and
  `CooldownTracker` are keyed by caller-supplied `authId`; `RateLimiter` had
  no removal path, and the raw strings reached metric attributes as unbounded
  cardinality. Now: `protocol::validate_ids()` at all three parse sites
  (`callId`/`authId` ≤ 128 B, `model` ≤ 256 B, provider half ≤ 32 B, both
  halves non-empty); `MAX_TRACKED_KEYS = 100_000` per map behind an `admit()`
  gate, with `RateLimiter` sweeping earlier-minute buckets and
  `CooldownTracker` sweeping expired windows plus entries idle over 15 min;
  `metrics::provider_label()` clamps `provider` to a 13-name allowlist,
  everything else aggregating under `other`.
  Exhaustion fails closed — a new key is refused rather than evicting a live
  one, since failing open would let `authId` rotation evade rpm/tpm entirely.
  Already-tracked keys are unaffected. `mohdel.enforcer.keyspace_full{map}`
  counts refusals.
- **Provider API key echoed in `NET_ERROR` messages.** The network fallback in
  `classifyProviderError` put the raw SDK message on `error.message`;
  `scrubKey` was applied to `detail` only. It now scrubs before truncating —
  the reverse order leaves a key prefix at the 200-char boundary that exact
  substring matching cannot catch.

### Changed

- **One error kind.** `MohdelError` and `MohdelTypedError` were two classes
  with inverted conventions: the former put the machine key in `message`, the
  wire type puts it in `type`. There is now one class, `MohdelError` in
  `js/core/errors.js`, whose serialized form is the frozen `TypedError`.
  `toJSON()` whitelists the wire fields, so in-process state cannot reach the
  wire.
- `mohdel/errors` resolves to `js/core/errors.js`; exports are `MohdelError`
  and `SEVERITY_TAGS`.
- `MohdelError.context` — `{provider, model, modelKey}` set by the bridge,
  excluded from `toJSON()`.
- Ingress rejects `"anthropic/"` and `"/gpt-5"`, previously accepted —
  `split_once('/')` only checked that a slash existed. `"/gpt-5"` failed at
  adapter resolution and produced an empty `provider` metric label;
  `"anthropic/"` resolved and reached the provider with an empty model,
  spending an rpm/tpm slot and a cooldown failure on a request that could
  only 400. The in-process factory applies the same validation via
  `validateIds()`, so both transports reject identically instead of only the
  gate path being covered.
- Wire envelopes cannot read local files unless `MOHDEL_MEDIA_ROOTS` is set.
  In-process callers are unaffected when it is unset.

### Removed

- `src/lib/errors.js`, folded into `js/core/errors.js`.
- The `Severity` symbol table and `getSeverityNumber()`. Severity is the
  lowercase string tag everywhere; the symbols did not survive
  `JSON.stringify` and compared unequal across duplicate installs.
- `MohdelError`'s `cause`, `component` and `silent` — all write-only.
- `fromTypedError()` and `toSeveritySymbol()` in `js/factory/bridge.js`.
- `src/lib/cooldown.js`, superseded by `js/session/_cooldown.js`.
- `parseModelId()`, `MODEL_ID_RE` and the branded `ModelId` type from
  `js/core/model-id.js`. The validator had no call site anywhere; validation is `validateIds()`.
- `isStatus()` from `js/core/status.js` — no caller in shipped code; the
  status constants and `STATUSES` are unchanged.
- Six unreferenced exports: `loadProviders`
  (`_providers.js`), `isTranscriptionProvider` (`transcription/index.js`),
  `getDefaultModelId` (`common.js`), and `expandModelAlias`,
  `overwriteCuratedCache`, `reloadCuratedCache` (`curated-cache.js`). Each was
  a leaf with no caller anywhere including tests. `expandModelAliasSync` is
  live and unchanged.

### Fixed

- The bridge synthesized `detail` from `message` when the wire carried none
  (`err.detail || err.message`). Wire fields now carry over untouched.
- `TypedError`'s field semantics were documented backwards in PROTOCOL.md,
  ARCHITECTURE.md, README.md and docs/GLOSSARY.md.
- `extractDetail()`'s JSDoc in `_errors.js` was attached to `scrubKey()`.
- Three `parseErrorBody()` copies in `js/client/` omitted the required
  `severity` on `PROTOCOL_HTTP_ERROR`.

### Added

- `js/session/adapters/_media.js` — local-media resolver, `markTrustedMedia()`
  / `isTrustedMedia()`, `MOHDEL_MEDIA_ROOTS`.
- `protocol::validate_ids()` with `MAX_ID_BYTES` / `MAX_MODEL_BYTES` /
  `MAX_PROVIDER_BYTES`; `mohdel.enforcer.keyspace_full{map}` counter.
- `validateIds()` in `js/core/envelope.js` — the JS mirror, applied by the
  factory bridge on all three in-process entry points. Reason strings match
  the gate's exactly. `test/unit/core-validate-ids.test.js` parses the caps
  out of `protocol.rs` and fails when the two sides drift.
- `test/unit/session-media.test.js` — 30 tests: `/dev/zero`, symlink escape,
  `..` traversal, prefix-sibling, percent-decoding, multi-root, mark
  unforgeability and survival across the `run.js` spread.
- `test/unit/gate-provider-labels.test.js` — fails when the Rust allowlist and
  `src/lib/providers.js` drift.
- Rust coverage for the caps, `validate_ids`, and a socket test asserting a
  4 KB `authId` returns 400.

### Documentation

- INTEGRATION.md: **Local media** and **Envelope limits** sections; the error
  example branches on `err.type`.

### Migration

- `err.message === 'AUTH_INVALID'` → `err.type === 'AUTH_INVALID'`. `message`
  is now a short human-readable label.
- `Severity.ERROR` → `'error'`. `import { Severity } from 'mohdel/errors'` no
  longer resolves.
- Operators serving `file://` media through a gate must set
  `MOHDEL_MEDIA_ROOTS`.
- `"provider/"` and `"/model"` ids now 400 at ingress.

### Notes

- `rust/thin-gate/src/protocol.rs::TypedError` and PROTOCOL.md §4.4 are
  unchanged: the wire shape was chosen as the survivor of the error merge so
  the frozen contract would not move.

## [0.117.3] — Test: cross-language field-parity guard for the gate protocol / Chore: bump dependencies

### Added

- Cross-language field-parity test (`test/unit/core-conformance.test.js`) that
  reparses every `deny_unknown_fields` struct in `protocol.rs` and asserts the
  JS-side allowlists are exactly the set of wire keys each struct accepts. The
  0.117.2 outage was exactly this drift — the Anthropic adapter emitted a field
  the gate struct lacked — so the guard now fails at the pre-release test gate
  instead of in production.

### Fixed

- Three JS conformance allowlists that had silently drifted from their Rust
  structs: `Auth` (missing `baseUrl`), `AnswerResult` (missing
  `cacheWrite1hInputTokens`, `maxInterFrameMs`, `reasoning`), and `ToolCall`
  (missing `thoughtSignature`). Test-side strictness checks only — no runtime
  behavior change.

### Changed

- `@anthropic-ai/sdk` `^0.112.5` → `^0.115.0`
- `groq-sdk` `^1.3.0` → `^1.4.0`
- `openai` `^6.48.0` → `^6.49.0`
- `lint-staged` (dev) `^17.1.1` → `^17.2.0`

### Notes

- Dependency maintenance plus test-side strictness only; no protocol or
  adapter changes.

## [0.117.2] — Fix: thin-gate rejected the 1h cache-write counter

### Fixed

- The thin-gate `AnswerResult` deserializer (`rust/thin-gate/src/protocol.rs`)
  is `deny_unknown_fields` and had no field for `cacheWrite1hInputTokens`. The
  Anthropic session adapter emits that key on the done result whenever a
  `cache: '1h'` marker produces a 1h cache write (added in 0.114.0). The gate
  therefore rejected every such done event as a "session emitted non-Event
  line", terminating the whole call. This surfaced in production once callers
  began setting 1h TTL markers on chat prefixes: warm-cache turns failed hard.
- `AnswerResult` now carries `cacheWrite1hInputTokens` (optional, serialized
  only when present). Cost is unaffected — it is resolved session-side and
  already prices the 1h tier; the gate only needed to accept the counter.

### Changed

- `@anthropic-ai/sdk` `^0.112.2` → `^0.112.5`
- `@google/genai` `^2.12.0` → `^2.13.0`
- `@opentelemetry/exporter-trace-otlp-grpc` `^0.220.0` → `^0.221.0`
- `@opentelemetry/sdk-node` `^0.220.0` → `^0.221.0`
- `lint-staged` `^17.0.8` → `^17.1.1` (dev)

### Notes

- No behavior change for callers not using 1h cache markers: the field is
  absent from those results exactly as before.

## [0.117.1] — Chore: bump provider SDK dependencies

### Changed

- `@anthropic-ai/sdk` `^0.110.0` → `^0.112.2`
- `@cerebras/cerebras_cloud_sdk` `^1.61.1` → `^1.91.0`
- `@google/genai` `^2.11.0` → `^2.12.0`
- `openai` `^6.46.0` → `^6.48.0`

### Notes

- Dependency maintenance only; no adapter or protocol changes.

## [0.117.0] — Feat: Anthropic conversation-prefix caching

### Added

- A `cache: '5m' | '1h'` marker on any non-system message part now opts the
  conversation into prefix caching on the Anthropic adapter. Two
  `cache_control` breakpoints are placed: one on the last content block (so
  the next request's prefix covers the whole conversation) and one at the
  last stable milestone position (block indices ≡ 15 mod 16), which keeps a
  readable entry within Anthropic's 20-block cache lookback even when a
  single request appends a large batch of blocks. Replayed history then
  bills at the cache-read rate instead of full input price on every call.
  The marker field was already part of the wire protocol
  (`MessagePart::Text.cache`); providers with automatic caching ignore it.

### Fixed

- Anthropic requests now enforce the provider's 4-breakpoint cap. Over-cap
  system breakpoints are dropped middle-first (the first and last survive
  longest), instead of letting a 5-marker system prompt fail the request
  with a 400. Dropping a breakpoint never changes prompt content — only
  cache eligibility.

### Notes

- `envelope.cache` stays a boolean (the thin-gate protocol types it
  `Option<bool>`); the per-part marker carries the TTL.
- Callers decide when to tag: mark only conversations whose history will be
  replayed — a tagged single-shot call pays the cache-write premium with
  nothing ever reading it back.

## [0.116.1] — Fix: publish workflow pins npm 11

### Fixed

- The publish workflow upgraded npm with `npm install -g npm@latest`; npm
  12.0.0 (2026-07-08) installs without `libnpmpublish`'s `sigstore` dependency,
  so `npm publish --provenance` fails with `MODULE_NOT_FOUND`. Pinned to
  `npm@11` (trusted publishing needs ≥ 11.5.1). Revisit when npm 12.x fixes
  its bundle manifest.

### Notes

- v0.116.0 never reached the registry (its publish job hit the bug above);
  0.116.1 is the first published release carrying the 0.116.0 changes.

## [0.116.0] — Feat: OpenAI cache-write billing (GPT-5.6) / Chore: bump openai SDK

### Added

- The OpenAI Responses adapter reads `usage.input_tokens_details.cache_write_tokens`
  (new on GPT-5.6 models, which bill cache writes at 1.25× the input rate) and
  reports it as `cacheWriteInputTokens` on the AnswerResult. Like `cached_tokens`,
  the write count is a subset of `input_tokens`; the adapter subtracts both into
  mohdel's additive convention so regular input, cache reads, and cache writes
  each price at their own catalog rate (`inputPrice` / `cacheReadPrice` /
  `cacheWritePrice`). No pricing-engine change — `cacheWritePrice` support
  already existed for the Anthropic path, including tiered `{">N", default}`
  rates.
- Requests to the `openai` provider now send `prompt_cache_key`, set to the
  envelope `identifier` (the same value as `safety_identifier`). GPT-5.6
  requires it for reliable prefix matching on implicit and explicit caching;
  earlier models accept it harmlessly.

### Changed

- `openai` `^6.45.0` → `^6.46.0`. Brings the `cache_write_tokens` usage types
  and fixes the streaming crash on the server's new `keepalive` event
  (`OpenAIError: Unhandled response stream event`), which killed in-flight
  calls whose reasoning pauses exceeded OpenAI's keepalive threshold.

### Notes

- Explicit cache breakpoints (`prompt_cache_breakpoint`,
  `prompt_cache_options.mode: 'explicit'`) are not sent yet. GPT-5.6 implicit
  caching applies; writes are billed either way, and this release accounts for
  them.
- Cache-key granularity is per-user (`identifier`), not per-conversation. A
  session-scoped key needs a new envelope field and is deferred.

## [0.115.0] — Fix: NDJSON stdin framing is `\n`-only / Chore: bump dependencies

### Fixed

- The session stdin reader used Node's `readline`, which treats U+2028/U+2029
  (Unicode line/paragraph separators) as line terminators. Both are legal
  *unescaped* inside JSON strings — `JSON.stringify` and `serde_json` emit them
  raw — so a CallEnvelope whose prompt contained a pasted separator arrived as
  several fragments, none valid JSON. The driver skipped them silently and the
  supervisor waited on a stream that would never produce a terminal event,
  camping its pool slot until an external timeout. The driver now splits stdin
  on `\n` bytes only; separator code points inside strings are ordinary payload.

### Changed

- A stdin line that is not valid JSON is now terminal instead of
  skip-and-continue: message boundaries can no longer be trusted once framing
  is broken. The session writes a terminal `error` event
  (`type: "SESSION_STDIN_MALFORMED"`) so the supervisor releases the call
  immediately, then exits non-zero.
- `@anthropic-ai/sdk` `^0.105.0` → `^0.110.0`.
- `@google/genai` `^2.9.0` → `^2.10.0`.
- `groq-sdk` `^1.2.1` → `^1.3.0`.
- `openai` `^6.44.0` → `^6.45.0`.
- `@clack/prompts` (optional) `^1.5.1` → `^1.7.0`.
- `@opentelemetry/exporter-trace-otlp-grpc` / `@opentelemetry/sdk-node`
  (optional) `^0.219.0` → `^0.220.0`.
- `lint-staged` (dev) `^17.0.7` → `^17.0.8`.
- `release-it` (dev) `^20.2.0` → `^20.2.1`.
- `vitest` (dev) `^4.1.9` → `^4.1.10`.

### Documentation

- PROTOCOL.md §2 framing now mandates `\n` (0x0A) as the only line delimiter,
  names the U+2028/U+2029 trap (Node `readline` is not a conforming reader),
  and specifies the terminal-error-and-exit contract for malformed lines. Both
  added to the compliance checklist.

### Notes

- Behavior change for supervisors that relied on malformed lines being skipped:
  the session now fails the call and exits. thin-gate's existing supervision
  (terminal error → release slot; EOF → discard + respawn) handles this
  without changes.

## [0.114.1] — Docs: cache pricing fields / Chore: bump dependencies

### Changed

- `@anthropic-ai/sdk` `^0.104.1` → `^0.105.0`.
- `@google/genai` `^2.8.0` → `^2.9.0`.
- `openai` `^6.42.0` → `^6.44.0`.
- `vitest` (dev) `^4.1.8` → `^4.1.9`.

No code changes.

### Documentation

- Document the `cacheWrite1hInputTokens` field on the `DoneEvent` result (the
  1h-TTL subset of `cacheWriteInputTokens`, billed at `cacheWrite1hPrice`).
- Document the `cacheWrite1hPrice` catalog field, and correct the prompt-caching
  note: Anthropic uses explicit breakpoints while OpenAI and Gemini cache
  implicitly with read counts surfaced automatically. No code changes.

## [0.114.0] — Fix: Anthropic 1h and Gemini implicit cache cost accounting

### Added

- Anthropic per-TTL cache-creation accounting. The streaming adapter now reads
  `usage.cache_creation.ephemeral_1h_input_tokens` and exposes
  `cacheWrite1hInputTokens` on the done result. `computeCost` prices the 1h write
  tier via a new optional spec field `cacheWrite1hPrice`; the 5m portion
  (`cacheWriteInputTokens − cacheWrite1hInputTokens`) stays on `cacheWritePrice`.
  A request may mix TTLs, so both tiers can be non-zero.
- Gemini implicit-cache read accounting. The adapter now reads
  `usageMetadata.cachedContentTokenCount` and exposes `cacheReadInputTokens` on
  the done result, priced via the existing `cacheReadPrice` spec field.

### Fixed

- Gemini cached input was billed at full `inputPrice`. Cached tokens are now
  subtracted from `inputTokens` (subset convention, matching the OpenAI adapter)
  and priced at `cacheReadPrice`, so reported `cost` reflects the provider's
  cached-token discount.
- Anthropic 1h cache writes were priced at the 5m rate. They now bill at
  `cacheWrite1hPrice` when the spec provides it.

### Notes

- Additive and backward-compatible. When `cacheWrite1hInputTokens` is absent or a
  spec omits `cacheWrite1hPrice`, the whole write bills at `cacheWritePrice` —
  prior behaviour. Realizing the corrected rates requires catalog specs to carry
  `cacheWrite1hPrice` (Anthropic) and `cacheReadPrice` (Gemini); without them the
  new fields are observability-only and cost is unchanged.

## [0.113.0] — Feature: Qwen Cloud provider

### Added

- Qwen Cloud provider (`qwen/*`) — OpenAI-compatible chat completions
  against Alibaba's international DashScope endpoint
  (`dashscope-intl.aliyuncs.com/compatible-mode/v1`), key via
  `QWEN_API_SK`. Thinking is wired through the new `qwen`
  reasoning-field variant: `outputEffort` maps to `enable_thinking`
  plus a numeric `thinking_budget` from the spec's
  `thinkingEffortLevels`; Qwen hybrid models think by default, so
  effort `none` sends an explicit `enable_thinking: false`.

## [0.112.0] — Feature: `/v1/transcription` on thin-gate

### Added

- `POST /v1/transcription` on thin-gate's data plane — closes the
  "factory path only" gap from 0.111.0; the cross-process client can
  now transcribe via `callTranscription(envelope, { socketPath })`
  from `mohdel/client`. Same one-shot shape as `/v1/image`: plain JSON
  response, no streaming, no enforcer, `op: "transcription"` driver
  tag. `audio.fileUri` is `file://` (gate sessions read the path —
  requires a shared filesystem with the caller) or `data:` (inline,
  subject to the 16 MiB body cap). Rust protocol structs
  (`TranscriptionEnvelope` / `TranscriptionResult`), conformance
  fixtures, and an end-to-end session-dispatch test included; the
  image and transcription paths now share one one-shot pool-exchange
  helper in the gate.

## [0.111.0] — Feature: speech-to-text via `transcribe()`

### Added

- Speech-to-text via `model.transcribe(audio, options?)` — a third call
  primitive alongside `answer()` and `image()`. One shared adapter posts
  multipart audio to the OpenAI-compatible `/audio/transcriptions`
  endpoint; registered for `groq`, `mistral`, and `openai`. Audio comes
  from a `file://` or `data:` URI; result is
  `{ status, text, language, durationSeconds, cost, timestamps }`.
  Factory path only for now — thin-gate has no `/v1/transcription` route
  yet, so the cross-process client cannot transcribe.
- `mo transcribe <model> <audio-file>` CLI command — MIME type guessed
  from the extension (`--mime` to override), `--language` / `--prompt`
  hints, `--json` output, duration/cost summary on stderr.
- Catalog support for transcription entries: `type: "transcription"`,
  `transcriptionPrice` (USD per audio minute), `"audio"` in
  `inputFormat`. Cost is duration × per-minute price when the provider
  reports duration, with a token-pricing fallback for OpenAI's
  `gpt-4o-*-transcribe` models (`computeTranscriptionCost` in
  `_pricing.js`).
- Live transcription smoke tests (`test/live/transcription.live.test.js`),
  key-gated per provider; the audio fixture is a generated sine WAV.

### Changed

- README repositioned around the gateway wedge new "How it compares"
  section (LiteLLM, Vercel AI SDK, OpenRouter, raw SDKs).
- `package.json` description rewritten in searcher vocabulary:
  LiteLLM-style unified API, provider names spelled out, per-call USD
  cost tracking, speech-to-text.

## [0.110.0] — Fix: preserve `toolCallId` for `tool`-role messages

### Fixed

- `toEnvelopePrompt` now accepts the `tool` role in addition to `tool_result`
  in the factory `{ system?, messages }` prompt shape, carrying `toolCallId`
  and `toolName` onto the envelope.

## [0.109.0] — Maintenance: dependency bumps

### Changed

- `fireworks` provider definition moved into alphabetical position in
  `providers.js` (between `cerebras` and `gemini`). No behavioral change —
  the provider config is byte-for-byte identical, only its source order
  changed.
- `@anthropic-ai/sdk` ^0.98.0 → ^0.100.1
- `@google/genai` ^2.6.0 → ^2.8.0
- `groq-sdk` ^1.2.0 → ^1.2.1
- `openai` ^6.39.0 → ^6.42.0
- `@clack/prompts` ^1.4.0 → ^1.5.1 (optional)
- `lint-staged` ^17.0.5 → ^17.0.7 (dev)
- `release-it` ^20.0.1 → ^20.2.0 (dev)
- `vitest` ^4.1.7 → ^4.1.8 (dev)

## [0.108.2] — Sync `package-lock.json` and `Cargo.lock` in release flow

The release-it `after:bump` hook now refreshes both `package-lock.json`
and `Cargo.lock` after the version bump, so CI's `npm ci` succeeds and
the working tree stays clean through the cargo build. No runtime changes.

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
