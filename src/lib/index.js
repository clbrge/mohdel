// TODO: split into factory.js / model-proxy.js / answer-call.js.
// This file is the default-export surface (`import mohdel from 'mohdel'`);
// any split must preserve that resolution to a factory function.
// Behaviour-preserving refactor only.

import providers from './providers.js'
import { getAPIKey, loadDefaultEnv, getProvidersConfig, saveProvidersConfig, setLogger as setCommonLogger } from './common.js'
import {
  loadCuratedCache,
  getCuratedCacheSnapshot,
  expandModelAliasSync,
  suggestModels,
  persistCuratedCache
} from './curated-cache.js'
import { createRateLimiter } from '../../js/session/_rate_limiter.js'
import { createCooldownTracker } from '../../js/session/_cooldown.js'
import { runAnswer, runAnswerImage, runAnswerTranscription } from '../../js/factory/bridge.js'
import { startSpan, endSpanOk, endSpanError } from './tracing.js'
import { isValidTag } from './schema.js'
import { silent } from './logger.js'
import { createRequire } from 'node:module'

export const version = createRequire(import.meta.url)('../../package.json').version

const noop = () => {}

// Verbosity tiers — controls which mohdel internal log lines fire.
//
//   0  Anomaly-only. Failures, throttling, deprecation, server lifecycle.
//      Recommended for production where you want to see only what needs attention.
//   1  Default. Adds per-call `start` (debug), `done` (debug), and a basic
//      `result` envelope (trace). Useful in dev to see every model call without
//      drowning in payload detail.
//   2  Verbose. Adds request preview (trace), tool call expansion (trace),
//      and full output preview (trace). Use when debugging mohdel internals
//      or specific model behavior.
//
// Selection precedence: factory opt `verbosity` > env `MOHDEL_VERBOSITY` > default 1.
// Captured once at factory init; restart your process to change at runtime.
const VERBOSITY_DEFAULT = 1
const VERBOSITY_MIN = 0
const VERBOSITY_MAX = 2

const parseVerbosity = (raw) => {
  if (raw == null || raw === '') return VERBOSITY_DEFAULT
  const v = typeof raw === 'number' ? raw : parseInt(raw, 10)
  if (!Number.isFinite(v) || v < VERBOSITY_MIN) return VERBOSITY_DEFAULT
  if (v > VERBOSITY_MAX) return VERBOSITY_MAX
  return v
}

// @internal — exported under an underscore-prefixed alias for unit tests only.
// Not part of the public package surface.
export { parseVerbosity as _parseVerbosityForTests }

const TOOL_SDKS = new Set(['anthropic', 'openai', 'gemini', 'cerebras', 'fireworks', 'openrouter'])

const resolvePrice = (price, inputTokens) => {
  if (typeof price === 'number') return price
  if (price == null || typeof price !== 'object') return 0
  let resolved = price.default ?? 0
  let highestThreshold = -1
  for (const key of Object.keys(price)) {
    if (key.startsWith('>')) {
      const threshold = parseInt(key.slice(1), 10)
      if (inputTokens > threshold && threshold > highestThreshold) {
        highestThreshold = threshold
        resolved = price[key]
      }
    }
  }
  return resolved
}

// @internal — exported for unit tests only.
export { resolvePrice as _resolvePriceForTests }

const normalizeModelSpec = (resolvedModelId, modelSpec, providerConfig) => {
  const normalized = { ...modelSpec }
  if (!normalized.provider) {
    normalized.provider = resolvedModelId.split('/')[0]
  }
  if (!normalized.sdk) {
    normalized.sdk = providerConfig.sdk
  }
  if (!normalized.api && providerConfig.api) {
    normalized.api = providerConfig.api
  }
  if (normalized.supportsTools === undefined) {
    normalized.supportsTools = TOOL_SDKS.has(normalized.sdk)
  }
  return normalized
}

const createFallbackModelSpec = (resolvedModelId) => {
  const [providerName, ...modelParts] = resolvedModelId.split('/')
  if (!providerName || modelParts.length === 0) return null

  const providerConfig = providers[providerName]
  if (!providerConfig?.createFallbackModelSpec) return null

  const fallback = providerConfig.createFallbackModelSpec(resolvedModelId, modelParts.join('/'))
  if (!fallback) return null

  return normalizeModelSpec(resolvedModelId, fallback, providerConfig)
}

