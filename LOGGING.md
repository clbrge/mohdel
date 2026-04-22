# Mohdel Logging Guide

This document defines mohdel's logging conventions for contributors and integrators. Mohdel does not own a log sink — it accepts a logger object from the consumer and routes structured events through it. This document specifies what mohdel emits, at what level, and how to integrate.

For the full library guide see [INTEGRATION.md](INTEGRATION.md). For design rationale see [ARCHITECTURE.md](ARCHITECTURE.md). For CLI usage see [README.md](README.md).

## Logger Interface

Mohdel takes a single `logger` option at factory init, plus an optional callback pair:

```js
const mo = await mohdel({
  logger,     // { trace, debug, info, warn, error, fatal }
  onSuccess,  // (result, { model, provider, rateLimitDelay }) => void
  onFailure   // (err,    { model, provider, rateLimitDelay }) => void
})
```

### Canonical logger shape

The minimum interface mohdel calls into:

```js
{
  trace: (firstArg, ...rest) => void,
  debug: (firstArg, ...rest) => void,
  info:  (firstArg, ...rest) => void,
  warn:  (firstArg, ...rest) => void,
  error: (firstArg, ...rest) => void,
  fatal: (firstArg, ...rest) => void
}
```

`firstArg` may be a string (the message) or an object (structured fields like `{ span }` or `{ span, err }`) followed by a format string in `rest`. This matches **pino's call convention** — pino works out of the box, no adapter needed. Other loggers can be adapted with a thin wrapper if their argument shape differs.

If a method is missing from the logger, that level is **silent** (no-op). Mohdel never falls back to `console.log` for missing methods.

### Default behavior

When `logger` is omitted, mohdel defaults to `silent` — all six levels are no-ops. Factory init failures still throw, so you don't need to wire a logger to discover misconfiguration.

### Explicit silence

To be intentional about wanting no log output:

```js
import mohdel, { silent } from 'mohdel'

const mo = await mohdel({ logger: silent })
```

`silent` is a frozen object — callers cannot mutate it accidentally.

### Stateful loggers (pino, winston, bunyan)

Mohdel routes log calls through closures that **preserve `this` binding** on the original logger object. This means stateful loggers — pino child loggers, winston/bunyan instances, or any class-based logger that stores instance state via Symbol-keyed properties — work correctly without manual `.bind()` or adapter wrapping:

```js
import pino from 'pino'

const logger = pino({ level: 'debug' })
const mo = await mohdel({ logger })
```

The `this` binding survives because mohdel internally builds wrapper closures `(...args) => logger.method(...args)` that capture the original `logger` reference, not detached method functions.

### Optional `child(bindings)`

Loggers may implement `.child(bindings)` returning a new logger with extra context bound. Pino loggers do this natively. Mohdel does not currently use `.child()` internally — it's exposed for consumer-side scope binding (the consumer can pre-bind a child logger before passing it to mohdel).

## Verbosity Tiers

Independent of the **logger level** (which determines whether trace/debug/info/etc. lines are emitted at all), mohdel has an internal **verbosity tier** that gates which per-call log statements fire. This is a separate dial because the logger level is set by the host app (often "info in prod, trace in dev"), while the verbosity tier is set by the operator who's debugging a specific issue.

| Tier | What fires | Use case |
|---|---|---|
| **0** | Anomalies only — failures (warn), throttling (debug, conditional), deprecation (warn), provider cooldown (info), server lifecycle (info), callback errors (warn) | Production: surface only what needs attention |
| **1** *(default)* | Tier 0 + per-call `[mohdel:answer] start` (debug), `[mohdel:answer] done` (debug), basic `[mohdel:answer] result` envelope (trace) | Dev: see every model call without payload detail |
| **2** | Tier 1 + `[mohdel:answer] request` preview (trace), `[mohdel:answer] tool_calls` expansion (trace), `[mohdel:answer] output` full preview (trace) | Deep debugging: see what's being sent to the model and what comes back |

### Selection precedence

Resolved once at factory init, in this order (first defined wins):

1. Factory option `verbosity` — `mohdel({ logger, verbosity: 2 })`
2. Environment variable `MOHDEL_VERBOSITY` — `MOHDEL_VERBOSITY=2 npm run dev`
3. Default: `1`

Restart your process to change the tier. Out-of-range or non-numeric values fall back to the default; values above 2 clamp to 2.

### Interaction with logger level

The verbosity gate is **in addition to** the logger level filter. A line at trace level only appears if both:
- Verbosity tier is high enough (e.g. tier 2 for `[mohdel:answer] request`)
- Logger level is at trace (10) or below

