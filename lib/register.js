/**
 * The Guild tool set, registration lifecycle, and mount.
 *
 * `guild_list_workspaces` is registered separately at apply time, so this file owns
 * only the six tools that need the Session services. `ToolRegistrationOptions.when`
 * exists on 0.2.2-rc.1+; older hosts get all five definitions unconditionally
 * and enforce the same ownership checks inside each `execute()`. Registration is repeated
 * when the permission catalog changes, because `guild_publish_quest` advertises the
 * catalog values as an enum.
 * @module dsh-session-guild/lib/register
 */

import { detectCapabilities, selectAdapter } from './compat.js'
import { createAppendTool } from './tools/append.js'
import { createCollectTool } from './tools/collect.js'
import { createListQuestsTool } from './tools/list-quests.js'
import { cascadeArchive, createPublishQuestTool } from './tools/publish-quest.js'
import { createReportTool } from './tools/report.js'
import { createResumeTool } from './tools/resume.js'

/**
 * Tools become visible after the session has published a quest. Records are
 * append-only, so once true this stays true for the rest of the session.
 */
function hasPublishedQuest(runtime) {
  return async context => runtime.cache.hasPublished(context?.agent?.session)
}

/**
 * The contractor sees `guild_report` from its first step: the quest record is saved
 * before the requirement is delivered.
 */
function hasReceivedQuest(runtime) {
  return async context => runtime.cache.hasReceived(context?.agent?.session)
}

/**
 * Build fresh definitions for one registration pass.
 * @param {object} runtime - Composition root created by `index.js`.
 * @returns {Array<{ definition: object, when?: (context: object) => Promise<boolean> }>}
 */
function createToolset(runtime) {
  const published = hasPublishedQuest(runtime)
  const received = hasReceivedQuest(runtime)
  return [
    { definition: createPublishQuestTool(runtime) },
    { definition: createListQuestsTool(runtime), when: published },
    { definition: createCollectTool(runtime), when: published },
    { definition: createAppendTool(runtime), when: published },
    { definition: createResumeTool(runtime), when: published },
    { definition: createReportTool(runtime), when: received },
  ]
}

/**
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   runtime: object,
 *   perStepVisibility: boolean,
 * }} deps
 */
export function createRegistration({ ctx, runtime, perStepVisibility }) {
  let disposers = []

  /** Register the six Session-backed tools (idempotent after `unregister`). */
  function register() {
    disposers = createToolset(runtime).map(({ definition, when }) => perStepVisibility && when !== undefined
      ? ctx.tools.register(definition, { when })
      : ctx.tools.register(definition))
  }

  /** Dispose the current definitions; the next registration replaces them. */
  function unregister() {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Disposal is best effort; the next registration replaces the definition.
      }
    }
    disposers = []
  }

  return { register, unregister }
}

/**
 * Select the adapter, register the tools, and subscribe to catalog/archive
 * events in the injected scope. This is the registration side of the plugin:
 * the tool implementations stay in `lib/tools/`.
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   scope: object,
 *   runtime: object,
 *   registration: ReturnType<typeof createRegistration>,
 * }} deps
 */
export function mountQuestTools({ ctx, scope, runtime, registration }) {
  const selected = selectAdapter(detectCapabilities(ctx))
  if (!selected.available) {
    ctx.logger?.warn?.(
      'session-guild: sessionController is not usable (< DSH 0.1.2); only workspace discovery is registered',
    )
    return
  }
  runtime.host.pin(selected)
  ctx.logger?.info?.(`session-guild: host adapter "${selected.id}" (since DSH ${selected.since})`)

  // `ctx.inject` hands back a scoped context; a plain test/mock context may
  // only have the root effect/on, so fall back to those.
  const effect = typeof scope.effect === 'function' ? scope.effect.bind(scope) : ctx.effect.bind(ctx)
  const on = typeof scope.on === 'function' ? scope.on.bind(scope) : ctx.on.bind(ctx)

  effect(() => {
    registration.register()
    return () => registration.unregister()
  })

  const offCatalog = on('permission-presets/catalog-changed', () => {
    registration.unregister()
    registration.register()
  })
  effect(() => () => offCatalog())

  const offArchiveEvents = selected.archiveEvents.map(event => on(event, payload => cascadeArchive(runtime, payload)))
  effect(() => () => {
    for (const off of offArchiveEvents) off()
  })

  ctx.logger?.info?.(
    `session-guild: registered guild tools (adapter ${selected.id}, default permission: ${runtime.settings.defaultPermissionPreset ?? 'inherit'})`,
  )
}
