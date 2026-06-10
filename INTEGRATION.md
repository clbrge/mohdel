# Mohdel Library Integration Guide

Two integration paths. **The client is the primary integration for production**: your app speaks HTTP-over-unix-socket to a running `thin-gate` that owns the session pool, enforcement, and metrics. The factory is an in-process shortcut for the narrow case where you don't need a gate — CLI tools (`mo ask`), scripts, tests, single-process services.

For CLI + installation see [README.md](README.md). For design rationale see [ARCHITECTURE.md](ARCHITECTURE.md). For logging see [LOGGING.md](LOGGING.md). For the wire protocol see [PROTOCOL.md](PROTOCOL.md).

## Choosing a path

| | **Client (cross-process)** — recommended default | **Factory (in-process)** — shortcut |
|---|---|---|
| Import | `import { call } from 'mohdel/client'` | `import mohdel from 'mohdel'` |
| Runs in | Remote via unix socket to thin-gate | Caller process (in-process `run()`) |
| Caller language | Any HTTP client | Node only |
| Fault isolation | Gate isolates crashes; pool respawns | Shared process (adapter crash kills caller) |
| Cross-process quota | Shared across all callers | Private per caller |
| Overhead | ~3ms / call (gate IPC) | ~0.5ms / call |
| When to use | **Default.** Multi-tenant, multi-process, non-Node callers, or any shape where fault isolation matters. | CLI, scripts, tests, single-process services where a subprocess is overkill. |

Both paths drive the same session adapters with the same wire types and the same event stream. The factory is literally "the client path minus the IPC hop" — switching later is a configuration change, not a rewrite.

---

# Client (cross-process) — primary production integration

For callers that want fault isolation, a cross-process shared pool, or non-Node language bindings.

```
┌────────────┐  HTTP over unix socket  ┌─────────────┐  stdin/stdout  ┌──────────┐
│  your app  │ ──────────────────────► │  thin-gate  │ ─────────────► │  session │
└────────────┘  (POST /v1/call)        └─────────────┘  (NDJSON)      └──────────┘
```

## Running thin-gate

```bash
# Release binary (recommended)
cargo build --release
./target/release/mohdel-thin-gate \
  /tmp/mohdel-data.sock \
  /tmp/mohdel-admin.sock \
  ./js/session/bin.js

# Or configure via TOML at ~/.config/mohdel/thin-gate.toml:
#   [sockets]
#   data  = "/run/mohdel/data.sock"
#   admin = "/run/mohdel/admin.sock"
#
#   [session]
#   command   = "node"
#   args      = ["/opt/mohdel/js/session/bin.js"]
#   pool_size = 4
./target/release/mohdel-thin-gate
```

Env overrides:
- `MOHDEL_THIN_GATE_CONFIG` — explicit path to TOML config
- `MOHDEL_SESSION_BIN` — session entrypoint (overrides config)
- `MOHDEL_SESSION_POOL_SIZE` — pre-warmed subprocess count (default 2)
- `MOHDEL_LOG_LEVEL` — `trace|debug|info|warn|error|silent` (session stderr)
- `MOHDEL_VERBOSITY` — 0/1/2 per LOGGING.md
- `OTEL_EXPORTER_OTLP_ENDPOINT` — enables span + metric export to your OTel collector

Without a session-bin configured, the data plane returns a synthetic event sequence (demo mode — useful for health-checking the HTTP layer without Node).

## Calling from JavaScript

```js
import { call } from 'mohdel/client'

const envelope = {
  callId: 'c-1',
  authId: 'tenant-42',
  auth: { key: process.env.ANTHROPIC_API_SK },
  model: 'anthropic/claude-haiku-4-5',
  prompt: 'Say hi.',
  outputBudget: 100,
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01'
}

for await (const ev of call(envelope, {
  socketPath: '/tmp/mohdel-data.sock',
  signal: controller.signal   // optional AbortSignal
})) {
  if (ev.type === 'delta') {
    process.stdout.write(ev.delta.delta)
  } else if (ev.type === 'done') {
    console.log('\n→', ev.result.status, 'cost:', ev.result.cost)
  } else if (ev.type === 'error') {
    console.error('error:', ev.error.type, ev.error.message)
  }
}
```

