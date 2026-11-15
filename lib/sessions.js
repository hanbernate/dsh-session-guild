/**
 * Session lookups, report evidence, and presentation shared by the quest tools.
 *
 * There is no role layer: tool visibility is decided by the durable quest
 * records (a session that published or received a quest), and `reportedIds`
 * reads the replayable report marker when a status write needs confirmation.
 * @module dsh-workspace-guild/lib/sessions
 */

/**
 * @param {{ host: object }} deps
 */
export function createSessions({ host }) {

  /** Resolve a live Session object from the sessions or agents service. */
  async function liveSession(sessionId) {
    const sessions = host.sessions()
    const direct = sessions?.get?.(sessionId)
    if (direct !== undefined) return direct
    const agents = host.agents()
    return agents?.get?.(sessionId)?.session
  }

  /** Poll briefly for a just-created Session to become live. */
  async function waitForSession(sessionId, attempts = 40) {
    for (let index = 0; index < attempts; index += 1) {
      const session = await liveSession(sessionId)
      if (session !== undefined) return session
      await new Promise(done => setTimeout(done, 10))
    }
    return undefined
  }

  /** Read a Session's event log without caching it. */
  function eventsOf(session) {
    if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
    return Array.isArray(session?.events) ? session.events : []
  }

  /** Extract the text blocks of a user or tool-result message event. */
  function textOf(event) {
    const content = Array.isArray(event?.data?.content)
      ? event.data.content
      : Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
    return content
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n')
  }

  /**
   * Report-marked quest ids in the client Session log. This is durable evidence
   * that survives a failed status write.
   */
  function reportedIds(session) {
    const ids = new Set()
    for (const event of eventsOf(session)) {
      for (const match of textOf(event).matchAll(/\[guild report #([A-Za-z0-9-]+)/g)) ids.add(match[1])
    }
    return ids
  }

  /** Whether the client Session log already contains the report marker. */
  function reported(session, questId) {
    return reportedIds(session).has(String(questId))
  }

  /** Title of a session, when the deployment exposes `sessionTitle`. */
  async function sessionTitleOf(sessionId) {
    const service = host.titles()
    const session = await liveSession(sessionId)
    if (service === undefined || session === undefined) return undefined
    try {
      return service.get(session)?.title
    } catch {
      return undefined
    }
  }

  /** Rename the contractor session; failures become notes instead of aborting. */
  async function renameSession(sessionId, wanted, notes) {
    const service = host.titles()
    const session = await liveSession(sessionId)
    if (service === undefined || session === undefined) return
    try {
      service.rename(session, wanted)
    } catch (error) {
      notes.push(`could not rename the contractor session: ${String(error)}`)
    }
  }

  return {
    liveSession,
    waitForSession,
    reported,
    reportedIds,
    sessionTitleOf,
    renameSession,
  }
}
