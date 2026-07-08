# Mohdel Wire Protocol

**Version:** 0.90. Frozen on release; additive extensions only.
**Audience:** implementors of mohdel session subprocesses and
cross-language callers hitting `thin-gate` directly.
**Authority:** JS types in `js/core/*.js` and Rust types in
`rust/thin-gate/src/protocol.rs` are the ground truth; this doc
describes the wire contract they encode.

Key words **MUST**, **MUST NOT**, **SHOULD**, **MAY** follow
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

---

## 1. Principle

**Wire shape = flat `answer(prompt, options)` surface + minimum
transport metadata.** The envelope is the answer options flat; the
terminal `done` event carries the full `AnswerResult`. Transport
metadata is limited to what a subprocess boundary actually needs:
`callId` (correlate), `authId` (quota-scope), `auth.key` (provider
API key), `traceparent` (W3C trace context), and a cancel control
message.

## 2. Transport

A session is a subprocess spawned by a supervisor (typically
thin-gate). The supervisor writes envelopes and control messages to
stdin; the session writes events to stdout.

- **Encoding:** UTF-8. LF line endings on output. CRLF accepted on
  input.
- **Framing:** one JSON document per line (NDJSON). Empty lines on
  input are ignored; output MUST NOT produce empty lines.
  Lines are delimited by `\n` (0x0A) **only**. Readers MUST NOT treat
  any other code point as a line terminator — in particular
  U+2028/U+2029, which JSON serializers (JSON.stringify, serde_json)
  legally emit *unescaped* inside strings, so they are ordinary
  payload bytes. Node's `readline` splits on U+2028/U+2029 and is
  therefore not a conforming reader; use a byte-level `\n` splitter.
- **Malformed lines:** a stdin line that is not valid JSON means the
  framing itself is broken; recovery is not possible because message
  boundaries can no longer be trusted. The session MUST emit a
  terminal `error` event (`type: "SESSION_STDIN_MALFORMED"`) and exit
  non-zero rather than skip the line and wait silently.
- **Field names:** camelCase.
- **Stderr:** diagnostics only; no protocol semantics.

## 3. Stdin

Two message types, discriminated by presence of the `op` field.

### 3.1 Envelope (no `op`)

```ts
interface CallEnvelope {
  // --- Transport metadata ---
  callId:       string            // unique per call
  authId:       string            // quota-scoping key for thin-gate
  auth:         { key: string }   // provider API key
  traceparent?: string            // W3C trace context
  baggage?:     string            // W3C baggage

  // --- Routing ---
  model:        string             // full mohdel id `"<provider>/<bare>"`,
                                   // with optional `:<effort>` suffix
                                   // (e.g. `"anthropic/claude-opus-4:max"`).
                                   // Same shape as `mo model list` and
                                   // cs-core's catalog keys. The gate
                                   // splits the provider prefix server-
                                   // side (see §3.1.1). Callers MUST NOT
                                   // send a separate `provider` field —
                                   // it is rejected by `deny_unknown_fields`.

  // --- answer() first arg ---
  prompt:       string | Message[]

  // --- answer options (flat) ---
  outputBudget?:      number
  outputType?:        'text' | 'json'
  outputStyle?:       'chat' | 'coding' | 'analysis' | 'translation' | 'creative'
  outputEffort?:      string        // per-model; validated against
                                    // the model's thinkingEffortLevels.
                                    // Redundant with the `:effort` suffix
                                    // on `model`; when both present,
                                    // explicit `outputEffort` wins.
  images?:            MediaRef[]
  videos?:            MediaRef[]
  cache?:             boolean       // Gemini video upload caching
  tools?:             ToolSpec[]
  toolChoice?:        'auto' | 'required' | 'none' | string
  parallelToolCalls?: boolean
  identifier?:        string        // opaque per-user ID forwarded to provider
  idleHeartbeatMs?:   number        // emit synthetic 'idle' events when adapter is silent
                                    // for ≥ N ms (re-emitted every N ms). Advisory only —
                                    // mohdel does not abort on its own. Omit to disable.
}

interface Message {
  role:         'system' | 'user' | 'assistant' | 'tool'
  content:      string | MessagePart[]
  toolCallId?:  string   // set on role='tool' — links to the assistant's invocation
  toolName?:    string   // set on role='tool' — which tool produced the content
  toolCalls?:   ToolCall[] // set on role='assistant' when the model invoked tools
}

interface ToolCall { id: string; name: string; arguments: object }

type MessagePart =
  | { type: 'text',      text: string }
  | { type: 'reasoning', text: string }

interface MediaRef { fileUri: string; mimeType: string }
interface ToolSpec { name: string; description?: string; parameters: object }
```

