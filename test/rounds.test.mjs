/**
 * Append rounds: one report per round, and a follow-up after a report opens the
 * next round.
 *
 * G3: append after `completed` registers a new `guild-quest` job for the client
 * session, reopens the quest with the new round/job, and the contractor can
 * report again — the client's `job_output` (here: the job's settled result)
 * receives the new summary.
 * G4: append while `in_progress` only delivers (steering) and never registers a
 * second receiver; a repeated report for the same round is still refused.
 * G5: a cold cache rebuild folds the blocks in message order
 * (`publish → report → append → report`) and restores both sides.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createQuestCache } from '../lib/cache.js'

const PRESET_SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
}

function makeSession(id, cwd) {
  return {
    id,
    header: { cwd },
    preset: undefined,
    events: [],
    append(type, data) {
      this.events.push({ type, data, seq: this.events.length })
    },
  }
}

function makeJobs() {
  const records = new Map()
  let seq = 0
  return {
    start(spec) {
      const id = `guild-quest-${++seq}`
      const hooks = spec.run({ id, append() {}, updateProgress() {} })
      records.set(id, { id, spec, hooks })
      return id
    },
    get(id) {
      return records.get(id)
    },
    settled(id) {
      return records.get(id).hooks.done
    },
    kill(id, reason) {
      records.get(id).hooks.cancel(reason)
    },
    get count() {
      return records.size
    },
  }
}

function makeCtx(services) {
  const tools = new Map()
  const ctx = {
    get: name => name === 'tools' ? ctx.tools : services[name],
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') services.cleanups.push(cleanup)
    },
    inject(deps, callback) {
      if (deps.every(name => services[name] !== undefined)) return callback(ctx)
      return undefined
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, tools }
}

/** Every pure-JSON block in a prompt's content. */
function recordsOf(request) {
  return (request?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => {
      try {
        return JSON.parse(block.text)
      } catch {
        return undefined
      }
    })
    .filter(record => record !== undefined && typeof record.kind === 'string')
}

function fixture({ promptDeliveryFailure = false, config = {} } = {}) {
  const client = makeSession('S1', '/ws/a')
  const contractor = makeSession('S2', '/ws/b')
  const sessions = new Map([['S1', client], ['S2', contractor]])
  const prompts = []
  const cleanups = []
  const archived = []
  let failNextPrompt = promptDeliveryFailure

  const controller = {
    async create() {
      return { sessionId: 'S2' }
    },
    async prompt(request) {
      if (failNextPrompt && request.sessionId === 'S2') {
        failNextPrompt = false
        throw new Error('prompt rejected')
      }
      prompts.push(request)
      return { accepted: true }
    },
    async state() {
      return { running: false, active: true }
    },
  }

  const services = {
    workspaceRegistry: {
      list: () => [
        { id: 'w-a', title: 'alpha', path: '/ws/a' },
        { id: 'w-b', title: 'beta', path: '/ws/b' },
      ],
      get archivedSessionIds() {
        return archived
      },
      archiveSession(id) {
        if (!archived.includes(id)) archived.push(id)
      },
      unarchiveSession(id) {
        const index = archived.indexOf(id)
        if (index >= 0) archived.splice(index, 1)
      },
    },
    sessionController: controller,
    sessions: { get: id => sessions.get(id) },
    agents: { get: id => (id === 'S1' ? { id, session: client } : undefined) },
    permissionPresets: {
      current: () => 'read-only',
      catalog: () => ({
        options: Object.keys(PRESET_SPECS).map(value => ({ value, name: value })),
        defaultOptions: Object.keys(PRESET_SPECS).map(value => ({ value, name: value })),
        defaultPreset: 'read-only',
      }),
      resolve: name => PRESET_SPECS[name],
      set: (session, name) => { session.preset = name },
    },
    sessionTitle: { get: () => ({ title: 'A' }), rename: () => ({ title: 'renamed' }) },
    approval: { overrideOf: () => undefined, request: async () => 'allowed-once' },
    workingDirectory: { get: session => session.header.cwd },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    jobs: makeJobs(),
    cleanups,
  }
  const built = makeCtx(services)
  apply(built.ctx, config)
  const clientExec = () => ({ agent: { id: 'S1', session: client }, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'call-1' })
  const contractorExec = () => ({ agent: { id: 'S2', session: contractor }, signal: new AbortController().signal, callId: 'call-2' })
  return { ...built, services, client, contractor, prompts, archived, clientExec, contractorExec }
}

