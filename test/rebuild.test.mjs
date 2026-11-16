/**
 * Cache rebuild from derived Session messages.
 *
 * The cache must rebuild without persisting anything, without scanning the
 * event log, and without prose regular expressions: only structured
 * `guild.quest` / `guild.report` blocks and the `report:<questId>` request
 * identity count.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQuestCache } from '../lib/cache.js'

function userText(text) {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function recordBlock(record) {
  return { type: 'text', text: JSON.stringify(record) }
}

function publishResult(callId, questId, contractorSessionId, workspace) {
  return {
    role: 'tool',
    toolCallId: callId,
    content: [
      { type: 'text', text: `交给「${workspace}」的新会话（${contractorSessionId}）` },
      recordBlock({
        kind: 'guild.quest',
        questId,
        clientSessionId: 'S1',
        contractorSessionId,
        workspace,
        workspacePath: `/ws/${workspace}`,
        permission: 'read-only',
      }),
    ],
  }
}

function publishCall(callId, quest, title) {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', id: callId, name: 'guild_publish_quest', args: { quest, title } }],
  }
}

test('client cache rebuilds from message order and structured records only', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [
      publishCall('call-1', 'second quest', 'second'),
      publishResult('call-1', 'q-2', 'S2b', 'beta'),
      // Prose that looks like the old marker must never create a record.
      userText('[guild quest #q-decoy client=S1 workspace=/ws/x]'),
      publishCall('call-2', 'first quest', ''),
      publishResult('call-2', 'q-1', 'S2a', 'alpha'),
      // Completion evidence: request identity only, no machine block.
      { role: 'user', source: { kind: 'user', rpcId: 'report:q-1' }, content: [{ type: 'text', text: 'done' }] },
    ],
  }

  await cache.ensureClient(session)

  const records = cache.byClient('S1')
  assert.deepEqual(records.map(record => record.id), ['q-2', 'q-1'], 'message order is the commission order')
  assert.equal(records[0].status, 'in_progress')
  assert.equal(cache.get('q-1').status, 'completed', 'report rpcId completes the quest')
  assert.equal(records[0].contractorSessionId, 'S2b')
  assert.equal(records[0].workspace, 'beta')
  assert.equal(records[0].permission, 'read-only')
  assert.equal(records[0].quest, 'second quest')
  assert.equal(records[0].label, 'second')
  assert.equal(cache.get('q-1').label, 'first quest', 'an empty title falls back to the first quest line')
  assert.equal(cache.get('q-decoy'), undefined, 'no record comes from prose')
  assert.equal('publishedAt' in records[0], false, 'the commission timestamp is gone')
})

test('contractor cache rebuilds from the delivered quest block and report result', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S2',
    inheritedEventCount: 0,
    deriveMessages: () => [
      {
        role: 'user',
        content: [
          { type: 'text', text: '来自另一个工作区的委托：修一下' },
          recordBlock({
            kind: 'guild.quest',
            questId: 'q-1',
            clientSessionId: 'S1',
            contractorSessionId: 'S2',
            workspace: 'beta',
            workspacePath: '/ws/beta',
            permission: 'read-only',
          }),
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-9', name: 'guild_report', args: { summary: 'ok' } }] },
      {
        role: 'tool',
        toolCallId: 'call-9',
        content: [
          { type: 'text', text: '摘要已回报' },
          recordBlock({ kind: 'guild.report', questId: 'q-1' }),
        ],
      },
    ],
  }

  await cache.ensureContractor(session)

  const record = cache.byContractor('S2')
  assert.equal(record.id, 'q-1')
  assert.equal(record.clientSessionId, 'S1')
  assert.equal(record.workspacePath, '/ws/beta')
  assert.equal(record.status, 'completed')
  assert.equal(await cache.hasReceived(session), true)
})

test('the client cache keeps the model selection and the round across a rebuild', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [{
      role: 'tool',
      toolCallId: 'call-1',
      content: [recordBlock({
        kind: 'guild.quest',
        questId: 'q-1',
        clientSessionId: 'S1',
        contractorSessionId: 'S2',
        workspace: 'beta',
        workspacePath: '/ws/beta',
        permission: 'read-only',
        delivery: 'job',
        jobId: 'guild-quest-1',
        round: 2,
        selection: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
      })],
    }],
  }
  await cache.ensureClient(session)
  const record = cache.get('q-1')
  assert.equal(record.round, 2, 'a block that names a round keeps it')
  assert.deepEqual(record.selection, {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  })
  assert.equal(record.delivery, 'job')
  assert.equal(record.jobId, 'guild-quest-1')
})

test('a completed record is not downgraded by a later in-progress record', async () => {
  const cache = createQuestCache()
  cache.add({ id: 'q-1', clientSessionId: 'S1', contractorSessionId: 'S2', status: 'completed' })
  cache.add({ id: 'q-1', clientSessionId: 'S1', contractorSessionId: 'S2', status: 'in_progress' })
  assert.equal(cache.get('q-1').status, 'completed')
})

test('forked sessions are skipped instead of inheriting the parent quests', async () => {
  const cache = createQuestCache()
  const forked = {
    id: 'S9',
    inheritedEventCount: 3,
    deriveMessages: () => [
      publishCall('call-1', 'x', 'x'),
      publishResult('call-1', 'q-1', 'S2', 'beta'),
    ],
  }
  await cache.ensureClient(forked)
  await cache.ensureContractor(forked)
  assert.deepEqual(cache.byClient('S9'), [])
  assert.equal(cache.byContractor('S9'), undefined)
})

test('a compacted-away publish result still yields a minimal completed record', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [{
      role: 'user',
      source: { kind: 'user', rpcId: 'report:q-7' },
      content: [
        { type: 'text', text: '摘要' },
        recordBlock({ kind: 'guild.report', questId: 'q-7', contractorSessionId: 'S2' }),
      ],
    }],
  }
  await cache.ensureClient(session)
  const records = cache.byClient('S1')
  assert.equal(records.length, 1)
  assert.equal(records[0].id, 'q-7')
  assert.equal(records[0].contractorSessionId, 'S2')
  assert.equal(records[0].status, 'completed')
})

test('hosts without derived messages rebuild nothing instead of throwing', async () => {
  const cache = createQuestCache()
  await cache.ensureClient({ id: 'S1' })
  await cache.ensureContractor({ id: 'S2' })
  assert.deepEqual(cache.byClient('S1'), [])
  assert.equal(cache.byContractor('S2'), undefined)
})
