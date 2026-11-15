/**
 * DSH host compatibility adapters for dsh-workspace-guild.
 *
 * The Guild talks to the Harness through Cordis services, and the rc line moved
 * four of those contracts at different times:
 *
 * | Generation | rc range          | permissionPresets.catalog | workingDirectory.get | sessionController.state | workspaceRegistry.unarchiveSession | tools `when` |
 * | ---------- | ----------------- | ------------------------- | -------------------- | ----------------------- | ---------------------------------- | ------------ |
 * | latest     | 0.2.2-rc.1+       | yes                       | yes                  | yes                     | yes                                | yes          |
 * | v2         | 0.1.7-rc.1–0.2.1  | yes                       | 0.2.1+ only          | no                      | yes                                | no           |
 * | v1         | 0.1.2-rc.1–0.1.5  | no                        | no                   | no                      | no                                 | no           |
 * | v0         | < 0.1.2           | –                         | –                    | –                       | –                                  | –            |
 *
 * This module mirrors the adapter pattern used by dsh-save-button: one adapter
 * per live host generation, chosen by probing the actual Cordis context instead
 * of reading a version string, so a partially composed profile still gets a
 * truthful fallback. `lib/` calls only the selected adapter's interface; adding
 * a future generation means appending an adapter here.
 *
 * Adapters never throw for an absent capability: they return the degraded
 * value (`undefined`, `false`, or `[]`) and the caller records a note.
 * @module dsh-workspace-guild/lib/compat
 */

/** Built-in permission preset names, used only when the host exposes no name list. */
export const PRESET_FALLBACKS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access'])

/** Event emitted after a Session was archived (0.2.2-rc.1+). */
export const ARCHIVED_EVENT = 'workspace/session-archived'
/** Event emitted before a Session is stopped/archived (0.1.7-rc.1–0.2.1). */
export const STOP_EVENT = 'workspace/session-stop'