const publishArgs = { workspace: 'beta', quest: '评审 diff' }

test('G3: append after completed opens round 2, registers a new job, and the next report settles it', async () => {
  const f = fixture()
  const publish = f.tools.get('guild_publish_quest')
  const report = f.tools.get('guild_report')
  const append = f.tools.get('guild_append')
  const list = f.tools.get('guild_list_quests')
  const collect = f.tools.get('guild_collect')

  const published = await publish.execute(publishArgs, f.clientExec())
  const first = await report.execute({ summary: '第一轮结论' }, f.contractorExec())
  assert.equal(first.jobId, published.jobId)
  assert.equal(first.round, 1)

  const appended = await append.execute({ sessionId: 'S2', message: '补一下验收矩阵' }, f.clientExec())
  assert.equal(appended.delivered, true)
  assert.equal(appended.round, 2)
  assert.notEqual(appended.jobId, published.jobId, 'round 2 has its own report job')
  assert.match(appended.jobId, /^guild-quest-/)

  const job = f.services.jobs.get(appended.jobId)
  assert.equal(job.spec.owner, 'S1', 'the new job belongs to the client session')
  assert.equal(job.spec.label, `${published.questId} (round 2) → beta`)

  // The delivered append carries a guild.quest block with the new round/job,
  // and the prompt is the only message the contractor receives.
  const delivered = f.prompts.at(-1)
  assert.equal(delivered.sessionId, 'S2')
  const block = recordsOf(delivered).find(record => record.kind === 'guild.quest')
  assert.equal(block.round, 2)
  assert.equal(block.jobId, appended.jobId)
  assert.equal(block.clientSessionId, 'S1')
  assert.equal(block.contractorSessionId, 'S2')

  const reopened = await list.execute({}, f.clientExec())
  assert.equal(reopened.quests[0].status, 'in_progress')
  assert.equal(reopened.quests[0].round, 2)
  const opened = await collect.execute({ questId: published.questId }, f.clientExec())
  assert.equal(opened.quests[0].jobId, appended.jobId, 'the reopened record carries the round-2 job id')

  // Second round reports once and settles the new job; the client's job result
  // (job_output's source) is the new summary, not the first one.
  const second = await report.execute({ summary: '第二轮补齐的矩阵' }, f.contractorExec())
  assert.equal(second.settled, true)
  assert.equal(second.round, 2)
  assert.equal(second.jobId, appended.jobId)
  assert.deepEqual(await f.services.jobs.settled(appended.jobId), {
    status: 'completed',
    result: '第二轮补齐的矩阵',
    detail: 'reported by S2',
  })

  const collected = await collect.execute({ questId: published.questId }, f.clientExec())
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].round, 2)
  assert.equal(collected.quests[0].summary, '第二轮补齐的矩阵')

  // No append, no second report: round 2's report is the last one.
  await assert.rejects(
    () => report.execute({ summary: 'again' }, f.contractorExec()),
    /already reported/,
  )
})

