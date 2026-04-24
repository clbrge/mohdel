/**
 * Dispatch a CallEnvelope to the matching adapter and yield its
 * Event stream.
 *
 * Per call:
 *   - Opens a `mohdel.session.answer` OTel span under the envelope's
 *     remote parent (`traceparent`). Log lines carry `traceId` /
 *     `spanId` for SigNoz/Jaeger correlation even when no exporter
 *     is wired.
 *   - Pre-dispatch: cooldown fast-fail, then rpm/tpm throttle
 *     (await + record).
 *   - Post-dispatch: on `done`, reset cooldown and record tokens
 *     (TPM); on `error`, recordFailure (immediate for AUTH_INVALID,
 *     skipped for non-retryable provider errors). Span ends with
 *     `gen_ai.*` + `mohdel.*` attributes.
 *
 * Terminal events are `done` (success / incomplete / cancelled /
 * tool_use) and `error`. The adapter is expected to emit exactly
 * one terminal per call. If it returns without one, `run()`
 * synthesizes an `error`.
 *
 * @module session/run
 */

import { getAdapter } from './adapters/index.js'
import { isImageProvider } from './adapters/image/index.js'
import { getSpec } from './adapters/_catalog.js'
import { getProviderLimits } from './adapters/_providers.js'
import { providerOf, catalogKey, effortOf } from '#core/model-id.js'
import * as defaultCooldown from './_cooldown.js'
import * as defaultLimiter from './_rate_limiter.js'
import { logger as defaultLogger } from './_logger.js'
import {
  startSpan,
  endSpanOk,
  endSpanError,
  remoteParentFromTraceparent
} from './_tracing.js'
import { STATUS_INCOMPLETE, WARNING_CANCELLED } from '#core/status.js'

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {{
 *   resolveAdapter?: (provider: string) => (
 *     env: import('#core/envelope.js').CallEnvelope,
 *     deps?: {signal?: AbortSignal, log?: any, span?: any}
 *   ) => AsyncGenerator<import('#core/events.js').Event>,
 *   resolveSpec?: (key: string) => any,
 *   resolveProviderLimits?: (provider: string) => any,
 *   cooldown?: any,
 *   limiter?: any,
 *   logger?: any,
 *   sleep?: (ms: number) => Promise<void>,
 *   signal?: AbortSignal
 * }} [options]
 * @returns {AsyncGenerator<import('#core/events.js').Event>}
 */
