/**
 * Row configuration for dsh-session-guild.
 *
 * The plugin declares no Cordis `Config` schema, so every value is normalized
 * here: unknown keys pass through, and the title byte budget falls back to its
 * default when a deployment writes a non-positive or non-integer value. Quest
 * and report lengths have no plugin-side cap; the model decides how long they
 * need to be.
 * @module dsh-session-guild/lib/config
 */

export const DEFAULTS = Object.freeze({
  /**
   * Preset key for the contractor session. Read-only by default: the contractor confirms
   * the design first and the user escalates it from that session. Set `null`
   * explicitly to inherit the caller's permission instead.
   */
  defaultPermissionPreset: 'read-only',
  /**
   * UTF-8 byte budget for the contractor Session title. DSH enforces its own
   * `session-title` `maxTitleBytes` (80 in the shipped profile) on anything it
   * accepts; fitting here first lets the quest title survive instead of the
   * attribution tail being cut mid-character. Keep it at or below the
   * deployment's own limit. When the two disagree, the title is shortened as
   * a whole string by DSH and the attribution preference is lost.
   */
  titleMaxBytes: 80,
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
    titleMaxBytes: positiveInteger(merged.titleMaxBytes, DEFAULTS.titleMaxBytes),
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
