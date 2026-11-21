/**
 * Quest reporting mode: `review` (human-in-the-loop default) vs `unattended`.
 *
 * The mode changes what the plugin injects, not what the tools accept: publish
 * appends the reporting rule to the requirement, append and resume apply the
 * same rule to later rounds, and the `guild.quest` block carries the mode so a
 * cold cache rebuild applies it too.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'
import { createQuestCache } from '../lib/cache.js'
import { questMode, reportingDiscipline } from '../lib/quest-mode.js'

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

function fixture() {
  const client = makeSession('S1', '/ws/a')
  const contractor = makeSession('S2', '/ws/b')
  const sessions = new Map([['S1', client], ['S2', contractor]])
  const prompts = []
  const created = []
  const cleanups = []
  const archived = []

  const controller = {
    async create(request) {
      created.push(request)
      return { sessionId: 'S2' }
    },
    async prompt(request) {
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
  apply(built.ctx, {})
  const clientExec = () => ({ agent: { id: 'S1', session: client }, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'call-1' })
  const contractorExec = () => ({ agent: { id: 'S2', session: contractor }, signal: new AbortController().signal, callId: 'call-2' })
  return { ...built, services, client, contractor, prompts, created, archived, clientExec, contractorExec }
}

const publishArgs = { workspace: 'beta', quest: '评审 diff' }

test('publish defaults to review and appends the confirm-before-report rule', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())

  assert.equal(published.mode, 'review')
  const delivered = f.prompts.find(request => request.sessionId === 'S2')
  assert.match(delivered.content[0].text, /回报方式（人在环/)
  assert.match(delivered.content[0].text, /确认后再调用 guild_report/)
  assert.doesNotMatch(delivered.content[0].text, /完成后直接调用 guild_report/)

  const block = recordsOf(delivered).find(record => record.kind === 'guild.quest')
  assert.equal(block.mode, 'review')

  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.equal(listed.quests[0].mode, 'review')
})

test('publish with mode unattended tells the contractor to report when done', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(
    { ...publishArgs, mode: 'unattended' },
    f.clientExec(),
  )

  assert.equal(published.mode, 'unattended')
  const delivered = f.prompts.find(request => request.sessionId === 'S2')
  assert.match(delivered.content[0].text, /回报方式（无人值守/)
  assert.match(delivered.content[0].text, /完成后直接调用 guild_report/)
  const block = recordsOf(delivered).find(record => record.kind === 'guild.quest')
  assert.equal(block.mode, 'unattended')

  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.equal(listed.quests[0].mode, 'unattended')
})

test('an unknown mode is refused before any session is created', async () => {
  const f = fixture()
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute({ ...publishArgs, mode: 'automatic' }, f.clientExec()),
    /mode must be "review" or "unattended"/,
  )
  assert.equal(f.created.length, 0, 'no session was created')
  assert.equal(f.prompts.length, 0, 'nothing was delivered')
})

test('append keeps the review gate on the next round', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(publishArgs, f.clientExec())
  await f.tools.get('guild_report').execute({ summary: '第一轮' }, f.contractorExec())

  const appended = await f.tools.get('guild_append').execute({ sessionId: 'S2', message: '补一下矩阵' }, f.clientExec())
  assert.equal(appended.round, 2)
  assert.equal(appended.mode, 'review')

  const delivered = f.prompts.at(-1)
  assert.match(delivered.content[0].text, /确认后再调用 guild_report/)
  assert.doesNotMatch(delivered.content[0].text, /完成后请再次调用 guild_report/)
  const block = recordsOf(delivered).find(record => record.kind === 'guild.quest')
  assert.equal(block.mode, 'review')
})

test('append on an unattended quest keeps the report-when-done order', async () => {
  const f = fixture()
  await f.tools.get('guild_publish_quest').execute({ ...publishArgs, mode: 'unattended' }, f.clientExec())
  await f.tools.get('guild_report').execute({ summary: '第一轮' }, f.contractorExec())

  const appended = await f.tools.get('guild_append').execute({ sessionId: 'S2', message: '补一下矩阵' }, f.clientExec())
  assert.equal(appended.mode, 'unattended')
  const delivered = f.prompts.at(-1)
  assert.match(delivered.content[0].text, /完成后请再次调用 guild_report 汇报本轮摘要/)
  assert.doesNotMatch(delivered.content[0].text, /确认后再调用 guild_report/)
  const block = recordsOf(delivered).find(record => record.kind === 'guild.quest')
  assert.equal(block.mode, 'unattended')
})

test('resume applies the mode to the wake message', async () => {
  const review = fixture()
  const reviewed = await review.tools.get('guild_publish_quest').execute(publishArgs, review.clientExec())
  review.archived.push('S2')
  await review.tools.get('guild_resume').execute({ questIds: [reviewed.questId] }, review.clientExec())
  assert.match(review.prompts.at(-1).content[0].text, /确认后再调用 guild_report/)
  assert.doesNotMatch(review.prompts.at(-1).content[0].text, /完成后调用 guild_report 汇报摘要/)

  const unattended = fixture()
  const auto = await unattended.tools.get('guild_publish_quest').execute(
    { ...publishArgs, mode: 'unattended' },
    unattended.clientExec(),
  )
  unattended.archived.push('S2')
  await unattended.tools.get('guild_resume').execute({ questIds: [auto.questId] }, unattended.clientExec())
  assert.match(unattended.prompts.at(-1).content[0].text, /完成后调用 guild_report 汇报摘要/)
})

test('a cold rebuild carries the mode from the quest block', async () => {
  const cache = createQuestCache()
  const block = mode => ({
    kind: 'guild.quest',
    questId: 'q-1',
    clientSessionId: 'S1',
    contractorSessionId: 'S2',
    workspace: 'beta',
    workspacePath: '/ws/b',
    permission: 'read-only',
    delivery: 'job',
    ...(mode === undefined ? {} : { mode }),
    round: 1,
  })
  const session = mode => ({
    id: 'S1',
    inheritedEventCount: 0,
    deriveMessages: () => [{ role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: JSON.stringify(block(mode)) }] }],
  })

  await cache.ensureClient(session('unattended'))
  assert.equal(cache.get('q-1').mode, 'unattended')

  const legacy = createQuestCache()
  await legacy.ensureClient(session(undefined))
  assert.equal(legacy.get('q-1').mode, undefined, 'a block written before modes existed carries none')
  assert.equal(questMode(legacy.get('q-1').mode), 'review', 'the absent mode means human-in-the-loop')
})

test('the injected discipline text matches the documented rule', () => {
  assert.match(reportingDiscipline('review'), /未经确认不要直接回报/)
  assert.match(reportingDiscipline('unattended'), /不要停下来等用户确认/)
  assert.equal(questMode(undefined), 'review')
  assert.equal(questMode('anything'), 'review')
  assert.equal(questMode('unattended'), 'unattended')
})