const resolveProviderConfiguration = async (provider, providerName) => {
  if (provider.resolveConfiguration) {
    return provider.resolveConfiguration()
  }

  if (provider.apiKeyEnv) {
    const apiKey = getAPIKey(provider.apiKeyEnv)
    if (!apiKey) {
      throw new Error(`API key not found for ${providerName}. Set ${provider.apiKeyEnv} environment variable.`)
    }
    return provider.createConfiguration(apiKey)
  }

  if (provider.createConfiguration) {
    return provider.createConfiguration()
  }

  return {}
}

// Build the handlers bag from a caller-provided logger.
//
// The logger is the single source of log routing. Each level becomes a closure
// that captures the original `logger` reference and forwards calls through it.
// The closure preserves `this` binding so stateful loggers (pino, winston,
// bunyan, or any class-based logger that stores instance state via `this` —
// pino uses Symbol-keyed properties like `Symbol(pino.msgPrefix)`) work
// correctly even after the methods are stored on a different object.
//
// Canonical logger shape — the minimum interface mohdel calls into:
//
//   {
//     trace: (firstArg, ...rest) => void,
//     debug: (firstArg, ...rest) => void,
//     info:  (firstArg, ...rest) => void,
//     warn:  (firstArg, ...rest) => void,
//     error: (firstArg, ...rest) => void,
//     fatal: (firstArg, ...rest) => void
//   }
//
// `firstArg` may be a string (the message) or an object (structured fields like
// `{ span }` or `{ span, err }`) followed by a format string in `rest`. This
// matches pino's call convention; other loggers can adapt with a thin wrapper.
//
// If a method is missing from the logger (partial logger), that level is silent
// — never console-logged. Default when no logger is provided is `silent` from
// `./logger.js`. Pass `silent` explicitly to be intentional about wanting no output.
//
// `onSuccess` and `onFailure` are independent of the logger and pass through
// unchanged.
const buildHandlers = ({ logger, onSuccess, onFailure }) => {
  const log = logger || silent
  return {
    trace: typeof log.trace === 'function' ? (...args) => log.trace(...args) : noop,
    debug: typeof log.debug === 'function' ? (...args) => log.debug(...args) : noop,
    info: typeof log.info === 'function' ? (...args) => log.info(...args) : noop,
    warn: typeof log.warn === 'function' ? (...args) => log.warn(...args) : noop,
    error: typeof log.error === 'function' ? (...args) => log.error(...args) : noop,
    fatal: typeof log.fatal === 'function' ? (...args) => log.fatal(...args) : noop,
    onSuccess,
    onFailure
  }
}

// @internal — exported under an underscore-prefixed alias for unit tests only.
// Not part of the public package surface.
export { buildHandlers as _buildHandlersForTests }

/**
 * mohdel factory.
 *
 * @param {object} [opts]
 * @param {object} [opts.logger]               — logger object with `{trace, debug, info, warn, error, fatal}`
 *                                                methods. Defaults to `silent` from './logger.js'. See the
 *                                                `buildHandlers` comment above for the canonical shape and how
 *                                                stateful loggers (pino, winston) are supported via
 *                                                `this`-preserving closures.
 * @param {number} [opts.verbosity]             — internal log verbosity tier (0/1/2). Defaults to env
 *                                                `MOHDEL_VERBOSITY` if set, otherwise 1. See the verbosity
 *                                                comment near `parseVerbosity` for what each tier emits.
 * @param {Function} [opts.onSuccess]           — fired after every successful answer call
 * @param {Function} [opts.onFailure]           — fired after every failed answer call
 * @param {number} [opts.cooldownThreshold=3]   — consecutive provider failures before cooldown
 * @param {number} [opts.cooldownDuration=60000] — cooldown duration in ms
 * @param {object} [opts.models]                — model catalog (library mode — skips disk init)
 * @param {object} [opts.configurations]        — provider configurations (library mode)
 */
