/**
 * Quest reporting mode.
 *
 * A quest is human-in-the-loop by default: the contractor presents its result
 * in its own session and waits for the user before `guild_report`. Only a
 * quest that explicitly declared itself unattended reports as soon as the work
 * is done. The mode travels in the `guild.quest` record, so publish, append,
 * resume, and a cold cache rebuild all apply the same rule.
 *
 * The instruction text lives here, not in the tool descriptions alone: the
 * delivered user message is the only prompt every contractor reads before its
 * first step, while a tool description sits far back in a long context.
 * @module dsh-session-guild/lib/quest-mode
 */

/** Accepted modes, in the order the publish tool advertises them. */
export const QUEST_MODES = ['review', 'unattended']

/** Human-in-the-loop default. */
export const DEFAULT_QUEST_MODE = 'review'

/**
 * Normalize a stored or argument mode. Unknown values — including records
 * written before modes existed — are the human-in-the-loop default: silence is
 * not a declaration of unattended work.
 * @param {unknown} value - raw mode.
 * @returns {'review' | 'unattended'} normalized mode.
 */
export function questMode(value) {
  return value === 'unattended' ? 'unattended' : DEFAULT_QUEST_MODE
}

/**
 * Whether a value is an accepted mode. Used to reject a typo at the tool
 * boundary instead of silently publishing the wrong reporting rule.
 * @param {unknown} value - raw mode.
 * @returns {boolean} whether `value` names a mode.
 */
export function isQuestMode(value) {
  return value === 'review' || value === 'unattended'
}

/**
 * The paragraph appended to a delivered requirement. It sits after the quest
 * text so it is the last thing the contractor reads before it starts.
 * @param {unknown} mode - raw mode.
 * @returns {string} the reporting discipline paragraph.
 */
export function reportingDiscipline(mode) {
  return questMode(mode) === 'unattended'
    ? '——\n回报方式（无人值守，以本条为准）：完成后直接调用 guild_report 汇报结果，不要停下来等用户确认。'
    : '——\n回报方式（人在环，以本条为准）：本会话是给用户看的子会话。完成或到达需要用户拍板的点后，把结果与待确认事项发在这里，'
      + '问用户是否回报（有提问工具就用它，它会等回答），确认后再调用 guild_report 回报；未经确认不要直接回报。'
}

/**
 * The sentence an append that opens a new round puts in front of the message.
 * @param {unknown} mode - raw mode.
 * @returns {string} the reporting sentence for this round.
 */
export function appendReportSentence(mode) {
  return questMode(mode) === 'unattended'
    ? '这是委托方的新要求，完成后请再次调用 guild_report 汇报本轮摘要。'
    : '这是委托方的新要求；处理完先把结果与待确认事项发给本会话的用户，确认后再调用 guild_report 回报。'
}

/**
 * The sentence a resume wake adds after "continue this quest".
 * @param {unknown} mode - raw mode.
 * @returns {string} the reporting sentence for the resumed round.
 */
export function resumeReportSentence(mode) {
  return questMode(mode) === 'unattended'
    ? '完成后调用 guild_report 汇报摘要。'
    : '完成或到达需要拍板的点后，先把结果发给本会话的用户，确认后再调用 guild_report 回报。'
}
