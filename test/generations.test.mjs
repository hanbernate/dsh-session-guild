/**
 * Generation-level behaviour tests: the same plugin source, mounted on four
 * host shapes (0.2.2+, 0.1.7–0.2.1, 0.1.2–0.1.5, pre-0.1.2), must quest,
 * report, and degrade exactly where the adapter says it does.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

function makeSession(id, cwd) {
  return {
    id,
    header: { cwd },
    preset: undefined,
    title: undefined,
    events: [],
    append(type, data) {
      const event = { type, data, seq: this.events.length, time: Date.now() }
      this.events.push(event)
      return event
    },
  }
}

function makeCtx(services, { inject = true } = {}) {
  const tools = new Map()
  const registrations = []
  const listeners = new Map()
  const ctx = {
    get: name => name === 'tools' ? ctx.tools : services[name],
    tools: {
      register(definition, options) {
        registrations.push({ name: definition.name, options })
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
      ...(services.toolWhen === true
        ? { resolve: async () => ({ definitions: [], schemas: [] }), executable: () => undefined }
        : {}),
    },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === 'function') services.cleanups.push(cleanup)
    },
    ...(inject ? {
      inject(deps, callback) {
        if (deps.every(name => services[name] !== undefined)) return callback(ctx)
        return undefined
      },
    } : {}),
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, tools, registrations, listeners }
}

const PRESET_SPECS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'ask' },
}

function fixture(generation, overrides = {}, options = {}) {
  const client = makeSession('S1', '/ws/a')
  const contractor = makeSession('S2', '/ws/b')
  const sessions = new Map([['S1', client], ['S2', contractor]])
  const archived = []
  const created = []
  const prompts = []
  const archiveCalls = []
  const cleanups = []

  const controller = {
    async create(request) {
      created.push(request)
      return { sessionId: 'S2' }
    },
    async prompt(request, signal) {
      prompts.push({ request, signal })
      return { accepted: true }
    },
  }
  if (generation === 'modern' || generation === 'legacy') {
    controller.state = async () => ({ running: false, active: true })
  }

  const presets = {
    current: () => 'read-only',
    resolve: name => {
      if (PRESET_SPECS[name] === undefined) throw new Error(`unknown preset ${name}`)
      return PRESET_SPECS[name]
    },
    set: (session, name) => { session.preset = name },
  }
  if (generation === 'modern' || generation === 'legacy') {
    presets.catalog = () => ({
      options: Object.keys(PRESET_SPECS).map(value => ({ value, name: value })),
      defaultOptions: Object.keys(PRESET_SPECS).map(value => ({ value, name: value })),
      defaultPreset: 'read-only',
    })
  } else if (generation !== 'unsupported') {
    presets.names = Object.keys(PRESET_SPECS)
    presets.optionOf = value => ({ value, name: value })
  }

  const registry = {
    list: () => [
      { id: 'w-a', title: 'alpha', path: '/ws/a' },
      { id: 'w-b', title: 'beta', path: '/ws/b' },
    ],
    get archivedSessionIds() {
      return archived
    },
    archiveSession(id, options) {
      archiveCalls.push(options === undefined ? [id] : [id, options])
      if (!archived.includes(id)) archived.push(id)
    },
  }
  if (generation === 'modern' || generation === 'legacy') {
    registry.unarchiveSession = id => {
      const index = archived.indexOf(id)
      if (index >= 0) archived.splice(index, 1)
    }
  }

  const services = {
    workspaceRegistry: registry,
    sessionController: generation === 'unsupported' ? undefined : controller,
    sessions: { get: id => sessions.get(id) },
    agents: { get: id => (id === 'S1' ? { session: client } : undefined) },
    permissionPresets: generation === 'unsupported' ? undefined : presets,
    sessionTitle: { get: () => ({ title: 'A' }), rename: () => ({ title: 'renamed' }) },
    approval: { overrideOf: () => undefined, request: async () => 'allowed-once' },
    // 0.2.1 has workingDirectory; older do not.
    workingDirectory: generation === 'modern' || generation === 'legacy' ? { get: session => session.header.cwd } : undefined,
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    toolWhen: generation === 'modern',
    cleanups,
    ...overrides,
  }
  const built = makeCtx(services, options)
  const clientAgent = { session: client }
  const exec = () => ({ agent: clientAgent, signal: new AbortController().signal, callId: 'call-1' })
  apply(built.ctx, {})
  return { ...built, services, client, contractor, archived, created, prompts, archiveCalls, exec, clientAgent }
}

test('modern host uses per-step `when` and restores an archived contractor', async () => {
  const f = fixture('modern')
  const entry = f.registrations.filter(item => ['guild_list_quests', 'guild_append', 'guild_resume', 'guild_report'].includes(item.name))
  assert.equal(entry.length, 4)
  for (const item of entry) assert.equal(typeof item.options?.when, 'function', `${item.name} must be gated by when`)

  const published = await f.tools.get('guild_publish_quest').execute({ workspace: 'beta', task: 'x' }, f.exec())
  assert.equal(published.permission, 'read-only')
  assert.equal(f.contractor.preset, 'read-only')
  assert.equal(f.prompts.length, 1)
  assert.equal(f.prompts[0].signal.aborted, false)

  f.archived.push('S2')
  const resumed = await f.tools.get('guild_resume').execute({}, f.exec())
  assert.equal(resumed.resumed[0].restored, true)
  assert.equal(resumed.resumed[0].delivered, true)
  assert.equal(f.archived.includes('S2'), false)
})

test('legacy host (0.1.7–0.2.1) registers without `when` but keeps full lifecycle', async () => {
  const f = fixture('legacy')
  assert.equal(f.registrations.length, 6, 'one discovery tool plus five quest tools')
  for (const item of f.registrations) assert.equal(item.options, undefined)

  const published = await f.tools.get('guild_publish_quest').execute({ workspace: 'beta', task: 'x' }, f.exec())
  assert.equal(published.permission, 'read-only')
  assert.equal(f.contractor.preset, 'read-only')
  assert.equal(f.prompts[0].signal.aborted, false)

  f.archived.push('S2')
  const resumed = await f.tools.get('guild_resume').execute({}, f.exec())
  assert.equal(resumed.resumed[0].restored, true)
  assert.equal(resumed.resumed[0].delivered, true)
})

test('minimal host (0.1.2–0.1.5) synthesizes the preset catalog from names/optionOf', async () => {
  const f = fixture('minimal')
  const publishTool = f.tools.get('guild_publish_quest')
  assert.deepEqual(publishTool.parameters.properties.permission.enum, ['read-only', 'workspace-write', 'danger-full-access'])
  const published = await publishTool.execute({ workspace: 'beta', task: 'x' }, f.exec())
  assert.equal(published.permission, 'read-only')
  assert.equal(f.contractor.preset, 'read-only')
  // `when` is absent before 0.2.2, so every definition is registered plainly.
  assert.equal(f.registrations.length, 6, 'one discovery tool plus five quest tools')
  for (const item of f.registrations) assert.equal(item.options, undefined)
})

test('minimal host wakes an archived contractor without unarchive and says so', async () => {
  const f = fixture('minimal')
  await f.tools.get('guild_publish_quest').execute({ workspace: 'beta', task: 'x' }, f.exec())
  f.archived.push('S2')

  const resumed = await f.tools.get('guild_resume').execute({}, f.exec())
  assert.equal(resumed.resumed[0].restored, false)
  assert.equal(resumed.resumed[0].delivered, true)
  assert.match(resumed.resumed[0].note, /没有 unarchiveSession/)
  assert.equal(f.archived.includes('S2'), true, 'the contractor stays archived when the host cannot restore it')

  // guild_append explains the same degradation instead of promising a restore.
  await assert.rejects(
    () => f.tools.get('guild_append').execute({ sessionId: 'S2', message: 'y' }, f.exec()),
    /no unarchiveSession.*guild_resume/,
  )
})

test('minimal host has no archive events, so nothing subscribes for cascade', async () => {
  const f = fixture('minimal')
  assert.equal(f.listeners.has('workspace/session-archived'), false)
  assert.equal(f.listeners.has('workspace/session-stop'), false)
})

test('legacy host cascades from the pre-archive stop event', async () => {
  const f = fixture('legacy')
  assert.equal(f.listeners.has('workspace/session-archived'), false)
  assert.equal(f.listeners.has('workspace/session-stop'), true)
  await f.tools.get('guild_publish_quest').execute({ workspace: 'beta', task: 'x' }, f.exec())
  const [listener] = f.listeners.get('workspace/session-stop')
  await listener({ sessionId: 'S1' })
  await new Promise(done => setTimeout(done, 10))
  assert.equal(f.archiveCalls.at(-1)[0], 'S2')
  assert.deepEqual(f.archiveCalls.at(-1)[1], { stopActivity: true })
})

test('modern host cascades from both archive events and passes stopActivity', async () => {
  const f = fixture('modern')
  assert.equal(f.listeners.has('workspace/session-archived'), true)
  assert.equal(f.listeners.has('workspace/session-stop'), true)
  await f.tools.get('guild_publish_quest').execute({ workspace: 'beta', task: 'x' }, f.exec())
  const [listener] = f.listeners.get('workspace/session-archived')
  await listener({ sessionId: 'S1' })
  await new Promise(done => setTimeout(done, 10))
  assert.equal(f.archiveCalls.at(-1)[0], 'S2')
  assert.deepEqual(f.archiveCalls.at(-1)[1], { stopActivity: true })
})

test('a plain mock context without ctx.inject still mounts the quest tools', async () => {
  const f = fixture('legacy', {}, { inject: false })
  assert.equal(f.registrations.length, 6)
  for (const item of f.registrations) assert.equal(item.options, undefined)
})

test('pre-0.1.2 registers discovery only and warns instead of pretending to quest', async () => {
  const f = fixture('unsupported')
  assert.deepEqual([...f.tools.keys()], ['guild_list_workspaces'])
  const listed = await f.tools.get('guild_list_workspaces').execute({}, f.exec())
  assert.equal(listed.workspaces.length, 2)
})
