/**
 * Row configuration for dsh-workspace-guild.
 *
 * The plugin declares no Cordis `Config` schema, so every value is normalized
 * here: unknown keys pass through, and the two size limits fall back to their
 * defaults when a deployment writes a non-positive or non-integer value.
 * @module dsh-workspace-guild/lib/config
 */

export const DEFAULTS = Object.freeze({
  /**
   * Preset key for the contractor session. Read-only by default: the contractor confirms
   * the design first and the user escalates it from that session. Set `null`
   * explicitly to inherit the caller's permission instead.
   */
  defaultPermissionPreset: 'read-only',
  /** Upper bound for the requirement text delivered to the contractor session. */
  maxTaskChars: 20000,
  /** Upper bound for the summary pushed back into the client session. */
  summaryChars: 4000,
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
    maxTaskChars: positiveInteger(merged.maxTaskChars, DEFAULTS.maxTaskChars),
    summaryChars: positiveInteger(merged.summaryChars, DEFAULTS.summaryChars),
  }
}

/** Accept only finite, positive integers; anything else uses the default. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
