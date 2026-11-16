/**
 * Unit tests for the DSH host compatibility adapters.
 *
 * The adapter layer is the only place that knows a host generation's API
 * differences; these tests pin the selection rules and every degraded return.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARCHIVED_EVENT,
  ADAPTERS,
  STOP_EVENT,
  archivePlain,
  archiveWithStop,
  catalogPresetOptions,
  detectCapabilities,
  directoryFromHeader,
  directoryViaService,
  latestAdapter,
  namesPresetOptions,
  noSessionState,
  noUnarchive,
  selectAdapter,
  sessionState,
  unarchiveSession,
  v0Adapter,
  v1Adapter,
  v2Adapter,
} from '../lib/compat.js'

const CONTROLLER = {
  create: async () => ({ sessionId: 'S' }),
  prompt: async () => ({ accepted: true }),
  state: async () => ({ running: true, active: true }),
  modelCatalog: async () => ({ default: {}, routableProviders: [], groups: [], failures: [] }),
  selectModel: async () => ({ selected: {} }),
}

const PRESETS = {
  names: ['read-only', 'workspace-write'],
  catalog: () => ({
    options: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
      { value: 'auto', name: 'Auto' },
    ],
    defaultOptions: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
    ],
  }),
  optionOf: value => ({ value, name: value === 'read-only' ? 'Read only' : value }),
  resolve: value => {
    if (value === 'auto') throw new Error('not switchable')
    return {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    }[value]
  },
  current: () => 'read-only',
  set: () => {},
}

const REGISTRY = {
  list: () => [],
  archiveSession: () => {},
  unarchiveSession: () => {},
}

function fakeCtx(overrides = {}) {
  const services = {
    sessionController: CONTROLLER,
    permissionPresets: PRESETS,
    workspaceRegistry: REGISTRY,
    workingDirectory: { get: () => '/w' },
    tools: {
      register: () => () => {},
      resolve: async () => ({ definitions: [], schemas: [] }),
      executable: () => undefined,
    },
    ...overrides,
  }
  return { get: name => services[name] }
}

const capabilities = overrides => ({
  sessionController: true,
  controllerState: true,
  modelCatalog: true,
  selectModel: true,
  presetCatalog: true,
  presetNames: true,
  workingDirectory: true,
  unarchive: true,
  toolWhen: true,
  ...overrides,
})

test('detectCapabilities probes services and the tools API, not a version string', () => {
  assert.deepEqual(detectCapabilities(fakeCtx()), capabilities())

  const legacy = detectCapabilities(fakeCtx({
    sessionController: { create: CONTROLLER.create, prompt: CONTROLLER.prompt },
    permissionPresets: { optionOf: PRESETS.optionOf, resolve: PRESETS.resolve, current: PRESETS.current, set: PRESETS.set, names: PRESETS.names },
    workspaceRegistry: { list: REGISTRY.list, archiveSession: REGISTRY.archiveSession },
    workingDirectory: undefined,
    tools: { register: () => () => {} },
  }))
  assert.deepEqual(legacy, capabilities({
    controllerState: false,
    modelCatalog: false,
    selectModel: false,
    presetCatalog: false,
    workingDirectory: false,
    unarchive: false,
    toolWhen: false,
  }))
})

test('selectAdapter follows the generation order and falls back to v0', () => {
  assert.equal(selectAdapter(capabilities()), latestAdapter)
  assert.equal(selectAdapter(capabilities({ controllerState: false, toolWhen: false })), v2Adapter)
  assert.equal(selectAdapter(capabilities({ controllerState: false, toolWhen: false, presetCatalog: false, unarchive: false })), v1Adapter)
  assert.equal(selectAdapter(capabilities({ sessionController: false })), v0Adapter)
  assert.equal(v0Adapter.available, false)
  assert.equal(ADAPTERS.at(-1), v0Adapter)
})

test('latest and v2 adapters know their archive events and restore support', () => {
  assert.deepEqual([...latestAdapter.archiveEvents], [ARCHIVED_EVENT, STOP_EVENT])
  assert.deepEqual([...v2Adapter.archiveEvents], [STOP_EVENT])
  assert.deepEqual([...v1Adapter.archiveEvents], [])
  assert.equal(latestAdapter.toolWhen, true)
  assert.equal(v2Adapter.toolWhen, false)
  assert.equal(v1Adapter.canUnarchive, false)
  assert.equal(v2Adapter.canUnarchive, true)
})

test('catalogPresetOptions reads defaultOptions and drops advertised-but-unresolvable presets', () => {
  const options = catalogPresetOptions(PRESETS)
  assert.deepEqual(options.map(option => option.value), ['read-only', 'workspace-write'])
  assert.deepEqual(options[1], { value: 'workspace-write', name: 'Workspace write', sandbox: 'workspace-write', approval: 'ask' })
  assert.deepEqual(catalogPresetOptions(undefined), [])
  assert.deepEqual(catalogPresetOptions({ catalog: () => { throw new Error('not ready') } }), [])
})

test('namesPresetOptions synthesizes the catalog on 0.1.2–0.1.5', () => {
  const options = namesPresetOptions(PRESETS)
  assert.deepEqual(options.map(option => option.value), ['read-only', 'workspace-write'])
  assert.deepEqual(options[0], { value: 'read-only', name: 'Read only', sandbox: 'read-only', approval: 'ask' })

  // No `names` getter: probe the documented built-in names through resolve().
  const bare = {
    optionOf: value => ({ value, name: value }),
    resolve: value => value === 'read-only' ? { sandbox: 'read-only', approval: 'ask' } : undefined,
  }
  assert.deepEqual(namesPresetOptions(bare).map(option => option.value), ['read-only'])
})

test('directory adapters prefer workingDirectory.get and fall back to the durable header', () => {
  const agent = { session: { header: { cwd: '/header' } } }
  assert.equal(directoryViaService({ get: () => '/service' }, agent), '/service')
  assert.equal(directoryViaService({ get: () => { throw new Error('not ready') } }, agent), '/header')
  assert.equal(directoryViaService(undefined, agent), '/header')
  assert.equal(directoryFromHeader({ get: () => '/service' }, agent), '/header')
  assert.equal(directoryViaService({ get: () => '/service' }, undefined), undefined)
})

test('sessionState returns live state only when the host exposes state()', async () => {
  const signal = new AbortController().signal
  assert.deepEqual(await sessionState(CONTROLLER, 'S', signal), { running: true, active: true })
  assert.equal(await sessionState({}, 'S', signal), undefined)
  assert.equal(await sessionState({ state: async () => { throw new Error('gone') } }, 'S', signal), undefined)
  assert.equal(await noSessionState(), undefined)
})

test('unarchive adapters report whether the contractor became visible again', async () => {
  const calls = []
  const registry = { unarchiveSession: async id => { calls.push(id) } }
  assert.equal(await unarchiveSession(registry, 'S'), true)
  assert.deepEqual(calls, ['S'])
  assert.equal(await noUnarchive(), false)
})

test('archive adapters call the host signature each generation accepts', () => {
  const calls = []
  const registry = { archiveSession: (...args) => { calls.push(args) } }
  archiveWithStop(registry, 'A')
  archivePlain(registry, 'B')
  assert.deepEqual(calls, [['A', { stopActivity: true }], ['B']])
})
