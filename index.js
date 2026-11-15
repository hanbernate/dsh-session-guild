/**
 * Workspace guild: publish a quest for a task in one DSH workspace to a fresh
 * ordinary Session that belongs to another workspace, track it as a durable
 * quest record, and let the contractor report back so the client can continue.
 *
 * This entry point owns the composition:
 * - `createHost` exposes the optional Cordis services lazily.
 * - `createRuntime` wires the shared helpers once per plugin instance.
 * - `lib/register.js` owns the tool set and its registration lifecycle.
 * - `lib/tools/*.js` holds one tool per file.
 * - `lib/register.js` owns the tool set and the mount/event subscriptions.
 *
 * State model (see docs/architecture.md):
 * - Durable quest state lives in a plugin-owned storage domain (`quests`
 *   table), never in the Session log: an external plugin cannot append a new
 *   event type without corrupting later replays, and Session events cannot be
 *   written while the Session is cold.
 * - The Session log only carries the delivered requirement (contractor) and the
 *   report message (client), which the model needs as context.
 * - Quest status is independent of the contractor Session's state: `in_progress`
 *   until the contractor's model calls `guild_report`, even when it is
 *   idle, waiting for permission, interrupted, or archived.
 * - Nothing resumes on startup. `guild_resume` restores an archived contractor
 *   with `unarchiveSession` (never a new Session) and wakes it.
 *
 * The plugin is dependency free (Node builtins only). It touches host services
 * through soft lookups so a deployment that composes only some of them still
 * loads: `storageDomain`, `workspaceRegistry`, `sessionController`,
 * `permissionPresets`, `sessionTitle`, `approval`, `workingDirectory`,
 * `sandboxPolicy`, `sessions`, `agents`.
 *
 * Every rc-generation difference (permission catalog shape, working directory,
 * live state, archive restore, archive events, per-step tool visibility) lives
 * in `./lib/compat.js`; the runtime and tools only call the selected adapter.
 *
 * @module dsh-workspace-guild
 */

import { detectCapabilities, selectAdapter } from './lib/compat.js'
import { normalizeConfig } from './lib/config.js'
import { createPermissions } from './lib/permissions.js'
import { createRegistration, mountQuestTools } from './lib/register.js'
import { createSessions } from './lib/sessions.js'
import { createStore } from './lib/store.js'
import { createListWorkspacesTool } from './lib/tools/list-workspaces.js'
import { createWorkspaces } from './lib/workspaces.js'
import { commitSignal } from './lib/signals.js'

export const name = 'workspace-guild'

/**
 * `tools` and the DSH permission-presets service are required. The Session
 * services are injected separately before the quest tools mount.
 */
export const inject = ['tools', 'permissionPresets']

/**
 * Build the host facade shared by every tool and helper.
 *
 * Only `tools` is a hard dependency, so every other service is looked up at
 * call time. Adapter selection is deferred until `sessionController` is
 * mounted; until then `adapter()` keeps probing and returns the degraded
 * read-only adapter without pinning the plugin to it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
function createHost(ctx) {
  /** Selected once the Session services are live. */
  let adapter

  return {
    ctx,

    /**
     * The selected adapter. Retries selection until `sessionController` is
     * mounted; the read-only fallback is never cached, so a late mount can
     * still upgrade the plugin.
     */
    adapter() {
      if (adapter !== undefined) return adapter
      const selected = selectAdapter(detectCapabilities(ctx))
      if (selected.available) adapter = selected
      return selected
    },

    /** Pin the adapter chosen by the lifecycle mount. */
    pin(selected) {
      adapter = selected
    },

    registry: () => ctx.get('workspaceRegistry'),
    controller: () => ctx.get('sessionController'),
    presets: () => ctx.get('permissionPresets'),
    titles: () => ctx.get('sessionTitle'),
    approvals: () => ctx.get('approval'),
    workingDirectory: () => ctx.get('workingDirectory'),
    sandboxPolicy: () => ctx.get('sandboxPolicy'),
    sessions: () => ctx.get('sessions'),
    agents: () => ctx.get('agents'),
  }
}

/**
 * Wire the shared helpers once per plugin instance.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {import('./lib/config.js').DEFAULTS} settings - Normalized row config.
 */
function createRuntime(ctx, settings) {
  const host = createHost(ctx)
  const workspaces = createWorkspaces({ host })
  const store = createStore(ctx)
  const sessions = createSessions({ host })
  const permissions = createPermissions({ ctx, settings, host })
  /** Observation only; it never changes quest state. */
  const observeContractor = async sessionId => {
    const archived = workspaces.archivedIds().includes(sessionId)
    const state = await host.adapter().state(host.controller(), sessionId, commitSignal())
    const live = await sessions.liveSession(sessionId)
    return { archived, running: state?.running === true, active: state?.active === true, live: live !== undefined }
  }

  return { ctx, settings, host, workspaces, sessions, permissions, store, observeContractor }
}

/**
 * Register the guild tools for the lifetime of the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {Record<string, unknown>} [config] - Raw row config (no schema is declared).
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const runtime = createRuntime(ctx, settings)
  // `tools` is the plugin's only hard dependency; per-step visibility is a
  // property of the tools service alone (0.2.2-rc.1+), so it can be decided
  // before the optional Session services mount.
  const perStepVisibility = detectCapabilities(ctx).toolWhen
  const registration = createRegistration({ ctx, runtime, perStepVisibility })

  // Discovery is always available, including on hosts older than 0.1.2.
  // `guild_list_workspaces` is registered once at apply time; the Session-backed
  // tools are registered by the registration mount below.
  ctx.effect(() => {
    const dispose = ctx.tools.register(createListWorkspacesTool(runtime))
    return () => dispose()
  })

  // The quest tools need the Session services. Waiting for them here (rather
  // than selecting an adapter during apply) keeps a slow service from pinning
  // the plugin to the read-only fallback, and leaves < 0.1.2 with discovery.
  const dependencies = ['sessionController', 'workspaceRegistry']
  if (typeof ctx.inject === 'function') {
    ctx.inject(dependencies, scope => mountQuestTools({
      ctx,
      scope,
      runtime,
      registration,
    }))
  } else {
    mountQuestTools({ ctx, scope: ctx, runtime, registration })
  }
}