export async function * run (envelope, {
  resolveAdapter = getAdapter,
  resolveSpec = getSpec,
  resolveProviderLimits = getProviderLimits,
  cooldown = defaultCooldown,
  limiter = defaultLimiter,
  logger = defaultLogger,
  sleep = defaultSleep,
  signal
} = {}) {
  // Honor the `model:effort` shortcut on the wire (mirrors the
  // factory-side `mohdel().use('model:effort')` convenience). If
  // the envelope's `model` field ends in `:<effort>` and the base
  // resolves to a known spec, split the suffix into
  // `envelope.outputEffort`. Explicit `outputEffort` wins when both
  // are set (suffix is a shortcut, not an override).
  const effortNorm = normalizeModelEffort(envelope, resolveSpec)
  if (effortNorm.error) { yield effortNorm.error; return }
  envelope = effortNorm.envelope

  const provider = providerOf(envelope.model)
  const span = openSpan(envelope)
  const log = scopedLogger(logger, envelope, span)
  const startedAt = Date.now()

  log.debug({
    provider,
    model: envelope.model,
    effort: envelope.outputEffort ?? 'default',
    outputBudget: envelope.outputBudget ?? null,
    tools: envelope.tools?.length || 0,
    images: envelope.images?.length || 0
  }, '[mohdel:answer] start')

  let adapter
  try {
    adapter = resolveAdapter(provider)
  } catch (e) {
    // Distinguish "image-only provider invoked via answer" from
    // truly-unknown. Novita-and-friends have no text adapter but a
    // caller using `mohdel.use('novita/...').answer(...)` otherwise
    // gets a bare "unknown provider" with no hint.
    if (isImageProvider(provider)) {
      const detail = `provider '${provider}' supports image generation only; use mohdel.image(...) instead`
      const err = errorEvent(detail, 'PROVIDER_TEXT_NOT_SUPPORTED')
      log.warn({ provider }, '[mohdel:answer] image-only provider via answer')
      endSpanError(span, new Error(detail))
      yield err
      return
    }
    const err = errorEvent(messageOf(e), 'SESSION_UNKNOWN_PROVIDER')
    log.warn({ err: e, provider }, '[mohdel:answer] unknown provider')
    endSpanError(span, e)
    yield err
    return
  }

  // Catalog is authoritative: every callable model must have a
  // spec. Without one we'd silently run the provider call with
  // defaults (no rate-limits, no budget clamps, cost=0), masking
  // misconfiguration in the layer that pushed the catalog. Effort
  // suffix is stripped for the lookup — catalog entries are keyed
  // by the bare `<provider>/<bare>` id, not per-effort variants.
  const key = catalogKey(envelope.model)
  const spec = resolveSpec(key)
  if (!spec) {
    const detail = `Unknown model '${key}' — not in catalog`
    const err = errorEvent(detail, 'SESSION_UNKNOWN_MODEL')
    log.warn({ provider, model: envelope.model }, '[mohdel:answer] unknown model')
    endSpanError(span, new Error(detail))
    yield err
    return
  }

  const coolErr = cooldown.coolingDownError(provider)
  if (coolErr) {
    log.debug({ provider, detail: coolErr.detail }, '[mohdel:cooldown] fast-fail')
    span.setAttribute('mohdel.cooldown', true)
    endSpanOk(span, { 'mohdel.status': 'cooldown' })
    yield { type: 'error', error: coolErr }
    return
  }

  const providerCfg = resolveProviderLimits(provider) || {}
  const rpmLimit = spec?.rpmLimit ?? providerCfg.rpmLimit
  const tpmLimit = spec?.tpmLimit ?? providerCfg.tpmLimit
  const bucketKey = (spec?.rateLimitScope === 'model') ? key : provider

  // `0` is a killswitch ("deny all"), not "unset"; `undefined`/`null`
  // means no limit configured for that dimension. Gate on nullability
  // so an intentional `Some(0)` quota is enforced.
  if (rpmLimit != null || tpmLimit != null) {
    const delay = limiter.check(bucketKey, { rpmLimit, tpmLimit })
    if (delay > 0) {
      log.debug({ key: bucketKey, delayMs: delay }, '[mohdel:ratelimit] throttling')
      span.setAttribute('mohdel.rate_limit_delay_ms', delay)
      await sleep(delay)
    }
    limiter.recordRequest(bucketKey)
  }

  let sawTerminal = false
  // Track whether the adapter emitted any `delta` events during the
  // call. Recorded as `mohdel.stream` on the span at finalize time —
  // a non-streaming terminal (adapter fell back to wait-for-done, or
  // the provider SDK collapsed stream events) is a hazard for any
  // host-side read-timeout watchdog and shows up in traces before
  // it turns into an abort downstream.
  let sawDelta = false
  // Track the longest gap between adapter events within this call —
  // from `startedAt` to the first frame, between consecutive frames,
  // and from the last frame to the terminal. A direct signal for any
  // host-side read-timeout watchdog: a 15-min call that streams
  // deltas every 30s is safe; a 5-min call with zero intermediate
  // frames is dangerous. Surfaced on `AnswerResult.maxInterFrameMs`
  // and the span's `mohdel.max_inter_frame_ms` attribute so hosts
  // can aggregate it for adaptive-timeout calibration.
  let lastFrameAt = startedAt
  let maxInterFrameMs = 0
  try {
    for await (const ev of adapter(envelope, { signal, log, span })) {
      const now = Date.now()
      const gap = now - lastFrameAt
      if (gap > maxInterFrameMs) maxInterFrameMs = gap
      lastFrameAt = now

      if (ev.type === 'delta') {
        sawDelta = true
      } else if (ev.type === 'done') {
        sawTerminal = true
        // A cancelled terminal is the caller's action, not evidence
        // of provider recovery — don't wipe an accumulated failure
        // streak. Every other `done` state (completed /
        // incomplete-budget / tool_use) IS a genuine provider-side
        // success and resets the streak.
        if (ev.result?.warning !== WARNING_CANCELLED) {
          cooldown.reset(provider)
        }
        if (tpmLimit != null && ev.result) {
          const total =
            (ev.result.inputTokens || 0) +
            (ev.result.outputTokens || 0) +
            (ev.result.thinkingTokens || 0)
          if (total > 0) limiter.recordTokens(bucketKey, total)
        }
        // Surface on AnswerResult so hosts that pass the whole
        // result upstream pick it up without needing a separate
        // wire field.
        if (ev.result) ev.result.maxInterFrameMs = maxInterFrameMs
        finalizeSpanOk(span, ev.result, sawDelta, maxInterFrameMs)
        log.debug(summarizeDone(ev.result, startedAt), '[mohdel:answer] done')
      } else if (ev.type === 'error') {
        sawTerminal = true
        recordFailureFromError(cooldown, provider, ev.error)
        log.warn({
          err: ev.error,
          provider,
          totalMs: Date.now() - startedAt,
          maxInterFrameMs
        }, '[mohdel:answer] failed')
        endSpanError(span, new Error(ev.error?.message || 'adapter error'))
      }
      yield ev
    }
  } catch (e) {
    if (signal?.aborted && !sawTerminal) {
      const fallback = cancelledFallback()
      if (fallback.result) fallback.result.maxInterFrameMs = maxInterFrameMs
      finalizeSpanOk(span, fallback.result, sawDelta, maxInterFrameMs)
      yield fallback
      return
    }
    log.warn({ err: e, provider, maxInterFrameMs }, '[mohdel:answer] adapter threw')
    endSpanError(span, e)
    yield errorEvent(messageOf(e), 'SESSION_ADAPTER_THREW')
    return
  }

  if (!sawTerminal) {
    if (signal?.aborted) {
      const fallback = cancelledFallback()
      if (fallback.result) fallback.result.maxInterFrameMs = maxInterFrameMs
      finalizeSpanOk(span, fallback.result, sawDelta, maxInterFrameMs)
      yield fallback
    } else {
      const err = 'adapter returned without a terminal event'
      log.error({ provider, maxInterFrameMs }, '[mohdel:answer] no terminal event')
      endSpanError(span, new Error(err))
      yield errorEvent(err, 'SESSION_ADAPTER_NO_TERMINAL')
    }
  }
}

