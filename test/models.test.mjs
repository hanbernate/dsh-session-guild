/**
 * Publishing a quest with an explicit model.
 *
 * G1: the contractor runs the model named on the publish, from its first model
 * step, and the deployment default model is untouched.
 * G2: a route that is invalid or unavailable fails **before** the requirement
 * is delivered, so no quest ever runs on the wrong model.
 *
 * The contracts pinned here:
 * - `provider` + `model` (and optional `reasoning_effort`) are applied with
 *   `agents.get(sessionId).model.select`, i.e. to that Session only;
 * - `sessionController.selectModel` is only the degraded path, and its
 *   deployment-default side effect is stated in the notes;
 * - neither argument keeps today's behaviour (deployment default, no note);
 * - a host with no way to select a model refuses an explicit selection.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

const PRESET_SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
}

/** The deployment default is a value the plugin must never rewrite by hand. */
const DEPLOYMENT_DEFAULT = { provider: 'deploy', model: 'default-model' }

const CATALOG = {
  default: DEPLOYMENT_DEFAULT,
  routableProviders: ['opencode-go'],
  groups: [{
    id: 'opencode-go',
    name: 'OpenCode Go',
    models: [
      {
        id: 'deepseek-v4.1-flash',
        name: 'Flash',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
      },
      { id: 'mimo-v2.6-flash', name: 'MiMo' },
    ],
  }],
  failures: [],
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

/** Parse every pure-JSON text block a tool result/prompt carries. */
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

function fixture({ catalog = true, agentModel = true, selectModel = true, llm } = {}) {
  const client = makeSession('S1', '/ws/a')
  const contractor = makeSession('S2', '/ws/b')
  const sessions = new Map([['S1', client], ['S2', contractor]])
  const prompts = []
  const created = []
  const selectModelCalls = []
  const order = []
  const cleanups = []

  const controller = {
    async create() {
      created.push('S2')
      return { sessionId: 'S2' }
    },
    async prompt(request) {
      prompts.push(request)
      order.push('prompt')
      return { accepted: true }
    },
    async state() {
      return { running: false, active: true }
    },
  }
  if (catalog) controller.modelCatalog = async () => CATALOG
  if (selectModel) {
    controller.selectModel = async request => {
      selectModelCalls.push(request)
      order.push('selectModel')
      return { selected: request }
    }
  }

  const contractorAgent = {
    id: 'S2',
    session: contractor,
    model: {
      selected: undefined,
      select(value) {
        this.selected = value
        order.push('session-select')
      },
      current() {
        return this.selected
      },
    },
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
    agents: {
      get: id => {
        if (id === 'S1') return { id, session: client }
        if (id === 'S2' && agentModel) return contractorAgent
        return undefined
      },
    },
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
    ...(llm === undefined ? {} : { llm }),
    cleanups,
  }
  const built = makeCtx(services)
  apply(built.ctx, {})
  const clientExec = () => ({ agent: { id: 'S1', session: client }, signal: new AbortController().signal, callId: 'call-1', rootCallId: 'call-1' })
  return { ...built, services, client, contractor, created, prompts, selectModelCalls, order, contractorAgent, clientExec }
}

const base = { workspace: 'beta', quest: '只读评审一次 diff' }

test('G1: a publish selection applies to the contractor session before its first model step', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute({
    ...base,
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoning_effort: 'high',
  }, f.clientExec())

  assert.deepEqual(published.selection, {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  })
  assert.deepEqual(f.contractorAgent.model.selected, published.selection)
  assert.equal(f.selectModelCalls.length, 0, 'the deployment-default path must not run when Agent-level selection exists')
  assert.deepEqual(f.order, ['session-select', 'prompt'], 'the selection lands before the requirement that starts the first model step')

  // The deployment default is a catalog value this plugin never writes.
  assert.deepEqual(DEPLOYMENT_DEFAULT, { provider: 'deploy', model: 'default-model' })

  // The delivered quest block carries the selection and round 1.
  const block = recordsOf(f.prompts[0]).find(record => record.kind === 'guild.quest')
  assert.deepEqual(block.selection, published.selection)
  assert.equal(block.round, 1)

  // The client can see the model through the quest list.
  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.equal(listed.quests[0].model, 'opencode-go/deepseek-v4.1-flash (high)')
  assert.equal(listed.quests[0].round, 1)
})

test('G2: an unknown provider fails before delivery and names the session', async () => {
  const f = fixture()
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute({ ...base, provider: 'nope', model: 'x' }, f.clientExec()),
    error => /session S2/.test(error.message) && /not in the host model catalog/.test(error.message),
  )
  assert.equal(f.prompts.length, 0, 'no requirement reached the contractor')
  assert.equal(f.contractorAgent.model.selected, undefined)
  assert.equal(f.selectModelCalls.length, 0)
  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.deepEqual(listed.quests, [])
})

