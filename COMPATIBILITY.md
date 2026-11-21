# dsh-session-guild × DSH rc 兼容性与适配器

测试对象：`dsh-session-guild 0.0.1`（`0.0.x` 分支；下表完整矩阵实测对象）与 `0.0.2`（2026-11-19 在 `0.2.2-rc.5` 上复核；公测版，npm `beta` 标签）

> 版本说明：本包由 `dsh-workspace-guild` 改名而来，版本从 `0.0.1` 重新起算；文中「旧包 0.0.2」指改名前的 `dsh-workspace-guild@0.0.2`（与本包 `0.0.2` 不是同一版本号）及其写下的会话数据。
>
> **0.0.2 新增能力（公测）：** 发布时选模型（`provider` / `model` / `reasoning_effort`）、
> `guild_append` 追加轮次、按字节预算的委托标题（`title` / `titleMaxBytes`），以及回报模式
> `mode`（`review` 默认人在环 / `unattended` 无人值守）。这几项都不改变既有适配器选择与降级路径；模型能力（`agents.get(...).model.select`、
> `sessionController.modelCatalog` / `selectModel`、`llm.resolveCallConfig`）见
> [`docs/compatibility.md`](docs/compatibility.md) 与 [`docs/limitations.md`](docs/limitations.md)。
> 下表的宿主兼容结论来自 0.0.1 实测，0.0.2 的委托/回报/归档链路未改变；0.0.2 已于 2026-11-19
> 在 `0.2.2-rc.5` 上复核：rc.3→rc.5 插件调用面契约零变化、隔离实例装载与工具注册正常；发布版套件
> 73/73（2026-11-21 本地 `node --test`，比复核时新增回报模式用例）。
测试日期：2026-11-15（完整矩阵）；复核日期：2026-11-19（`0.2.2-rc.5`，0.0.2）
测试环境：npm 发布的各 DSH rc 包，每个版本使用独立 `DSH_HOME`、私有 store 与非 3080 端口。生产 checkout 与 3080 服务全程未触碰；一次性产物不属于本仓库。

## 结论

- **0.2.2-rc.1+（含 0.2.2-rc.5）**：完整兼容。委托 → 回报 → 归档 → 找回 → 级联全部通过，含 `sessionController.state`、`tools.when`、`workspace/session-archived`。`0.2.2-rc.5` 已用 0.0.2 复核：契约面与 rc.3 相同，仍选中 `latest` 适配器。
- **0.1.7-rc.1 – 0.2.1**：完整委托链路通过。降级项：没有 `sessionController.state`（`running` 恒为 false）、没有 `tools.when`（七个 Session 相关工具常驻）、0.2.1 之前没有 `workingDirectory.get`（用会话头 cwd）。
- **0.1.5-rc.1 – 0.1.5-rc.3**：委托 / 回报通过；`guild_resume` 会原地唤醒归档受托会话但无法取消归档（宿主没有 `unarchiveSession`）；没有归档事件，因此不级联。
- **0.1.2-rc.1**：插件能安装、加载并注册 6 个工具，适配器选择 `v1`；但该版本自身在创建会话时 `agent-presets` 的 `standard` preset 挂载失败（`Cannot read properties of undefined (reading 'parent')`），委托无法完成，与本插件无关。
- **< 0.1.2**：没有 `sessionController`，只注册 `guild_list_workspaces` 并告警，不假装能委托。
- `package.json` 的 `engines.dsh` 因此定为 `>=0.1.5-rc.1`（第一个实际可完成委托的版本）。

## 适配器

所有版本差异集中在 [`lib/compat.js`](lib/compat.js)，`index.js` 与 `lib/` 只调用选中适配器的接口。适配器**按运行时能力探测**（`ctx.get()` 到的服务方法、`tools` 的 API），不读版本字符串；因此只组合了部分服务的 profile 也会得到真实降级。适配器与各代际降级的说明见 [`docs/compatibility.md`](docs/compatibility.md)。

| 适配器 | 范围 | `permissionPresets.catalog` | `workingDirectory.get` | `sessionController.state` | `unarchiveSession` | `tools.when` | 归档事件 |
|---|---|---|---|---|---|---|---|
| `latest` | 0.2.2-rc.1+（rc.5 已复核） | ✅ | ✅ | ✅ | ✅ | ✅ | `session-archived` + `session-stop` |
| `v2` | 0.1.7-rc.1 – 0.2.1 | ✅ | 0.2.1+ | — | ✅ | — | `session-stop` |
| `v1` | 0.1.2-rc.1 – 0.1.5 | —（用 `names`/`optionOf` 合成） | —（会话头 cwd） | — | — | — | 无 |
| `v0` | < 0.1.2 | — | — | — | — | — | 无（只发现工作区） |

选择顺序：`ADAPTERS = [latest, v2, v1, v0]`，第一个 `accepts(capabilities)` 的生效。`permissionPresets` 由插件级 `inject` 保证；`ctx.inject(['sessionController', 'workspaceRegistry'])` 保证适配器在其余 Session 服务就绪后才选择；`guild_list_workspaces` 在此之前就可用。`ToolRegistrationOptions.when` 是 `tools` 服务自身的能力，在 `apply` 时单独探测，因此不会因 Session 服务晚挂载而丢失按需可见。

关键适配点：

