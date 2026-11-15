/**
 * `guild_append`: deliver a follow-up instruction to an existing contractor.
 * The quest stays `in_progress` until that contractor reports again.
 * @module dsh-workspace-guild/lib/tools/append
 */

import { randomUUID } from 'node:crypto'

/**
 * @param {object} runtime
 */
export function createAppendTool(runtime) {
  const { settings, workspaces, store, observeContractor, host } = runtime

  return {
    name: 'guild_append',
    description:
      'Append a follow-up instruction to a session created by guild_publish_quest. Use it to ask for corrections or the next step; '
      + 'the message is delivered as a user message in that session and starts a new turn there. The quest keeps its '
      + 'current status, and a completed quest cannot submit a second report.',
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
        },
        required: ['delivered', 'running'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.running ? '追加指令已送达，受托会话正在执行。' : '追加指令已送达，受托会话将开始新一轮。',
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('guild_append requires an Agent-backed session')
      const target = String(args?.sessionId ?? '').trim()
      if (target.length === 0) throw new Error('sessionId must not be empty')
      const message = String(args?.message ?? '').trim()
      if (message.length === 0) throw new Error('message must not be empty')

      const record = await store.byContractor(target)
      if (record === undefined) {
        throw new Error(`session ${target} is not a session that received a quest`)
      }
      if (record.clientSessionId !== String(agent.session.id)) {
        throw new Error(`session ${target} belongs to a quest from another client session`)
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

      await service.prompt({
        sessionId: target,
        requestId: `append-${randomUUID()}`,
        mode: 'queue',
        content: [{ type: 'text', text: `[guild append #${record.id}]\n${message}` }],
      }, exec.signal)

      const observed = await observeContractor(target)
      return { delivered: true, running: observed.running }
    },
  }
}