/**
 * Split an optional `:effort` suffix from `envelope.model`. If the
 * base resolves to a known spec, rewrites `envelope.model` and sets
 * `envelope.outputEffort` (unless already set). Emits a typed error
 * when the suffix is present and the spec rejects it.
 *
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {(key: string) => any} resolveSpec
 * @returns {{
 *   envelope: import('#core/envelope.js').CallEnvelope,
 *   error?: import('#core/events.js').ErrorEvent
 * }}
 */
function normalizeModelEffort (envelope, resolveSpec) {
  const candidate = effortOf(envelope.model)
  if (!candidate) return { envelope }
  if (envelope.outputEffort) return { envelope } // explicit wins

  const base = catalogKey(envelope.model)
  const baseSpec = resolveSpec(base)
  if (!baseSpec) return { envelope } // base not known — let full string fall through to not-found

  if (!baseSpec.thinkingEffortLevels) {
    return {
      envelope,
      error: errorEvent(
        `Model '${base}' does not support output effort (no thinkingEffortLevels). Cannot use ':${candidate}' suffix.`,
        'SESSION_INVALID_OUTPUT_EFFORT'
      )
    }
  }
  if (candidate !== 'none' && !baseSpec.thinkingEffortLevels[candidate]) {
    return {
      envelope,
      error: errorEvent(
        `Model '${base}' does not support output effort level '${candidate}'. Available: ${Object.keys(baseSpec.thinkingEffortLevels).join(', ')}`,
        'SESSION_INVALID_OUTPUT_EFFORT'
      )
    }
  }

  return {
    envelope: { ...envelope, model: base, outputEffort: candidate }
  }
}

/**
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 */
function openSpan (envelope) {
  const parent = envelope.traceparent
    ? remoteParentFromTraceparent(envelope.traceparent)
    : null
  /** @type {Record<string, any>} */
  const attrs = {
    'gen_ai.request.model': envelope.model,
    'gen_ai.system': providerOf(envelope.model),
    'mohdel.call_id': envelope.callId,
    'mohdel.auth_id': envelope.authId
  }
  if (envelope.outputBudget) attrs['gen_ai.request.max_tokens'] = envelope.outputBudget
  if (envelope.outputEffort) attrs['mohdel.output_effort'] = envelope.outputEffort
  return startSpan('mohdel.session.answer', attrs, parent)
}

