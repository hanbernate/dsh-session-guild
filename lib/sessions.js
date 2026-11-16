/**
 * Session lookups and presentation shared by the quest tools.
 *
 * There is no role layer: tool visibility is decided by the in-memory quest
 * cache rebuilt from the Session's derived messages (a session that published
 * or received a quest). This module only resolves live Sessions and titles.
 * @module dsh-session-guild/lib/sessions
 */

/** Emoji that marks a quest session in the sidebar. */
const QUEST_MARK = '📜 '
/** Attribution wrapper around the client workspace title. */
const FROM_OPEN = ' (from '
const FROM_CLOSE = ')'
/** Marks text the byte budget cut. */
const ELLIPSIS = '…'
/** Least room inside the attribution that still names the source workspace. */
const MIN_SOURCE_BYTES = 6

/** UTF-8 size of one string. */
function sizeOf(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Longest leading code-point prefix of `text` within `limit` bytes. */
function truncateBytes(text, limit) {
  let used = 0
  let output = ''
  for (const character of text) {
    const size = sizeOf(character)
    if (used + size > limit) break
    output += character
    used += size
  }
  return output
}

/** Cut `text` to `limit` bytes, marking the cut with an ellipsis when it fits. */
function cutToBytes(text, limit) {
  if (sizeOf(text) <= limit) return text
  const room = limit - sizeOf(ELLIPSIS)
  const head = room > 0 ? truncateBytes(text, room) : ''
  return head === '' ? truncateBytes(text, limit) : `${head}${ELLIPSIS}`
}

/**
 * Fit one quest title into the Session title byte budget.
 *
 * The quest title is what the reader needs; the workspace attribution is
 * context. So a title that does not fit loses the attribution first — cut to
 * the remaining bytes, or dropped outright when too little of the workspace
 * title would remain — and only then is the title itself truncated.
 * @param {string} label - quest title from the tool arguments.
 * @param {string} sourceLabel - client workspace title.
 * @param {number} maxBytes - accepted Session title byte budget.
 * @returns {string} title of at most `maxBytes` UTF-8 bytes.
 */
export function questSessionTitle(label, sourceLabel, maxBytes) {
  const marker = `${QUEST_MARK}${label}`
  const attribution = `${FROM_OPEN}${sourceLabel}${FROM_CLOSE}`
  if (sizeOf(marker + attribution) <= maxBytes) return marker + attribution
  const markerBytes = sizeOf(marker)
  if (markerBytes > maxBytes) return cutToBytes(marker, maxBytes)
  const room = maxBytes - markerBytes - sizeOf(FROM_OPEN) - sizeOf(FROM_CLOSE)
  if (room >= MIN_SOURCE_BYTES) return `${marker}${FROM_OPEN}${cutToBytes(sourceLabel, room)}${FROM_CLOSE}`
  return marker
}

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
