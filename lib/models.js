/**
 * Model selection for a freshly created contractor session.
 *
 * A quest may name the exact model the contractor must use, so a delegated
 * sub-session can run the same model as the session that delegated it. Two
 * invariants shape this module:
 *
 * - The deployment default model is never changed. A model named on the quest
 *   applies to that one Session; only a host without Agent-level selection
 *   falls back to `sessionController.selectModel`, whose documented side effect
 *   (it saves the new route as the deployment default) is reported in the
 *   publish notes.
 * - Availability is confirmed **before** the requirement is delivered, so a
 *   bad route fails the publish instead of producing a quest that ran on the
 *   wrong model. The catalog comes from `sessionController.modelCatalog()` or,
 *   on hosts without it, from the live `llm` registry (`resolveCallConfig`,
 *   which is the same validation `selectModel` performs).
 *
 * Everything degrades through the host facade: a deployment that exposes no
 * catalog and no `llm` service is unverified (recorded as a note), and a
 * deployment with no way to select a model at all refuses an explicitly
 * requested selection rather than silently running the default.
 * @module dsh-session-guild/lib/models
 */

import { detectCapabilities } from './compat.js'
import { selectionRecord } from './records.js'

/** Trimmed string, or undefined when absent/blank. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse the model arguments of `guild_publish_quest`.
 *
 * `provider` and `model` must be given together; `reasoning_effort` needs both.
 * Rejecting a lone `provider` here is what keeps a typo from silently falling
 * back to the default model.
 * @param {object | undefined} args - tool arguments.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 * @throws {Error} when only one of provider/model, or an effort alone, is given.
 */
export function requestedSelection(args) {
  const provider = text(args?.provider)
  const model = text(args?.model)
  // Accept the camelCase spelling as well: the host APIs use it, so a caller
  // written against them should not have to discover the snake_case schema.
  const reasoningEffort = text(args?.reasoning_effort) ?? text(args?.reasoningEffort)
  if (provider === undefined && model === undefined) {
    if (reasoningEffort !== undefined) {
      throw new Error('reasoning_effort requires provider and model; give both, or omit all three to keep the deployment default model')
    }
    return undefined
  }
  if (provider === undefined || model === undefined) {
    throw new Error('provider and model must be given together (both or neither); a partial selection would silently run the deployment default model')
  }
  return selectionRecord({ provider, model, reasoningEffort })
}

/** Human-readable `provider/model (effort)` label. */
export function selectionLabel(selection) {
  if (selection === undefined) return undefined
  const label = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? label : `${label} (${selection.reasoningEffort})`
}

/** The selection as a host `LlmCallConfig`, without request controls. */
function callConfig(selection) {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/** Provider ids a catalog groups, for the error message. */
function providerIds(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  return groups.map(group => group?.id).filter(id => typeof id === 'string' && id !== '')
}

/** Model ids inside one catalog provider group. */
function modelIds(catalog, provider) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const group = groups.find(entry => entry?.id === provider)
  const models = Array.isArray(group?.models) ? group.models : []
  return models.map(model => model?.id).filter(id => typeof id === 'string' && id !== '')
}

/** The catalog's failure text for a provider, when the catalog recorded one. */
function failureText(catalog, provider) {
  const failures = Array.isArray(catalog?.failures) ? catalog.failures : []
  const failure = failures.find(entry => entry?.id === provider)
  return typeof failure?.message === 'string' && failure.message !== '' ? failure.message : undefined
}

/**
 * Check one selection against a `ModelCatalog`.
 *
 * `reasoning` is present exactly when the adapter supports efforts for that
 * route, so a named effort on a model with no `reasoning` is correctly
 * rejected; an effort outside the advertised list is rejected too.
 * @param {object} catalog - `sessionController.modelCatalog()` value.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
 * @returns {{ state: 'available' | 'unavailable', reason?: string }}
 */
