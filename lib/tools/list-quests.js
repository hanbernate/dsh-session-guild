/**
 * `guild_list_quests`: the client session's cross-workspace quest list.
 * Status is quest state; archived/running are only live observations.
 * A quest shows its current round and the model it was told to use (when the
 * publish named one), so a delegated review can be checked at a glance.
 * @module dsh-session-guild/lib/tools/list-quests
 */

import { selectionLabel } from '../models.js'
import { questMode } from '../quest-mode.js'

/**
 * @param {object} runtime
 */
export function createListQuestsTool(runtime) {
  const { cache, observeContractor, sessions } = runtime

  return {
    name: 'guild_list_quests',
    description:
      'List this session\'s cross-workspace quests. `in_progress` means the contractor session has not reported back yet, '
      + 'even when it is idle, waiting for permission, interrupted, or archived. `completed` appears only after the contractor '
      + 'called guild_report. The current round is shown: guild_append opens the next round after a report. `mode` says '
      + 'whether the quest is human-in-the-loop (`review`, the default: the contractor waits for the user before reporting) '
      + 'or reports when done (`unattended`). Use it to answer "what is still running in other workspaces" and to find '
      + 'archived contractors that guild_resume should restore.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          quests: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                questId: { type: 'string' },
                sessionId: { type: 'string' },
                workspace: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string' },
                mode: { type: 'string' },
                round: { type: 'integer' },
                model: { type: 'string' },
                archived: { type: 'boolean' },
                running: { type: 'boolean' },
                note: { type: 'string' },
              },
              required: ['questId', 'sessionId', 'workspace', 'title', 'status', 'mode', 'round', 'archived', 'running'],
              additionalProperties: false,
            },
          },
        },
        required: ['quests'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.quests.length === 0
          ? '当前没有委托。'
          : value.quests.map(item => {
            const flags = [
              item.status === 'completed' ? '已完成' : undefined,
              item.status === 'failed' ? '失败' : undefined,
              item.archived ? '已归档' : undefined,
              item.running ? '执行中' : undefined,
              item.status === 'in_progress' && !item.archived && !item.running ? '等待中' : undefined,
            ].filter(Boolean).join('，')
            const model = item.model === undefined ? '' : `，模型 ${item.model}`
            const round = item.round > 1 ? `，第 ${item.round} 轮` : ''
            const mode = item.mode === 'unattended' ? '，无人值守' : '，人在环'
            return `${item.status === 'completed' ? '✔' : '◌'} ${item.title} → ${item.workspace}（${flags}${round}${model}${mode}）`
          }).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_list_quests requires an Agent-backed session')
      await cache.ensureClient(agent.session)
      const records = cache.byClient(String(agent.session.id))
      const quests = []
      for (const original of records) {
        // A live contractor's own log is the completion evidence when this
        // client did not see the report settle a job (restart, owner disposal).
        const live = await sessions.liveSession(original.contractorSessionId)
        if (live !== undefined) await cache.ensureContractor(live)
        const record = cache.get(original.id) ?? original
        const observed = await observeContractor(record.contractorSessionId)
        const model = selectionLabel(record.selection)
        quests.push({
          questId: String(record.id),
          sessionId: String(record.contractorSessionId),
          workspace: String(record.workspace ?? ''),
          title: String(record.label ?? record.id),
          status: String(record.status ?? 'in_progress'),
          mode: questMode(record.mode),
          round: Number(record.round) || 1,
          ...(model === undefined ? {} : { model }),
          archived: observed.archived,
          running: observed.running,
          ...(typeof record.note === 'string' && record.note !== '' ? { note: record.note } : {}),
        })
      }
      return { quests }
    },
  }
}
