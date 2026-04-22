/**
 * Answer-result status contract.
 *
 * Three states:
 *   - `completed`  — the call finished normally.
 *   - `tool_use`   — the model emitted tool calls; the caller is
 *                    expected to round-trip results back.
 *   - `incomplete` — the call was cut short (budget, cancel, policy).
 *
 * Rust mirror: `rust/thin-gate/src/protocol.rs::Status`.
 *
 * @module core/status
 */

/** @typedef {('completed'|'tool_use'|'incomplete')} Status */

/**
 * Warning values emitted on `AnswerResult.warning` when status is
 * `incomplete`:
 *   - `insufficientOutputBudget` — the model hit `max_tokens`.
 *   - `cancelled` — the call was aborted via a cancel control
 *     message or `AbortSignal`.
 *
 * Additive: future releases may add new warning strings; consumers
 * should treat unknown warnings as pass-through metadata.
 *
 * @typedef {('insufficientOutputBudget'|'cancelled'|string)} Warning
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
export const WARNING_CANCELLED = 'cancelled'

/**
 * @param {unknown} x
 * @returns {x is Status}
 */
export function isStatus (x) {
  return typeof x === 'string' && STATUSES.includes(/** @type {Status} */(x))
}
