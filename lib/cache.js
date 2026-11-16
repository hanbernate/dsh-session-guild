/**
 * In-memory quest cache.
 *
 * Nothing is persisted by the plugin. The derived Session messages are the
 * source of truth: `ensureClient` rebuilds a client's quests from the
 * structured `guild.quest` blocks in `guild_publish_quest` / `guild_append`
 * results (including `selection`, `round`, `jobId`, `delivery`) plus the
 * `report:` / `guild.report` completion evidence, and `ensureContractor`
 * rebuilds the contractor's view from the delivered quest blocks and
 * `guild_report` results (whose block carries the summary). A DSH restart
 * starts with an empty cache; the next step or tool call on a Session rebuilds
 * the part it needs.
 *
 * Rebuilding walks `Session.deriveMessages()` (the model-visible surface), not
 * the raw event log: no persistence, no full-log scan, no deprecated readers,
 * and no prose regular expressions.
 *
 * Rounds are folded **in message order**: a quest block opens its round
 * (`in_progress`), a report closes the same round (`completed`), and a later
 * quest block with a higher round reopens the quest for the next round. So
 * `publish → report → append → report` ends `completed` at round 2 whether it
 * is replayed from a cold cache or applied live. The fold is monotone in the
 * round number: a same-round quest block never downgrades a completed record
 * (a compacted-away report cannot resurrect an open round), and a report for an
 * older round never completes a newer open one.
 * @module dsh-session-guild/lib/cache
 */

import {
  QUEST,
  REPORT,
  machineRecord,
  messagesOf,
  questLabel,
  reportRpcPart,
  rpcIdOf,
} from './records.js'