So `MOHDEL_VERBOSITY=2` with a logger at level info will still hide the trace lines (the logger drops them). Pair `MOHDEL_VERBOSITY=2` with `logger.level = 'trace'` (or whatever your host logger's trace threshold is) to see everything.

Tier 0 still emits warn/error lines (failures, deprecation), so a host app at level warn will see anomalies regardless of verbosity. Use it when you want quiet mohdel logs without losing failure visibility.

## Log Level Semantics

Mohdel uses standard severity levels:

| Level | Meaning |
|---|---|
| **fatal** | Process crash, unrecoverable state, invariant violation. "Should never happen." |
| **error** | Server-side problem that needs attention. Not user input failures. |
| **warn** | Anomalous or potentially anomalous. User-caused failures. Intermediate failures in fallback chains. |
| **info** | Lifecycle and operational events. Must not contain user data. |
| **debug** | Per-call diagnostic. May contain short extracts of user data. |
| **trace** | Verbose flow. No content restrictions. |

**Fallback chains:** when code tries multiple methods, intermediate failures are `warn`; only the final exhausted failure is `error`.

**User-caused errors:** failures originating from user input (bad model ID, missing API key, malformed prompt) are `warn`, not `error`. The library rejected the request correctly — there is nothing to address on the library side.

**"Should never happen":** violated invariants (unknown severity symbol, unexpected enum value) are `fatal` — they signal a bug that needs immediate investigation. Mohdel currently throws on these instead of logging, since they indicate corrupted state where continuing is unsafe.

## Prefix Convention

All mohdel log lines use the format `[mohdel:<subsystem>] <message>`:

| Prefix | Subsystem |
|---|---|
| `[mohdel:answer]` | Main inference path |
| `[mohdel:catalog]` | Model catalog operations (deprecation, lookup) |
| `[mohdel:cooldown]` | Provider cooldown tracker |
| `[mohdel:ratelimit]` | RPM/TPM throttling |
| `[mohdel:cache]` | File cache (gemini upload deduplication) |
| `[mohdel:common]` | File I/O for config and curated cache |
| `[mohdel:schema]` | Curated model spec validation |
| `[mohdel:server]` | Unix socket sidecar |
| `[mohdel:gemini]`, `[mohdel:openai]`, etc. | Provider-specific SDK paths |

Contributors adding new subsystems should follow this format.

## What Mohdel Logs at Each Level

### fatal
Currently none — invariant violations throw instead (`getSeverityNumber`, etc.).

### error
- File I/O failures during config save (`[mohdel:cache]`, `[mohdel:common]`)

### warn
- Deprecated model usage with replacement redirect (`[mohdel:catalog]`)
- onSuccess/onFailure user callback exceptions (`[mohdel:answer]`)
- Provider SDK errors that bubble up (e.g. `[mohdel:gemini] answer failed`)
- File load failures (cache, config) — always paired with a fallback default

### info
- Cooldown activation (`[mohdel:cooldown] X activated`)
- Server lifecycle (`[mohdel:server] listening on ...`)

### debug
- Rate limit throttling decisions (`[mohdel:ratelimit] throttling X for Yms`)
- Cooldown reset and expiry (`[mohdel:cooldown] X reset`)

### trace
- Cooldown fast-fail (`[mohdel:cooldown] X fast-fail (Ns remaining)`)

## OpenTelemetry Span Correlation

Mohdel creates one OTel span per `answer()` call (`mohdel.answer`). The span is a child of the caller-provided `parentSpan` (passed in `answer()` options).

Log calls inside `answer()` include `{ span }` as the first argument, e.g.:

```js
handlers.debug({ span }, '[mohdel:ratelimit] throttling X for Yms')
```

Pino-compatible loggers can configure a `span` serializer that extracts `traceId`/`spanId`/`traceFlags` from the OTel span object. When configured, every log line emitted within the span scope carries the trace identity, enabling SigNoz/Honeycomb/etc. to show logs correlated with the span.

Example pino configuration:

```js
import pino from 'pino'
import { trace as otelTrace } from '@opentelemetry/api'

const serializeSpan = (span) => {
  const ctx = span?.spanContext?.()
  return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: ctx.traceFlags } : undefined
}

const logger = pino({
  serializers: { span: serializeSpan }
})

const mo = await mohdel({ logger })
```

For consumers that don't use OTel, the `{ span }` first-arg is harmless — `console.*` will print `{ span: ... }` along with the message string. No-op stubs ignore it.

## Adding New Log Calls

When contributing code that needs logging:

1. Pick the level using the semantics above. When in doubt, prefer the lower-noise level (debug over info, info over warn).
2. Use the `[mohdel:<subsystem>]` prefix.
3. Inside `answer()`-scope code, pass `{ span }` as the first arg so trace correlation works.
4. Include enough context for the operator to act (model ID, error message, count, duration). Avoid logging full prompts, full responses, or API keys.
5. If your code is a factory module (like `cooldown.js`, `cache.js`), accept an optional `{ logger }` parameter defaulting to the `silent` export from `./logger.js`. The mohdel factory will pass real handlers when constructing your module.

## Handler Routing in the Codebase

Mohdel uses three patterns to get handlers into modules:

1. **Factory injection** (preferred): the mohdel factory builds `handlers` from consumer-provided functions and passes them to module constructors:
   ```js
   const cooldown = createCooldownTracker(threshold, duration, { logger: handlers })
   ```

2. **Function parameter**: pure utility functions accept an optional `logger` param:
   ```js
   await loadFileCache(handlers)
   ```

3. **Module-level setter**: shared singletons that are imported as-is use a `setLogger()` export, called once by the factory:
   ```js
   import { setLogger as setCommonLogger } from './common.js'
   setCommonLogger(handlers)
   ```

Pattern (1) is preferred. Pattern (3) is used only when the module exports module-level singletons that can't easily be reconstructed (e.g., `common.js` exports four `createFileOperation` instances at import time).

## What Mohdel Does NOT Log

- **API keys** — never logged, even at trace level
- **Full prompts or response bodies** — providers handle their own request logging if enabled via SDK config
- **User identifiers** beyond the `identifier` field passed in answer options (logged at debug if at all)

## CLI Output

Mohdel's CLI commands (`src/cli/*`) intentionally use `console.log`/`console.error` directly for user-facing output. They are not part of the logging system — they print results, tables, and prompts that are meant for the terminal. Do not route them through handlers.
