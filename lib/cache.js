/**
 * In-memory quest cache.
 *
 * Nothing is persisted by the plugin. The derived Session messages are the
 * source of truth: `ensureClient` rebuilds a client's quests from the
 * structured `guild.quest` blocks in `guild_publish_quest` results and the
 * `report:` / `guild.report` completion evidence, and `ensureContractor`
 * rebuilds the contractor's minimal view from the delivered quest block and
 * `guild_report` results. A DSH restart starts with an empty cache; the next
 * step or tool call on a Session rebuilds the part it needs.
 *
 * Rebuilding walks `Session.deriveMessages()` (the model-visible surface), not
 * the raw event log: no persistence, no full-log scan, no deprecated readers,
 * and no prose regular expressions.
 * @module dsh-workspace-guild/lib/cache
 */

import { QUEST, REPORT, machineRecord, messagesOf, rpcIdOf } from './records.js'

/** Delivery request ids are `report:<questId>`. */
const REPORT_RPC_PREFIX = 'report:'

/**
 * Label for one quest, derived from the tool-call arguments exactly like the
 * publish tool derives it.
 * @param {object | undefined} args - `guild_publish_quest` arguments.
 * @returns {string} label.
 */
function labelOf(args) {
  const task = String(args?.task ?? '')
  return typeof args?.description === 'string' && args.description.trim() !== ''
    ? args.description.trim()
    : task.split('\n')[0].slice(0, 40)
}

/**
 * A fork child's messages include the inherited prefix, and derived messages
 * carry no per-message sequence that could cut it. Rebuilding such a Session
 * would re-attribute the parent's quests to the child, so skip it.
 * @param {object} session - live Session.
 * @returns {boolean} whether the Session has a fork-inherited prefix.
 */
function isForked(session) {
  return (session?.inheritedEventCount ?? 0) > 0
}

