/**
 * `guild_collect`: read quest reports without waiting.
 *
 * A job-delivered report arrives through `job_output`, which is the client's
 * normal path. This tool exists for the states the job cannot cover: the job
 * is gone (restart, owner disposal), the report was recorded while the client
 * was not live, or the model simply wants the current state of every quest.
 * It never waits, never polls, and never opens a turn.
 *
 * A completed quest's summary comes from three places, in order: the in-memory
 * cache patched by `guild_report`, a live contractor Session rebuilt from its
 * derived messages, or a cold read of the contractor's message-aligned history
 * (the `guild.report` block its own `guild_report` result carries).
 * @module dsh-session-guild/lib/tools/collect
 */

import { REPORT, machineRecord } from '../records.js'
import { commitSignal } from '../signals.js'

/** Message budget for one cold contractor read; the report is its last turn's result. */
const COLD_PAGE_MESSAGES = 200

/**
 * Find the newest round's summary for one quest in a cold history page.
 * Later rounds append a `guild.report` block per round, so the page is folded
 * by round: an old round's report must not answer an open newer round.
 * @param {readonly object[] | undefined} records - `SessionEventsPage.records`.
 * @param {string} questId - quest whose report is wanted.
 * @returns {{ summary: string, round: number } | undefined} the recorded report.
 */
function reportSummaryOf(records, questId) {
  let found
  for (const row of records ?? []) {
    const data = row?.event?.data
    const blocks = []
    if (Array.isArray(data?.content)) blocks.push(...data.content)
    if (Array.isArray(data?.message?.content)) blocks.push(...data.message.content)
    if (blocks.length === 0) continue
    const report = machineRecord({ content: blocks }, REPORT)
    if (report === undefined || String(report.questId) !== String(questId)) continue
    const round = Number.isSafeInteger(report.round) && report.round > 0 ? report.round : 1
    if (found !== undefined && round < found.round) continue
    if (typeof report.summary === 'string' && report.summary !== '') found = { summary: report.summary, round }
  }
  return found
}

/**
 * @param {object} runtime
 */
export function createCollectTool(runtime) {
  const { cache, sessions, host } = runtime

  /**
   * Flag a completed quest whose report job never settled: the summary is
   * readable here, but the job still occupies one of the owner's background
   * slots until someone ends it. The registry is read as the owner (this
   * session — exactly the caller), which is the access the fence allows; any
   * refusal means there is no live job to flag. This is the client-visible
   * signal for a settlement handle an instance reload lost: without it a
   * zombie job is silent — the notice never fires because settlement never
   * happens.
   * @param {object} record - quest record from the client cache.
   * @param {string} ownerSessionId - the calling (owner) session id.
   * @returns {string | undefined} the cleanup note, when the job is still live.
   */
  function zombieNote(record, ownerSessionId) {
    if (record.status !== 'completed' || record.delivery !== 'job') return undefined
    const jobId = typeof record.jobId === 'string' && record.jobId !== '' ? record.jobId : undefined
    if (jobId === undefined) return undefined
    const jobs = host.jobs()
    if (jobs === undefined || typeof jobs.get !== 'function') return undefined
    let status
    try {
      status = jobs.get(jobId, ownerSessionId)?.status
    } catch {
      return undefined
    }
    if (status !== 'running' && status !== 'stopping') return undefined
    return `回报已记录，但任务 ${jobId} 仍处 ${status}（结算句柄可能因插件热重载丢失），名额仍被占用；`
      + '可用 job_kill 结束它释放名额（不会改动本条已完成的委托记录）'
  }

  /**
   * Pick up a report the live cache has not seen yet.
   * @param {object} record - quest record from the client cache.
   * @returns {Promise<string | undefined>} why the quest state is still unknown, when it is.
   */
  async function refresh(record) {
    if (record.status === 'completed') return undefined
    const live = await sessions.liveSession(record.contractorSessionId)
    if (live !== undefined) {
      await cache.ensureContractor(live)
      return undefined
    }
    const controller = host.controller()
    if (typeof controller?.events !== 'function') return '承包商会话未加载，无法读取其历史'
    try {
      const page = await controller.events({
        address: { kind: 'session', sessionId: record.contractorSessionId },
        maxMessages: COLD_PAGE_MESSAGES,
      }, commitSignal())
      const report = reportSummaryOf(page?.records, record.id)
      if (report === undefined) return '承包商会话未加载，且历史中没有找到该委托的回报'
      const round = Number(record.round) || 1
      if (report.round < round) {
        return `承包商会话未加载，历史中只有第 ${report.round} 轮的旧回报，当前第 ${round} 轮还没有回报`
      }
      await cache.patch(record.id, { status: 'completed', round: report.round, summary: report.summary, reportedAt: Date.now() })
      return undefined
    } catch (error) {
      return `承包商会话未加载，读取历史失败：${String(error?.message ?? error)}`
    }
  }

  return {
    name: 'guild_collect',
    description:
      'Read this session\'s quest reports without waiting. `completed` quests return the contractor\'s summary; '
      + '`in_progress` means no report has arrived yet — a `review` quest may be waiting for the user in the contractor '
      + 'session to confirm, which is normal, not a failure. It never blocks, polls, or opens a turn: use it after a background '
      + 'job notice, after the session was reloaded, or when the user asks what a quest returned. A quest\'s job result is '
      + 'also readable through job_output; this tool additionally covers quests whose job is already gone, and flags a '
      + 'completed quest whose job is still running with the cleanup action (job_kill).',
    parameters: {
      type: 'object',
      properties: {
        questId: {
          type: 'string',
          description: 'Quest to read. Omit it to read every quest of this session.',
        },
      },
      additionalProperties: false,
    },
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
                round: { type: 'integer' },
                jobId: { type: 'string' },
                summary: { type: 'string' },
                note: { type: 'string' },
              },
              required: ['questId', 'sessionId', 'workspace', 'title', 'status', 'round'],
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
            const round = item.round > 1 ? `，第 ${item.round} 轮` : ''
            const head = `${item.status === 'completed' ? '✔' : '◌'} ${item.title} → ${item.workspace}（${item.status}${round}）`
            return [
              head,
              item.jobId === undefined ? '' : `job: ${item.jobId}`,
              item.summary === undefined ? '' : item.summary,
              item.note === undefined ? '' : `注意：${item.note}`,
            ].filter(line => line !== '').join('\n')
          }).join('\n\n'),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_collect requires an Agent-backed session')
      await cache.ensureClient(agent.session)
      const wanted = typeof args?.questId === 'string' && args.questId.trim() !== '' ? args.questId.trim() : undefined
      const records = cache.byClient(String(agent.session.id))
        .filter(record => wanted === undefined || String(record.id) === wanted)
      if (wanted !== undefined && records.length === 0) {
        throw new Error(`no quest ${wanted} belongs to this session`)
      }

      const quests = []
      for (const original of records) {
        const note = await refresh(original)
        const record = cache.get(original.id) ?? original
        const cleanup = note ?? zombieNote(record, String(agent.session.id))
        quests.push({
          questId: String(record.id),
          sessionId: String(record.contractorSessionId),
          workspace: String(record.workspace ?? ''),
          title: String(record.label ?? record.id),
          status: String(record.status ?? 'in_progress'),
          round: Number(record.round) || 1,
          ...(typeof record.jobId === 'string' && record.jobId !== '' ? { jobId: record.jobId } : {}),
          ...(typeof record.summary === 'string' && record.summary !== '' ? { summary: record.summary } : {}),
          ...(cleanup === undefined ? {} : { note: cleanup }),
        })
      }
      return { quests }
    },
  }
}