Unknown fields **MUST** be ignored (additive tolerance). `auth.key`
**MUST NOT** appear in any event, log, or stderr output.

#### 3.1.1 Routing normalization — `<provider>/<bare>[:<effort>]`

The gate parses `model` on ingress:

1. The substring before the first `/` is the **provider**.
2. The remainder is the **bare provider-native id**, optionally
   suffixed with `:<effort>`.

Downstream runtime code (cooldown keys, rate-limit buckets, session
adapter dispatch, JS session `run.js`) reads the two parts in split
form on the post-normalization envelope. Consumers SHOULD use the
same split rule (`.split_once('/')` in Rust, `str.split('/', 2)` in
JS) when interpreting stored / logged envelopes.

Malformed `model` (no `/`) **MUST** be rejected at ingress with
`PROTOCOL_INVALID_ENVELOPE`.

The optional `:<effort>` suffix selects a thinking-effort level
for the call. The session runtime splits it before dispatch when
all of the following hold:

1. The string contains a `:` (use of `lastIndexOf`).
2. `envelope.outputEffort` is not already set — explicit
   `outputEffort` wins over the suffix.
3. The base (everything before the last `:`) resolves to a known
   spec via `<provider>/<base>`.
4. The spec has `thinkingEffortLevels` **and** the candidate level
   is either `"none"` or a key in `thinkingEffortLevels`.

On mismatch (base resolves but spec has no `thinkingEffortLevels`,
or the candidate is not in the level set), the session emits a
terminal `error` event with `type: 'SESSION_INVALID_OUTPUT_EFFORT'`.
If the base does not resolve, the session leaves `model` untouched
and the normal not-found path handles it.

This mirrors the factory's `mohdel().use('model:effort')`
convenience so factory and wire callers see identical ergonomics.

#### Operational note — auth.key lifetime asymmetry

By design, `auth.key` crosses the gate → session boundary as plain
JSON on stdin; the session needs it in cleartext to construct the
provider SDK client. On the Rust side, `SecretString` zeroizes on
`Drop`; V8 has no string-zeroize primitive, so once in the session
process the key lives in a GC-managed string until collection.

Implications for operators:

- Process inspection (`strace`, `ptrace`, `/proc/<pid>/mem`) of the
  session subprocess shows the key in cleartext.
- Core dumps from the session process may contain the key; disable
  core dumps or restrict their visibility on production hosts.
- The gate → session boundary relies on the socket's own permissions
  (see unix-socket `0o600` mode) for confidentiality, not on key
  wrapping.

If a deployment's threat model includes local process inspection,
treat each session subprocess as carrying the secret for its full
lifetime and lock down the host accordingly.

### 3.2 Control: `cancel`

```json
{ "op": "cancel", "callId": "<id>" }
```

- If `callId` matches the in-flight call, the session **MUST** abort
  it and emit a terminal `done` event with
  `result.status = 'incomplete'` and `result.warning = 'cancelled'`.
- Stale or unknown `callId` **MUST** be silently ignored.

## 4. Stdout — four events

```ts
type Event =
  | { type: 'delta', delta: DeltaChunk }
  | { type: 'idle',  sinceMs: number }
  | { type: 'done',  result: AnswerResult }
  | { type: 'error', error: TypedError }
```

**Field-order invariant:** `type` **MUST** be the first key emitted
in every event object. Supervisors fast-path delta events via a
prefix scan (`{"type":"delta"`) and only fully deserialize terminals.
Breaking the invariant doesn't corrupt the wire — it just reverts
the supervisor to full-parse-per-frame, a perf regression. All
session implementations built on `JSON.stringify({type: ..., ...})`
satisfy this automatically.

### 4.1 `delta` — streaming chunk

```ts
interface DeltaChunk {
  type: 'message' | 'function_call'
  delta: string
}
```

Zero or more per call. Adapters **SHOULD** flush after each delta so
downstream consumers see low latency.

### 4.2 `idle` — synthetic heartbeat

```ts
interface IdleEvent {
  type:    'idle'
  sinceMs: number          // ms since the last real event (or call start)
}
```

Emitted by the session loop, not by adapters, and only when the
caller sets `idleHeartbeatMs` on the envelope. Re-emitted every
`idleHeartbeatMs` while the silence persists; the timer resets on
the next real event. Advisory only — mohdel never aborts on its
own. Consumers decide whether to log, bump a watchdog, or trigger
an external cancel. Never terminal; further events may follow.

### 4.3 `done` — terminal with `AnswerResult`