/**
 * @param {any} logger
 * @param {import('#core/envelope.js').CallEnvelope} envelope
 * @param {any} span
 */
function scopedLogger (logger, envelope, span) {
  const ctx = span?.spanContext?.() || {}
  return logger.withContext({
    callId: envelope.callId,
    authId: envelope.authId,
    provider: providerOf(envelope.model),
    model: envelope.model,
    traceId: ctx.traceId,
    spanId: ctx.spanId
  })
}

/**
 * @param {any} span
 * @param {any} result
 * @param {boolean} sawDelta  Whether the adapter emitted at least one
 *   `delta` event during the call. Surfaces as `mohdel.stream` on the
 *   span so traces can flag calls that completed without streaming —
 *   a non-streaming long-running call is invisible to upstream idle
 *   watchdogs until the terminal lands.
 * @param {number} maxInterFrameMs  Longest gap between adapter events
 *   during the call (including pre-first-frame and post-last-frame).
 *   Surfaces as `mohdel.max_inter_frame_ms` so downstream timeout
 *   calibration has a direct signal independent of total elapsed.
 */
function finalizeSpanOk (span, result, sawDelta = false, maxInterFrameMs = 0) {
  /** @type {Record<string, any>} */
  const attrs = {
    'gen_ai.usage.input_tokens': result?.inputTokens || 0,
    'gen_ai.usage.output_tokens': result?.outputTokens || 0,
    'mohdel.thinking_tokens': result?.thinkingTokens || 0,
    'mohdel.status': result?.status || 'unknown',
    'mohdel.stream': !!sawDelta,
    'mohdel.max_inter_frame_ms': maxInterFrameMs
  }
  if (result?.cost != null) attrs['mohdel.cost'] = result.cost
  if (result?.warning) attrs['mohdel.warning'] = result.warning
  if (result?.timestamps?.start && result?.timestamps?.first) {
    try {
      const start = BigInt(result.timestamps.start)
      const first = BigInt(result.timestamps.first)
      if (first > start) attrs['mohdel.time_to_first_token_ms'] = Number(first - start) / 1e6
    } catch {
      // ignore parse failures — timestamps may be zero/unknown strings
    }
  }
  endSpanOk(span, attrs)
}

/**
 * @param {any} result
 * @param {number} startedAt
 */
function summarizeDone (result, startedAt) {
  return {
    status: result?.status,
    in: result?.inputTokens || 0,
    out: result?.outputTokens || 0,
    think: result?.thinkingTokens || 0,
    cost: result?.cost,
    warning: result?.warning,
    totalMs: Date.now() - startedAt,
    maxInterFrameMs: result?.maxInterFrameMs
  }
}

/**
 * Cooldown accounting rules:
 *   - 401/403 (AUTH_INVALID) → immediate cooldown, 1 failure.
 *   - Non-retryable client errors (400/404) → skip cooldown entirely.
 *   - 429/5xx/network errors → normal consecutive-failure tracking.
 *
 * @param {{recordFailure: (k: string, o?: {immediate?: boolean}) => boolean}} cooldown
 * @param {string} provider
 * @param {import('#core/errors.js').TypedError | undefined} err
 */
function recordFailureFromError (cooldown, provider, err) {
  if (!err) return
  if (err.type === 'AUTH_INVALID') {
    cooldown.recordFailure(provider, { immediate: true })
    return
  }
  if (err.retryable === false) return
  cooldown.recordFailure(provider)
}

/** @returns {import('#core/events.js').DoneEvent} */
function cancelledFallback () {
  const now = String(process.hrtime.bigint())
  return {
    type: 'done',
    result: {
      status: STATUS_INCOMPLETE,
      output: null,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cost: 0,
      timestamps: { start: now, first: now, end: now },
      warning: WARNING_CANCELLED
    }
  }
}

/**
 * @param {string} message
 * @param {string} type
 * @returns {import('#core/events.js').ErrorEvent}
 */
function errorEvent (message, type) {
  return {
    type: 'error',
    error: {
      message,
      severity: 'error',
      retryable: false,
      type
    }
  }
}

/** @param {unknown} e */
function messageOf (e) {
  return e instanceof Error ? e.message : String(e)
}

/** @param {number} ms */
function defaultSleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