test('G4: append while in_progress only steers and never opens a second receiver', async () => {
  const f = fixture()
  const publish = f.tools.get('guild_publish_quest')
  const report = f.tools.get('guild_report')
  const append = f.tools.get('guild_append')

  const published = await publish.execute(publishArgs, f.clientExec())
  const jobCount = f.services.jobs.count

  const steered = await append.execute({ sessionId: 'S2', message: '顺便看下边界' }, f.clientExec())
  assert.equal(steered.delivered, true)
  assert.equal(steered.round, 1)
  assert.equal(steered.jobId, undefined)
  assert.equal(f.services.jobs.count, jobCount, 'steering registers no new report job')
  assert.equal(f.prompts.at(-1).sessionId, 'S2')
  assert.equal(recordsOf(f.prompts.at(-1)).find(record => record.kind === 'guild.quest').round, 1)

  // The already-open round still reports once, into the original job.
  const reported = await report.execute({ summary: '一次到位' }, f.contractorExec())
  assert.equal(reported.round, 1)
  assert.equal(reported.jobId, published.jobId)
  assert.deepEqual(await f.services.jobs.settled(published.jobId), {
    status: 'completed',
    result: '一次到位',
    detail: 'reported by S2',
  })

  await assert.rejects(
    () => report.execute({ summary: 'again' }, f.contractorExec()),
    /already reported/,
  )
})

test('append refuses cancelled and failed quests and points at a new quest', async () => {
  const cancelled = fixture()
  const published = await cancelled.tools.get('guild_publish_quest').execute(publishArgs, cancelled.clientExec())
  cancelled.services.jobs.kill(published.jobId, 'user cancelled')
  await assert.rejects(
    () => cancelled.tools.get('guild_append').execute({ sessionId: 'S2', message: 'x' }, cancelled.clientExec()),
    error => /cancelled/.test(error.message) && /publish a new quest/.test(error.message),
  )

  const failed = fixture({ promptDeliveryFailure: true })
  await assert.rejects(
    () => failed.tools.get('guild_publish_quest').execute(publishArgs, failed.clientExec()),
    /was not delivered/,
  )
  await assert.rejects(
    () => failed.tools.get('guild_append').execute({ sessionId: 'S2', message: 'x' }, failed.clientExec()),
    error => /failed/.test(error.message) && /publish a new quest/.test(error.message),
  )
})

test('append after completed fails before reopening when no job can carry the new round', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  await f.tools.get('guild_report').execute({ summary: '第一轮' }, f.contractorExec())
  const promptsBefore = f.prompts.length
  // Every further receiver registration fails (host lost its jobs service).
  f.services.jobs.start = () => { throw new Error('jobs unavailable') }
  await assert.rejects(
    () => f.tools.get('guild_append').execute({ sessionId: 'S2', message: 'x' }, f.clientExec()),
    error => /could not open round 2/.test(error.message) && /session S2/.test(error.message),
  )
  assert.equal(f.prompts.length, promptsBefore, 'the follow-up was not delivered')
  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.equal(listed.quests[0].status, 'completed', 'the record stays completed instead of a round nothing can settle')
  assert.equal(listed.quests[0].round, 1)
  assert.equal(published.questId, listed.quests[0].questId)
})

test('a failed round-2 delivery rolls the record back to the completed round', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  await f.tools.get('guild_report').execute({ summary: '第一轮' }, f.contractorExec())

  const deliver = f.services.sessionController.prompt
  f.services.sessionController.prompt = async request => {
    if (request.sessionId === 'S2') throw new Error('delivery refused')
    return deliver(request)
  }
  await assert.rejects(
    () => f.tools.get('guild_append').execute({ sessionId: 'S2', message: 'x' }, f.clientExec()),
    /did not receive the follow-up/,
  )

  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.equal(listed.quests[0].status, 'completed')
  assert.equal(listed.quests[0].round, 1, 'the round that never durably opened is not left open')
  const collected = await f.tools.get('guild_collect').execute({ questId: published.questId }, f.clientExec())
  assert.equal(collected.quests[0].summary, '第一轮', 'the previous round answer survives the rollback')
  assert.deepEqual(await f.services.jobs.settled('guild-quest-2'), {
    status: 'failed',
    detail: 'round 2 delivery failed: delivery refused',
  })
})