```ts
interface AnswerResult {
  status:         'completed' | 'tool_use' | 'incomplete'
  output:         string | null
  inputTokens:    number
  outputTokens:   number
  thinkingTokens: number
  cost:           number                 // USD — single number
  timestamps:     { start: string, first: string, end: string }
                                         // process.hrtime.bigint() as strings (ns)
  warning?:       string                 // 'insufficientOutputBudget' | 'cancelled' | ...
  toolCalls?:     Array<{
    id:        string
    name:      string
    arguments: object                    // parsed — not a JSON string
  }>
  maxInterFrameMs?: number               // longest gap (ms) between adapter events
                                         // in this call: startedAt→first frame,
                                         // between consecutive frames, last frame→terminal
}
```

### 4.4 `error` — terminal on failure

```ts
interface TypedError {
  message:   string
  detail?:   string
  severity:  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  retryable: boolean
  type?:     string              // e.g. 'PROVIDER_COOLDOWN', 'AUTH_INVALID'
}
```

`message` is a stable machine key; `detail` carries user-facing
context. `message` MUST NOT contain provider response bodies —
some providers echo API keys back on 401.

### 4.5 Emission invariants

Per envelope:
1. Zero or more `delta` events MAY be emitted in the adapter's native
   order.
2. Zero or more `idle` events MAY appear between any two non-terminal
   events while the adapter is silent (only when the caller opted in
   via `idleHeartbeatMs`).
3. Exactly one terminal event (`done` or `error`) MUST be the last
   line.
4. No event MAY appear after the terminal.

## 5. Status semantics

| Status       | When                                                    |
|--------------|---------------------------------------------------------|
| `completed`  | Model finished normally with final output               |
| `tool_use`   | Model emitted tool calls and expects a round-trip       |
| `incomplete` | Call was cut short (truncation, safety filter, cancel)  |

`warning` qualifies `incomplete` status:

| Warning                     | When                                        |
|-----------------------------|---------------------------------------------|
| `insufficientOutputBudget`  | Response truncated by output budget         |
| `cancelled`                 | Call aborted by a cancel control message    |

Per-provider truncation signals (for adapter implementors):
- **Anthropic**: `message_delta.stop_reason === 'max_tokens'`
- **OpenAI**: `response.incomplete` + `incomplete_details.reason === 'max_output_tokens'`
- **Gemini**: `candidates[].finishReason === 'MAX_TOKENS'`

## 6. Session lifecycle

- **Startup:** session begins reading stdin immediately. No handshake.
- **Call handling:** read envelope, process, emit zero or more deltas
  + one terminal, loop.
- **Concurrency:** one call at a time per session (serial).
- **Pooling:** session MUST continue reading stdin after a terminal
  (for reuse). Exit only on stdin EOF.
- **Shutdown:** on stdin EOF, drain the in-flight call and exit 0.
  On SIGTERM, same behavior; SIGKILL follows supervisor grace period.
- **Crash:** if the session dies mid-call, the supervisor synthesizes
  a terminal `error` event with `type: 'SESSION_DIED'` and does NOT
  reuse the session.

## 7. Stderr

No protocol semantics. Implementations MAY write diagnostics freely.
Supervisors SHOULD forward stderr to their logs. Implementations
MUST NOT write `auth.key` or any secret to stderr.

## 8. Versioning

Frozen at 0.90. Post-release:

- **Additive:** new optional envelope fields, new `TypedError.type`
  values, new `warning` strings, new delta chunk types, new `Status`
  values — allowed without a bump.
- **Breaking:** renames, required-field additions, removal — require
  a major version bump.

## 9. Compliance checklist

- [ ] Reads NDJSON from stdin; tolerates empty lines and CRLF
- [ ] Splits stdin on `\n` bytes only (U+2028/U+2029 are payload, not terminators)
- [ ] Emits terminal `SESSION_STDIN_MALFORMED` + exits non-zero on an unparseable stdin line
- [ ] Writes NDJSON events with LF
- [ ] Uses camelCase field names on the wire
- [ ] Emits exactly one terminal (`done` or `error`) per envelope
- [ ] `done.result` round-trips through `test/conformance/events.json`
- [ ] `error` never contains provider response bodies or secrets
- [ ] Reports `status: 'incomplete'` + `warning: 'insufficientOutputBudget'`
      on output-budget truncation
- [ ] Reports `status: 'tool_use'` when finishing on tool calls
- [ ] Honors `{op:'cancel', callId}` — aborts, emits `done` with
      `warning: 'cancelled'`
- [ ] Ignores cancel for unknown / stale `callId`
- [ ] Handles malformed stdin without crashing
- [ ] Returns to idle between calls
- [ ] Exits cleanly on stdin EOF
- [ ] Writes no secrets to stdout or stderr
