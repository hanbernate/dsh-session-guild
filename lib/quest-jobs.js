/**
 * Background-job bridge for quest reports.
 *
 * A quest's report is a value, and the Harness job registry already owns that
 * shape: `jobs.start` registers the work synchronously and returns an id, the
 * producer's `done` settles it later, and `JobOutcome.result` is handed to the
 * model once by its next `job_output` read. That is what lets the client
 * collect a report as a tool result instead of admitting a `user/message`
 * through `sessionController.prompt`.
 *
 * The bridge holds no durable state of its own. The report is durable twice
 * over: the contractor's `guild_report` tool result carries the `guild.report`
 * block (with the summary), and the client's `guild.quest` block carries the
 * job id. When the receiver is gone — a restart, or the owner's disposal
 * cancelling the job — `guild_report` records the report in the cache and the
 * durable block instead of falling back to a message, and `guild_collect`
 * rebuilds it from the contractor's Session.
 *
 * The receiver map is the one piece of state that must outlive a plugin
 * instance: an HMR reload (this plugin's `lib/` is a watch root) disposes the
 * running instance and applies a fresh one, while the host's job registry — a
 * host-level service — keeps the old instance's `done` promise alive. That
 * promise exposes no settle-by-id API (`kill` would record `killed` and run
 * the cancel side effects, the wrong outcome for a report), so the settlement
 * handle is what has to survive: the map lives on the application's root
 * context, which every instance shares, instead of in instance memory.
 *
 * @module dsh-session-guild/lib/quest-jobs
 */

/** Producer kind: also the job id prefix (`guild-quest-<short-uuid>`). */
export const QUEST_JOB_KIND = 'guild-quest'

/**
 * Symbol key of the receiver map on the root context. `Symbol.for` so two
 * module generations of this plugin (during a reload) address the same slot.
 */
const RECEIVERS = Symbol.for('dsh-session-guild.receivers')

/**
 * The quest → settlement-handle map shared by every instance of this plugin
 * in the process.
 *
 * Entries are deleted by `settle` itself (it closes over this map), so the
 * map only ever holds receivers whose jobs are still live; a settled job, a
 * killed job, and a teardown all run `settle` through the producer hooks.
 * @param {object} ctx - plugin context of any instance.
 * @returns {Map<string, { jobId: string, round: number, settle: (outcome: object) => void }>}
 */
function receiversOf(ctx) {
  // `ctx.root` is the application root every child context inherits; the test
  // doubles have no root, and there a context is its own scope.
  const scope = ctx?.root ?? ctx
  const existing = scope[RECEIVERS]
  if (existing !== undefined) return existing
  const created = new Map()
  scope[RECEIVERS] = created
  return created
}

/**
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   host: object,
 *   settings: object,
 *   cache: object,
 * }} deps
 */
export function createQuestJobs({ ctx, host, settings, cache }) {
  /** questId → the live producer's settlement handle. Shared across instances; see `receiversOf`. */
  const receivers = receiversOf(ctx)

  /**
   * Register the job that will carry one quest's report.
   *
   * The receiver lands on the shared map (`receiversOf`), so an HMR reload
   * between this publish and the contractor's report cannot lose it: the
   * successor instance settles this job exactly as this one would.
   *
   * The job is owner-fenced to the client session: its disposal cancels the
   * job, and the registry refuses to start one for an owner without a live
   * Agent or an attached job controller. Both refusals are reported as thrown
   * errors so `auto` can fall back to prompt delivery.
   *
   * @param {object} record - quest record (id, clientSessionId, contractorSessionId, workspace, round).
   * @param {{ callId: string, rootCallId: string } | undefined} toolCall - publishing invocation.
   * @returns {{ delivery: 'job', jobId: string } | { delivery: 'prompt' }}
   */
  function start(record, toolCall) {
    const round = Number(record.round) || 1
    if (settings.reportDelivery === 'prompt') return { delivery: 'prompt' }
    const jobs = host.jobs()
    if (jobs === undefined) {
      if (settings.reportDelivery === 'job') {
        throw new Error(
          'reportDelivery is "job" but this host exposes no jobs service; '
          + 'load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs, or set reportDelivery: "auto"',
        )
      }
      return { delivery: 'prompt' }
    }

    let finish
    const done = new Promise(resolve => { finish = resolve })
    let ended = false
    const settle = outcome => {
      if (ended) return
      ended = true
      receivers.delete(String(record.id))
      finish(outcome)
    }

    const jobId = jobs.start({
      kind: QUEST_JOB_KIND,
      // Round 1 keeps the historical label; a reopened round says which one.
      label: `${record.id}${round > 1 ? ` (round ${round})` : ''} → ${record.workspace || record.contractorSessionId}`,
      owner: record.clientSessionId,
      ...(toolCall === undefined ? {} : { toolCall }),
      // Bounds the completion notice and the read; the summary itself is
      // capped by `summaryChars`, and UTF-8 bytes may take three per character.
      outputLimitBytes: settings.summaryChars * 3 + 1024,
      run: () => ({
        cancel: reason => {
          if (ended) return
          settle({ status: 'killed', detail: typeof reason === 'string' && reason !== '' ? reason : 'cancelled' })
          cache.patch(record.id, {
            status: 'cancelled',
            note: `后台任务已终止${typeof reason === 'string' && reason !== '' ? `：${reason}` : ''}`,
          })
          stopContractor(record)
        },
        done,
      }),
    })

    receivers.set(String(record.id), { jobId, round, settle })
    return { delivery: 'job', jobId }
  }

  /**
   * Settle the live receiver for one quest, if the client still owns it.
   * @param {string} questId - quest whose job should settle.
   * @param {{ status: 'completed' | 'killed' | 'failed', result?: string, detail?: string }} outcome - terminal outcome.
   * @param {number} [round] - the reporting round; a receiver for another round is left alone.
   * @returns {string | undefined} the settled job id, or undefined when no matching receiver is live.
   */
  function deliver(questId, outcome, round) {
    const receiver = receivers.get(String(questId))
    if (receiver === undefined) return undefined
    if (round !== undefined && receiver.round !== round) return undefined
    receiver.settle(outcome)
    return receiver.jobId
  }

  /**
   * Settle a receiver as failed without a report; used when quest delivery
   * itself failed after the job was registered.
   * @param {string} questId - quest to fail.
   * @param {string} detail - terminal reason.
   * @param {number} [round] - the round whose registration is being abandoned.
   */
  function fail(questId, detail, round) {
    deliver(questId, { status: 'failed', detail }, round)
  }

  /**
   * Stop the contractor's current turn after the client killed the quest.
   * Best effort: a cold or already-idle contractor simply rejects nothing.
   * @param {object} record - quest record.
   */
  function stopContractor(record) {
    try {
      host.controller()?.cancel?.({ sessionId: record.contractorSessionId })
    } catch (error) {
      ctx.logger?.warn?.(
        `session-guild: could not stop contractor ${String(record.contractorSessionId)} after ${String(record.id)} was cancelled: ${String(error)}`,
      )
    }
  }

  return { start, deliver, fail }
}
