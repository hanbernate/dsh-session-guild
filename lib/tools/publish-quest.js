/**
 * `guild_publish_quest`: create a fresh ordinary Session in another
 * workspace, seed its permission, cache the quest, and deliver its requirement.
 * @module dsh-session-guild/lib/tools/publish-quest
 */

import { randomUUID } from 'node:crypto'
import { selectionLabel, requestedSelection } from '../models.js'
import { sameDirectory } from '../paths.js'
import { questRecord, recordBlock, questLabel } from '../records.js'
import { questSessionTitle } from '../sessions.js'
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
        runtime.ctx.logger?.warn?.(`session-guild: could not archive contractor ${String(record.contractorSessionId)} of ${clientId}: ${String(error)}`)
      }
    }
  })()
}

/**
 * @param {object} runtime
 */
export function createPublishQuestTool(runtime) {
  const { settings, workspaces, sessions, permissions, models, cache, host, questJobs } = runtime
  const catalog = permissions.presetCatalog()
  const names = catalog.map(preset => preset.value)
  // The permission module owns the default; this file only embeds its wording.
  const defaultText = permissions.defaultPermissionText()
  const permissionField = {
    type: 'string',
    description:
      `Initial permission of the new session. Pick the value that matches what the user asked for. `
      + `When omitted, the contractor starts with ${defaultText}; pass a higher preset only when the quest needs write access. `
      + `available: ${names.length > 0 ? names.join(', ') : '(no permission catalog)'}`,
    ...(names.length > 0 ? { enum: names } : {}),
  }

  return {
    name: 'guild_publish_quest',
    description:
      'Publish a quest: start a fresh ordinary session owned by the target workspace (visible in that workspace\'s sidebar), '
      + 'set its initial permission, and deliver the requirement as its first user message. '
      + 'What it owes you differs from subagent: a subagent gets a task you have already specified in full, runs without human '
      + 'involvement, and is expected to execute exactly that; the contractor session gets only the goal and acceptance '
      + 'criteria and works out the detailed design itself after the quest lands, while the user can open that session, talk '
      + 'to it, and grant it write access as it goes. Keep subagent for a focused, self-contained piece that needs neither '
      + 'supervision nor a sidebar session of its own. '
      + 'Use it whenever the work belongs to a DIFFERENT workspace than the current one; do not reach into that workspace with '
      + 'shell, read, edit, or write tools from this session, publish the quest to a session that belongs there instead. '
      + 'Use it for work that stays in the current workspace too, when this session is already long or the user would rather '
      + 'not follow the details here: naming the current workspace opens a sub-session that carries the long task and reports '
      + 'a summary back, so this session keeps only the goal and the result. A same-workspace sub-session shares this '
      + 'checkout, so do not publish one that edits files you are editing at the same time. '
      + 'Quests are independent — one in another workspace shares no files or state with this one — so keep several in flight '
      + 'and publish the next without waiting for the previous contractor to report.',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Target workspace: id, title, absolute path, or directory basename. The current workspace is allowed and opens a sub-session inside it. Use guild_list_workspaces to discover.',
        },
        quest: {
          type: 'string',
          description: 'The quest: goal and acceptance criteria, self-contained. The contractor session does not see this conversation. Do not include your execution plan or approach; the contractor decides how to do the work.',
        },
        title: {
          type: 'string',
          description:
            'Title of the contractor session: a short name for this quest, shown in that session\'s sidebar entry and in the quest list. '
            + 'Write a title that names the deliverable or the outcome — a few words, at most about 12 Chinese characters — '
            + 'not a sentence, not a restatement of the quest, and no trailing punctuation.',
        },
        permission: permissionField,
        provider: {
          type: 'string',
          description:
            'Optional model provider route for the contractor session (for example "opencode-go"). '
            + 'Give it together with model, or omit both to keep the deployment default model. '
            + 'The selection applies to this one session only; the deployment default model is not changed.',
        },
        model: {
          type: 'string',
          description:
            'Optional model id under provider. Must be available in the host model catalog; an unavailable route '
            + 'fails the publish before the requirement is delivered.',
        },
        reasoning_effort: {
          type: 'string',
          description:
            'Optional reasoning effort for the explicit provider/model. Requires provider and model, and must be '
            + 'one this model advertises.',
        },
      },
      required: ['workspace', 'quest', 'title'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          questId: { type: 'string' },
          sessionId: { type: 'string' },
          clientSessionId: { type: 'string' },
          workspace: { type: 'string' },
          path: { type: 'string' },
          permission: { type: 'string' },
          status: { type: 'string' },
          round: { type: 'integer' },
          selection: {
            type: 'object',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              reasoningEffort: { type: 'string' },
            },
            required: ['provider', 'model'],
            additionalProperties: false,
          },
          notes: { type: 'array', items: { type: 'string' } },
          jobId: { type: 'string' },
        },
        required: ['questId', 'sessionId', 'clientSessionId', 'workspace', 'path', 'permission', 'status', 'round', 'notes'],
        additionalProperties: false,
      },
      /**
       * The second block is a machine-readable record. It is durable, replayable,
       * and visible through `Session.deriveMessages()`, which is where the
       * in-memory cache rebuilds from after a restart.
       */
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `已把委托交给工作区「${value.workspace}」的新会话（${value.sessionId}），初始权限：${value.permission}。`,
            value.selection === undefined
              ? '模型：部署默认模型（未指定）。'
              : `模型：${selectionLabel(value.selection)}（只作用于该会话，部署默认模型不变）。`,
            '该会话已在受托工作区侧栏中；委托状态为 in_progress，完成后受托会话会调用 guild_report 回报，届时自动置为 completed。',
            value.jobId === undefined
              ? '本次回报通过会话消息投递（该宿主没有后台任务服务）。'
              : `回报由后台任务 ${value.jobId} 承载：结果就绪时会以通知唤醒本会话，用 job_output 读取；不要等待或轮询。`,
            ...value.notes.map(note => `注意：${note}`),
          ].join('\n'),
        },
        recordBlock(questRecord({
          questId: value.questId,
          clientSessionId: value.clientSessionId,
          contractorSessionId: value.sessionId,
          workspace: value.workspace,
          workspacePath: value.path,
          permission: value.permission,
          delivery: value.jobId === undefined ? 'prompt' : 'job',
          round: value.round,
          ...(value.selection === undefined ? {} : { selection: value.selection }),
          ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
        })),
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_publish_quest requires an Agent-backed session')

      const quest = String(args?.quest ?? '').trim()
      if (quest.length === 0) throw new Error('quest must not be empty')
      if (quest.length > settings.maxQuestChars) {
        throw new Error(`quest exceeds the ${settings.maxQuestChars} character limit; split it or raise maxQuestChars`)
      }
      // Parse the model arguments before anything is created: a lone provider
      // or a stray reasoning effort must not leave a session behind.
      const wantedSelection = requestedSelection(args)

      const workspace = await workspaces.matchWorkspace(args?.workspace)
      const directory = workspaces.currentDirectory(agent)
      // The current workspace is a valid target: the quest becomes a sub-session
      // beside this one. It shares the same checkout, so the note tells the
      // caller not to edit the same files concurrently.
      const sameWorkspace = await sameDirectory(workspace.path, directory)

      const permission = permissions.resolvePermission(args?.permission, agent)
      const notes = permission.note === undefined ? [] : [permission.note]
      if (sameWorkspace) {
        notes.push(`「${workspace.title}」是本会话所在的工作区：受托会话是与本会话并列的子会话，共用同一份文件，不要让它和本会话同时修改同一批文件。`)
      }

      const approval = await permissions.confirmPublishQuest(agent, exec, workspace, permission, quest)
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

      // Select the model after the permission and before the session is named
      // or a report receiver exists: an unavailable route fails here, so no
      // quest is ever delivered to a session that would run the wrong model.
      let selection
      if (wantedSelection !== undefined) {
        await models.apply(sessionId, wantedSelection, notes)
        selection = wantedSelection
      }

      const label = questLabel(args)
      const sourceWorkspace = await workspaces.currentWorkspace(agent)
      const sourceLabel = sourceWorkspace?.title ?? '来源工作区'
      await sessions.renameSession(sessionId, questSessionTitle(label, sourceLabel, settings.titleMaxBytes), notes)

      const clientTitle = await sessions.sessionTitleOf(String(agent.session.id))
      // The prompt carries only the goal and its context. Planning, approach,
      // and execution steps belong to the contractor; the client wants the result.
      const body = [
        `来自${clientTitle === undefined ? '另一个工作区' : `「${clientTitle}」`}的委托：`,
        quest,
      ].join('\n')

      const record = {
        id: questId,
        clientSessionId: String(agent.session.id),
        contractorSessionId: sessionId,
        workspaceId: String(workspace.id),
        workspace: String(workspace.title ?? ''),
        workspacePath: String(workspace.path ?? ''),
        permission: applied,
        quest,
        label,
        status: 'in_progress',
        delivery: 'prompt',
        round: 1,
        ...(selection === undefined ? {} : { selection }),
        deliveredAt: undefined,
      }

      // Register the report receiver before the requirement lands, so a fast
      // contractor can never report into nothing. The job belongs to this
      // session: "auto" falls back to the legacy message delivery when the
      // host cannot start one, and "job" refuses to publish without it.
      let jobId
      try {
        const started = questJobs.start(record, exec.callId === undefined ? undefined : {
          callId: exec.callId,
          rootCallId: exec.rootCallId ?? exec.callId,
        })
        record.delivery = started.delivery
        if (started.jobId !== undefined) {
          jobId = started.jobId
          record.jobId = jobId
        } else if (settings.reportDelivery === 'auto') {
          notes.push('该宿主没有后台任务服务，回报会作为消息投递到本会话。')
        }
      } catch (error) {
        if (settings.reportDelivery === 'job') {
          cache.add({ ...record, status: 'failed' })
          throw new Error(
            `session ${sessionId} was created in "${workspace.title}" but no background job could carry its report: `
            + `${String(error?.message ?? error)}`,
          )
        }
        notes.push(`后台任务不可用，回报将退化为消息投递：${String(error?.message ?? error)}`)
      }

      // Cache before delivery so the next step sees the quest immediately. The
      // durable copy is the structured tool result in the Session log, not a
      // plugin store.
      cache.add(record)

      try {
        await service.prompt({
          sessionId,
          requestId: questId,
          mode: 'queue',
          content: [{ type: 'text', text: body }, recordBlock(questRecord(record))],
        }, commitSignal())
      } catch (error) {
        questJobs.fail(questId, `quest delivery failed: ${String(error?.message ?? error)}`)
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
        clientSessionId: record.clientSessionId,
        workspace: record.workspace,
        path: record.workspacePath,
        permission: applied,
        status: 'in_progress',
        round: 1,
        ...(selection === undefined ? {} : { selection }),
        notes,
        ...(jobId === undefined ? {} : { jobId }),
      }
    },
  }
}
