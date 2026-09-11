/**
 * The output cap.
 *
 * `outputBudget` on the envelope is a request, not a promise. Providers
 * disagree on what happens when it exceeds the model's own ceiling: some
 * reject the call outright, others silently serve fewer tokens than asked
 * for. Neither is useful to a caller, so mohdel never sends more than
 * `spec.outputTokenLimit`.
 *
 * Adapters that add thinking headroom on top of the budget apply the cap
 * *after* that addition — the sum is what reaches the wire, so the sum is
 * what has to fit. Capping before would let the headroom push it back over.
 *
 * A spec carrying no `outputTokenLimit` cannot be capped and the caller's
 * number is sent as given; that is the concrete cost of leaving the field
 * out (docs/CATALOG.md).
 *
 * The catalog's `outputCapStrategy` records which of the two provider
 * behaviours applies. It is informational — published for embedders that
 * build their own provider requests rather than going through a session —
 * and mohdel caps regardless of its value.
 *
 * @param {unknown} requested
 * @param {unknown} outputTokenLimit
 * @returns {unknown} `requested`, capped when both numbers are known.
 */
export const capOutput = (requested, outputTokenLimit) => {
  if (typeof requested !== 'number' || typeof outputTokenLimit !== 'number') return requested
  return Math.min(requested, outputTokenLimit)
}
