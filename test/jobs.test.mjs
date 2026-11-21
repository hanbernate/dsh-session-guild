/**
 * Job-carried report delivery.
 *
 * A quest's report is a background job owned by the client session: publishing
 * registers it and returns immediately, `guild_report` settles it with the
 * summary as `JobOutcome.result`, and the client reads that result with
 * `job_output`. Nothing is admitted as a `user/message` through
 * `sessionController.prompt` — the client must not open a turn just because it
 * waits for a contractor.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

const PRESET_SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
}

function makeSession(id, cwd) {
  return {
    id,
    header: { cwd },
    preset: undefined,
    events: [],
    append(type, data) {
      this.events.push({ type, data, seq: this.events.length, time: Date.now() })
    },
  }
}

/** A fake jobs service: `start` stores the producer's hooks and keeps `done`. */
function makeJobs() {
  const records = new Map()
  let seq = 0
  return {
    start(spec) {
      const id = `guild-quest-${++seq}`
      const hooks = spec.run({ id, append() {}, updateProgress() {} })
      const record = { id, spec, hooks, status: 'running' }
      // Mirror the registry's terminal projection: the view's status flips
      // when the producer's done promise settles.
      hooks.done.then(outcome => { record.status = outcome.status }, () => { record.status = 'failed' })
      records.set(id, record)
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
  }
}

function makeCtx(services, root) {
  const tools = new Map()
  const cleanups = []
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
      if (typeof cleanup === 'function') cleanups.push(cleanup)
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
  // The app-lifetime scope the receiver registry lives on. A real host
  // inherits it from the cordis root context; the fixture hands the same
  // object to every instance so a reload can be simulated by applying again.
  ctx.root = root ?? ctx
  return { ctx, tools }
}

function fixture({ jobs = true, cold = false, config = {} } = {}) {
  const client = makeSession('S1', '/ws/a')
  const contractor = makeSession('S2', '/ws/b')
  const sessions = new Map([['S1', client], ['S2', contractor]])
  const prompts = []
  const cancels = []
  const cleanups = []
  let coldPage = { records: [], hasMore: false }

  const controller = {
    async create() {
      return { sessionId: 'S2' }
    },
    async prompt(request) {
      prompts.push(request)
      return { accepted: true }
    },
    cancel(request) {
      cancels.push(request)
      return { accepted: true }
    },
    async state() {
      return { running: false, active: true }
    },
    async events() {
      return coldPage
    },
  }

  const presets = {
    current: () => 'read-only',
    catalog: () => ({
      options: Object.keys(PRESET_SPECS).map(value => ({ value, name: value })),
      defaultOptions: Object.keys(PRESET_SPECS).map(value => ({ value, name: value })),
      defaultPreset: 'read-only',
    }),
    resolve: name => PRESET_SPECS[name],
    set: (session, name) => { session.preset = name },
  }

  const services = {
    workspaceRegistry: {
      list: () => [
        { id: 'w-a', title: 'alpha', path: '/ws/a' },
        { id: 'w-b', title: 'beta', path: '/ws/b' },
      ],
      get archivedSessionIds() {
        return []
      },
      archiveSession() {},
    },
    sessionController: controller,
    sessions: { get: id => sessions.get(id) },
    agents: { get: id => (id === 'S1' ? { id, session: client } : undefined) },
    permissionPresets: presets,
    sessionTitle: { get: () => ({ title: 'A' }), rename: () => ({ title: 'renamed' }) },
    approval: { overrideOf: () => undefined, request: async () => 'allowed-once' },
    workingDirectory: { get: session => session.header.cwd },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    cleanups,
    ...(jobs ? { jobs: makeJobs() } : {}),
  }
  const built = makeCtx(services)
  apply(built.ctx, config)

  const clientExec = () => ({ agent: { id: 'S1', session: client }, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'call-1' })
  const contractorExec = () => ({ agent: { id: 'S2', session: contractor }, signal: new AbortController().signal, callId: 'call-2' })

  return {
    ...built,
    services,
    client,
    contractor,
    prompts,
    cancels,
    clientExec,
    contractorExec,
    setColdPage(page) { coldPage = page },
    goCold() {
      sessions.delete('S2')
    },
  }
}

const publishArgs = { workspace: 'beta', quest: '修一下' }

test('publishing registers an owner-fenced job and never waits for it', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())

  assert.match(published.jobId, /^guild-quest-/)
  const job = f.services.jobs.get(published.jobId)
  assert.equal(job.spec.kind, 'guild-quest')
  assert.equal(job.spec.owner, 'S1', 'the job belongs to the client session, so its disposal cancels it')
  assert.equal(job.spec.label, `${published.questId} → beta`)
  assert.equal(f.prompts.length, 1, 'only the contractor receives a prompt')
  assert.equal(f.prompts[0].sessionId, 'S2')

  const listed = await f.tools.get('guild_collect').execute({}, f.clientExec())
  assert.equal(listed.quests[0].jobId, published.jobId)
  assert.equal(listed.quests[0].status, 'in_progress')
})

