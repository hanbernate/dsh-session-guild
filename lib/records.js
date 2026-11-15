/**
 * Structured quest/report records carried inside model-visible tool-result and
 * user-message content.
 *
 * The rebuild source is `Session.deriveMessages()`, never the raw event log:
 * every record is one pure-JSON text block, so a reader parses blocks and
 * checks `kind` instead of matching prose with regular expressions.
 *
 * @module dsh-workspace-guild/lib/records
 */

/** Machine-readable block kinds. */
export const QUEST = 'guild.quest'
export const REPORT = 'guild.report'

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
  return {
    kind: QUEST,
    questId: String(fields.questId ?? fields.id),
    clientSessionId: String(fields.clientSessionId ?? ''),
    contractorSessionId: String(fields.contractorSessionId ?? ''),
    workspace: String(fields.workspace ?? ''),
    workspacePath: String(fields.workspacePath ?? ''),
    permission: String(fields.permission ?? ''),
  }
}

/**
 * Canonical report record. `contractorSessionId` is present on the delivery to
 * the client session and omitted in the contractor's own tool result.
 * @param {object} fields - report fields.
 * @returns {object} record with the stable `guild.report` shape.
 */
export function reportRecord(fields) {
  const record = { kind: REPORT, questId: String(fields.questId) }
  if (fields.contractorSessionId !== undefined) record.contractorSessionId = String(fields.contractorSessionId)
  if (fields.to !== undefined) record.to = String(fields.to)
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