1. **权限目录**：0.1.7+ 读 `catalog()`；0.1.2–0.1.5 用 `names` + `optionOf` + `resolve` 合成同样的 `{ value, name, sandbox, approval }`，没有 `names` 时再按三个内置 preset 探测。
2. **cwd**：优先 `workingDirectory.get(session)`，失败/缺失时退回 `session.header.cwd`。
3. **运行态**：只有 `sessionController.state` 存在时才读；否则 `running` 为 false，不影响委托状态。
4. **归档恢复**：0.1.7+ 调 `unarchiveSession`；0.1.5 返回 `restored:false` 但仍投递“继续”，并在结果 note 中明确“仍在归档列表”。
5. **归档级联**：按代际只订阅该代际存在的事件；`archiveSession` 在 0.1.7+ 传 `{ stopActivity: true }`，0.1.5 只传 id。
6. **工具可见性**：0.2.2+ 传 `{ when }`；更早版本七个 Session 相关工具常驻，角色限制仍在每个 `execute()` 内。

## 运行矩阵（真实宿主）

每个版本都是全新 `DSH_HOME` + 私有 pnpm/npm store + 私有端口，插件以 `link` 方式装进 `web` profile，并跑完整生命周期。

| 版本 | 安装/加载 | 工具注册 | 委托 | 回报 | 归档后恢复 | 委托人会话归档级联 | 备注 |
|---|---|---|---|---|---|---|---|
| 0.1.2-rc.1 | ✅ | 6/6 | ❌ | — | — | — | 宿主 preset 挂载 bug，创建会话即失败 |
| 0.1.5-rc.3 | ✅ | 6/6 | ✅ | ✅ | ⚠️ `restored:false` / `delivered:true` | ❌ | 无 `unarchiveSession` 与归档事件 |
| 0.1.7-rc.2 | ✅ | 6/6 | ✅ | ✅ | ✅ `restored:true` | ✅ | `running` 恒 false，工具常驻 |
| 0.2.0-rc.2 | ✅ | 6/6 | ✅ | ✅ | ✅ | ✅ | 同上，cwd 用会话头 |
| 0.2.1-rc.5 | ✅ | 6/6 | ✅ | ✅ | ✅ | ✅ | 有 `workingDirectory.get`，仍无 `state` |
| 0.2.2-rc.3 | ✅ | 6/6 | ✅ | ✅ | ✅ | ✅ | 完整：`state` + `when` + 双归档事件 |
| 0.2.2-rc.5 | ✅ | ✅（7 个工具由单测覆盖；宿主无 HTTP 工具列表接口） | 未重跑 | 未重跑 | 未重跑 | 未重跑 | 0.0.2 复核：rc.3→rc.5 插件调用面仅版本号变化，仍选 `latest`；rc.4/rc.5 只改 web-search 默认与 LiveShare 修复；发布版 73/73 单测 |

## 能力首次出现版本

由各 tag 的 `packages/extensions/tool-cordis/src/api-catalog.ts` + 相关源码解析得出：

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

`SessionCreateRequest.workspaceId` 从 0.1.2-rc.1 起就存在且生效，不是 0.1.7 才有的能力。

> 运行矩阵中的 `6/6` 是改名前的 `dsh-workspace-guild@0.0.2` 实测时的工具数。当前源码注册 7 个 Session 相关工具
> （新增 `guild_collect`）。回报的 job 投递是能力探测式的：宿主有 `ctx.jobs` 时以
> 委托方会话为 owner 登记 `guild-quest` 任务，结果由 `job_output` 或
> `guild_collect` 读出；没有该服务时 `auto` 自动退回本文实测的 prompt 消息投递，
> 生命周期不变。

## 已知宿主问题（非插件）

- **0.1.2-rc.1**：`agent-presets` 的 `standard` preset 在创建会话时挂载失败，任何 `sessionController.create()` 都会失败。0.1.5 已修复。插件在该版本上能加载、列出工作区，但委托无法完成。
- **0.0.1-rc.5**：该 npm 包在本机启动即失败（`user patch-layer watching requires the Cordis HMR service`），且没有 `sessionController`；不在支持范围。
- **0.1.0 / 0.1.1 系列**：没有 `sessionController`，插件只注册工作区发现。

## 与旧版兼容性结论的差异

旧报告里的 P0（`sessionController.prompt` 少传 AbortSignal）和不写自定义 Session 事件的状态模型已在改名前的 `dsh-workspace-guild@0.0.1` 重写中修复；本报告基于改名前的 `dsh-workspace-guild@0.0.2` 的适配器实现重新实测：

- 三处 `prompt` 都传入不可取消信号或 `exec.signal`；
- 委托状态不落插件私有存储：`guild_publish_quest` 结果与投递/回报消息里的结构化 `guild.quest` / `guild.report` 块是事实来源，进程内 cache 在重启后从派生消息按需重建；
- 0.1.2–0.1.5 的 `catalog` / `unarchive` / 事件差异现在由适配器承担，而不是让调用点直接抛错。

## 测试与验证

```bash
cd <repo>/0.0.x
npm run check            # index.js、lib/、lib/tools/ 全部语法检查
node --test              # 73 个用例：适配器选择、四代宿主行为、cache 结构化重建、job 投递、回报模式
node .script/smoke.mjs   # 端到端假宿主冒烟
```

真实宿主矩阵（上表）是一次性验证的结论；逐版本安装、启动与探针脚本不随插件仓库保留。