export function checkCatalog(catalog, selection) {
  const providers = providerIds(catalog)
  const group = Array.isArray(catalog?.groups)
    ? catalog.groups.find(entry => entry?.id === selection.provider)
    : undefined
  if (group === undefined) {
    // A provider that failed to load has no group; say why when the catalog knows.
    const failure = failureText(catalog, selection.provider)
    return {
      state: 'unavailable',
      reason: failure === undefined
        ? `provider "${selection.provider}" is not in the host model catalog; available providers: ${providers.join(', ') || '(none)'}`
        : `provider "${selection.provider}" failed to load in the host model catalog: ${failure}`,
    }
  }
  const models = modelIds(catalog, selection.provider)
  const model = Array.isArray(group.models) ? group.models.find(entry => entry?.id === selection.model) : undefined
  if (model === undefined) {
    return {
      state: 'unavailable',
      reason: `model "${selection.model}" is not available under provider "${selection.provider}"; available models: ${models.join(', ') || '(none)'}`,
    }
  }
  if (selection.reasoningEffort !== undefined) {
    const efforts = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : undefined
    if (efforts === undefined) {
      return {
        state: 'unavailable',
        reason: `model "${selection.provider}/${selection.model}" advertises no reasoning effort, so "reasoning_effort: ${selection.reasoningEffort}" cannot be honoured`,
      }
    }
    if (!efforts.some(effort => effort?.id === selection.reasoningEffort)) {
      const ids = efforts.map(effort => effort?.id).filter(id => typeof id === 'string')
      return {
        state: 'unavailable',
        reason: `reasoning effort "${selection.reasoningEffort}" is not supported by "${selection.provider}/${selection.model}"; supported: ${ids.join(', ') || '(none)'}`,
      }
    }
  }
  return { state: 'available' }
}

/**
 * @param {{ host: object, ctx: import('@deepseek-ai/cordis').Context }} deps
 */
export function createModels({ host, ctx }) {
  /**
   * Confirm a selection is currently routable.
   * @param {{ provider: string, model: string }} selection
   * @returns {Promise<{ state: 'available' | 'unavailable' | 'unverified', reason?: string }>}
   */
  async function availability(selection) {
    if (detectCapabilities(ctx).modelCatalog) {
      let catalog
      try {
        catalog = await host.controller().modelCatalog()
      } catch (error) {
        // A catalog that cannot be read is not a verdict; try the LLM registry.
        catalog = undefined
        ctx.logger?.warn?.(`session-guild: modelCatalog() failed, falling back to the llm registry: ${String(error)}`)
      }
      if (catalog !== undefined) return checkCatalog(catalog, selection)
    }
    const llm = host.llm()
    if (typeof llm?.resolveCallConfig === 'function') {
      try {
        // This is exactly the validation `sessionController.selectModel` runs:
        // unknown route or an unsupported effort rejects before provider I/O.
        await llm.resolveCallConfig(callConfig(selection))
        return { state: 'available' }
      } catch (error) {
        return { state: 'unavailable', reason: String(error?.message ?? error) }
      }
    }
    return { state: 'unverified' }
  }

  /**
   * Apply a selection to one Session only, preferring Agent-level selection.
   * @param {string} sessionId - the contractor Session.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} selection
   * @param {string[]} notes - publish notes, appended in place.
   * @returns {Promise<{ scope: 'session' | 'deployment-default' | 'unverified' }>}
   */
  async function apply(sessionId, selection, notes) {
    const verdict = await availability(selection)
    if (verdict.state === 'unavailable') {
      throw new Error(
        `session ${sessionId} was created but the requested model ${selectionLabel(selection)} is unavailable: `
        + `${verdict.reason}; the requirement was not delivered, so no quest ran on the wrong model`,
      )
    }
    if (verdict.state === 'unverified') {
      notes.push(
        `此宿主没有暴露模型目录（或等价 llm 目录），无法在投递前确认 ${selectionLabel(selection)} 是否可用；`
        + '若不可用，受托会话的第一个模型步会失败。',
      )
    }

    const agent = host.agents()?.get?.(sessionId)
    if (typeof agent?.model?.select === 'function') {
      try {
        agent.model.select(selection)
        return { scope: verdict.state === 'unverified' ? 'unverified' : 'session' }
      } catch (error) {
        notes.push(`Agent 级模型选择失败：${String(error?.message ?? error)}；将尝试 sessionController.selectModel。`)
      }
    }

    const controller = host.controller()
    if (typeof controller?.selectModel === 'function') {
      try {
        await controller.selectModel({
          sessionId,
          ...callConfig(selection),
        })
      } catch (error) {
        throw new Error(
          `session ${sessionId} was created but its model could not be set to ${selectionLabel(selection)}: `
          + `${String(error?.message ?? error)}; the requirement was not delivered`,
        )
      }
      // selectModel validates and then saves the selection as the deployment
      // default. That is a real side effect and the client must know it.
      notes.push(
        `此宿主没有 Agent 级模型选择（agent.model.select），已改用 sessionController.selectModel 设置 ${selectionLabel(selection)}：`
        + '该调用会把新模型同时保存为部署默认模型。',
      )
      return { scope: 'deployment-default' }
    }

    throw new Error(
      `session ${sessionId} was created but this host exposes neither agent.model.select nor sessionController.selectModel, `
      + `so the requested model ${selectionLabel(selection)} cannot be set; the requirement was not delivered`,
    )
  }

  return { availability, apply }
}
