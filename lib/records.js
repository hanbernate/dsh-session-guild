/**
 * Structured quest/report records carried inside model-visible tool-result and
 * user-message content.
 *
 * The rebuild source is `Session.deriveMessages()`, never the raw event log:
 * every record is one pure-JSON text block, so a reader parses blocks and
 * checks `kind` instead of matching prose with regular expressions.
 *
 * @module dsh-session-guild/lib/records
 */

/** Machine-readable block kinds. */
export const QUEST = 'guild.quest'
export const REPORT = 'guild.report'

/** Delivery request ids are `report:<questId>`, one per round. */
export const REPORT_RPC_PREFIX = 'report:'

/** Positive round number, or undefined when absent. */
function roundOf(fields) {
  return Number.isSafeInteger(fields?.round) && fields.round > 0 ? fields.round : undefined
}

/**
 * Label for one quest, derived from the `guild_publish_quest` arguments so the
 * client cache rebuilds exactly the name the publish tool used.
 * `title` is the current parameter; `description` and `task` keep labels
 * rebuildable for tool calls recorded by earlier releases.
 * @param {object | undefined} args - `guild_publish_quest` arguments.
 * @returns {string} label, never empty.
 */
export function questLabel(args) {
  const explicit = args?.title ?? args?.description
  const title = typeof explicit === 'string' ? explicit.trim() : ''
  if (title !== '') return title
  return String(args?.quest ?? args?.task ?? '').split('\n')[0].slice(0, 40)
}

/**
 * Normalize one `{ provider, model, reasoningEffort? }` selection.
 * @param {object | undefined} fields - raw selection.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function selectionRecord(fields) {
  if (fields === undefined || fields === null) return undefined
  const provider = typeof fields.provider === 'string' ? fields.provider.trim() : ''
  const model = typeof fields.model === 'string' ? fields.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const selection = { provider, model }
  if (typeof fields.reasoningEffort === 'string' && fields.reasoningEffort !== '') {
    selection.reasoningEffort = fields.reasoningEffort
  }
  return selection
}

/**
 * One text block holding the record as pure JSON.
 * @param {object} record - structured record.
 * @returns {{ type: 'text', text: string }} content block.
 */
export function recordBlock(record) {
  return { type: 'text', text: JSON.stringify(record) }
}

/**
 * Canonical quest record shared by the publish result and the quest delivery.
 * @param {object} fields - quest fields (`id` or `questId`, client, contractor,
 *   workspace, permission).
 * @returns {object} record with the stable `guild.quest` shape.
 */
export function questRecord(fields) {
  const record = {
    kind: QUEST,
    questId: String(fields.questId ?? fields.id),
    clientSessionId: String(fields.clientSessionId ?? ''),
    contractorSessionId: String(fields.contractorSessionId ?? ''),
    workspace: String(fields.workspace ?? ''),
    workspacePath: String(fields.workspacePath ?? ''),
    permission: String(fields.permission ?? ''),
  }
  // Delivery facts are optional so blocks written by older releases still parse.
  if (fields.delivery === 'job' || fields.delivery === 'prompt') record.delivery = fields.delivery
  if (typeof fields.jobId === 'string' && fields.jobId !== '') record.jobId = fields.jobId
  // Round 1 is the publish; every `guild_append` after completion opens the
  // next round and carries its own job id. Older blocks have no round.
  const round = roundOf(fields)
  if (round !== undefined) record.round = round
  // The model the contractor was told to use; absent when the quest kept the
  // deployment default, so an older block never gains a selection.
  const selection = selectionRecord(fields.selection)
  if (selection !== undefined) record.selection = selection
  return record
}

/**
 * Report request id for one round. Round 1 keeps the historical
 * `report:<questId>` identity; later rounds append `:r<n>` so a second round
 * cannot reuse the first round's request identity.
 * @param {string} questId - quest id.
 * @param {number} [round] - 1-based round.
 * @returns {string} request id.
 */
export function reportRpcId(questId, round = 1) {
  return Number.isSafeInteger(round) && round > 1
    ? `${REPORT_RPC_PREFIX}${String(questId)}:r${round}`
    : `${REPORT_RPC_PREFIX}${String(questId)}`
}

/**
 * Parse a report request id back into its quest and round.
 * @param {string | undefined} rpcId - `source.rpcId`.
 * @returns {{ questId: string, round: number } | undefined}
 */
export function reportRpcPart(rpcId) {
  if (typeof rpcId !== 'string' || !rpcId.startsWith(REPORT_RPC_PREFIX)) return undefined
  const rest = rpcId.slice(REPORT_RPC_PREFIX.length)
  const match = /^(.*):r(\d+)$/u.exec(rest)
  if (match === null) return { questId: rest, round: 1 }
  return { questId: match[1], round: Number(match[2]) }
}

/**
 * Canonical report record. `contractorSessionId` is present on the delivery to
 * the client session and omitted in the contractor's own tool result, whose
 * copy carries the summary that a later cold read can recover.
 * @param {object} fields - report fields.
 * @returns {object} record with the stable `guild.report` shape.
 */
export function reportRecord(fields) {
  const record = { kind: REPORT, questId: String(fields.questId) }
  if (fields.contractorSessionId !== undefined) record.contractorSessionId = String(fields.contractorSessionId)
  if (fields.to !== undefined) record.to = String(fields.to)
  const round = roundOf(fields)
  if (round !== undefined) record.round = round
  if (typeof fields.summary === 'string' && fields.summary !== '') record.summary = fields.summary
  return record
}

/**
 * The model-visible messages already derived by the Session, or an empty list
 * when the host (or a test double) does not expose them.
 * @param {{ deriveMessages?: () => unknown }} session - live Session.
 * @returns {readonly object[]} messages in surface order.
 */
export function messagesOf(session) {
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : undefined
  return Array.isArray(messages) ? messages : []
}

/**
 * Find one machine record of `kind` in a message's text blocks.
 * @param {{ content?: readonly object[] }} message - one derived message.
 * @param {string} kind - expected `kind` value.
 * @returns {object | undefined} parsed record.
 */
export function machineRecord(message, kind) {
  for (const block of message?.content ?? []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trimStart()
    if (!text.startsWith('{')) continue
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.kind === kind) return parsed
  }
  return undefined
}

/**
 * The durable request identity of a delivered user message.
 * @param {{ source?: object }} message - one derived message.
 * @returns {string | undefined} `source.rpcId`.
 */
export function rpcIdOf(message) {
  const rpcId = message?.source?.rpcId
  return typeof rpcId === 'string' ? rpcId : undefined
}