test('guild_report settles the job result instead of prompting the client', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  const reported = await f.tools.get('guild_report').execute({ summary: '改好了' }, f.contractorExec())

  assert.equal(reported.settled, true)
  assert.equal(reported.delivered, true)
  assert.equal(reported.jobId, published.jobId)
  assert.equal(f.prompts.length, 1, 'the report did not admit a user message')
  assert.deepEqual(await f.services.jobs.settled(published.jobId), {
    status: 'completed',
    result: '改好了',
    detail: 'reported by S2',
  })

  const collected = await f.tools.get('guild_collect').execute({ questId: published.questId }, f.clientExec())
  assert.equal(collected.quests.length, 1)
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].summary, '改好了')

  await assert.rejects(
    () => f.tools.get('guild_report').execute({ summary: 'again' }, f.contractorExec()),
    /already reported/,
  )
})

test('quest and report lengths are model-decided: no plugin-side caps', async () => {
  // Stale config keys from older profiles must no longer bound either side.
  const f = fixture({ config: { maxQuestChars: 1, summaryChars: 1 } })
  const longQuest = `修一下${'细'.repeat(25000)}`
  const longSummary = `改好了${'报'.repeat(15000)}`

  const published = await f.tools.get('guild_publish_quest').execute(
    { ...publishArgs, quest: longQuest }, f.clientExec(),
  )
  assert.ok(published.jobId)
  // The quest text is delivered whole; the plugin appends its reporting rule
  // after it, so the requirement is no longer the tail of the message.
  assert.equal(f.prompts[0].content[0].text.includes(longQuest), true, 'the full quest is delivered')
  assert.equal(
    f.services.jobs.get(published.jobId).spec.outputLimitBytes, undefined,
    'the job keeps unbounded output; the host bounds what reaches the model',
  )

  const reported = await f.tools.get('guild_report').execute({ summary: longSummary }, f.contractorExec())
  assert.equal(reported.settled, true)
  assert.deepEqual(await f.services.jobs.settled(published.jobId), {
    status: 'completed',
    result: longSummary,
    detail: 'reported by S2',
  })
  const collected = await f.tools.get('guild_collect').execute({ questId: published.questId }, f.clientExec())
  assert.equal(collected.quests[0].summary, longSummary, 'the whole summary survives into the quest record')
})

test('a killed job stops the contractor and marks the quest cancelled', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  f.services.jobs.kill(published.jobId, 'cancelled by the user')

  assert.deepEqual(await f.services.jobs.settled(published.jobId), { status: 'killed', detail: 'cancelled by the user' })
  assert.deepEqual(f.cancels.at(-1), { sessionId: 'S2' })
  const collected = await f.tools.get('guild_collect').execute({}, f.clientExec())
  assert.equal(collected.quests[0].status, 'cancelled')
})

test('a report that arrives after the job is gone is recorded, not delivered as a message', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  // Owner disposal (or a restart) settles the job before the contractor reports.
  f.services.jobs.kill(published.jobId, 'owner disposed')

  const reported = await f.tools.get('guild_report').execute({ summary: '晚到的结果' }, f.contractorExec())
  assert.equal(reported.delivery, 'job')
  assert.equal(reported.settled, false)
  assert.equal(reported.delivered, false)
  assert.equal(reported.jobId, undefined)
  assert.equal(f.prompts.length, 1, 'a late report never falls back to a client prompt')

  const collected = await f.tools.get('guild_collect').execute({}, f.clientExec())
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].summary, '晚到的结果')
})

test('a cold contractor report is recovered from its message-aligned history', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  f.goCold()
  f.setColdPage({
    records: [{
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 7,
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            content: [{
              type: 'text',
              text: JSON.stringify({ kind: 'guild.report', questId: published.questId, summary: '冷读到的结果' }),
            }],
          },
        },
      },
    }],
    hasMore: false,
  })

  const collected = await f.tools.get('guild_collect').execute({ questId: published.questId }, f.clientExec())
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].summary, '冷读到的结果')
})

test('reportDelivery: prompt keeps the legacy user-message delivery', async () => {
  const f = fixture({ config: { reportDelivery: 'prompt' } })
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  assert.equal(published.jobId, undefined)

  const reported = await f.tools.get('guild_report').execute({ summary: '改好了' }, f.contractorExec())
  assert.equal(reported.delivery, 'prompt')
  assert.equal(reported.delivered, true)
  assert.equal(f.prompts.length, 2)
  assert.equal(f.prompts[1].sessionId, 'S1')
  assert.equal(f.prompts[1].requestId, `report:${published.questId}`)
})

