/**
 * `guild_report`: the contractor returns a summary to the client session and
 * completes the quest. Delivery happens before the task-state write so a
 * later failure cannot swallow the summary.
 * @module dsh-workspace-guild/lib/tools/report
 */

import { reportRecord, recordBlock } from '../records.js'
import { commitSignal } from '../signals.js'

/**
 * @param {object} runtime
 */
export function createReportTool(runtime) {
  const { settings, sessions, cache, host } = runtime

  return {
    name: 'guild_report',
    description:
      'Report the result of a quest back to the client session. Only a session that received a quest may call '
      + 'this. The summary is delivered to the client session as a user-visible message and the quest is marked '
      + 'completed, which lets the client continue working. Call it once the work is actually done; do not use it for '
      + 'intermediate progress.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Concise result: what changed, key decisions, and anything the client session must confirm.',
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean' },
          to: { type: 'string' },
          questId: { type: 'string' },
        },
        required: ['delivered', 'to', 'questId'],
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `摘要已回报给委托会话 ${value.to}，对应的委托已标记为 completed。`,
        },
        recordBlock(reportRecord({ questId: value.questId })),
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent
      const sessionId = agent?.session?.id
      if (sessionId === undefined) throw new Error('guild_report requires an Agent-backed session')
      const summary = String(args?.summary ?? '').trim()
      if (summary.length === 0) throw new Error('summary must not be empty')

      await cache.ensureContractor(agent.session)
      const record = cache.byContractor(String(sessionId))
      if (record === undefined) {
        throw new Error('this session did not receive a quest, so there is nothing to report back')
      }
      if (record.status === 'completed') {
        throw new Error('this quest was already reported; do not report it twice')
      }

      const service = host.controller()
      if (service === undefined) throw new Error('sessionController is not mounted, so the report cannot be delivered')

      const contractorTitle = await sessions.sessionTitleOf(String(sessionId))
      // Plain text on purpose: `dsh-session:` is the Host's *reference* form,
      // not a link. A raw id fails the receiving turn's parse
      // (`invalid session reference URI`), and a canonical URI makes the Host
      // re-inject the contractor's whole surface into every later client turn.
      const label = record.workspace === undefined || record.workspace === '' ? '受托会话' : `${record.workspace}`
      const text = [
        `[guild report #${record.id} from=${label} session=${String(sessionId)}]`,
        contractorTitle === undefined ? '' : `会话：${contractorTitle}`,
        '',
        summary.slice(0, settings.summaryChars),
      ].filter(line => line !== '').join('\n')

      // Deliver first: admission lands durably in the client inbox, so a
      // later task-state write failure cannot swallow the summary. The
      // `report:` request id and the machine block are the client's durable
      // completion evidence when the cache rebuilds from derived messages.
      await service.prompt({
        sessionId: record.clientSessionId,
        requestId: `report:${record.id}`,
        mode: 'queue',
        content: [
          { type: 'text', text },
          recordBlock(reportRecord({ questId: record.id, contractorSessionId: sessionId, to: record.clientSessionId })),
        ],
      }, commitSignal())
      await cache.patch(record.id, { status: 'completed', reportedAt: Date.now() })

      return { delivered: true, to: record.clientSessionId, questId: record.id }
    },
  }
}