const mohdel = async ({ logger, verbosity: verbosityOpt, onSuccess, onFailure, cooldownThreshold, cooldownDuration, models, configurations } = {}) => {
  // When consumer provides models + configurations, skip disk-based init (library mode).
  // Otherwise load from ~/.config/mohdel/ (CLI / standalone mode).
  const libraryMode = !!(models && configurations)

  if (!libraryMode) {
    loadDefaultEnv()
    await loadCuratedCache()
  }

  // Provider config: user-specific rate limits per provider (~/.config/mohdel/providers.json)
  const providersConfig = libraryMode ? {} : await getProvidersConfig()

  // Resolve verbosity tier once at init. Factory opt > env var > default.
  // Captured in the answer() closure below to gate per-call log lines.
  const verbosity = parseVerbosity(verbosityOpt ?? process.env.MOHDEL_VERBOSITY)

  const handlers = buildHandlers({ logger, onSuccess, onFailure })
  // Expose verbosity so SDK files (anthropic.js, openai.js, etc.) and any
  // downstream consumers reading from `handlers` can gate their own logs.
  handlers.verbosity = verbosity

  // SDK instance cache: providerName → Promise<{ provider, configuration, sdk, specs }>
  // Models from the same provider share one SDK client instance
  const sdkCache = new Map()

  // Rate limiter: throttles requests to stay within provider/model RPM and TPM limits
  const rateLimiter = createRateLimiter()

  // Cooldown: fast-fail after consecutive provider failures. 0.90
  // tracker is injected into the session `run()` by the bridge.
  const cooldown = createCooldownTracker(cooldownThreshold, cooldownDuration)

  // Resolve per-provider rate limits from the factory's local
  // providersConfig — keeps `setProviderRateLimit` / etc. working
  // as the source of truth inside this factory instance.
  const resolveProviderLimits = (provider) => providersConfig[provider]

  // Wire common.js module-level logger so file I/O errors route to consumer
  setCommonLogger(handlers)

  return new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'list') {
        return (tag) => { // Sync
          const catalog = libraryMode ? models : getCuratedCacheSnapshot()
          let modelEntries = Object.entries(catalog)
            .filter(([, metadata]) => !metadata.deprecated)

          if (tag) {
            modelEntries = modelEntries.filter(([/* value */, metadata]) =>
              metadata.tags && Array.isArray(metadata.tags) && metadata.tags.includes(tag)
            )
          }

          return modelEntries.map(([value, metadata]) => ({
            value,
            label: metadata.label || metadata.displayName || metadata.model || value.split('/').pop()
          }))
        }
      }

      if (prop === 'use') {
        return (modelId) => { // Sync
          const catalog = libraryMode ? models : getCuratedCacheSnapshot()

          // Parse optional :outputEffort suffix (e.g. "claude-opus:max").
          // Effort levels vary per spec (`thinkingEffortLevels` keys —
          // Anthropic Opus adds `minimal`/`max`; future providers may
          // add their own), so we can't hardcode a keyword list.
          // Instead: tentatively split, look up `base`. If that
          // resolves to a spec, treat the suffix as an effort
          // candidate and defer validation to the spec-aware check
          // below. If `base` doesn't resolve, fall through — the full
          // `modelId` (with colon) gets the normal lookup + "not
          // found" error path.
          let aliasOutputEffort
          const colonIdx = modelId.lastIndexOf(':')
          if (colonIdx > 0) {
            const candidate = modelId.slice(colonIdx + 1)
            const base = modelId.slice(0, colonIdx)
            const baseResolved = libraryMode ? base : expandModelAliasSync(base)
            const baseSpec = catalog[baseResolved] || createFallbackModelSpec(baseResolved)
            if (baseSpec) {
              aliasOutputEffort = candidate
              modelId = base
            }
          }

          let resolvedModelId = libraryMode ? modelId : expandModelAliasSync(modelId)
          let modelSpec = catalog[resolvedModelId]

          if (!modelSpec) {
            modelSpec = createFallbackModelSpec(resolvedModelId)
            if (!modelSpec) {
              if (libraryMode) {
                throw new Error(`Model '${modelId}' not found in provided models.`)
              }
              const suggestions = suggestModels(modelId)
              let msg = `Model '${modelId}' not found in curated models.`
              if (suggestions.length) {
                msg += ' Did you mean?\n' + suggestions.map(s => `  ${s.id}  ${s.label}`).join('\n')
              }
              throw new Error(msg)
            }
          }

          // Handle deprecated models — follow chain up to 5 levels
          const seen = new Set()
          while (modelSpec.deprecated) {
            if (seen.has(resolvedModelId)) {
              throw new Error(`Circular deprecation chain detected at '${resolvedModelId}'.`)
            }
            seen.add(resolvedModelId)
            const replacement = modelSpec.deprecated
            handlers.warn(`[mohdel:catalog] model '${resolvedModelId}' is deprecated, using '${replacement}' instead`)
            const replacementSpec = catalog[replacement]
            if (!replacementSpec) {
              throw new Error(`Model '${resolvedModelId}' is deprecated (replacement: '${replacement}'), but replacement not found.`)
            }
            resolvedModelId = replacement
            modelSpec = replacementSpec
          }

          // Ensure provider is part of modelSpec, critical for SDK operations.
          // sync.js should populate this, but as a safeguard:
          if (!modelSpec.provider) {
            modelSpec.provider = resolvedModelId.split('/')[0]
          }
          const providerConfig = providers[modelSpec.provider]
          if (!providerConfig) {
            throw new Error(`Provider configuration for '${modelSpec.provider}' not found while preparing model '${resolvedModelId}'.`)
          }
          modelSpec = normalizeModelSpec(resolvedModelId, modelSpec, providerConfig)

          // Validate outputEffort alias against model capabilities
          if (aliasOutputEffort) {
            if (!modelSpec.thinkingEffortLevels) {
              throw new Error(`Model '${resolvedModelId}' does not support output effort (no thinkingEffortLevels). Cannot use ':${aliasOutputEffort}' suffix.`)
            }
            if (aliasOutputEffort !== 'none' && !modelSpec.thinkingEffortLevels[aliasOutputEffort]) {
              throw new Error(`Model '${resolvedModelId}' does not support output effort level '${aliasOutputEffort}'. Available: ${Object.keys(modelSpec.thinkingEffortLevels).join(', ')}`)
            }
          }

          return createModelProxy(resolvedModelId, modelSpec, handlers, aliasOutputEffort, sdkCache, rateLimiter, providersConfig, cooldown, configurations, resolveProviderLimits)
        }
      }

      if (prop === 'getProviderRateLimit') {
        return (providerName) => {
          const entry = providersConfig[providerName]
          if (!entry) return null
          const { rpmLimit, tpmLimit } = entry
          return (rpmLimit || tpmLimit) ? { rpmLimit, tpmLimit } : null
        }
      }

      if (prop === 'setProviderRateLimit') {
        return async (providerName, { rpm, tpm } = {}) => {
          const entry = providersConfig[providerName] || (providersConfig[providerName] = {})
          if (rpm != null) entry.rpmLimit = rpm
          if (tpm != null) entry.tpmLimit = tpm
          await saveProvidersConfig(providersConfig)
          return entry
        }
      }

      if (prop === 'clearProviderRateLimit') {
        return async (providerName) => {
          const entry = providersConfig[providerName]
          if (entry) {
            delete entry.rpmLimit
            delete entry.tpmLimit
            if (Object.keys(entry).length === 0) delete providersConfig[providerName]
            await saveProvidersConfig(providersConfig)
          }
        }
      }

      if (prop === 'close') {
        return () => {
          sdkCache.clear()
        }
      }

      return target[prop]
    }
  })
}