test('G3: reportDelivery prompt keeps one message per round with a per-round request id', async () => {
  const f = fixture({ config: { reportDelivery: 'prompt' } })
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  assert.equal(published.jobId, undefined, 'the publish uses message delivery')

  const first = await f.tools.get('guild_report').execute({ summary: '第一轮' }, f.contractorExec())
  assert.equal(first.delivery, 'prompt')
  assert.equal(f.prompts.at(-1).requestId, `report:${published.questId}`)
  assert.equal(recordsOf(f.prompts.at(-1)).find(record => record.kind === 'guild.report').round, 1)

  const appended = await f.tools.get('guild_append').execute({ sessionId: 'S2', message: '补一轮' }, f.clientExec())
  assert.equal(appended.round, 2)
  assert.equal(appended.delivery, 'prompt')
  assert.equal(appended.jobId, undefined, 'prompt delivery opens the round without a job')
  const delivered = recordsOf(f.prompts.at(-1)).find(record => record.kind === 'guild.quest')
  assert.equal(delivered.round, 2)
  assert.equal(delivered.delivery, 'prompt')

  const second = await f.tools.get('guild_report').execute({ summary: '第二轮' }, f.contractorExec())
  assert.equal(second.round, 2)
  assert.equal(f.prompts.at(-1).requestId, `report:${published.questId}:r2`)
  const reportBlock = recordsOf(f.prompts.at(-1)).find(record => record.kind === 'guild.report')
  assert.equal(reportBlock.round, 2)
  assert.equal(reportBlock.summary, '第二轮')

  const collected = await f.tools.get('guild_collect').execute({}, f.clientExec())
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].round, 2)
  assert.equal(collected.quests[0].summary, '第二轮')
})

/* ------------------- archived completed quests (G6) ------------------- */

test('G6: an archived contractor of a completed quest can resume → append round 2', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  await f.tools.get('guild_report').execute({ summary: '第一轮结论' }, f.contractorExec())
  f.archived.push('S2')

  // The refusal names the executable path: resume with this quest's id.
  await assert.rejects(
    () => f.tools.get('guild_append').execute({ sessionId: 'S2', message: '补一下边界' }, f.clientExec()),
    error => error.message.includes(`guild_resume with questIds ["${published.questId}"]`),
  )
  assert.equal(
    (await f.tools.get('guild_list_quests').execute({}, f.clientExec())).quests[0].status,
    'completed',
    'the refusal changes nothing',
  )

  // Resume accepts the explicitly named completed quest: restore + wake only —
  // no status change, no report job, the original session restored in place.
  const resumed = await f.tools.get('guild_resume').execute({ questIds: [published.questId] }, f.clientExec())
  assert.equal(resumed.resumed.length, 1)
  assert.equal(resumed.resumed[0].restored, true)
  assert.equal(resumed.resumed[0].delivered, true)
  assert.deepEqual(f.archived, [], 'the original session is restored, not replaced')
  const wake = f.prompts.at(-1)
  assert.equal(wake.sessionId, 'S2')
  assert.match(wake.content[0].text, /guild_append/, 'the wake says what the session is waiting for')
  assert.doesNotMatch(wake.content[0].text, /guild_report 汇报/, 'a settled round must not invite another report')
  assert.equal(
    (await f.tools.get('guild_list_quests').execute({}, f.clientExec())).quests[0].status,
    'completed',
    'resume must not reopen the round or downgrade the record',
  )

  // The append that was deadlocked now opens round 2 with its own job.
  const appended = await f.tools.get('guild_append').execute({ sessionId: 'S2', message: '补一下边界' }, f.clientExec())
  assert.equal(appended.round, 2)
  assert.match(appended.jobId, /^guild-quest-/)
  const second = await f.tools.get('guild_report').execute({ summary: '第二轮结论' }, f.contractorExec())
  assert.equal(second.settled, true)
  assert.deepEqual(await f.services.jobs.settled(appended.jobId), {
    status: 'completed',
    result: '第二轮结论',
    detail: 'reported by S2',
  })

  // Cold rebuild: resume wrote no quest/report block, so the same blocks
  // still fold to completed round 1 on their own (metadata stays metadata).
  const cache = createQuestCache()
  await cache.ensureClient({
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'tool', toolCallId: 'c1', content: [blockOf(questBlock({ questId: published.questId, round: 1, jobId: 'j1' }))] },
      { role: 'tool', toolCallId: 'c2', content: [blockOf(reportBlock({ questId: published.questId, round: 1, summary: '第一轮结论' }))] },
    ],
  })
  assert.equal(cache.get(published.questId).status, 'completed')
  assert.equal(cache.get(published.questId).round, 1)
  assert.equal(cache.get(published.questId).summary, '第一轮结论')
})