test('G2: an unknown model and an unsupported effort fail before delivery', async () => {
  const unknownModel = fixture()
  await assert.rejects(
    () => unknownModel.tools.get('guild_publish_quest').execute(
      { ...base, provider: 'opencode-go', model: 'gpt-9' },
      unknownModel.clientExec(),
    ),
    error => /session S2/.test(error.message) && /not available under provider/.test(error.message),
  )
  assert.equal(unknownModel.prompts.length, 0)

  const unknownEffort = fixture()
  await assert.rejects(
    () => unknownEffort.tools.get('guild_publish_quest').execute(
      { ...base, provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoning_effort: 'ultra' },
      unknownEffort.clientExec(),
    ),
    error => /session S2/.test(error.message) && /reasoning effort "ultra" is not supported/.test(error.message),
  )
  assert.equal(unknownEffort.prompts.length, 0)

  // A model that advertises no reasoning at all cannot honour an effort.
  const noReasoning = fixture()
  await assert.rejects(
    () => noReasoning.tools.get('guild_publish_quest').execute(
      { ...base, provider: 'opencode-go', model: 'mimo-v2.6-flash', reasoning_effort: 'high' },
      noReasoning.clientExec(),
    ),
    /advertises no reasoning effort/,
  )
  assert.equal(noReasoning.prompts.length, 0)
})

test('provider and model must be given together, before anything is created', async () => {
  const f = fixture()
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute({ ...base, provider: 'opencode-go' }, f.clientExec()),
    /provider and model must be given together/,
  )
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute({ ...base, model: 'deepseek-v4.1-flash' }, f.clientExec()),
    /provider and model must be given together/,
  )
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute({ ...base, reasoning_effort: 'high' }, f.clientExec()),
    /reasoning_effort requires provider and model/,
  )
  assert.equal(f.created.length, 0, 'a precondition failure creates no Session')
  assert.equal(f.prompts.length, 0)
})

test('a host without Agent-level selection falls back to selectModel and says the default changed', async () => {
  const f = fixture({ agentModel: false })
  const published = await f.tools.get('guild_publish_quest').execute({
    ...base,
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoning_effort: 'low',
  }, f.clientExec())

  assert.deepEqual(f.selectModelCalls, [{
    sessionId: 'S2',
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'low',
  }])
  assert.deepEqual(published.selection, {
    provider: 'opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'low',
  })
  assert.ok(
    published.notes.some(note => note.includes('部署默认模型')),
    `the default-rewrite side effect must be stated: ${published.notes.join(' | ')}`,
  )
})

test('a host with no selection capability refuses instead of running the default', async () => {
  const f = fixture({ catalog: false, agentModel: false, selectModel: false })
  await assert.rejects(
    () => f.tools.get('guild_publish_quest').execute(
      { ...base, provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      f.clientExec(),
    ),
    error => /session S2/.test(error.message) && /neither agent\.model\.select nor sessionController\.selectModel/.test(error.message),
  )
  assert.equal(f.prompts.length, 0, 'nothing was delivered, so no wrong model ran')
})

test('without a catalog the llm registry validates the route', async () => {
  const f = fixture({
    catalog: false,
    llm: { resolveCallConfig: async config => {
      if (config.model !== 'deepseek-v4.1-flash') throw new Error(`unknown model ${config.model}`)
      return config
    } },
  })
  const published = await f.tools.get('guild_publish_quest').execute(
    { ...base, provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    f.clientExec(),
  )
  assert.equal(published.selection.model, 'deepseek-v4.1-flash')

  const rejected = fixture({
    catalog: false,
    llm: { resolveCallConfig: async () => { throw new Error('unknown route') } },
  })
  await assert.rejects(
    () => rejected.tools.get('guild_publish_quest').execute(
      { ...base, provider: 'opencode-go', model: 'gpt-9' },
      rejected.clientExec(),
    ),
    error => /session S2/.test(error.message) && /unknown route/.test(error.message),
  )
  assert.equal(rejected.prompts.length, 0)
})

test('without any directory the publish proceeds but records that availability was unverified', async () => {
  const f = fixture({ catalog: false })
  const published = await f.tools.get('guild_publish_quest').execute(
    { ...base, provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    f.clientExec(),
  )
  assert.ok(published.notes.some(note => note.includes('无法在投递前确认')))
  assert.equal(f.prompts.length, 1)
})

test('omitting the model keeps the previous behaviour exactly', async () => {
  const f = fixture()
  const published = await f.tools.get('guild_publish_quest').execute(base, f.clientExec())

  assert.equal('selection' in published, false)
  assert.equal(f.contractorAgent.model.selected, undefined)
  assert.equal(f.selectModelCalls.length, 0)
  assert.equal(f.prompts.length, 1)
  const block = recordsOf(f.prompts[0]).find(record => record.kind === 'guild.quest')
  assert.equal('selection' in block, false, 'an unselected quest never gains a selection field')
  assert.equal(block.round, 1)
  assert.equal(published.notes.some(note => note.includes('模型')), false)
  const listed = await f.tools.get('guild_list_quests').execute({}, f.clientExec())
  assert.equal('model' in listed.quests[0], false)
})