`call` opens a unix socket, POSTs the envelope as JSON, and parses the response body as NDJSON events.

`AbortSignal` forwards: the client closes the HTTP connection, the gate infers cancel, and forwards a `{op:"cancel", callId}` control message to the session. Session returns a `done` terminal with `warning: 'cancelled'`; the pool reuses the session.

## Envelope shape

Required fields:

```js
{
  callId:   'c-1',                       // unique per call
  authId:   'tenant-42',                 // quota-scoping identity
  auth:     { key: '<provider-api-key>' },
  model:    'anthropic/claude-haiku-4-5',  // full id; the gate splits the provider prefix
  prompt:   'string or Message[]'
}
```

Optional fields:

```js
{
  traceparent:       '00-<traceId>-<spanId>-01',   // W3C trace context
  baggage:           'key=value',                   // W3C baggage
  outputBudget:      1024,
  outputType:        'json',                        // 'text' | 'json'
  outputStyle:       'coding',                      // 'chat'|'coding'|'analysis'|'translation'|'creative'
  outputEffort:      'high',                        // per-model effort level
  images:            [{ fileUri, mimeType }],
  videos:            [{ fileUri, mimeType }],
  cache:             true,
  tools:             [{ name, description, parameters }],
  toolChoice:        'auto',                        // 'auto'|'required'|'none'|'<name>'
  parallelToolCalls: false,
  identifier:        'user-abc',
  providerOptions: {
    openrouter: {
      order: ['anthropic', 'openai'],
      allow: [...],
      deny:  [...]
    }
  }
}
```

