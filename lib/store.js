/**
 * Durable quest records.
 *
 * Task state lives in a plugin-owned storage domain (`workspace_guild` /
 * `quests`), never in the Session log: an external plugin cannot append a new
 * event type without corrupting later replays, and Session events cannot be
 * written while the Session is cold. When a deployment mounts no storage
 * domain the store degrades to a process-local Map.
 * @module dsh-workspace-guild/lib/store
 */

/** Namespace of the plugin-owned storage domain. */
const DOMAIN_NAME = 'workspace_guild'
/** Table holding one record per quest, keyed by quest id. */
const TABLE = 'quests'

/** Record shape validator used by the storage domain at its durable boundary. */
const recordSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object'
      || typeof value.id !== 'string'
      || typeof value.clientSessionId !== 'string'
      || typeof value.contractorSessionId !== 'string') {
      throw new Error('workspace-guild quest record is malformed')
    }
    return value
  },
}

const DOMAIN_SPEC = {
  name: DOMAIN_NAME,
  version: 2,
  tables: { [TABLE]: { valueSchema: recordSchema } },
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function createStore(ctx) {
  /** In-memory fallback only when the deployment mounts no storage domain. */
  const fallback = new Map()
  let storePromise

  /** Open (once) the plugin-owned storage domain, falling back to memory. */
  function open() {
    if (storePromise !== undefined) return storePromise
    storePromise = (async () => {
      const facility = ctx.get('storageDomain')
      if (facility === undefined) {
        ctx.logger?.warn?.('workspace-guild: storageDomain is not mounted; quest records are process-local only')
        return { kind: 'memory' }
      }
      try {
        const domain = await facility.open(DOMAIN_SPEC)
        ctx.effect(() => () => { void domain.close() })
        return { kind: 'domain', table: domain.table(TABLE) }
      } catch (error) {
        ctx.logger?.warn?.(`workspace-guild: could not open the quest storage domain (${String(error)}); using process-local state`)
        return { kind: 'memory' }
      }
    })()
    return storePromise
  }

  /** Read every record from the selected backend. */
  async function all() {
    const opened = await open()
    return opened.kind === 'domain'
      ? [...opened.table.entries()].map(([, value]) => value)
      : [...fallback.values()]
  }

  /** Persist a complete record. */
  async function save(record) {
    const opened = await open()
    if (opened.kind === 'domain') await opened.table.put(record.id, record)
    else fallback.set(record.id, record)
    return record
  }

  /** Read one record by quest id. */
  async function read(id) {
    const opened = await open()
    return opened.kind === 'domain' ? opened.table.get(id) : fallback.get(id)
  }

  /** Merge a patch into an existing record; undefined when it disappeared. */
  async function patch(id, changes) {
    const current = await read(id)
    if (current === undefined) return undefined
    return save({ ...current, ...changes })
  }

  /** Records created by one client session, oldest quest first. */
  async function byClient(clientSessionId) {
    return (await all())
      .filter(record => record.clientSessionId === String(clientSessionId))
      .sort((left, right) => (left.publishedAt ?? 0) - (right.publishedAt ?? 0))
  }

  /** The record whose contractor session is `contractorSessionId`. */
  async function byContractor(contractorSessionId) {
    return (await all()).find(record => record.contractorSessionId === String(contractorSessionId))
  }

  return { save, read, patch, byClient, byContractor }
}
