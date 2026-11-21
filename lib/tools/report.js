/**
 * `guild_report`: the contractor returns a summary to the client session and
 * completes the quest. A job-delivered report settles the client's background
 * job, whose `result` the client reads with `job_output`; only a quest
 * published in the legacy prompt mode admits a user message.
 *
 * The tool description carries the review gate: a quest is human-in-the-loop
 * by default, so the contractor presents the summary in its own session and
 * waits for the user's approval before calling this. The gate lives in the
 * description because it is the only instruction every contractor reads; no
 * session or plugin state can tell the model which quests are unattended.
 * @module dsh-session-guild/lib/tools/report
 */

import { reportRecord, recordBlock, reportRpcId } from '../records.js'
import { commitSignal } from '../signals.js'

/**
 * @param {object} runtime
 */
export function createReportTool(runtime) {
  const { sessions, cache, host, questJobs } = runtime

  /**
   * Classify why `deliver` found no receiver, using the durable job id the
   * record carries. The registry is read as the owner the record names (the
   * client session — the access the registry's fence allows); any refusal is
   * treated as "gone". The two operational cases read differently for the
   * contractor: a job still `running` lost only its settlement handle (an HMR
   * reload replaced the plugin instance), so the slot is still occupied and
   * `guild_collect` will carry the summary; anything else can never hand out
   * this summary (restart, owner disposal, termination).
   * @param {object} record - quest record (`jobId`, `clientSessionId`).
   * @returns {string | undefined} the tool-result note, when a job id exists.
   */
  function settlementNote(record) {
    const jobId = typeof record.jobId === 'string' && record.jobId !== '' ? record.jobId : undefined
    if (jobId === undefined) return undefined
    const jobs = host.jobs()
    if (jobs === undefined || typeof jobs.get !== 'function') {
      return `后台任务 ${jobId} 已不可查询（宿主 jobs 服务不在），摘要不会作为任务结果交出；`
    }
    let status
    try {
      status = jobs.get(jobId, record.clientSessionId)?.status
    } catch {
      status = undefined
    }
    if (status === 'running') {
      return `后台任务 ${jobId} 仍在运行，但结算句柄已丢失（插件热重载会重建实例）；`
        + '该任务名额仍被占用，委托方可 job_kill 释放；'
    }
    return `后台任务 ${jobId} 已${status === undefined
      ? '不存在（宿主重启、会话释放或已被终止）'
      : `处于终态 ${status}`}，摘要不会作为任务结果交出；`
  }

  return {
    name: 'guild_report',
    description:
      'Report a quest result back to the client session — but only after the user in this session has approved sending '
      + 'it. Only a session that received a quest may call this. '
      + 'A quest is human-in-the-loop by default: finish the work, put the summary and anything the user must decide in '
      + 'front of the user here, and get their go-ahead before you report. Ask with the question tool whether to send it '
      + '("ok, report it", "回报吧"): it waits for the answer, so a clear yes in the same turn is fine. The only exception '
      + 'is a quest published as unattended, whose delivered requirement says to report when done without stopping; that '
      + 'line overrides this rule. Silence is not a declaration of unattended work: a round waiting on a human is a normal '
      + 'state, not a failure, and waiting costs one round-trip while an early report cannot be undone. '
      + 'The summary settles the round and its background job: the client reads it with job_output (or guild_collect) and '
      + 'the quest becomes completed, so this call does not post a chat message into the client session. Report once per '
      + 'round; a second report for the same round is refused. When the client appends a follow-up to a completed quest it '
      + 'opens the next round, and this tool reports that round instead. '
      + 'If the tool result reports that the background job could not be settled, carry that warning into your summary too: '
      + 'the client must know the report is collect-only.',
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
          note: { type: 'string' },
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
              + `${value.note ?? ''}`
              + '它下次用 guild_collect 即可读到。'
          })(),
        },
        recordBlock(reportRecord({
          questId: value.questId,
          round: value.round,
          summary: String(args?.summary ?? '').trim(),
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
          summary,
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
              summary,
            })),
          ],
        }, commitSignal())
        await cache.patch(record.id, { status: 'completed', round, summary, reportedAt: Date.now() })
        return { delivered: true, delivery, settled: false, to: record.clientSessionId, questId: record.id, round }
      }

      // The job result is the delivery: `job_output` hands it out once, and a
      // live waiter suppresses the completion notice entirely. A missing
      // receiver means the job's settlement handle is gone — its owner was
      // disposed, the host restarted, or the plugin instance that registered
      // it was replaced before this bridge shared receivers across instances.
      // The report is still recorded so `guild_collect` can return it, but
      // nothing is pushed into the client session; `settlementNote` says which
      // case it was so the contractor can carry the warning in its summary.
      const jobId = questJobs.deliver(record.id, {
        status: 'completed',
        result: summary,
        detail: `reported by ${String(sessionId)}`,
      }, round)
      await cache.patch(record.id, { status: 'completed', round, summary, reportedAt: Date.now() })
      const settled = jobId !== undefined
      const note = settled ? undefined : settlementNote(record)
      return {
        delivered: settled,
        delivery,
        settled,
        to: record.clientSessionId,
        questId: record.id,
        round,
        ...(jobId === undefined ? {} : { jobId }),
        ...(note === undefined ? {} : { note }),
      }
    },
  }
}
