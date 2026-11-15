/**
 * `guild_list_workspaces`: discovery. This is the only Guild tool registered
 * before the Session services are mounted, and the only one that survives on
 * hosts older than 0.1.2.
 * @module dsh-workspace-guild/lib/tools/list-workspaces
 */

import { sameDirectory } from '../paths.js'

/**
 * @param {{ workspaces: ReturnType<import('../workspaces.js').createWorkspaces> }} runtime
 */
export function createListWorkspacesTool({ workspaces }) {
  return {
    name: 'guild_list_workspaces',
    description:
      'List the workspaces registered in this Harness and mark the current one. Call it first whenever a task may belong to '
      + 'a workspace other than the current one (the user names a repo, plugin, service, or path that lives elsewhere) or the '
      + 'target workspace is not obvious.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                path: { type: 'string' },
                current: { type: 'boolean' },
              },
              required: ['id', 'title', 'path', 'current'],
              additionalProperties: false,
            },
          },
        },
        required: ['workspaces'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.workspaces.length === 0
          ? '没有已注册的工作区。'
          : value.workspaces.map(item => `${item.current ? '* ' : '- '}${item.title} → ${item.path}`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const directory = workspaces.currentDirectory(exec.agent)
      const items = []
      for (const workspace of workspaces.list()) {
        items.push({
          id: String(workspace.id),
          title: String(workspace.title ?? ''),
          path: String(workspace.path ?? ''),
          current: await sameDirectory(workspace.path, directory),
        })
      }
      return { workspaces: items }
    },
  }
}
