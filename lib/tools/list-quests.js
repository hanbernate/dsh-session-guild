/**
 * `guild_list_quests`: the client session's cross-workspace quest list.
 * Status is quest state; archived/running are only live observations.
 * @module dsh-workspace-guild/lib/tools/list-quests
 */

/**
 * @param {object} runtime
 */
export function createListQuestsTool(runtime) {
  const { store, sessions, observeContractor } = runtime

  return {
    name: 'guild_list_quests',
    description:
      'List this session\'s cross-workspace quests. `in_progress` means the contractor session has not reported back yet, '
      + 'even when it is idle, waiting for permission, interrupted, or archived. `completed` appears only after the contractor '
      + 'called guild_report. Use it to answer "what is still running in other workspaces" and to find archived contractors '
      + 'that guild_resume should restore.',
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
                archived: { type: 'boolean' },
                running: { type: 'boolean' },
                note: { type: 'string' },
              },
              required: ['questId', 'sessionId', 'workspace', 'title', 'status', 'archived', 'running'],
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
            return `${item.status === 'completed' ? '✔' : '◌'} ${item.title} → ${item.workspace}（${flags}）`
          }).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_list_quests requires an Agent-backed session')
      const records = await store.byClient(String(agent.session.id))
      const quests = []
      const reports = sessions.reportedIds(agent.session)
      for (const record of records) {
        const observed = await observeContractor(record.contractorSessionId)
        const completed = record.status === 'completed' || reports.has(String(record.id))
        quests.push({
          questId: String(record.id),
          sessionId: String(record.contractorSessionId),
          workspace: String(record.workspace ?? ''),
          title: String(record.label ?? record.id),
          status: completed ? 'completed' : String(record.status ?? 'in_progress'),
          archived: observed.archived,
          running: observed.running,
          ...(typeof record.note === 'string' && record.note !== '' ? { note: record.note } : {}),
        })
      }
      return { quests }
    },
  }
}