test('G6: resume without questIds still skips completed quests', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  await f.tools.get('guild_report').execute({ summary: '第一轮结论' }, f.contractorExec())
  f.archived.push('S2')

  const resumed = await f.tools.get('guild_resume').execute({}, f.clientExec())
  assert.equal(resumed.resumed.length, 0, 'an implicit resume only touches open quests')
  assert.deepEqual(f.archived, ['S2'], 'the archived contractor stays archived')
  assert.equal(
    (await f.tools.get('guild_list_quests').execute({}, f.clientExec())).quests[0].status,
    'completed',
  )
})

test('G6: an explicit resume of an open quest keeps its original wake message', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  f.archived.push('S2')

  const resumed = await f.tools.get('guild_resume').execute({ questIds: [published.questId] }, f.clientExec())
  assert.equal(resumed.resumed.length, 1)
  assert.equal(resumed.resumed[0].restored, true)
  assert.equal(resumed.resumed[0].delivered, true)
  assert.equal(resumed.resumed[0].note, undefined, 'the open-quest path carries no completion note')
  const wake = f.prompts.at(-1)
  assert.match(wake.content[0].text, /guild_report/)
  assert.doesNotMatch(wake.content[0].text, /guild_append/)
  assert.equal(
    (await f.tools.get('guild_list_quests').execute({}, f.clientExec())).quests[0].status,
    'in_progress',
  )
})

/* ----------------------------- cold rebuild (G5) ----------------------------- */

function blockOf(record) {
  return { type: 'text', text: JSON.stringify(record) }
}

function questBlock({ questId = 'q-1', round, jobId, delivery = 'job', client = 'S1', contractor = 'S2' } = {}) {
  return {
    kind: 'guild.quest',
    questId,
    clientSessionId: client,
    contractorSessionId: contractor,
    workspace: 'beta',
    workspacePath: '/ws/beta',
    permission: 'read-only',
    delivery,
    ...(jobId === undefined ? {} : { jobId }),
    ...(round === undefined ? {} : { round }),
  }
}

function reportBlock({ questId = 'q-1', round, summary } = {}) {
  return {
    kind: 'guild.report',
    questId,
    ...(round === undefined ? {} : { round }),
    ...(summary === undefined ? {} : { summary }),
  }
}

test('G5: the client cache folds publish → report → append → report into round 2 completed', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'tool', toolCallId: 'c1', content: [blockOf(questBlock({ round: 1, jobId: 'j1' }))] },
      { role: 'tool', toolCallId: 'c2', content: [blockOf(reportBlock({ round: 1, summary: '第一轮' }))] },
      { role: 'tool', toolCallId: 'c3', content: [blockOf(questBlock({ round: 2, jobId: 'j2' }))] },
      { role: 'tool', toolCallId: 'c4', content: [blockOf(reportBlock({ round: 2, summary: '第二轮' }))] },
    ],
  }
  await cache.ensureClient(session)
  const record = cache.get('q-1')
  assert.equal(record.status, 'completed')
  assert.equal(record.round, 2)
  assert.equal(record.summary, '第二轮')
  assert.equal(record.jobId, 'j2', 'the latest appended round carries the live job id')
})

