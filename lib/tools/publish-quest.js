/**
 * `guild_publish_quest`: create a fresh ordinary Session in another
 * workspace, seed its permission, cache the quest, and deliver the task.
 * @module dsh-workspace-guild/lib/tools/publish-quest
 */

import { randomUUID } from 'node:crypto'
import { sameDirectory } from '../paths.js'
import { commitSignal } from '../signals.js'

/**
 * Archive every contractor of an archived client Session. This is part of the
 * publish-quest tool: the tool owns the relationship that makes the cascade.
 * A repeated event is a no-op because the contractors are already archived.
 * @param {object} runtime
 * @param {{ sessionId?: unknown }} payload - Archive event payload.
 */
export function cascadeArchive(runtime, payload) {
  const clientId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined
  if (clientId === undefined) return
  void (async () => {
    const clientSession = await runtime.sessions.liveSession(clientId)
    if (clientSession !== undefined) await runtime.cache.ensureClient(clientSession)
    const contractors = runtime.cache.byClient(clientId)
    for (const record of contractors) {
      try {
        const service = runtime.host.registry()
        if (service === undefined) return
        if (runtime.workspaces.archivedIds().includes(record.contractorSessionId)) continue
        await runtime.host.adapter().archive(service, record.contractorSessionId)
      } catch (error) {
        runtime.ctx.logger?.warn?.(`workspace-guild: could not archive contractor ${String(record.contractorSessionId)} of ${clientId}: ${String(error)}`)
      }
    }
  })()
}

/**
 * @param {object} runtime
 */