const createModelProxy = (resolvedModelId, modelSpec, handlers, aliasOutputEffort, sdkCache, rateLimiter, providersConfig, cooldown, externalConfigurations, resolveProviderLimits) => {
  // modelSpec is the full metadata object for resolvedModelId
  let runtimePromise = null

  const getRuntime = async () => {
    if (runtimePromise) return runtimePromise

    runtimePromise = (async () => {
      const providerName = modelSpec.provider
      const provider = providers[providerName]
      if (!provider) {
        throw new Error(`Provider ${providerName} not supported for model ${resolvedModelId}`)
      }

      // Reuse cached configuration for this provider
      if (sdkCache.has(providerName)) {
        const cached = await sdkCache.get(providerName)
        cached.specs[resolvedModelId] = modelSpec
        return cached
      }

      // Resolve configuration and cache the promise to handle
      // concurrent use() calls.
      const initPromise = (async () => {
        const configuration = externalConfigurations?.[providerName] ?? await resolveProviderConfiguration(provider, providerName)
        const specs = { [resolvedModelId]: modelSpec }
        return { provider, configuration, specs }
      })()

      sdkCache.set(providerName, initPromise)

      try {
        return await initPromise
      } catch (err) {
        sdkCache.delete(providerName)
        throw err
      }
    })().catch(err => {
      runtimePromise = null
      throw err
    })

    return runtimePromise
  }

  return new Proxy({}, {
    get: (target, prop) => {
      if (prop === 'id') {
        return resolvedModelId
      }
      if (prop === 'label') {
        return modelSpec.label || modelSpec.displayName || resolvedModelId.split('/').pop()
      }
      if (prop === 'supportsTools') {
        return !!modelSpec.supportsTools
      }

      if (prop === 'answer') {
        return async (prompt, options = {}) => {
          if (aliasOutputEffort && !options.outputEffort) {
            options.outputEffort = aliasOutputEffort
          }

          // Verbosity tier — captured from handlers (set by the mohdel factory). Used
          // to gate per-call log lines. Read once per call so the closure doesn't have
          // to dereference handlers.verbosity at each gate.
          const verbosity = handlers.verbosity ?? 1

          // OTEL span: child of caller's span (engine inference → mohdel answer)
          const { parentSpan, ...sdkOptions } = options
          const spanAttrs = {
            'gen_ai.request.model': resolvedModelId,
            'gen_ai.system': modelSpec.provider
          }
          if (sdkOptions.outputBudget) spanAttrs['gen_ai.request.max_tokens'] = sdkOptions.outputBudget
          if (sdkOptions.outputEffort) spanAttrs['mohdel.output_effort'] = sdkOptions.outputEffort
          const span = startSpan('mohdel.answer', spanAttrs, parentSpan)

          // Dev visibility: log call entry at debug level. The OTel span carries the
          // same dimensions but is invisible without a configured exporter; this line
          // lets developers see per-call activity directly in their pino output.
          // Gated at verbosity >= 1 (default).
          const startedAt = Date.now()
          if (verbosity >= 1) {
            handlers.debug({ span, provider: modelSpec.provider, model: resolvedModelId, effort: sdkOptions.outputEffort || 'default', budget: sdkOptions.outputBudget || '?', tools: sdkOptions.tools?.length || 0, images: sdkOptions.images?.length || 0 }, '[mohdel:answer] start')
          }

          // Verbose-only request preview at trace level (verbosity >= 2). Compact
          // summary of what's being sent: input shape, system block presence,
          // message count, last user message preview, tool list.
          // Wrapped in try/catch because prompts have wildly varying shapes
          // (string vs structured vs multimodal arrays).
          if (verbosity >= 2) {
            try {
              const reqMeta = {}
              if (typeof prompt === 'string') {
                reqMeta.input = prompt.slice(0, 500)
                reqMeta.inputLength = prompt.length
              } else if (prompt && typeof prompt === 'object') {
                if (prompt.system) {
                  const sysText = Array.isArray(prompt.system)
                    ? prompt.system.map(s => s?.text || '').join('\n')
                    : String(prompt.system)
                  reqMeta.systemPreview = sysText.slice(0, 500)
                  reqMeta.systemLength = sysText.length
                }
                if (Array.isArray(prompt.messages)) {
                  reqMeta.messageCount = prompt.messages.length
                  const last = prompt.messages[prompt.messages.length - 1]
                  if (last) {
                    reqMeta.lastRole = last.role
                    reqMeta.lastContentPreview = typeof last.content === 'string'
                      ? last.content.slice(0, 300)
                      : '[multimodal]'
                  }
                }
              }
              if (sdkOptions.tools?.length) reqMeta.toolNames = sdkOptions.tools.map(t => t.name)
              if (sdkOptions.images?.length) reqMeta.images = sdkOptions.images.length
              handlers.trace({ span, ...reqMeta }, '[mohdel:answer] request')
            } catch (previewErr) {
              handlers.trace({ span, err: previewErr }, '[mohdel:answer] request preview unavailable')
            }
          }

          try {
            // 0.90 session handles cooldown + rate-limit + cost inline;
            // factory-owned trackers are threaded in so
            // `setProviderRateLimit` / factory-scoped cooldown settings
            // remain the source of truth for this factory instance.
            const { configuration: defaultConfiguration } = await getRuntime()
            const effectiveConfiguration = sdkOptions.configuration || defaultConfiguration
            delete sdkOptions.configuration

            const result = await runAnswer({
              provider: modelSpec.provider,
              model: modelSpec.model ?? resolvedModelId.split('/').pop(),
              modelKey: resolvedModelId,
              configuration: effectiveConfiguration,
              prompt,
              options: sdkOptions
            }, { cooldown, limiter: rateLimiter, resolveProviderLimits })

            // End span with result attributes
            const endAttrs = {
              'gen_ai.usage.input_tokens': result.inputTokens || 0,
              'gen_ai.usage.output_tokens': result.outputTokens || 0,
              'mohdel.thinking_tokens': result.thinkingTokens || 0,
              'mohdel.status': result.status
            }
            if (result.cost != null) endAttrs['mohdel.cost'] = result.cost
            if (result.warning) endAttrs['mohdel.warning'] = result.warning
            if (result.timestamps) {
              const start = BigInt(result.timestamps.start)
              const first = BigInt(result.timestamps.first)
              if (first > start) {
                endAttrs['mohdel.time_to_first_token_ms'] = Number(first - start) / 1e6
              }
            }
            endSpanOk(span, endAttrs)

            // Dev visibility: per-call summary at debug level. Mirrors what the OTel
            // span captures so developers see the same data in their pino stream
            // without needing an exporter. Cost is formatted in dollars to 5 decimals
            // (per-call cost is typically sub-cent for short prompts).
            // Gated at verbosity >= 1 (default).
            const totalMs = Date.now() - startedAt
            const ttftMs = endAttrs['mohdel.time_to_first_token_ms']
            if (verbosity >= 1) {
              handlers.debug({
                span,
                status: result.status,
                in: result.inputTokens || 0,
                out: result.outputTokens || 0,
                think: result.thinkingTokens || 0,
                cost: result.cost != null ? result.cost : undefined,
                ttf: ttftMs != null ? Math.round(ttftMs) : undefined,
                total: totalMs,
                warning: result.warning || undefined
              }, '[mohdel:answer] done')
            }

            // Trace-level basic envelope for deep debugging. See
            // LOGGING.md: trace may include user-visible content
            // (prompts, outputs, tool args), so the consumer's log
            // pipeline must treat trace output as sensitive. Output
            // preview truncated to 200 chars. Gated at verbosity >= 1.
            if (verbosity >= 1) {
              handlers.trace({
                span,
                status: result.status,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                thinkingTokens: result.thinkingTokens,
                toolCallCount: result.toolCalls?.length || 0,
                outputPreview: typeof result.output === 'string' ? result.output.slice(0, 200) : null
              }, '[mohdel:answer] result')
            }

            // Verbose-only deep envelope at trace level (verbosity >= 2):
            // - Tool call expansion (id, name, full args) when present
            // - Full output preview (truncated to 2000 chars instead of 200)
            // These are separate lines so they can be filtered independently.
            if (verbosity >= 2) {
              if (result.toolCalls?.length) {
                try {
                  handlers.trace({ span, toolCalls: result.toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) }, '[mohdel:answer] tool_calls')
                } catch (toolErr) {
                  handlers.trace({ span, err: toolErr }, '[mohdel:answer] tool_calls serialization failed')
                }
              }
              if (typeof result.output === 'string' && result.output.length > 0) {
                handlers.trace({ span, output: result.output.slice(0, 2000) }, '[mohdel:answer] output')
              }
            }

            if (handlers.onSuccess) {
              try { handlers.onSuccess(result, { model: resolvedModelId, provider: modelSpec.provider }) } catch (e) { handlers.warn({ span, err: e }, '[mohdel:answer] onSuccess callback error') }
            }

            return result
          } catch (err) {
            endSpanError(span, err)

            // Cooldown-rejected calls are the expected fast-fail path
            // when the provider is in backoff; annotate the span so
            // operators can distinguish these from real adapter errors.
            if (err.message === 'PROVIDER_COOLDOWN') {
              span.setAttribute('mohdel.cooldown', true)
            }

            // Dev visibility: surface failure with provider/model + total latency.
            // Provider SDK files (anthropic.js etc.) emit their own [mohdel:<provider>]
            // warn lines on the underlying error; this is the consolidated boundary
            // line so callers can spot failures without grepping per-provider prefixes.
            const totalMs = Date.now() - startedAt
            handlers.warn({ span, err, provider: modelSpec.provider, model: resolvedModelId, totalMs }, '[mohdel:answer] failed')

            if (handlers.onFailure) {
              try { handlers.onFailure(err, { model: resolvedModelId, provider: modelSpec.provider }) } catch (e) { handlers.warn({ span, err: e }, '[mohdel:answer] onFailure callback error') }
            }

            throw err
          }
        }
      }

      if (prop === 'image') {
        return async (prompt, options = {}) => {
          const { configuration } = await getRuntime()
          return runAnswerImage({
            provider: modelSpec.provider,
            model: modelSpec.model ?? resolvedModelId.split('/').pop(),
            configuration,
            prompt,
            options,
            spec: modelSpec
          })
        }
      }

      if (prop === 'transcribe') {
        return async (audio, options = {}) => {
          const { configuration } = await getRuntime()
          return runAnswerTranscription({
            provider: modelSpec.provider,
            model: modelSpec.model ?? resolvedModelId.split('/').pop(),
            configuration,
            audio,
            options,
            spec: modelSpec
          })
        }
      }

      if (prop === 'setRateLimit') {
        return async ({ rpm, tpm } = {}) => {
          const curatedCache = getCuratedCacheSnapshot()
          const model = curatedCache[resolvedModelId] || (curatedCache[resolvedModelId] = { ...modelSpec })
          if (rpm != null) model.rpmLimit = rpm
          if (tpm != null) model.tpmLimit = tpm
          model.rateLimitScope = 'model'
          await persistCuratedCache()
          return { rpmLimit: model.rpmLimit, tpmLimit: model.tpmLimit }
        }
      }

      if (prop === 'clearRateLimit') {
        return async () => {
          const curatedCache = getCuratedCacheSnapshot()
          const model = curatedCache[resolvedModelId]
          if (model) {
            delete model.rpmLimit
            delete model.tpmLimit
            delete model.rateLimitScope
            await persistCuratedCache()
          }
        }
      }

      if (prop === 'addTag') {
        return async (tag) => {
          if (!isValidTag(tag)) throw new Error(`Invalid tag "${tag}". Tags must match /^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/.`)
          const curatedCache = getCuratedCacheSnapshot()
          const model = curatedCache[resolvedModelId] || (curatedCache[resolvedModelId] = { ...modelSpec })

          model.tags = model.tags || []

          if (!model.tags.includes(tag)) {
            model.tags.push(tag)
            await persistCuratedCache()
          }

          return model.tags
        }
      }

      if (prop === 'removeTag' || prop === 'delTag') {
        return async (tag) => {
          const curatedCache = getCuratedCacheSnapshot()
          const model = curatedCache[resolvedModelId]
          if (!model) return modelSpec.tags || []

          if (model.tags && Array.isArray(model.tags)) {
            model.tags = model.tags.filter(t => t !== tag)
            await persistCuratedCache()
          }

          return model.tags || []
        }
      }

      if (prop === 'listTags' || prop === 'tags') {
        return () => { // Sync
          const curatedCache = getCuratedCacheSnapshot()
          const model = curatedCache[resolvedModelId] || modelSpec
          return model?.tags || []
        }
      }

      if (prop === 'info') {
        return () => { // Sync
          const catalog = externalConfigurations ? null : getCuratedCacheSnapshot()
          return catalog?.[resolvedModelId] ? { ...catalog[resolvedModelId] } : { ...modelSpec }
        }
      }

      return target[prop]
    }
  })
}

export { silent } from './logger.js'
export { loadCuratedCache, getCuratedCacheSnapshot } from './curated-cache.js'
export { effectiveContextLimit } from './utils.js'
export default mohdel