test('prompt delivery also carries the full, untruncated summary', async () => {
  const f = fixture({ config: { reportDelivery: 'prompt' } })
  await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  const longSummary = `改好了${'报'.repeat(15000)}`
  const reported = await f.tools.get('guild_report').execute({ summary: longSummary }, f.contractorExec())

  assert.equal(reported.delivery, 'prompt')
  assert.equal(f.prompts[1].content[0].text.endsWith(longSummary), true)
  const collected = await f.tools.get('guild_collect').execute({}, f.clientExec())
  assert.equal(collected.quests[0].summary, longSummary)
})

test('auto falls back to prompt delivery when the host has no jobs service', async () => {
  const f = fixture({ jobs: false })
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  assert.equal(published.jobId, undefined)
  assert.match(published.notes.join('\n'), /没有后台任务服务|后台任务不可用/)

  const reported = await f.tools.get('guild_report').execute({ summary: '改好了' }, f.contractorExec())
  assert.equal(reported.delivery, 'prompt')
  assert.equal(f.prompts.length, 2)
})

test('reportDelivery: job refuses to publish without a jobs service', async () => {
  const f = fixture({ jobs: false, config: { reportDelivery: 'job' } })
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec()),
    /no background job could carry its report/,
  )
  assert.equal(f.prompts.length, 0)
})

/* ----------------------- instance reload (HMR) ----------------------- */

test('an HMR reload keeps the settlement path: the new instance settles the job its predecessor registered', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  const delivered = f.prompts.at(-1)

  // Both sides of the conversation are durable Session messages; a fresh
  // instance rebuilds its cache from exactly these, as after a real reload.
  f.contractor.deriveMessages = () => [{ role: 'user', content: delivered.content }]
  f.client.deriveMessages = () => [{ role: 'tool', toolCallId: 'call-1', content: delivered.content }]

  // The reload: the Loader re-applies the entry over the same host services
  // (same job registry) and the same root context — new instance, new
  // in-memory cache, and (before the fix) a new empty receiver map.
  const reloaded = makeCtx(f.services, f.ctx.root)
  apply(reloaded.ctx, {})

  const reported = await reloaded.tools.get('guild_report').execute({ summary: '热重载后的回报' }, f.contractorExec())
  assert.equal(reported.settled, true, 'the receiver registered before the reload still settles')
  assert.equal(reported.delivered, true)
  assert.equal(reported.jobId, published.jobId)
  assert.equal(reported.note, undefined, 'a settled report needs no degradation note')
  assert.deepEqual(await f.services.jobs.settled(published.jobId), {
    status: 'completed',
    result: '热重载后的回报',
    detail: 'reported by S2',
  })

  const collected = await reloaded.tools.get('guild_collect').execute({ questId: published.questId }, f.clientExec())
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].summary, '热重载后的回报')
  assert.equal(collected.quests[0].note, undefined, 'a settled job needs no cleanup note')
})

test('a report whose settlement handle was lost is flagged by guild_collect with the cleanup action', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  const delivered = f.prompts.at(-1)

  // The contractor's Session log: the delivered quest block now, the
  // guild_report result once the report has executed (a cold rebuild reads
  // exactly these two).
  const log = [{ role: 'user', content: delivered.content }]
  f.contractor.deriveMessages = () => [...log]

  // A receiver registered on a different root models the pre-fix loss: the
  // report finds no handle, the job keeps running, and no notice ever fires.
  const stray = makeCtx(f.services, {})
  apply(stray.ctx, {})
  const reported = await stray.tools.get('guild_report').execute({ summary: '句柄丢失的回报' }, f.contractorExec())
  assert.equal(reported.settled, false)
  assert.equal(reported.delivered, false)
  assert.match(reported.note, /仍在运行/)
  assert.match(reported.note, /job_kill/)
  assert.equal(f.services.jobs.get(published.jobId).status, 'running', 'the job keeps its slot')

  log.push({
    role: 'tool',
    toolCallId: 'call-2',
    content: [{ type: 'text', text: JSON.stringify({ kind: 'guild.report', questId: published.questId, round: 1, summary: '句柄丢失的回报' }) }],
  })

  // The client's pull path carries the signal the notice never delivered:
  // completed record + still-running job + the action that frees the slot
  // without touching the completed record.
  const collected = await f.tools.get('guild_collect').execute({}, f.clientExec())
  assert.equal(collected.quests[0].status, 'completed')
  assert.equal(collected.quests[0].summary, '句柄丢失的回报')
  assert.match(collected.quests[0].note, new RegExp(published.jobId))
  assert.match(collected.quests[0].note, /job_kill/)
})
