/**
 * In-memory quest cache.
 *
 * Nothing is persisted by the plugin. The Session logs are the source of
 * truth: `ensureClient` rebuilds a client's quests from the replayed
 * `guild_publish_quest` tool results, and `ensureContractor` rebuilds the
 * contractor's minimal view from the delivered marker and `guild_report`
 * results. A DSH restart starts with an empty cache; the next tool call on a
 * Session rebuilds the part it needs.
 * @module dsh-workspace-guild/lib/cache
 */

const QUEST_MARKER = /\[guild quest #([A-Za-z0-9-]+) client=([^\s\]]+)(?: workspace=([^\]]+))?\]/

/**
 * @param {{ sessions: object }} deps
 */
export function createQuestCache({ sessions }) {
  /** questId → record */
  const quests = new Map()
  /** client session id → quest ids */
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
    const clientId = String(merged.clientSessionId)
    if (!clients.has(clientId)) clients.set(clientId, new Set())
    clients.get(clientId).add(id)
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
      .sort((left, right) => (left.publishedAt ?? 0) - (right.publishedAt ?? 0))
  }

  /** The record whose contractor is `sessionId`. */
  function byContractor(sessionId) {
    const id = contractors.get(String(sessionId))
    return id === undefined ? undefined : quests.get(id)
  }

  /** Rebuild one client's cache from its replayable Session log. */
  async function ensureClient(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || loadedClients.has(sessionId)) return
    loadedClients.add(sessionId)
    const reports = sessions.reportedIds(session)
    for (const event of sessions.eventsOf(session)) {
      const meta = event?.type === 'tool/result' ? event.data?.meta : undefined
      if (meta?.kind !== 'guild.quest' || typeof meta.questId !== 'string') continue
      index({
        id: meta.questId,
        clientSessionId: sessionId,
        contractorSessionId: meta.contractorSessionId,
        workspace: meta.workspace,
        workspacePath: meta.workspacePath,
        permission: meta.permission,
        task: meta.task,
        label: meta.label,
        status: reports.has(meta.questId) ? 'completed' : 'in_progress',
        publishedAt: event.time,
      })
    }
    for (const questId of reports) patch(questId, { status: 'completed' })
  }

  /** Rebuild one contractor's cache from its replayable Session log. */
  async function ensureContractor(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || loadedContractors.has(sessionId)) return
    loadedContractors.add(sessionId)
    for (const event of sessions.eventsOf(session)) {
      const text = sessions.textOf(event)
      const marker = text.match(QUEST_MARKER)
      if (marker !== null) {
        const [, questId, clientSessionId, workspacePath] = marker
        if (!quests.has(questId)) {
          index({
            id: questId,
            clientSessionId,
            contractorSessionId: sessionId,
            workspacePath: workspacePath ?? '',
            workspace: workspacePath === undefined ? '' : workspacePath.split('/').pop(),
            status: 'in_progress',
          })
        }
      }
      const meta = event?.type === 'tool/result' ? event.data?.meta : undefined
      if (meta?.kind === 'guild.report' && typeof meta.questId === 'string') {
        patch(meta.questId, { status: 'completed' })
      }
    }
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
