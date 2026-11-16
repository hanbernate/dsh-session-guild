/**
 * `guild_report`: the contractor returns a summary to the client session and
 * completes the quest. A job-delivered report settles the client's background
 * job, whose `result` the client reads with `job_output`; only a quest
 * published in the legacy prompt mode admits a user message.
 * @module dsh-session-guild/lib/tools/report
 */

import { reportRecord, recordBlock, reportRpcId } from '../records.js'
import { commitSignal } from '../signals.js'

/**
 * @param {object} runtime
 */
export function createReportTool(runtime) {
  const { settings, sessions, cache, host, questJobs } = runtime

  return {
    name: 'guild_report',
    description:
      'Report the result of a quest back to the client session. Only a session that received a quest may call '
      + 'this. The summary settles the quest round and its background job: the client session reads it with job_output '
      + '(or guild_collect), so this call does not post a chat message into the client session. Report once per round, '
      + 'when the work is actually done; a second report for the same round is refused. When the client appends a '
      + 'follow-up to a completed quest it opens the next round, and this tool reports that round instead.',
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
          delivery: { type: 'string' },
          settled: { type: 'boolean' },
          to: { type: 'string' },
          questId: { type: 'string' },
          round: { type: 'integer' },
          jobId: { type: 'string' },
        },
        required: ['delivered', 'delivery', 'settled', 'to', 'questId', 'round'],
        additionalProperties: false,
      },
      render: (args, value) => [
        {
          type: 'text',
          text: (() => {
            const round = value.round > 1 ? `第 ${value.round} 轮` : '本轮'
            if (value.settled) {
              return `摘要已交给委托会话 ${value.to} 的后台任务 ${String(value.jobId)}，${round}委托已标记为 completed。`
            }
            if (value.delivery === 'prompt') {
              return `摘要已作为消息投递给委托会话 ${value.to}，${round}委托已标记为 completed。`
            }
            return `摘要已记录到委托账本（被委托人 ${value.questId}），委托会话没有活跃的接收任务；`
              + '它下次用 guild_collect 即可读到。'
          })(),
        },
        recordBlock(reportRecord({
          questId: value.questId,
          round: value.round,
          summary: String(args?.summary ?? '').trim().slice(0, settings.summaryChars),
        })),
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
        throw new Error(
          'this quest round was already reported; the client must call guild_append to open the next round before another report',
        )
      }
      const bounded = summary.slice(0, settings.summaryChars)
      const round = Number(record.round) || 1
      // Quests published before this release carry no `delivery` field and
      // still use the message delivery they were promised; only an explicit
      // `job` delivery settles the client's background job.
      const delivery = record.delivery === 'job' ? 'job' : 'prompt'

      if (delivery === 'prompt') {
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
          bounded,
        ].filter(line => line !== '').join('\n')
        // Deliver first: admission lands durably in the client inbox, so a
        // later quest-state write failure cannot swallow the summary. The
        // `report:` request id and the machine block are the client's durable
        // completion evidence when the cache rebuilds from derived messages.
        await service.prompt({
          sessionId: record.clientSessionId,
          // One request identity per round: round 1 is the historical
          // `report:<questId>`, later rounds append `:r<n>`.
          requestId: reportRpcId(record.id, round),
          mode: 'queue',
          content: [
            { type: 'text', text },
            recordBlock(reportRecord({
              questId: record.id,
              contractorSessionId: sessionId,
              to: record.clientSessionId,
              round,
              summary: bounded,
            })),
          ],
        }, commitSignal())
        await cache.patch(record.id, { status: 'completed', round, summary: bounded, reportedAt: Date.now() })
        return { delivered: true, delivery, settled: false, to: record.clientSessionId, questId: record.id, round }
      }

      // The job result is the delivery: `job_output` hands it out once, and a
      // live waiter suppresses the completion notice entirely. A missing
      // receiver means the job is gone (restart or owner disposal); the report
      // is still recorded so `guild_collect` can return it, but nothing is
      // pushed into the client session.
      const jobId = questJobs.deliver(record.id, {
        status: 'completed',
        result: bounded,
        detail: `reported by ${String(sessionId)}`,
      }, round)
      await cache.patch(record.id, { status: 'completed', round, summary: bounded, reportedAt: Date.now() })
      return {
        delivered: jobId !== undefined,
        delivery,
        settled: jobId !== undefined,
        to: record.clientSessionId,
        questId: record.id,
        round,
        ...(jobId === undefined ? {} : { jobId }),
      }
    },
  }
}