export function createPublishQuestTool(runtime) {
  const { settings, workspaces, sessions, permissions, cache, host } = runtime
  const catalog = permissions.presetCatalog()
  const names = catalog.map(preset => preset.value)
  const defaultText = settings.defaultPermissionPreset === null || settings.defaultPermissionPreset === undefined
    ? 'the caller session permission (inherited)'
    : `"${String(settings.defaultPermissionPreset)}"`
  const permissionField = {
    type: 'string',
    description:
      `Initial permission of the new session. Pick the value that matches what the user asked for. `
      + `When omitted, the contractor starts with ${defaultText}. available: ${names.length > 0 ? names.join(', ') : '(no permission catalog)'}`,
    ...(names.length > 0 ? { enum: names } : {}),
  }

  return {
    name: 'guild_publish_quest',
    description:
      'Publish a quest in another workspace: start a fresh ordinary session that belongs to the target workspace '
      + '(visible in that workspace\'s sidebar), set its initial permission, and deliver the requirement as its first user message. '
      + 'Use it whenever the work belongs to a DIFFERENT workspace than the current one — the repo, plugin, service, or file '
      + 'path named by the user lives under another registered workspace — including read-only work such as verification, '
      + 'review, debugging, or documentation. Do not reach into another workspace with shell, read, edit, or write tools from '
      + 'this session; publish the quest to a session that belongs there instead. Work that stays in the current workspace does not '
      + 'need a quest. If the target workspace is not obvious, call guild_list_workspaces first. The contractor session works in its '
      + 'own workspace and reports a summary back through guild_report; until then the quest stays in_progress in '
      + 'guild_list_quests. Contractor sessions are independent — one workspace never shares files or state with another — so keep '
      + 'several quests in flight at once and publish the next quest without waiting for the previous contractor to report. '
      + `Permission defaults to ${defaultText}; pass a higher preset only when the task needs write access.`,
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Target workspace: id, title, absolute path, or directory basename; must differ from the current workspace. Use guild_list_workspaces to discover.',
        },
        task: {
          type: 'string',
          description: 'The goal and acceptance criteria, self-contained: the contractor session does not see this conversation. Do not include your execution plan or approach; the contractor decides how to do the work.',
        },
        permission: permissionField,
        description: {
          type: 'string',
          description: 'Optional short label used in the contractor session title and the quest list.',
        },
      },
      required: ['workspace', 'task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          questId: { type: 'string' },
          sessionId: { type: 'string' },
          workspace: { type: 'string' },
          path: { type: 'string' },
          permission: { type: 'string' },
          status: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
        },
        required: ['questId', 'sessionId', 'workspace', 'path', 'permission', 'status', 'notes'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `已把委托交给工作区「${value.workspace}」的新会话（${value.sessionId}），初始权限：${value.permission}。`,
          '该会话已在受托工作区侧栏中；委托状态为 in_progress，完成后受托会话会调用 guild_report 回报，届时自动置为 completed。',
          ...value.notes.map(note => `注意：${note}`),
        ].join('\n'),
      }],
      /**
       * Replayable presentation data used to rebuild the in-memory cache from
       * the client Session log after a restart.
       */
      presentationMeta: (args, value) => {
        const task = String(args?.task ?? '')
        const label = typeof args?.description === 'string' && args.description.trim() !== ''
          ? args.description.trim()
          : task.split('\n')[0].slice(0, 40)
        return {
          kind: 'guild.quest',
          questId: value.questId,
          contractorSessionId: value.sessionId,
          workspace: value.workspace,
          workspacePath: value.path,
          permission: value.permission,
          task,
          label,
        }
      },
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_publish_quest requires an Agent-backed session')

      const task = String(args?.task ?? '').trim()
      if (task.length === 0) throw new Error('task must not be empty')
      if (task.length > settings.maxTaskChars) {
        throw new Error(`task exceeds the ${settings.maxTaskChars} character limit; split it or raise maxTaskChars`)
      }

      const workspace = await workspaces.matchWorkspace(args?.workspace)
      const directory = workspaces.currentDirectory(agent)
      if (await sameDirectory(workspace.path, directory)) {
        throw new Error(`"${workspace.title}" is the current workspace; work in this session instead of publishing a quest to yourself`)
      }

      const permission = permissions.resolvePermission(args?.permission, agent)
      const notes = permission.note === undefined ? [] : [permission.note]

      const approval = await permissions.confirmPublishQuest(agent, exec, workspace, permission, task)
      if (!approval.ok) throw new Error(approval.message ?? 'the quest was not approved')

      const service = host.controller()
      if (service === undefined) {
        throw new Error('sessionController is not mounted in this deployment, so cross-session quest publishing is unavailable')
      }

      const created = await service.create({ workspaceId: workspace.id })
      const sessionId = String(created.sessionId)
      const questId = `q-${randomUUID().slice(0, 8)}`

      const session = await sessions.waitForSession(sessionId)
      if (session === undefined) {
        throw new Error(`session ${sessionId} was created in "${workspace.title}" but never became live; set its permission manually and delete the empty session`)
      }

      const applied = await permissions.applyPermission(session, permission, agent, notes)

      const label = typeof args?.description === 'string' && args.description.trim() !== ''
        ? args.description.trim()
        : task.split('\n')[0].slice(0, 40)
      const sourceWorkspace = await workspaces.currentWorkspace(agent)
      const sourceLabel = sourceWorkspace?.title ?? '来源工作区'
      await sessions.renameSession(sessionId, `🏰 ${label} (from ${sourceLabel})`, notes)

      const clientTitle = await sessions.sessionTitleOf(String(agent.session.id))
      const marker = `[guild quest #${questId} client=${String(agent.session.id)} workspace=${workspace.path}]`
      // The prompt carries only the goal and its context. Planning, approach,
      // and execution steps belong to the contractor; the client wants the result.
      const body = [
        marker,
        `来自${clientTitle === undefined ? '另一个工作区' : `「${clientTitle}」`}的委托：`,
        task,
      ].join('\n')

      const record = {
        id: questId,
        clientSessionId: String(agent.session.id),
        contractorSessionId: sessionId,
        workspaceId: String(workspace.id),
        workspace: String(workspace.title ?? ''),
        workspacePath: String(workspace.path ?? ''),
        permission: applied,
        task,
        label,
        status: 'in_progress',
        publishedAt: Date.now(),
        deliveredAt: undefined,
      }

      // Cache before delivery so the next step sees the quest immediately. The
      // replayable copy is the tool result in the Session log, not a plugin store.
      cache.add(record)

      try {
        await service.prompt({
          sessionId,
          requestId: questId,
          mode: 'queue',
          content: [{ type: 'text', text: body }],
        }, commitSignal())
      } catch (error) {
        cache.patch(questId, {
          status: 'failed',
          note: `delivery failed: ${String(error?.message ?? error)}`,
        })
        throw new Error(`session ${sessionId} was created in "${workspace.title}" but the requirement was not delivered: ${String(error?.message ?? error)}`)
      }

      cache.patch(questId, { deliveredAt: Date.now() })

      return {
        questId,
        sessionId,
        workspace: record.workspace,
        path: record.workspacePath,
        permission: applied,
        status: 'in_progress',
        notes,
      }
    },
  }
}
