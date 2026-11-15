/**
 * Signals for writes that the caller's turn must not cancel.
 * @module dsh-workspace-guild/lib/signals
 */

/** A fresh, never-aborted signal for durable writes and quest delivery. */
export const commitSignal = () => new AbortController().signal
