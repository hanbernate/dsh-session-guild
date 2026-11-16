/**
 * `guild_append`: deliver a follow-up instruction to an existing contractor.
 *
 * Two cases, and the difference is what the client can wait for:
 *
 * - `in_progress`: the current round is still open, so the message is only
 *   delivered (steering). No receiver is registered and the round does not
 *   change; the contractor's report settles the round that is already open.
 * - `completed`: the follow-up needs a new answer, so it opens round N+1. The
 *   new `guild-quest` job is registered **first** (owner: the client session),
 *   the record is reopened with the new round and job id, and only then is the
 *   message delivered. A host that cannot register the job therefore fails
 *   before the quest is reopened.
 *
 * `cancelled`/`failed` quests refuse an append: there is no receiver to settle
 * and no open round to continue, so the caller must publish a new quest.
 * @module dsh-session-guild/lib/tools/append
 */

import { randomUUID } from 'node:crypto'
import { questRecord, recordBlock } from '../records.js'

/**
 * @param {object} runtime
 */
export function createAppendTool(runtime) {
  const { settings, workspaces, cache, observeContractor, host, questJobs } = runtime

  return {
    name: 'guild_append',
    description:
      'Append a follow-up instruction to a session created by guild_publish_quest. Use it to ask for corrections, the next step, '
      + 'or a missing detail. The message is delivered as a user message in that session and starts a new turn there. '
      + 'When the quest is in_progress the message is only delivered (steering): the open round stays open and no new report job '
      + 'is registered. When the quest is completed the append opens the next round: a new guild-quest job is registered for this '
      + 'session and the contractor reports once more for that round. A cancelled or failed quest cannot be appended; publish a new '
      + 'quest instead.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The contractor session id returned by guild_publish_quest.' },
        message: { type: 'string', description: 'The follow-up instruction.' },
      },
      required: ['sessionId', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean' },
          running: { type: 'boolean' },
          questId: { type: 'string' },
          clientSessionId: { type: 'string' },
          sessionId: { type: 'string' },
          workspace: { type: 'string' },
          workspacePath: { type: 'string' },
          permission: { type: 'string' },
          round: { type: 'integer' },
          delivery: { type: 'string' },
          jobId: { type: 'string' },
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
        },
        required: ['delivered', 'running', 'questId', 'clientSessionId', 'sessionId', 'workspace', 'workspacePath', 'permission', 'round', 'delivery'],
        additionalProperties: false,
      },
      /**
       * The durable side of the append is this `guild.quest` block: a cold
       * client cache folds it in message order and reopens the round.
       */
      render: (_args, value) => [
        {
          type: 'text',
          text: value.round > 1
            ? `追加指令已送达（第 ${value.round} 轮，受托会话将开始新一轮）。`
            : `追加指令已送达（第 ${value.round} 轮仍在进行，受托会话收到的是 steering 指令，不会新开任务）。`,
        },
        recordBlock(questRecord({
          questId: value.questId,
          clientSessionId: value.clientSessionId,
          contractorSessionId: value.sessionId,
          workspace: value.workspace,
          workspacePath: value.workspacePath,
          permission: value.permission,
          delivery: value.delivery,
          round: value.round,
          ...(value.selection === undefined ? {} : { selection: value.selection }),
          ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
        })),
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_append requires an Agent-backed session')
      const target = String(args?.sessionId ?? '').trim()
      if (target.length === 0) throw new Error('sessionId must not be empty')
      const message = String(args?.message ?? '').trim()
      if (message.length === 0) throw new Error('message must not be empty')

      await cache.ensureClient(agent.session)
      const record = cache.byContractor(target)
      if (record === undefined) {
        throw new Error(`session ${target} is not a session that received a quest`)
      }
      if (record.clientSessionId !== String(agent.session.id)) {
        throw new Error(`session ${target} belongs to a quest from another client session`)
      }
      if (record.status === 'cancelled' || record.status === 'failed') {
        throw new Error(
          `quest ${record.id} is ${record.status}; it has no open round to continue — publish a new quest instead`,
        )
      }
      if (workspaces.archivedIds().includes(target)) {
        throw new Error(host.adapter().canUnarchive
          ? `session ${target} is archived; call guild_resume to restore it first`
          : `session ${target} is archived and this DSH version has no unarchiveSession; call guild_resume to wake it in place (it stays archived in the sidebar)`)
      }

      const service = host.controller()
      if (service === undefined) throw new Error('sessionController is not mounted, so the follow-up cannot be delivered')

      if (settings.approveAppend === true) {
        const approval = host.approvals()
        if (approval === undefined) throw new Error('approval service is unavailable while approveAppend is enabled')
        const outcome = await approval.request({
          agent,
          toolName: 'guild_append',
          callId: exec.callId,
          reason: `Send a follow-up to the contractor session ${target}`,
          displayReason: {
            en: `Send this follow-up instruction to the contractor session?\n\n${message.slice(0, 400)}`,
            zh: `是否把这条追加指令发送给受托会话？\n\n${message.slice(0, 400)}`,
          },
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') throw new Error(`the follow-up was not approved (outcome: ${outcome})`)
      }

      const reopening = record.status === 'completed'
      const round = reopening ? (Number(record.round) || 1) + 1 : (Number(record.round) || 1)
      let delivery = record.delivery === 'job' ? 'job' : 'prompt'
      let jobId

      if (reopening) {
        // Register the next round's receiver before the quest is reopened: a
        // host that cannot carry the report fails here, with the record still
        // completed, instead of leaving an open round that nothing can settle.
        try {
          const started = questJobs.start(
            { ...record, round },
            exec.callId === undefined ? undefined : { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
          )
          delivery = started.delivery
          if (started.jobId !== undefined) jobId = started.jobId
        } catch (error) {
          throw new Error(
            `quest ${record.id} could not open round ${round} in session ${target}: `
            + `no background job could carry its report (${String(error?.message ?? error)})`,
          )
        }
        await cache.patch(record.id, {
          status: 'in_progress',
          round,
          delivery,
          ...(jobId === undefined ? { jobId: undefined } : { jobId }),
        })
      }

      const block = questRecord({
        questId: record.id,
        clientSessionId: record.clientSessionId,
        contractorSessionId: target,
        workspace: record.workspace,
        workspacePath: record.workspacePath,
        permission: record.permission,
        delivery,
        round,
        ...(record.selection === undefined ? {} : { selection: record.selection }),
        ...(jobId === undefined ? {} : { jobId }),
      })

      try {
        await service.prompt({
          sessionId: target,
          requestId: `append-${randomUUID()}`,
          mode: 'queue',
          content: [
            {
              type: 'text',
              text: reopening
                ? `[guild append #${record.id} round=${round}]\n受托会话已进入第 ${round} 轮：这是委托方的新要求，完成后请再次调用 guild_report 汇报本轮摘要。\n${message}`
                : `[guild append #${record.id} round=${round}]\n${message}`,
            },
            recordBlock(block),
          ],
        }, exec.signal)
      } catch (error) {
        if (reopening) {
          // Undo the reopen: the new job will never be settled, and the quest
          // keeps the answer it already had. This is a wholesale restore, not a
          // fold: the round never durably opened (no tool result carries it).
          questJobs.fail(record.id, `round ${round} delivery failed: ${String(error?.message ?? error)}`, round)
          await cache.replace(record.id, record)
        }
        throw new Error(`session ${target} did not receive the follow-up: ${String(error?.message ?? error)}`)
      }

      const observed = await observeContractor(target)
      return {
        delivered: true,
        running: observed.running,
        questId: record.id,
        clientSessionId: record.clientSessionId,
        sessionId: target,
        workspace: String(record.workspace ?? ''),
        workspacePath: String(record.workspacePath ?? ''),
        permission: String(record.permission ?? ''),
        round,
        delivery,
        ...(jobId === undefined ? {} : { jobId }),
        ...(record.selection === undefined ? {} : { selection: record.selection }),
      }
    },
  }
}