const service = (ctx, name) => {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

const hasFunction = (target, key) => typeof target?.[key] === 'function'

/**
 * Probe the live Cordis context for every capability the Guild adapts.
 *
 * Capabilities, not versions: a bundled/headless profile may mount only some
 * of a version's services, and a plugin must describe that deployment rather
 * than assume the release notes. `tools.resolve`/`tools.executable` appear
 * together with `ToolRegistrationOptions.when` in 0.2.2-rc.1, which is the only
 * runtime signal for per-step visibility.
 * @param ctx - Host plugin context.
 * @returns a frozen capability record.
 */
export function detectCapabilities(ctx) {
  const controller = service(ctx, 'sessionController')
  const presets = service(ctx, 'permissionPresets')
  const registry = service(ctx, 'workspaceRegistry')
  const directory = service(ctx, 'workingDirectory')
  const tools = service(ctx, 'tools')
  return Object.freeze({
    sessionController: hasFunction(controller, 'create') && hasFunction(controller, 'prompt'),
    controllerState: hasFunction(controller, 'state'),
    presetCatalog: hasFunction(presets, 'catalog'),
    presetNames: hasFunction(presets, 'optionOf'),
    workingDirectory: hasFunction(directory, 'get'),
    unarchive: hasFunction(registry, 'unarchiveSession'),
    toolWhen: hasFunction(tools, 'resolve') && hasFunction(tools, 'executable'),
  })
}

/** Normalize `{ value, name, sandbox, approval }` from host catalog options. */
function normalizeOptions(presets, options) {
  const result = []
  for (const option of Array.isArray(options) ? options : []) {
    const value = option?.value
    if (typeof value !== 'string' || value.length === 0) continue
    try {
      const spec = presets.resolve(value)
      if (spec === undefined) continue
      result.push({
        value,
        name: typeof option.name === 'string' && option.name.length > 0 ? option.name : value,
        sandbox: spec.sandbox,
        approval: spec.approval,
      })
    } catch {
      // Advertised but not switchable (auto/custom) entries are skipped.
    }
  }
  return result
}

/**
 * Read the full catalog a modern host exposes (`permissionPresets.catalog()`).
 * @param presets - the permissionPresets service, or undefined.
 * @returns normalized preset options; `[]` when the service is absent.
 */
export function catalogPresetOptions(presets) {
  if (presets === undefined) return []
  let catalog
  try {
    catalog = presets.catalog?.()
  } catch {
    return []
  }
  const options = Array.isArray(catalog?.defaultOptions) && catalog.defaultOptions.length > 0
    ? catalog.defaultOptions
    : catalog?.options ?? []
  return normalizeOptions(presets, options)
}

/**
 * Synthesize the catalog on 0.1.2–0.1.5, which expose `names` + `optionOf` but
 * no `catalog()`. When even `names` is absent, probe the three documented
 * built-in presets through `resolve`.
 * @param presets - the permissionPresets service, or undefined.
 * @returns normalized preset options; `[]` when nothing resolves.
 */
export function namesPresetOptions(presets) {
  if (presets === undefined) return []
  let names
  try {
    names = presets.names
  } catch {
    names = undefined
  }
  if (!Array.isArray(names) || names.length === 0) names = PRESET_FALLBACKS
  const options = []
  for (const value of names) {
    if (typeof value !== 'string' || value.length === 0) continue
    let name = value
    try {
      const option = presets.optionOf?.(value)
      if (typeof option?.name === 'string' && option.name.length > 0) name = option.name
    } catch {
      // The label is cosmetic; resolve() below decides switchability.
    }
    options.push({ value, name })
  }
  return normalizeOptions(presets, options)
}

/**
 * Resolve the current directory through `workingDirectory.get`, falling back to
 * the durable Session header (`0.1.2–0.2.0`, headless deployments).
 * @param directory - the workingDirectory service, or undefined.
 * @param agent - the tool execution agent, or undefined.
 * @returns the directory string, or undefined when neither source has one.
 */
export function directoryViaService(directory, agent) {
  if (directory !== undefined && agent !== undefined) {
    try {
      const resolved = directory.get(agent.session)
      if (typeof resolved === 'string' && resolved.length > 0) return resolved
    } catch {
      // Fall through to the durable header.
    }
  }
  return agent?.session?.header?.cwd
}

/**
 * Read the durable Session header only (`0.1.2–0.1.5`, no workingDirectory service).
 * @param _directory - unused service slot, for interface parity.
 * @param agent - the tool execution agent, or undefined.
 * @returns the header cwd, or undefined.
 */
export function directoryFromHeader(_directory, agent) {
  return agent?.session?.header?.cwd
}

/**
 * Read live execution state (`sessionController.state`, 0.2.2-rc.1+).
 * @param controller - the sessionController service, or undefined.
 * @param sessionId - the observed contractor session.
 * @param signal - abort signal for the read.
 * @returns `{ running, active }`, or undefined when unsupported/unavailable.
 */
export async function sessionState(controller, sessionId, signal) {
  if (!hasFunction(controller, 'state')) return undefined
  try {
    const state = await controller.state({ sessionId }, signal)
    return { running: state?.running === true, active: state?.active === true }
  } catch {
    return undefined
  }
}

/** No live state on this host; callers treat it as idle. */
export const noSessionState = async () => undefined

/**
 * Restore an archived contractor through `workspaceRegistry.unarchiveSession`.
 * @param registry - the workspaceRegistry service.
 * @param sessionId - the archived contractor.
 * @returns true after the session is visible again.
 */
export async function unarchiveSession(registry, sessionId) {
  await registry.unarchiveSession(sessionId)
  return true
}

/** This host has no archive-restore API; the caller records the degradation. */
export const noUnarchive = async () => false

/**
 * Archive a contractor, asking the host to stop its activity as well (0.1.7-rc.1+).
 * @param registry - the workspaceRegistry service.
 * @param sessionId - the contractor to archive.
 */
export function archiveWithStop(registry, sessionId) {
  return registry.archiveSession(sessionId, { stopActivity: true })
}

/**
 * Archive a contractor on 0.1.2–0.1.5, whose `archiveSession` takes only the id.
 * @param registry - the workspaceRegistry service.
 * @param sessionId - the contractor to archive.
 */
export function archivePlain(registry, sessionId) {
  return registry.archiveSession(sessionId)
}

/** `latest` adapter: 0.2.2-rc.1 and later. */
export const latestAdapter = Object.freeze({
  id: 'latest',
  since: '0.2.2-rc.1',
  available: true,
  toolWhen: true,
  canUnarchive: true,
  accepts: capabilities => capabilities.sessionController
    && capabilities.controllerState
    && capabilities.presetCatalog
    && capabilities.unarchive
    && capabilities.toolWhen,
  presetOptions: catalogPresetOptions,
  directory: directoryViaService,
  state: sessionState,
  unarchive: unarchiveSession,
  archive: archiveWithStop,
  archiveEvents: Object.freeze([ARCHIVED_EVENT, STOP_EVENT]),
})

/** `v2` adapter: 0.1.7-rc.1 through 0.2.1. */
export const v2Adapter = Object.freeze({
  id: 'v2',
  since: '0.1.7-rc.1',
  available: true,
  toolWhen: false,
  canUnarchive: true,
  accepts: capabilities => capabilities.sessionController
    && capabilities.presetCatalog
    && capabilities.unarchive,
  presetOptions: catalogPresetOptions,
  directory: directoryViaService,
  state: noSessionState,
  unarchive: unarchiveSession,
  archive: archiveWithStop,
  archiveEvents: Object.freeze([STOP_EVENT]),
})

/** `v1` adapter: 0.1.2-rc.1 through 0.1.5. */
export const v1Adapter = Object.freeze({
  id: 'v1',
  since: '0.1.2-rc.1',
  available: true,
  toolWhen: false,
  canUnarchive: false,
  accepts: capabilities => capabilities.sessionController,
  presetOptions: namesPresetOptions,
  directory: directoryFromHeader,
  state: noSessionState,
  unarchive: noUnarchive,
  archive: archivePlain,
  archiveEvents: Object.freeze([]),
})

/** `v0` fallback: no sessionController (< 0.1.2); only discovery is usable. */
export const v0Adapter = Object.freeze({
  id: 'v0',
  since: '<0.1.2',
  available: false,
  toolWhen: false,
  canUnarchive: false,
  accepts: () => true,
  presetOptions: () => [],
  directory: directoryFromHeader,
  state: noSessionState,
  unarchive: noUnarchive,
  archive: archivePlain,
  archiveEvents: Object.freeze([]),
})

/** Adapters in preference order: latest → v2 → v1 → v0. The first accepting adapter wins. */
export const ADAPTERS = Object.freeze([latestAdapter, v2Adapter, v1Adapter, v0Adapter])

/**
 * Pick the adapter matching the live host capabilities.
 * @param capabilities - result of {@link detectCapabilities}.
 * @returns the first accepting adapter; the v0 fallback always matches.
 */
export function selectAdapter(capabilities) {
  return ADAPTERS.find(adapter => adapter.accepts(capabilities)) ?? v0Adapter
}