test('G5: an append-only replay reopens the round and keeps the new job id', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'tool', toolCallId: 'c1', content: [blockOf(questBlock({ round: 1, jobId: 'j1' }))] },
      { role: 'tool', toolCallId: 'c2', content: [blockOf(reportBlock({ round: 1, summary: '第一轮' }))] },
      { role: 'tool', toolCallId: 'c3', content: [blockOf(questBlock({ round: 2, jobId: 'j2' }))] },
    ],
  }
  await cache.ensureClient(session)
  const record = cache.get('q-1')
  assert.equal(record.status, 'in_progress')
  assert.equal(record.round, 2)
  assert.equal(record.jobId, 'j2')
  assert.equal(record.summary, undefined, 'a reopened round has no answer yet')

  // A report for the previous round cannot close the newer open round.
  const stale = createQuestCache()
  await stale.ensureClient({
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'tool', toolCallId: 'c1', content: [blockOf(questBlock({ round: 2, jobId: 'j2' }))] },
      { role: 'tool', toolCallId: 'c2', content: [blockOf(reportBlock({ round: 1, summary: '旧轮' }))] },
    ],
  })
  assert.equal(stale.get('q-1').round, 2, 'a stale round-1 report cannot complete round 2')
  assert.equal(stale.get('q-1').status, 'in_progress')
  assert.equal(stale.get('q-1').summary, undefined)
})

test('G5: the contractor cache folds delivered quest blocks and report results per round', async () => {
  const cache = createQuestCache()
  const session = {
    id: 'S2',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'user', content: [blockOf(questBlock({ round: 1, jobId: 'j1' }))] },
      { role: 'user', content: [blockOf(questBlock({ round: 2, jobId: 'j2' }))] },
      { role: 'tool', toolCallId: 't1', content: [blockOf(reportBlock({ round: 1, summary: '第一轮' }))] },
      { role: 'tool', toolCallId: 't2', content: [blockOf(reportBlock({ round: 2, summary: '第二轮' }))] },
    ],
  }
  await cache.ensureContractor(session)
  const record = cache.byContractor('S2')
  assert.equal(record.status, 'completed')
  assert.equal(record.round, 2)
  assert.equal(record.summary, '第二轮')

  // Without the last report, the delivered round-2 block leaves it open.
  const open = createQuestCache()
  await open.ensureContractor({
    id: 'S2',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'user', content: [blockOf(questBlock({ round: 1, jobId: 'j1' }))] },
      { role: 'tool', toolCallId: 't1', content: [blockOf(reportBlock({ round: 1, summary: '第一轮' }))] },
      { role: 'user', content: [blockOf(questBlock({ round: 2, jobId: 'j2' }))] },
    ],
  })
  assert.equal(open.byContractor('S2').status, 'in_progress')
  assert.equal(open.byContractor('S2').round, 2)
  assert.equal(open.byContractor('S2').jobId, 'j2')
})

test('G5: prompt-delivery completion is rebuilt from the per-round request id', async () => {
  const cache = createQuestCache()
  await cache.ensureClient({
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [
      { role: 'tool', toolCallId: 'c1', content: [blockOf(questBlock({ round: 1, delivery: 'prompt' }))] },
      { role: 'user', source: { kind: 'user', rpcId: 'report:q-1' }, content: [{ type: 'text', text: '第一轮' }] },
      { role: 'tool', toolCallId: 'c2', content: [blockOf(questBlock({ round: 2, delivery: 'prompt' }))] },
      // The round-2 rpc identity alone is enough; the block carries the summary.
      {
        role: 'user',
        source: { kind: 'user', rpcId: 'report:q-1:r2' },
        content: [blockOf(reportBlock({ round: 2, summary: '第二轮' }))],
      },
    ],
  })
  const record = cache.get('q-1')
  assert.equal(record.status, 'completed')
  assert.equal(record.round, 2)
  assert.equal(record.summary, '第二轮')
})
