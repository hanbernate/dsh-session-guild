/**
 * Path helpers shared by workspace discovery and quest publishing.
 * @module dsh-session-guild/lib/paths
 */

import { realpath } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

/**
 * Resolve a path through `realpath`, falling back to lexical resolution for
 * paths that do not exist (or are not accessible).
 * @param {unknown} path - Candidate path.
 * @returns {Promise<string | undefined>} Absolute path, or undefined.
 */
export async function canonical(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  try {
    return await realpath(path)
  } catch {
    return resolvePath(path)
  }
}

/**
 * Compare two directories after resolving symlinks.
 * @param {unknown} left - First path.
 * @param {unknown} right - Second path.
 * @returns {Promise<boolean>} True when both resolve to the same directory.
 */
export async function sameDirectory(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const [a, b] = await Promise.all([canonical(left), canonical(right)])
  return a !== undefined && b !== undefined && a === b
}

/**
 * Read the directory of the session behind a tool call.
 * @param {object} host - Host facade.
 * @param {{ session?: object } | undefined} agent - Tool execution agent.
 * @returns {string | undefined} The session cwd.
 */
export function directoryOf(host, agent) {
  return host.adapter().directory(host.workingDirectory(), agent)
}