/** Create one empty quest cache. */
export function createQuestCache() {
  /** questId → record */
  const quests = new Map()
  /** client session id → quest ids, in publication order */
  const clients = new Map()
  /** contractor session id → quest id */
  const contractors = new Map()
  const loadedClients = new Set()
  const loadedContractors = new Set()

  function index(record) {
    const id = String(record.id)
    const existing = quests.get(id)
    const status = existing?.status === 'completed' ? 'completed' : (record.status ?? existing?.status ?? 'in_progress')
    const merged = { ...existing, ...record, id, status }
    quests.set(id, merged)
    const clientId = String(merged.clientSessionId ?? '')
    if (clientId !== '') {
      if (!clients.has(clientId)) clients.set(clientId, new Set())
      clients.get(clientId).add(id)
    }
    if (merged.contractorSessionId) contractors.set(String(merged.contractorSessionId), id)
    return merged
  }

  /** Add or replace a record after a tool action. */
  function add(record) {
    return index(record)
  }

  /** Merge fields into an existing record. */
  function patch(id, changes) {
    const current = quests.get(String(id))
    if (current === undefined) return undefined
    return index({ ...current, ...changes })
  }

  function get(id) {
    return quests.get(String(id))
  }

  /** Client records, oldest commission first. */
  function byClient(sessionId) {
    const ids = clients.get(String(sessionId)) ?? new Set()
    return [...ids]
      .map(id => quests.get(id))
      .filter(record => record !== undefined)
  }

  /** The record whose contractor is `sessionId`. */
  function byContractor(sessionId) {
    const id = contractors.get(String(sessionId))
    return id === undefined ? undefined : quests.get(id)
  }

  /** Rebuild one client's cache from its derived Session messages. */
  async function ensureClient(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || loadedClients.has(sessionId)) return
    if (isForked(session)) {
      loadedClients.add(sessionId)
      return
    }
    // Records indexed from a contractor log before this client's own scan keep
    // their relative order after the scan.
    const prior = new Set(clients.get(sessionId) ?? [])
    /** @type {string[]} quest ids in message order */
    const order = []
    /** @type {Set<string>} report evidence */
    const completed = new Set()
    /** @type {Map<string, object>} publish call id → arguments */
    const calls = new Map()

    for (const message of messagesOf(session)) {
      if (message?.role === 'assistant') {
        for (const block of message.content ?? []) {
          if (block?.type === 'tool-call' && block.name === 'guild_publish_quest' && typeof block.id === 'string') {
            calls.set(block.id, block.args)
          }
        }
        continue
      }
      if (message?.role === 'tool') {
        const quest = machineRecord(message, QUEST)
        if (quest !== undefined) {
          const args = calls.get(String(message.toolCallId ?? ''))
          index({
            id: String(quest.questId),
            clientSessionId: sessionId,
            contractorSessionId: String(quest.contractorSessionId ?? ''),
            workspace: String(quest.workspace ?? ''),
            workspacePath: String(quest.workspacePath ?? ''),
            permission: String(quest.permission ?? ''),
            // The assistant call may have been compacted away; never erase a
            // label another record already supplied.
            ...(args === undefined ? {} : { task: String(args.task ?? ''), label: labelOf(args) }),
            status: 'in_progress',
          })
          order.push(String(quest.questId))
        }
        const report = machineRecord(message, REPORT)
        if (report !== undefined) completed.add(String(report.questId))
        continue
      }
      if (message?.role === 'user') {
        const rpcId = rpcIdOf(message)
        if (rpcId !== undefined && rpcId.startsWith(REPORT_RPC_PREFIX)) {
          completed.add(rpcId.slice(REPORT_RPC_PREFIX.length))
        }
        const report = machineRecord(message, REPORT)
        if (report !== undefined) {
          completed.add(String(report.questId))
          // The publish result may have been compacted away while the report
          // survived; keep a minimal completed record instead of dropping it.
          if (!quests.has(String(report.questId)) && typeof report.contractorSessionId === 'string') {
            index({
              id: String(report.questId),
              clientSessionId: sessionId,
              contractorSessionId: report.contractorSessionId,
              workspace: '',
              workspacePath: '',
              permission: '',
              status: 'completed',
            })
            order.push(String(report.questId))
          }
        }
      }
    }

    for (const questId of completed) {
      if (quests.has(questId)) patch(questId, { status: 'completed' })
    }

    const ordered = new Set()
    for (const id of order) if (quests.has(id)) ordered.add(id)
    for (const id of prior) if (!ordered.has(id)) ordered.add(id)
    clients.set(sessionId, ordered)
    loadedClients.add(sessionId)
  }

  /** Rebuild one contractor's cache from its derived Session messages. */
  async function ensureContractor(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || loadedContractors.has(sessionId)) return
    if (isForked(session)) {
      loadedContractors.add(sessionId)
      return
    }
    for (const message of messagesOf(session)) {
      if (message?.role === 'user') {
        const quest = machineRecord(message, QUEST)
        if (quest === undefined || quests.has(String(quest.questId))) continue
        index({
          id: String(quest.questId),
          clientSessionId: String(quest.clientSessionId ?? ''),
          contractorSessionId: sessionId,
          workspace: String(quest.workspace ?? ''),
          workspacePath: String(quest.workspacePath ?? ''),
          permission: String(quest.permission ?? ''),
          status: 'in_progress',
        })
        continue
      }
      if (message?.role === 'tool') {
        const report = machineRecord(message, REPORT)
        if (report !== undefined) patch(String(report.questId), { status: 'completed' })
      }
    }
    loadedContractors.add(sessionId)
  }

  /** Whether this Session has published at least one quest. */
  async function hasPublished(session) {
    await ensureClient(session)
    return (clients.get(String(session?.id))?.size ?? 0) > 0
  }

  /** Whether this Session has received at least one quest. */
  async function hasReceived(session) {
    await ensureContractor(session)
    return contractors.has(String(session?.id))
  }

  return {
    add,
    patch,
    get,
    byClient,
    byContractor,
    ensureClient,
    ensureContractor,
    hasPublished,
    hasReceived,
  }
}
