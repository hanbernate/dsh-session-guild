/**
 * Initial-permission resolution for the contractor session, plus the optional
 * pre-publish confirmation.
 *
 * The permission catalog shape differs between host generations; that
 * difference is owned by `lib/compat.js`, so this module only consumes the
 * normalized `{ value, name, sandbox, approval }` options.
 * @module dsh-workspace-guild/lib/permissions
 */

/**
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   settings: import('./config.js').DEFAULTS,
 *   host: object,
 * }} deps
 */
export function createPermissions({ ctx, settings, host }) {
  /** The DSH permission-presets service; this plugin does not work without it. */
  function presets() {
    const service = host.presets()
    if (service === undefined) {
      throw new Error('workspace-guild requires the DSH permission-presets plugin (ctx.permissionPresets)')
    }
    return service
  }

  /**
   * Preset values this deployment can switch to.
   * @returns {Array<{ value: string, name: string, sandbox?: string, approval?: string }>}
   */
  function presetCatalog() {
    try {
      return host.adapter().presetOptions(presets())
    } catch (error) {
      ctx.logger?.warn?.(`workspace-guild: permission catalog is unavailable: ${String(error)}`)
      return []
    }
  }

  /**
   * Pick the initial permission of the contractor session.
   * An explicit argument wins, then the configured default, then the caller's
   * own permission (the `null` configuration).
   * @returns {{ mode: string, name?: string, sandbox?: string, note?: string, current?: string }}
   */
  function resolvePermission(requested, agent) {
    const catalog = presetCatalog()
    const explicit = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined
    if (explicit !== undefined) {
      if (catalog.length === 0) {
        throw new Error('workspace-guild requires DSH permission-presets to expose selectable presets')
      }
      const hit = catalog.find(preset => preset.value === explicit)
      if (hit === undefined) {
        throw new Error(`unknown permission "${explicit}"; available presets: ${catalog.map(preset => preset.value).join(', ')}`)
      }
      return { mode: 'explicit', name: hit.value, sandbox: hit.sandbox }
    }

    const configured = settings.defaultPermissionPreset
    if (configured !== null && configured !== undefined && String(configured).trim() !== '') {
      const wanted = String(configured).trim()
      const hit = catalog.find(preset => preset.value === wanted)
      if (hit !== undefined) return { mode: 'default', name: hit.value, sandbox: hit.sandbox }
      const fallback = catalog.find(preset => preset.value === 'read-only') ?? catalog[0]
      ctx.logger?.warn?.(`workspace-guild: defaultPermissionPreset "${wanted}" is not in the catalog; falling back to "${fallback?.value ?? 'n/a'}"`)
      if (fallback !== undefined) {
        return {
          mode: 'default',
          name: fallback.value,
          sandbox: fallback.sandbox,
          note: `defaultPermissionPreset "${wanted}" is unavailable; used "${fallback.value}"`,
        }
      }
      return { mode: 'default', name: wanted }
    }

    // null / omitted: inherit the caller's current permission.
    const service = presets()
    if (agent === undefined) {
      return { mode: 'inherit', note: 'no Agent-backed session; the contractor keeps the deployment default' }
    }
    let current
    try {
      current = service.current(agent.session)
    } catch (error) {
      return { mode: 'inherit', note: `could not read the caller permission: ${String(error)}` }
    }
    const hit = catalog.find(preset => preset.value === current)
    if (hit !== undefined) return { mode: 'inherit', name: hit.value, sandbox: hit.sandbox }
    return { mode: 'inherit-custom', current }
  }

  /**
   * Write the resolved permission into the new Session once, at creation time.
   * @returns {Promise<string>} The permission label recorded in the quest.
   */
  async function applyPermission(session, permission, agent, notes) {
    const service = presets()
    if (permission.mode === 'inherit-custom') {
      const sandboxPolicy = host.sandboxPolicy()
      let mode
      try {
        mode = sandboxPolicy?.resolve?.({ session: agent.session })?.mode
      } catch {
        mode = undefined
      }
      if (mode !== undefined) {
        try {
          session.append('sandbox/mode', { mode })
        } catch (error) {
          notes.push(`could not inherit the sandbox mode (${String(error)})`)
        }
      }
      let policy
      try {
        policy = host.approvals()?.overrideOf?.(agent.session)
      } catch {
        policy = undefined
      }
      if (policy !== undefined) {
        try {
          session.append('approval/policy', { policy })
        } catch (error) {
          notes.push(`could not inherit the approval policy (${String(error)})`)
        }
      }
      return permission.current ?? 'custom'
    }
    if (permission.name === undefined) {
      notes.push('permissionPresets did not resolve a preset; the contractor session keeps the deployment default permission')
      return 'deployment-default'
    }
    try {
      service.set(session, permission.name)
      return permission.name
    } catch (error) {
      notes.push(`could not set permission "${permission.name}": ${String(error)}`)
      return 'deployment-default'
    }
  }

  /**
   * Ask the user before creating the contractor session. Off unless the deployment
   * opts in with `requireApproval: true`; there is no per-workspace allowlist —
   * every workspace starts automatically.
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async function confirmPublishQuest(agent, exec, workspace, permission, task) {
    if (settings.requireApproval !== true) return { ok: true }
    const service = host.approvals()
    if (service === undefined) {
      return { ok: false, message: 'approval service is unavailable, so the quest was refused instead of starting unconfirmed' }
    }
    let policy
    try {
      policy = service.overrideOf?.(agent.session)
    } catch {
      policy = undefined
    }
    if (policy === 'never') {
      return {
        ok: false,
        message: 'this session never asks for approval (policy "never"); set requireApproval: false for this profile, or switch the session to "ask"',
      }
    }
    const label = `${workspace.title} (${workspace.path})`
    const preview = task.length > 400 ? `${task.slice(0, 400)}…` : task
    let outcome
    try {
      outcome = await service.request({
        agent,
        toolName: 'guild_publish_quest',
        callId: exec.callId,
        reason: `Hand off a requirement to workspace "${workspace.title}"`,
        displayReason: {
          en: `Start a new session in workspace "${label}" with permission "${permission.name ?? permission.current ?? 'inherited'}" and publish this quest?\n\n${preview}`,
          zh: `是否在工作区「${label}」新建会话，以「${permission.name ?? permission.current ?? '继承当前会话'}」权限接收该需求？\n\n${preview}`,
        },
        signal: exec.signal,
      })
    } catch (error) {
      return { ok: false, message: `approval request failed: ${String(error)}` }
    }
    if (outcome !== 'allowed-once') {
      return { ok: false, message: `the quest was not approved (outcome: ${outcome})` }
    }
    return { ok: true }
  }

  return { presetCatalog, resolvePermission, applyPermission, confirmPublishQuest }
}
