/**
 * Session lookups and presentation shared by the quest tools.
 *
 * There is no role layer: tool visibility is decided by the in-memory quest
 * cache rebuilt from the Session's derived messages (a session that published
 * or received a quest). This module only resolves live Sessions and titles.
 * @module dsh-session-guild/lib/sessions
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
    sessionTitleOf,
    renameSession,
  }
}