/** Trimmed non-empty string, or undefined. */
function textOf(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
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

/** Record's 1-based round; a record without one is round 1. */
function roundOf(record) {
  return Number.isSafeInteger(record?.round) && record.round > 0 ? record.round : 1
}

/** A block's round when it names one, else undefined (older release). */
function blockRound(block) {
  return Number.isSafeInteger(block?.round) && block.round > 0 ? block.round : undefined
}

/**
 * Delivery facts carried by a `guild.quest` block. Records written by older
 * releases have neither field and keep the legacy prompt delivery.
 * @param {object} quest - parsed `guild.quest` block.
 * @returns {{ delivery?: 'job' | 'prompt', jobId?: string }}
 */
function deliveryFields(quest) {
  const result = {}
  if (quest?.delivery === 'job' || quest?.delivery === 'prompt') result.delivery = quest.delivery
  if (typeof quest?.jobId === 'string' && quest.jobId !== '') result.jobId = quest.jobId
  return result
}

/**
 * The model selection a block names, when it is complete.
 * @param {object} quest - parsed `guild.quest` block.
 * @returns {{ selection?: { provider: string, model: string, reasoningEffort?: string } }}
 */
function selectionFields(quest) {
  const provider = textOf(quest?.selection?.provider)
  const model = textOf(quest?.selection?.model)
  if (provider === undefined || model === undefined) return {}
  const effort = textOf(quest?.selection?.reasoningEffort)
  return {
    selection: {
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    },
  }
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

  /**
   * @param {object} record - record fields.
   * @param {{ replace?: boolean }} [options] - `replace` overwrites the record
   *   instead of folding it (used to roll back an append whose delivery
   *   failed: the round was never durably opened, so nothing should stay open).
   */
  function index(record, options = {}) {
    const id = String(record.id)
    const existing = options.replace === true ? undefined : quests.get(id)
    const priorRound = roundOf(existing)
    const named = blockRound(record)
    const nextRound = named === undefined ? priorRound : Math.max(priorRound, named)
    const explicit = record.status
    // A higher round is the only way a completed record reopens. At the same
    // round, completion is the one sticky state: a replayed publish block (or a
    // compacted-away report) must not downgrade it. `cancelled`/`failed` are
    // not sticky — a late report still closes the round (the job is gone, the
    // answer is not).
    let status = explicit ?? existing?.status ?? 'in_progress'
    if (nextRound > priorRound) status = explicit ?? 'in_progress'
    else if (existing?.status === 'completed') status = 'completed'

    const merged = { ...existing, ...record, id, status, round: nextRound }
    if (nextRound > priorRound && status === 'in_progress') {
      // A reopened round has no answer yet; the previous round's summary is
      // no longer the quest's current result.
      delete merged.summary
      delete merged.reportedAt
    }
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

  /**
   * Overwrite a record wholesale (no fold, no round monotonicity).
   * @param {string} id - quest id.
   * @param {object} record - the state to restore.
   */
  function replace(id, record) {
    return index({ ...record, id }, { replace: true })
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

  /**
   * Fold one `guild.quest` block into the cache: it opens (or reopens) its round.
   * @param {object} block - parsed `guild.quest` block.
   * @param {{ clientSessionId?: string, contractorSessionId?: string, args?: object }} context
   */
  function foldQuest(block, context) {
    const id = String(block.questId)
    const existing = quests.get(id)
    const round = blockRound(block)
    const args = context.args
    const contractorSessionId = context.contractorSessionId ?? textOf(block.contractorSessionId)
    index({
      id,
      clientSessionId: context.clientSessionId ?? textOf(block.clientSessionId) ?? existing?.clientSessionId ?? '',
      ...(contractorSessionId === undefined ? {} : { contractorSessionId: String(contractorSessionId) }),
      workspace: textOf(block.workspace) ?? existing?.workspace ?? '',
      workspacePath: textOf(block.workspacePath) ?? existing?.workspacePath ?? '',
      permission: textOf(block.permission) ?? existing?.permission ?? '',
      // The assistant call may have been compacted away; never erase a label
      // another record already supplied.
      ...(args === undefined ? {} : { quest: String(args.quest ?? args.task ?? ''), label: questLabel(args) }),
      ...deliveryFields(block),
      ...selectionFields(block),
      ...(round === undefined ? {} : { round }),
      status: 'in_progress',
    })
    return id
  }

  /**
   * Fold one report into the cache: it completes the round it names.
   * @param {object} report - parsed `guild.report` block or `{ questId, round }`.
   * @param {{ clientSessionId?: string, create?: boolean }} context
   * @returns {string | undefined} the quest id when this report created the record
   */
  function foldReport(report, context) {
    const id = String(report.questId)
    const existing = quests.get(id)
    const round = blockRound(report) ?? roundOf(existing)
    // A stale round's report must not close a newer open round.
    if (existing !== undefined && round < roundOf(existing)) return
    const summary = typeof report.summary === 'string' && report.summary !== '' ? report.summary : undefined
    if (existing === undefined) {
      if (context.create === false) return
      const contractorSessionId = textOf(report.contractorSessionId)
      if (contractorSessionId === undefined) return
      const clientSessionId = context.clientSessionId ?? textOf(report.clientSessionId)
      if (clientSessionId === undefined) return
      index({
        id,
        clientSessionId,
        contractorSessionId,
        workspace: '',
        workspacePath: '',
        permission: '',
        round,
        status: 'completed',
        ...(summary === undefined ? {} : { summary }),
      })
      return id
    }
    const merged = {
      ...existing,
      id,
      round,
      status: 'completed',
      ...(summary === undefined ? {} : { summary }),
    }
    // A higher round closed without a summary must not inherit the old answer.
    if (summary === undefined && round > roundOf(existing)) delete merged.summary
    index(merged)
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
        if (quest !== undefined && typeof quest.questId === 'string') {
          order.push(foldQuest(quest, {
            clientSessionId: sessionId,
            args: calls.get(String(message.toolCallId ?? '')),
          }))
        }
        const report = machineRecord(message, REPORT)
        if (report !== undefined && typeof report.questId === 'string') {
          const created = foldReport(report, { clientSessionId: sessionId })
          if (created !== undefined) order.push(created)
        }
        continue
      }
      if (message?.role === 'user') {
        // Legacy prompt delivery has two independent completion witnesses: the
        // request identity (`report:<questId>` / `report:<questId>:r<n>`) and
        // the machine block that also carries the summary.
        const part = reportRpcPart(rpcIdOf(message))
        if (part !== undefined) foldReport({ questId: part.questId, round: part.round }, { clientSessionId: sessionId })
        const report = machineRecord(message, REPORT)
        if (report !== undefined && typeof report.questId === 'string') {
          const created = foldReport(report, { clientSessionId: sessionId })
          if (created !== undefined) order.push(created)
        }
      }
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
        if (quest === undefined || typeof quest.questId !== 'string') continue
        // Every delivered quest block is a round: publish is round 1, each
        // append that reopened the quest is the next one.
        foldQuest(quest, { contractorSessionId: sessionId })
        continue
      }
      if (message?.role === 'tool') {
        const report = machineRecord(message, REPORT)
        if (report !== undefined && typeof report.questId === 'string') {
          const summary = typeof report.summary === 'string' && report.summary !== '' ? report.summary : undefined
          foldReport({ ...report, ...(summary === undefined ? {} : { summary }) }, { create: false })
        }
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
    replace,
    get,
    byClient,
    byContractor,
    ensureClient,
    ensureContractor,
    hasPublished,
    hasReceived,
  }
}
