/**
 * Workspace discovery and target resolution.
 *
 * A quest target may be named by id, title, absolute path, or directory
 * basename. `matchWorkspace` preserves that order, and refuses to guess when
 * nothing matches so the model can list the workspace registry instead.
 * @module dsh-session-guild/lib/workspaces
 */

import { basename } from 'node:path'
import { canonical, directoryOf, sameDirectory } from './paths.js'

/**
 * @param {{ host: object }} deps
 */
export function createWorkspaces({ host }) {
  /** Registered workspaces; a deployment without the service cannot quest. */
  function list() {
    const service = host.registry()
    if (service === undefined) {
      throw new Error('session-guild: workspaceRegistry is not mounted in this deployment')
    }
    return service.list()
  }

  /** Sessions the registry currently considers archived. */
  function archivedIds() {
    try {
      return host.registry()?.archivedSessionIds ?? []
    } catch {
      return []
    }
  }

  /** Human-readable list used in "unknown workspace" errors. */
  function descriptors() {
    return list().map(workspace => `${workspace.title} (${workspace.path})`).join('; ')
  }

  /** Current directory of the calling session. */
  function currentDirectory(agent) {
    return directoryOf(host, agent)
  }

  /** Registered workspace that owns the calling session's directory. */
  async function currentWorkspace(agent) {
    const directory = currentDirectory(agent)
    for (const workspace of list()) {
      if (await sameDirectory(workspace.path, directory)) return workspace
    }
    return undefined
  }

  /**
   * Resolve a workspace argument. Exact id wins, then title, then directory
   * basename, then a symlink-aware absolute-path comparison.
   * @param {unknown} input - Tool argument.
   * @returns {Promise<{ id: string, title?: string, path?: string }>}
   */
  async function matchWorkspace(input) {
    const raw = String(input ?? '').trim()
    if (raw.length === 0) throw new Error(`workspace is required; available workspaces: ${descriptors()}`)
    const all = list()
    const lower = raw.toLowerCase()

    const byId = all.find(workspace => String(workspace.id) === raw)
    if (byId !== undefined) return byId

    const byTitle = all.find(workspace => String(workspace.title ?? '').toLowerCase() === lower)
    if (byTitle !== undefined) return byTitle

    const byBase = all.find(workspace => basename(String(workspace.path ?? '')).toLowerCase() === lower)
    if (byBase !== undefined) return byBase

    const absolute = await canonical(raw)
    if (absolute !== undefined) {
      for (const workspace of all) {
        if (await sameDirectory(workspace.path, absolute)) return workspace
      }
    }
    throw new Error(`unknown workspace "${raw}"; available workspaces: ${descriptors()}`)
  }

  return { list, archivedIds, descriptors, currentDirectory, currentWorkspace, matchWorkspace }
}
