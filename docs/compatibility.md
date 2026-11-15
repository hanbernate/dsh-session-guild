# 兼容性

插件支持有可用 `sessionController` 的 DSH rc 线。适配器按**运行时能力探测**
选择，从不读取版本字符串，因此只挂载了部分服务的 profile 也会得到真实降级。

## 适配器

| 适配器 | DSH 范围 | 关键能力 | 行为 |
|---|---|---|---|
| `latest` | 0.2.2-rc.1+ | `sessionController.state`、`tools.when`、`workspace/session-archived`、`unarchiveSession` | 完整：按需可见、受托会话运行态、归档恢复、双归档事件级联 |
| `v2` | 0.1.7-rc.1 – 0.2.1 | 无 `state`、无 `tools.when`；0.2.1 起有 `workingDirectory.get`；有 `unarchiveSession`；只有 `workspace/session-stop` | 六个工具常驻，`running` 恒为 false，完整生命周期，从 stop 级联 |
| `v1` | 0.1.2-rc.1 – 0.1.5 | 无 `permissionPresets.catalog`、无 `workingDirectory.get`、无 `unarchiveSession`、无归档事件 | 权限目录由 `names`/`optionOf` 合成；cwd 用会话头；继续操作原地唤醒；不级联 |
| `v0` | < 0.1.2 | 没有 `sessionController` | 只注册 `guild_list_workspaces` 并告警；不假装能委托 |

`ADAPTERS` 的顺序是 latest → v2 → v1 → v0。第一个
`accepts(capabilities)` 返回 true 的适配器生效；只读回退永远匹配。

## 选择与挂载

- `detectCapabilities(ctx)` 探测 `sessionController.create/prompt/state`、
  `permissionPresets.catalog/optionOf`、`workingDirectory.get`、
  `workspaceRegistry.unarchiveSession`，以及 `tools.resolve/executable`
  （`ToolRegistrationOptions.when` 的运行时信号）。
- `guild_list_workspaces` 在所有宿主上都于 apply 时注册。
- `permissionPresets` 是插件级 `inject` 的硬依赖；另外五个工具再等待
  `ctx.inject(['sessionController', 'workspaceRegistry'])` 后注册。此时才读取
  能力，避免服务晚挂载时把插件钉死在只读回退上。
- 按需可见是 `tools` 服务自身的能力，所以在 apply 时单独探测，而不是跟
  Session 服务一起延迟。

## 能力首次出现版本

| 能力 | 首次出现 |
|---|---|
| `dsh.bundle` profile 组合 | 0.0.1-rc.5 |
| `sessionController.create/prompt` | 0.1.2-rc.1 |
| `permissionPresets.catalog()` | 0.1.7-rc.1 |
| `workspaceRegistry.unarchiveSession()` | 0.1.7-rc.1 |
| `workspace/session-stop` | 0.1.7-rc.1 |
| `approval.request(displayReason)` | 0.1.7-rc.2 |
| `workingDirectory.get()` | 0.2.1-rc.1 |
| `sessionController.state()` | 0.2.2-rc.1 |
| `tools.register(definition, { when })` | 0.2.2-rc.1 |
| `workspace/session-archived` | 0.2.2-rc.1 |

`SessionCreateRequest.workspaceId` 从 0.1.2-rc.1 起就存在且生效。

## 预期降级

- **0.2.1 及更早：** 没有实时状态，`guild_list_quests` / `guild_append` 里的
  `running` 恒为 `false`。
- **0.2.1 及更早：** 六个工具在每个会话都出现；每个 `execute()` 内的归属检查仍会拒绝误用。
- **0.1.2 – 0.1.5：** 权限目录由 `names` / `optionOf` / `resolve` 合成；
  连 `names` 都没有时，用三个内置 preset 通过 `resolve` 探测。
- **0.1.2 – 0.1.5：** cwd 来自持久的会话头。
- **0.1.5：** `guild_resume` 返回 `restored: false`、`delivered: true`，
  唤醒原会话但让它留在归档列表里。`guild_append` 会解释同样的降级，而不是
  承诺能恢复。
- **0.1.2 – 0.1.5：** 没有归档事件，归档委托人会话不会级联。
- **< 0.1.2：** 只注册工作区发现；插件会告警。

## 已知宿主问题

- **0.1.2-rc.1** 在创建会话时挂载 `standard` preset 失败
  （`Cannot read properties of undefined (reading 'parent')`）。插件能加载并
  列出工作区，但委托无法完成。这不是插件 bug。
- **0.0.1-rc.5** 在本机启动即失败
  （`user patch-layer watching requires the Cordis HMR service`），且没有
  `sessionController`；不在支持范围。
- **0.1.0 / 0.1.1** 没有 `sessionController`，只能发现工作区。

因为 0.1.2-rc.1 的问题，`package.json` 的 `engines.dsh` 定为
`>=0.1.5-rc.1`，即第一个能真正完成委托的版本。

完整实测矩阵、证据路径和复现命令见
[COMPATIBILITY.md](../../COMPATIBILITY.md)。

用户可见的后果见 [limitations.md](limitations.md)。