Unknown fields are **rejected at parse time** by the gate (`deny_unknown_fields`). See [ARCHITECTURE.md](ARCHITECTURE.md#enforcement-of-the-freeze).

## Structured prompts

Use an array of `Message` when you have system / user / assistant history:

```js
const prompt = [
  { role: 'system', content: 'Be terse.' },
  { role: 'user', content: 'Hostname?' },
  {
    role: 'assistant',
    content: 'Let me check.',
    toolCalls: [{ id: 'c1', name: 'get_hostname', arguments: {} }]
  },
  { role: 'tool', toolCallId: 'c1', name: 'get_hostname', content: 'dev-box' }
]
```

Message shape:
- `role`: `'system'` | `'user'` | `'assistant'` | `'tool'`
- `content`: `string` or `Array<{ type: 'text' | 'reasoning', text: string }>`
- `toolCallId`: present on `tool` role — identifies which assistant tool call this responds to
- `name`: optional tool name on `tool` role
- `toolCalls`: present on `assistant` role when the model invoked tools in that turn

## Events

Three variants:

```js
// Streaming content (message or function_call deltas)
{ type: 'delta', delta: { type: 'message', delta: 'Hello' } }
{ type: 'delta', delta: { type: 'function_call', delta: '{"x":' } }

// Terminal success
{
  type: 'done',
  result: {
    status: 'completed' | 'tool_use' | 'incomplete',
    output: string | null,
    inputTokens, outputTokens, thinkingTokens,
    cost,
    timestamps: { start, first, end },
    warning?: 'insufficientOutputBudget' | 'cancelled',
    toolCalls?: [{ id, name, arguments }]
  }
}

// Terminal error
{
  type: 'error',
  error: {
    message: string,
    detail?: string,
    severity: 'trace'|'debug'|'info'|'warn'|'error'|'fatal',
    retryable: boolean,
    type: string   // AUTH_INVALID, RATE_LIMIT, PROVIDER_COOLDOWN, SESSION_DIED, ...
  }
}
```

Exactly one terminal event per call. Caller iterates until `done` or `error`.

## Cross-language callers

The gate's wire protocol is language-agnostic. Any client that can POST to a unix socket and parse NDJSON works:

```bash
# curl (bash)
curl --unix-socket /tmp/mohdel-data.sock \
  -H 'Content-Type: application/json' \
  -d '{"callId":"c1","authId":"a1","auth":{"key":"sk-..."},"model":"anthropic/claude-haiku-4-5","prompt":"hi"}' \
  http://unix/v1/call
```

```python
# python
import httpx
with httpx.stream('POST', 'http://unix/v1/call',
                  transport=httpx.HTTPTransport(uds='/tmp/mohdel-data.sock'),
                  json=envelope) as r:
    for line in r.iter_lines():
        if not line: continue
        event = json.loads(line)
        # ...
```

The Python / Go / curl callers ship nothing mohdel-related in their bundles — the gate does all the provider SDK work.

## Health + metrics

```bash
curl --unix-socket /tmp/mohdel-admin.sock http://unix/v1/health
# {"status":"ok","version":"0.90.0","uptime_ms":12345}
```

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the gate pushes OTLP metrics alongside session spans. Operators see `mohdel.sessions.alive`, `mohdel.calls{provider,status}`, `mohdel.call.duration_ms`, `mohdel.cooldown.rejections`, and `mohdel.quota.rejections` in the same collector as their trace data.
---

# Factory (in-process) — shortcut for single-process consumers

The public surface:

```
mohdel()                       ← factory: load env, curated catalog, build logger
  .use('provider/model')       ← resolve alias, get a model proxy
    .answer(prompt, options)   ← run inference, return AnswerResult
    .image(prompt, options)    ← generate an image (OpenAI, Novita)
    .transcribe(audio, options)← speech → text (Groq, Mistral, OpenAI)
```

Under the hood, `.answer()` delegates to `runAnswer()` in `js/factory/bridge.js`, which drives the session adapter directly in-process (no gate, no subprocess). You don't see any of that — the API is identical.

## Initialization

```js
import mohdel from 'mohdel'

const mo = await mohdel()
```

The factory reads `~/.config/mohdel/environment` and the curated catalog (`~/.config/mohdel/curated.json`). Customize:

```js
const mo = await mohdel({
  // Logger with { trace, debug, info, warn, error, fatal }.
  // Pino, winston, bunyan, or any class-based logger works natively.
  logger: pino({ level: 'debug' }),

  // Verbosity tier (0/1/2). Defaults to env MOHDEL_VERBOSITY or 1.
  //   0 = anomalies only (failures, throttling, deprecations)
  //   1 = + per-call debug start/done summaries
  //   2 = + request previews and tool-call expansion at trace level
  verbosity: 1,

  // Per-call lifecycle hooks (fire-and-forget; errors caught internally)
  onSuccess (result, { model, provider }) { /* ... */ },
  onFailure (err,    { model, provider }) { /* ... */ },

  // Cooldown tuning (applied via the session cooldown tracker)
  cooldownThreshold: 3,     // consecutive failures before cooldown
  cooldownDuration: 60000   // cooldown duration (ms)
})
```

When `logger` is omitted, mohdel is silent. Be explicit with `{ logger: silent }` (imported from `mohdel`) if you want to document that choice.

See [LOGGING.md](LOGGING.md) for log-level semantics, prefix conventions, and OTel span correlation via pino's `span` serializer.

## Selecting a model

```js
const gpt = mo.use('openai/gpt-5-mini')
const claude = mo.use('anthropic/claude-sonnet-4-6')
```

Alias resolution supports:
- Full ID: `'anthropic/claude-sonnet-4-6'`
- Model name (when unique across providers): `'gpt-5-mini'`
- Base name: `'claude-sonnet-4'` (strips date suffix, if unambiguous)
- Provider-qualified base: `'anthropic/claude-sonnet-4'`
- Explicit `aliases` from the curated entry

Throws on missing / ambiguous.

### `:outputEffort` suffix

Lock thinking effort at resolution time:

```js
const m = mo.use('claude-opus-4-7:low')  // model = claude-opus-4-7, effort = low
```

Valid levels: `none`, `low`, `medium`, `high`. Call-time `outputEffort` still wins if you pass it.

### Model proxy

| Property / Method | Returns | Description |
|---|---|---|
| `model.id` | `string` | Resolved canonical ID |
| `model.label` | `string` | Human-readable display name |
| `model.supportsTools` | `boolean` | Whether this model accepts tools |
| `model.info()` | `object` | Full curated spec (sync) |
| `model.answer(prompt, options?)` | `Promise<AnswerResult>` | Run inference |
| `model.image(prompt, options?)` | `Promise<ImageResult>` | Generate image (openai, novita) |
| `model.transcribe(audio, options?)` | `Promise<TranscriptionResult>` | Speech → text (groq, mistral, openai) |
| `model.addTag(tag)` | `Promise<string[]>` | Tag management, persisted |
| `model.removeTag(tag)` | `Promise<string[]>` | (alias: `delTag`) |
| `model.listTags()` | `string[]` | (alias: `tags`) |
| `model.setRateLimit({ rpm, tpm })` | `Promise` | Persist per-model rate limit to curated.json |

## answer() options

```js
const response = await model.answer(prompt, {
  // --- Output control ---
  outputBudget: 2048,         // max output tokens (clamped to model's outputTokenLimit)
  outputType: 'json',         // 'text' (default) | 'json'
  outputStyle: 'chat',        // 'chat' | 'coding' | 'analysis' | 'translation' | 'creative'
                              // currently drives GPT-5 verbosity

  // --- Thinking / reasoning ---
  outputEffort: 'high',       // 'none' | 'low' | 'medium' | 'high' (per-model keys;
                              //   validated at runtime against thinkingEffortLevels)

  // --- Multi-modal input ---
  images: [{ fileUri, mimeType }],   // file:// | https:// | data: URIs
  videos: [{ fileUri, mimeType }],   // Gemini only
  cache: true,                        // upload large files to the provider cache (Gemini)

  // --- Tools ---
  tools: [{ name, description, parameters }],   // unified JSON-Schema shape
  toolChoice: 'auto',                            // 'auto' | 'required' | 'none' | '<name>'
  parallelToolCalls: false,                      // serialize tool calls

  // --- Streaming ---
  realtimeHandler: (chunk) => {},    // chunk = { type: 'message'|'function_call', delta: string }
  bufferOpts: { maxChars: 250, maxMs: 10_000 },  // realtimeHandler flush tuning

  // --- Tracing ---
  traceparent: '00-<traceId>-<spanId>-01',   // W3C trace context → session span parent

  // --- Identification ---
  identifier: 'user-abc',     // per-user ID; adapter maps to provider-specific field:
                              //   openai → safety_identifier
                              //   other openai-compat → user
                              //   anthropic → metadata.user_id

  // --- OpenRouter routing (ignored by other providers) ---
  providerOrder: ['anthropic', 'openai'],
  providerAllow: ['anthropic'],
  providerDeny:  ['azure']
})
```

**Not supported** (see bridge docstring for full table):
- `parentSpan` — pass `traceparent` instead (W3C string is transport-friendly)
- `maybeThrowHandler` — no factory-side validation hook
- `configuration.baseURL` / `defaultHeaders` / etc. — only `configuration.apiKey` is threaded through; others throw `CONFIGURATION_UNSUPPORTED`

Prompt shape accepted by `.answer()`:

```js
// Plain string
model.answer('What is 2+2?')

// Message array (canonical)
model.answer([
  { role: 'system', content: 'Be terse.' },
  { role: 'user', content: 'What is 2+2?' }
])

// Structured shape — automatically normalized by the bridge
model.answer({
  system: 'Be terse.',
  messages: [
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: 'Add 3 to that.' }
  ]
})
```

Tool histories via legacy shape:

```js
model.answer({
  system: 'Summarize the tool outputs.',
  messages: [
    { role: 'user', content: 'Hostname?' },
    {
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [{ id: 'c1', name: 'get_hostname', arguments: {} }]
    },
    { role: 'tool_result', toolCallId: 'c1', content: 'dev-box', toolName: 'get_hostname' }
  ]
})
```

The bridge maps `tool_result` → `tool` role and preserves `assistant.toolCalls` onto the envelope `Message.toolCalls` field. Adapters emit the provider-native tool_use / function_call / functionCall representation downstream.

## AnswerResult

```js
{
  status: 'completed',              // 'completed' | 'tool_use' | 'incomplete'
  output: 'Generated text',         // string | null (null on tool_use with no prelude)
  inputTokens: 42,
  outputTokens: 128,                // visible output only (excludes thinking)
  thinkingTokens: 0,                // reasoning/thinking tokens consumed
  cost: 0.00042,                    // USD, computed from curated pricing
  timestamps: {
    start: '123456789',             // process.hrtime.bigint() → string (nanoseconds)
    first: '123456800',             // time to first token
    end:   '123457000'              // completion
  },
  warning: undefined,               // 'insufficientOutputBudget' on budget truncation;
                                    // 'cancelled' when caller-side abort completed mid-stream
  toolCalls: undefined              // Array<{ id, name, arguments }> when status === 'tool_use'
}
```

Branch on `status`, not on provider-specific finish reasons. Every adapter normalizes to the same three terminal states.

## Tool use

```js
const response = await model.answer('What is the weather in Paris?', {
  tools: [{
    name: 'get_weather',
    description: 'Get current weather for a location.',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
      },
      required: ['location']
    }
  }],
  toolChoice: 'auto'
})

if (response.status === 'tool_use') {
  for (const call of response.toolCalls) {
    const result = await executeTool(call.name, call.arguments)
    // Re-call with the result in history — see structured prompt example above.
  }
}
```

`toolChoice` values: `'auto'`, `'required'`, `'none'`, or a tool name string (forces that tool). `parallelToolCalls: false` serializes calls (maps to provider-specific field; Gemini ignores).

Tool support varies by provider — check `model.supportsTools` at runtime. Groq's shared chat-completions path passes tools through; actual acceptance depends on the Groq model.

## Streaming

Pass a `realtimeHandler` to receive buffered deltas:

```js
const response = await model.answer(prompt, {
  realtimeHandler: (chunk) => {
    // chunk = { type: 'message' | 'function_call', delta: string }
    process.stdout.write(chunk.delta)
  }
})
// `response` still resolves to the full AnswerResult after streaming completes.
```

The buffer flushes when it reaches 250 chars or 10 seconds elapse; override with `bufferOpts: { maxChars, maxMs }`. Handler receives `{type, delta}` objects.

All adapters emit delta events. The factory bridge pipes them into the handler in buffered form; the client path hands them through raw.

## Vision

```js
const response = await model.answer('Describe this image.', {
  images: [{ fileUri: '/absolute/path/to/image.jpg', mimeType: 'image/jpeg' }]
})
```

URI schemes:
- `file:///absolute/path` — read from disk, base64-encoded
- `data:image/png;base64,...` — inline
- `https://...` — passed through for the provider to fetch

Supported by: Anthropic, OpenAI, Gemini, xAI, Cerebras, OpenRouter (model-dependent).

## Videos (Gemini)

```js
const response = await model.answer('Summarize this clip.', {
  videos: [{ fileUri: '/path/to/clip.mp4', mimeType: 'video/mp4' }],
  cache: true   // upload and cache; large files auto-upload regardless
})
```

Files under 20 MB are inlined as base64. Larger files (or any file with `cache: true`) upload via Gemini's file API and poll until `ACTIVE`. The result URI is cached in `~/.cache/mohdel/uploaded-files.json` keyed by content hash + mtime + path, so repeat uploads of the same file skip the network round-trip. Edits to the file (mtime change) force a re-upload.

## Extended thinking

```js
const response = await model.answer('Prove the Pythagorean theorem.', {
  outputBudget: 2048,
  outputEffort: 'high'
})

console.log(response.thinkingTokens)   // reasoning tokens consumed
console.log(response.output)            // final answer
```

Effort levels are per-model — look at the curated spec's `thinkingEffortLevels`. Typical values are `low`, `medium`, `high`, but Anthropic Opus also accepts `minimal` and `max`. Adapters translate to the provider-native shape:

- **Anthropic** — `output_config.effort` (adaptive mode)
- **OpenAI o-series** — `reasoning.effort` + budget headroom added to `max_output_tokens`
- **Gemini 3.x** — `thinkingConfig.thinkingLevel`
- **Gemini 2.x** — `thinkingConfig.thinkingBudget`
- **Cerebras** — `reasoning_effort` (or `disable_reasoning` for zai models)
- **Fireworks** — `reasoning_effort`

`outputEffort` defaults from `spec.defaultThinkingEffort` when the model supports thinking and no explicit effort is passed.

## Error handling

Errors surface as `MohdelError` with typed `message`, `detail`, `severity`, `retryable`:

```js
import { MohdelError } from 'mohdel/errors'

try {
  const response = await model.answer(prompt)
} catch (err) {
  if (err instanceof MohdelError) {
    if (err.message === 'PROVIDER_COOLDOWN') {
      // backed off after consecutive failures; err.retryable === true
    } else if (err.message === 'AUTH_INVALID') {
      // 401/403; err.retryable === false
    } else if (err.retryable) {
      // transient — network error, 5xx, rate limit
    }
  }
}
```

Common error types: `AUTH_INVALID`, `RATE_LIMIT`, `QUOTA_EXHAUSTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `CONTEXT_OVERFLOW`, `CONTENT_BLOCKED`, `NET_ERROR`, `PROVIDER_COOLDOWN`.

`CONTEXT_OVERFLOW`, `QUOTA_EXHAUSTED`, and `CONTENT_BLOCKED` are non-retryable: same input → same failure. Recover at a higher layer (compact prompt, swap model, surface to user).

See [LOGGING.md](LOGGING.md#what-mohdel-logs-at-each-level) for the severity mapping.

## Image generation

```js
const dalle = mo.use('openai/dall-e-3')
const result = await dalle.image('a red cube on grass', {
  size: '1024x1024'   // provider-specific sizes
})

for (const img of result.images) {
  if (img.url) { /* fetch and save */ }
  if (img.base64) { /* decode and save */ }
}
```

Separate from `.answer()` — images don't stream. Returns `{ status: 'completed', images, seed, timestamps }`. Supported by `openai` (DALL-E) and `novita` (async submit + poll).

## Transcription (voice → text)

```js
const whisper = mo.use('groq/whisper-large-v3-turbo')
const result = await whisper.transcribe(
  { fileUri: 'file:///absolute/path/to/meeting.mp3', mimeType: 'audio/mpeg' },
  {
    language: 'fr',                  // optional ISO-639-1 hint
    prompt: 'Coppersmith, mohdel'    // optional spelling/context hint
  }
)

result.text             // the transcript
result.durationSeconds  // audio length as reported by the provider
result.cost             // USD — transcriptionPrice (per minute) × duration
```

Separate from `.answer()` — transcriptions don't stream. Returns
`{ status: 'completed', text, language, durationSeconds, cost, timestamps }`
(plus `inputTokens`/`outputTokens` for token-billed models). Audio is
uploaded as multipart from a `file://` or `data:` URI — remote `https://`
audio is not fetched; download it yourself first.

Supported by `groq` (Whisper, fastest + free tier), `mistral` (Voxtral),
and `openai` (Whisper, gpt-4o-*-transcribe) — all through the same
OpenAI-compatible `/audio/transcriptions` endpoint. The model entry must
exist in `curated.json` with `type: "transcription"` — see
[docs/CATALOG.md](docs/CATALOG.md#transcription-entries).

Factory path only for now: thin-gate has no `/v1/transcription` route
yet, so the cross-process client cannot transcribe.

## Rate limiting

Limits are per-account, so they live in user config:

```bash
# Provider-level (all models share the budget)
mo rl provider set anthropic 60 100000

# Model-level (overrides provider config for that model)
mo rl set gemini/gemini-2.0-flash 15
```

Mohdel throttles before calls (waits until the next minute bucket) rather than rejecting. On 429 / 5xx / network failure it backs off — three consecutive failures activate `PROVIDER_COOLDOWN` for 60 seconds (tunable via factory options). Auth failures (401/403) trigger cooldown immediately.

When cooling down, `.answer()` throws `MohdelError('PROVIDER_COOLDOWN', { retryable: true })` without a provider round-trip.

## OpenTelemetry

Depends on `@opentelemetry/api`. Mohdel creates one `mohdel.answer` span per call:

- Start: `gen_ai.request.model`, `gen_ai.system`, `gen_ai.request.max_tokens`, `mohdel.output_effort`
- End: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `mohdel.thinking_tokens`, `mohdel.status`, `mohdel.cost`, `mohdel.time_to_first_token_ms`
- On cooldown fast-fail: `mohdel.cooldown: true`

Pass `traceparent` (W3C string) in answer options to parent mohdel's span under the caller's trace. There is no direct-OTel-Span option — serialize your span context to a `traceparent` string instead.

## Storage

| Path | Purpose |
|---|---|
| `~/.config/mohdel/environment` | API keys (`ANTHROPIC_API_SK=…`, `OPENAI_API_SK=…`, …) |
| `~/.config/mohdel/curated.json` | Model catalog (metadata, pricing, rate limits) |
| `~/.config/mohdel/providers.json` | Provider-level rate limits |
| `~/.config/mohdel/default.json` | Default model |
| `~/.cache/mohdel/uploaded-files.json` | Gemini file upload cache |

Paths follow XDG via `env-paths`. Configure through `mo setup <provider>` and the `mo rl` / `mo model` commands.


---

# Testing with the `fake` provider

For deterministic stress tests, benchmarks, and bug reproductions, register `provider: "fake"` with a JSON scenario in `prompt`:

```js
await model.answer(JSON.stringify({ mode: 'volume', tokens: 100 }))
await model.answer(JSON.stringify({ mode: 'slow',   tokens: 20, delayMs: 50 }))
await model.answer(JSON.stringify({ mode: 'error',  type: 'AUTH_INVALID' }))
await model.answer(JSON.stringify({ mode: 'incomplete' }))
await model.answer(JSON.stringify({ mode: 'tool', name: 'f', args: { x: 1 } }))
await model.answer(JSON.stringify({ mode: 'hang' }))          // aborts via AbortSignal
await model.answer(JSON.stringify({ mode: 'crash' }))         // process.exit — isolation demo
await model.answer(JSON.stringify({ mode: 'cancel_after', tokens: 3 }))
```

All modes honor `AbortSignal`. No network, no API key required. Works identically through either integration path.

See `bench/bench.js` (throughput) and `bench/isolation.js` (fault isolation demo) for reference usage.

---

# See also

- [README.md](README.md) — install, CLI, configuration
- [ARCHITECTURE.md](ARCHITECTURE.md) — design rationale, three-plane model, freeze contract
- [PROTOCOL.md](PROTOCOL.md) — authoritative wire spec for implementing a session in another language
- [LOGGING.md](LOGGING.md) — log levels, prefixes, pino / OTel integration
- `bench/` — throughput and isolation benchmarks
- `test/conformance/` — JS↔Rust fixtures enforcing the frozen wire shape
