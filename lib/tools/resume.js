/**
 * `guild_resume`: resume open contractor sessions after the user explicitly
 * asks. Nothing resumes automatically on restart. An archived contractor is
 * restored with the original Session (never a new one) and woken in place.
 * @module dsh-workspace-guild/lib/tools/resume
 */

import { randomUUID } from 'node:crypto'

/**
 * @param {object} runtime
 */
export function createResumeTool(runtime) {
  const { workspaces, sessions, store, observeContractor, host } = runtime

  return {
    name: 'guild_resume',
    description:
      'Resume contractor sessions with an open quest after the user explicitly asks to continue them (for example after a Harness restart). '
      + 'Nothing resumes automatically. For every open quest this restores an archived contractor with unarchive (never creates a '
      + 'new session), wakes it with a resume message, and leaves the quest in_progress until that contractor reports. Pass questIds '
      + 'to resume only some of them.',
    parameters: {
      type: 'object',
      properties: {
        questIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional quest ids from guild_list_quests; omit to continue every open quest.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          resumed: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                questId: { type: 'string' },
                sessionId: { type: 'string' },
                restored: { type: 'boolean' },
                delivered: { type: 'boolean' },
                note: { type: 'string' },
              },
              required: ['questId', 'sessionId', 'restored', 'delivered'],
              additionalProperties: false,
            },
          },
        },
        required: ['resumed'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.resumed.length === 0
          ? '没有需要继续的委托。'
          : value.resumed.map(item => {
            const action = item.restored ? '已从归档恢复' : '保持原会话'
            return `${item.questId} → ${item.sessionId}（${action}${item.delivered ? '，已发送继续指令' : '，未发送继续指令'}${item.note === undefined ? '' : `，${item.note}`}）`
          }).join('\n'),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_resume requires an Agent-backed session')
      const service = host.controller()
      if (service === undefined) throw new Error('sessionController is not mounted, so contractors cannot be resumed')

      const wanted = Array.isArray(args?.questIds)
        ? new Set(args.questIds.filter(value => typeof value === 'string'))
        : undefined
      const records = await store.byClient(String(agent.session.id))
      const reports = sessions.reportedIds(agent.session)
      const open = records.filter(record => record.status === 'in_progress'
        && !reports.has(String(record.id))
        && (wanted === undefined || wanted.has(String(record.id))))
      if (open.length === 0) return { resumed: [] }

      const resumed = []
      for (const record of open) {
        const contractorId = String(record.contractorSessionId)
        const outcome = { questId: String(record.id), sessionId: contractorId, restored: false, delivered: false }
        try {
          if (workspaces.archivedIds().includes(contractorId)) {
            const registryService = host.registry()
            if (registryService === undefined) throw new Error('workspaceRegistry is unavailable, so the archived contractor cannot be restored')
            try {
              outcome.restored = await host.adapter().unarchive(registryService, contractorId)
            } catch (error) {
              outcome.note = `从归档恢复失败：${String(error?.message ?? error)}`
            }
            if (!outcome.restored) {
              // 0.1.2–0.1.5 has no unarchiveSession. The contractor can still be
              // woken in place; it simply stays hidden from the sidebar.
              outcome.note = outcome.note ?? '此 DSH 没有 unarchiveSession；受托会话仍在归档列表中，但已唤醒继续执行'
            }
          }
          const observed = await observeContractor(contractorId)
          if (observed.running) {
            outcome.note = '受托会话已在执行，跳过'
            resumed.push(outcome)
            continue
          }
          await service.prompt({
            sessionId: contractorId,
            requestId: `resume-${record.id}-${randomUUID()}`,
            mode: 'queue',
            content: [{
              type: 'text',
              text: `[guild resume #${record.id}]\n用户要求继续这条委托。请接着上一轮的工作做下去，完成后调用 guild_report 汇报摘要。`,
            }],
          }, exec.signal)
          outcome.delivered = true
          await store.patch(record.id, {
            resumedAt: Date.now(),
            resumeCount: (Number(record.resumeCount) || 0) + 1,
          })
        } catch (error) {
          outcome.note = `继续失败：${String(error?.message ?? error)}`
        }
        resumed.push(outcome)
      }
      return { resumed }
    },
  }
}
