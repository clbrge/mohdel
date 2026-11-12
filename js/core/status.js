/**
 * Answer-result status contract.
 *
 * Three states:
 *   - `completed`  — the call finished normally.
 *   - `tool_use`   — the model emitted tool calls; the caller is
 *                    expected to round-trip results back.
 *   - `incomplete` — the call was cut short (budget, abort, policy).
 *
 * Rust mirror: `rust/protocol/src/protocol.rs::Status`.
 *
 * @module core/status
 */

/** @typedef {('completed'|'tool_use'|'incomplete')} Status */

/**
 * Warning values emitted on `AnswerResult.warning` when status is
 * `incomplete`:
 *   - `insufficientOutputBudget` — the model hit its output limit.
 *   - `aborted` — the call was aborted via an abort control
 *     message or `AbortSignal`.
 *   - `contentBlocked` — the provider's safety or policy filter
 *     stopped the reply.
 *   - `contextOverflow` — the reply ran into the context window.
 *   - `malformedResponse` — the provider ended the reply because the
 *     model produced output it could not parse, such as a broken tool
 *     call.
 *   - `unmappedReason` — the provider cut the reply for a reason none
 *     of the above names.
 *
 * Every adapter follows the same rules:
 *   - An `incomplete` result always carries a `warning`, one of the
 *     values above; a provider's own word never goes in `warning`.
 *   - `warningDetail` carries the provider's own reason, as it came,
 *     whenever the provider gives one: its finish reason, or the finer
 *     category it sends with it. `aborted` has none.
 *   - A reason the adapter does not know: on an API one provider
 *     serves, any reason but its normal end is `incomplete` with
 *     `unmappedReason`. On an API many providers serve (Chat
 *     Completions), each provider names its normal ends its own way,
 *     so only the reasons listed as cuts are `incomplete`.
 *   - A stream that ends without the provider's finish is an error,
 *     never a result.
 *   - Tool calls on an `incomplete` result are what streamed before
 *     the cut, never a call to run.
 *
 * Additive: future releases may add new warning strings; consumers
 * should treat unknown warnings as pass-through metadata.
 *
 * @typedef {('insufficientOutputBudget'|'aborted'|'contentBlocked'|'contextOverflow'|'malformedResponse'|'unmappedReason'|string)} Warning
 */

export const STATUS_COMPLETED = 'completed'
export const STATUS_TOOL_USE = 'tool_use'
export const STATUS_INCOMPLETE = 'incomplete'
export const STATUSES = Object.freeze([
  STATUS_COMPLETED,
  STATUS_TOOL_USE,
  STATUS_INCOMPLETE
])

export const WARNING_INSUFFICIENT_OUTPUT_BUDGET = 'insufficientOutputBudget'
export const WARNING_ABORTED = 'aborted'
export const WARNING_CONTENT_BLOCKED = 'contentBlocked'
export const WARNING_CONTEXT_OVERFLOW = 'contextOverflow'
export const WARNING_MALFORMED_RESPONSE = 'malformedResponse'
export const WARNING_UNMAPPED_REASON = 'unmappedReason'
