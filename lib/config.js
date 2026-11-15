/**
 * Row configuration for dsh-session-guild.
 *
 * The plugin declares no Cordis `Config` schema, so every value is normalized
 * here: unknown keys pass through, and the two size limits fall back to their
 * defaults when a deployment writes a non-positive or non-integer value.
 * @module dsh-session-guild/lib/config
 */

export const DEFAULTS = Object.freeze({
  /**
   * Preset key for the contractor session. Read-only by default: the contractor confirms
   * the design first and the user escalates it from that session. Set `null`
   * explicitly to inherit the caller's permission instead.
   */
  defaultPermissionPreset: 'read-only',
  /** Upper bound for the quest text delivered to the contractor session. */
  maxQuestChars: 20000,
  /** Upper bound for the summary recorded as the quest's report. */
  summaryChars: 4000,
  /**
   * How a contractor's report reaches the client session.
   * - `auto` (default): a background job carries the report when the host
   *   exposes `jobs`; otherwise the legacy prompt delivery is used.
   * - `job`: always use the background job; publishing fails when the host
   *   cannot register one.
   * - `prompt`: legacy behaviour — the report is admitted as a user message
   *   through `sessionController.prompt`, which opens a turn on the client.
   */
  reportDelivery: 'auto',
  /**
   * Ask the user before creating the contractor session.
   * Off by default: every workspace starts automatically. Opt in with
   * `requireApproval: true` when a deployment wants a confirmation card.
   */
  requireApproval: false,
  /** Ask the user before every append message. */
  approveAppend: false,
})

/**
 * Merge raw row config over the defaults and validate the numeric limits.
 * @param {Record<string, unknown> | undefined} raw - Config from the profile patch.
 * @returns {typeof DEFAULTS & Record<string, unknown>} Normalized settings.
 */
export function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }
  return {
    ...merged,
    maxQuestChars: positiveInteger(merged.maxQuestChars, DEFAULTS.maxQuestChars),
    summaryChars: positiveInteger(merged.summaryChars, DEFAULTS.summaryChars),
    reportDelivery: deliveryMode(merged.reportDelivery),
  }
}

/** Accept only the three documented delivery modes; anything else is `auto`. */
function deliveryMode(value) {
  return value === 'job' || value === 'prompt' ? value : DEFAULTS.reportDelivery
}

/** Accept only finite, positive integers; anything else uses the default. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
