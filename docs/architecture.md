# 架构

插件不引入 npm 依赖，但依赖 DSH 的 `permission-presets` 服务；代码按职责拆分，每个文件都可以单独 review。本页说明各代码文件的
用途、调用关系，以及委托状态放在哪里。

## 模块总览

```
index.js                     入口：name/inject/apply、host 门面与 runtime 组装
lib/compat.js                宿主代际适配器（按能力探测选择）
lib/config.js                配置默认值与归一化
lib/paths.js                 realpath/cwd 辅助
lib/workspaces.js            工作区发现与目标匹配
lib/permissions.js           权限目录、解析、写入与审批
lib/sessions.js              会话查找、日志读取、日志证据、标题
lib/cache.js                 内存 cache、从 Session log 重建
lib/signals.js               不可取消信号工厂
lib/register.js              工具集、注册/注销、适配器挂载、事件订阅
lib/tools/list-workspaces.js guild_list_workspaces
lib/tools/publish-quest.js  guild_publish_quest
lib/tools/list-quests.js    guild_list_quests
lib/tools/append.js         guild_append
lib/tools/resume.js         guild_resume
lib/tools/report.js         guild_report
```

`index.js` 为每个插件实例创建一个 `runtime`，不直接访问 Cordis 服务。工具接收
runtime 并调用辅助方法；工具之间不互相 import。

## 代码文件用途

### 入口与适配

| 文件 | 用途 |
|---|---|
| `index.js` | 导出 `name`、`inject`、`apply`。内部定义 `createHost` 与 `createRuntime`：懒加载宿主服务、组装辅助模块；归一化配置，注册 `guild_list_workspaces`，等待 Session 服务后交给 `lib/register.js` 挂载。 |
| `lib/compat.js` | 定义四代适配器（modern/legacy/minimal/read-only）、`detectCapabilities`、`selectAdapter`，以及权限目录、cwd、运行态、归档恢复、归档事件、`when` 的全部代际差异。调用方只使用选中的适配器接口。 |

### 共享辅助模块

| 文件 | 用途 |
|---|---|
| `lib/config.js` | `DEFAULTS` 与 `normalizeConfig`。校验 `maxTaskChars` / `summaryChars` 为正整数，非法值回落默认值。 |
| `lib/paths.js` | `canonical`（realpath，失败时退回词法绝对路径）、`sameDirectory`、`directoryOf`（优先 `workingDirectory.get`，退回会话头 cwd）。 |
| `lib/workspaces.js` | `list`、`archivedIds`、`descriptors`、`currentDirectory`、`currentWorkspace`、`matchWorkspace`。匹配顺序：id → 标题 → basename → symlink 感知的绝对路径。 |
| `lib/permissions.js` | 依赖 `ctx.permissionPresets`：`presetCatalog`、`resolvePermission`（显式参数 → 配置默认 → 继承）、`applyPermission`（只写一次）、`confirmQuest`（`requireApproval` 与 `never` 策略）。 |
| `lib/sessions.js` | `liveSession`、`waitForSession`（40 次 × 10ms）、`eventsOf` / `textOf`（读日志）、`reported` / `reportedIds`（从 client log 的 report 标记确认完成），以及 `sessionTitleOf`、`renameSession`。 |
| `lib/cache.js` | 纯内存 cache：`add`/`patch`/`byClient`/`byContractor`；`ensureClient` 从 client log 的 `guild_publish_quest` tool result meta 重建，`ensureContractor` 从投递标记与 `guild_report` result meta 重建。插件不写任何持久化存储。 |
| `lib/signals.js` | `commitSignal()`：给投递、回报、观测用的全新、永不中止的 AbortSignal。 |

### 工具注册与挂载

| 文件 | 用途 |
|---|---|
| `lib/register.js` | 创建五个 Session 工具的 set：`guild_publish_quest` 没有 `when`，始终可见；`guild_list_quests`/`guild_append`/`guild_resume` 在会话发布过委托后出现，`guild_report` 在会话收到委托后出现；两者都只追加不删除。`createRegistration` 在 0.2.2+ 上带 `{ when }` 注册，老宿主上普通注册；`unregister` 释放上一轮定义。`mountQuestTools` 选择并 pin 适配器、注册工具、订阅 `permission-presets/catalog-changed` 与归档事件。 |

### 工具实现

| 文件 | 用途 |
|---|---|
| `lib/tools/list-workspaces.js` | `guild_list_workspaces`：列出工作区并标出当前工作区；唯一在 apply 时注册的工具。 |
| `lib/tools/publish-quest.js` | `guild_publish_quest`：解析目标与权限、可选审批、创建会话、写入权限、写入内存 cache、不可取消地投递需求；`cascadeArchive` 随该工具归档委托人的受托会话。 |
| `lib/tools/list-quests.js` | `guild_list_quests`：按委托时间列出本会话的记录（输出 `quests`），合并 live 观测。 |
| `lib/tools/append.js` | `guild_append`：向该委托的受托会话投递追加指令；已归档时提示改用 `guild_resume`。 |
| `lib/tools/resume.js` | `guild_resume`：只恢复 `in_progress` 记录；归档受托会话先 unarchive，再唤醒；运行中的跳过。 |
| `lib/tools/report.js` | `guild_report`：受托会话回报摘要；先投递，再把记录置为 `completed`。 |

### 测试、配置与文档

| 文件 | 用途 |
|---|---|
| `test/compat.test.mjs` | 适配器选择、能力探测、权限目录合成、cwd、运行态、unarchive、archive 签名。 |
| `test/generations.test.mjs` | 在四代宿主形状上挂载插件，验证注册数量、`when`、委托、回报、归档恢复、级联。 |
| `.script/smoke.mjs` | 端到端假宿主冒烟：可见性、工作区解析、审批门禁、cache 重建、回报、继续、级联。 |
| `docs/*.md` | 中文文档：概览、工具、生命周期、架构、兼容性、限制。 |
| `locale/en.json`、`locale/zh.json` | 插件管理器标题、描述、详情页路径。 |
| `cordis.patch.yml` | bundle 插入的插件行（`id: workspace-guild`）。 |
| `package.json` | 包元数据、`dsh.bundle.patch`、`engines.dsh`、`files`（含 `lib` 与全部文档）。 |
| `icon.svg` | 插件图标。 |

## 调用关系

```
apply(ctx, config)
  ├─ normalizeConfig
  ├─ createRuntime（index 内部）
  │    ├─ createHost
  │    ├─ createWorkspaces
  │    ├─ createSessions
  │    ├─ createPermissions
  │    ├─ createQuestCache
  │    └─ observeContractor（内联）
  ├─ detectCapabilities(ctx).toolWhen
  ├─ createRegistration
  ├─ ctx.effect(() => register(guild_list_workspaces))
  └─ ctx.inject([...Session 服务], scope =>
       mountQuestTools
         ├─ selectAdapter + host.pin
         ├─ registration.register()
         ├─ on('permission-presets/catalog-changed', 重注册)
         └─ on(archiveEvents, cascadeArchive)
```

## 状态模型

插件**不写任何持久化存储**。状态全部来自 Session log，进程内只保留一个可重建的
cache：

| 事实 | 来源 |
|---|---|
| 委托元数据 | client log 中 `guild_publish_quest` 的 `tool/result.data.meta`（`presentationMeta`）：quest id、受托会话、工作区、权限、任务、label |
| 完成 | client log 中的 `[guild report #...]` 用户消息；`guild_report` 的 result meta 也标记完成 |
| 受托侧身份 | contractor log 中的 `[guild quest #... client=...]` 投递标记 |
| cache | 纯内存；插件启动时为空，第一次访问某个 Session 时从它的日志重建 |

`lib/cache.js` 的 `ensureClient` / `ensureContractor` 负责重建；`guild_list_quests`、
`guild_append`、`guild_resume`、`guild_report` 和 `when` 谓词都会先确保对应缓存。

### 为什么不持久化

DSH 的 Session log 本身已经是可回放的持久事实。插件再维护一份
`storageDomain` 只会带来重复状态、迁移和版本兼容问题。现在：

- 委托元数据放在 client log 的 tool result `meta` 里；
- 完成证据是 client log 的 report 标记；
- 受托侧只需要投递标记和 report result meta；
- 重启后 cache 从这些日志按需重建，没有插件私有的持久化文件。

代价是缓存重建依赖日志里已有的 `presentationMeta`。由旧版本插件写入、没有该
meta 的委托无法重建；这是升级时需要接受的限制。

### 为什么不写自定义 Session 事件

外部插件追加一个未标记的新事件类型，会让该会话在下次启动时拒绝加载。插件只使用
已有的 `tool/result`、`user/message` 事件，不新增事件类型。

## 工具可见性

没有角色层。工具可见性由内存 cache 判断：

- `guild_list_workspaces` 和 `guild_publish_quest` 始终可见。
- 一个会话发布过委托后，`guild_list_quests`、`guild_append`、`guild_resume` 出现，
  并在之后的 step 一直可见。
- 一个会话收到委托后，`guild_report` 出现。投递标记随需求一起进入日志，所以受托
  会话从第一步就能看到 `guild_report`。

`lib/register.js` 里的 `hasPublishedQuest` / `hasReceivedQuest` 会调用 cache 的
`hasPublished` / `hasReceived`；cache 为空时先重建当前 Session 的部分。0.2.2+ 用
`{ when }`；老宿主注册全部定义，`execute()` 内的归属检查仍然生效。

## 信号

| 写入 | 信号 | 原因 |
|---|---|---|
| 投递任务 | `commitSignal()`（全新、永不中止） | 委托人 turn 停止不能让已创建的会话收不到任务 |
| 投递摘要 | `commitSignal()` | 受托会话 turn 正在被拆除时，摘要也必须送达 |
| 追加指令 | `exec.signal` | 用户停止时，未投递的追加指令应被取消 |
| 继续操作 | `exec.signal` | 同追加指令 |
| 观测读取 | `commitSignal()` | 读取不应被调用方 turn 取消 |

`commitSignal()` 在 `index.js`（观测）、`lib/tools/publish-quest.js`（投递）、`lib/tools/report.js`（回报）
三处使用，所以保留为独立的 `lib/signals.js`。

## 挂载生命周期

1. `apply` 立即注册 `guild_list_workspaces`。
2. 探测 `tools.resolve` / `tools.executable`，决定是否支持按需可见。
3. `ctx.inject` 等待 `sessionController` 与 `workspaceRegistry`。
4. `lib/register.js` 选择适配器并 pin，注册五个工具，订阅：
   - `permission-presets/catalog-changed` → 重新注册，刷新权限 enum；
   - 适配器的归档事件 → 级联归档。
5. 所有注册和订阅都在 `ctx.effect` 内，随插件释放。

## 测试

- `test/compat.test.mjs` 固定适配器选择与降级返回值。
- `test/generations.test.mjs` 在四种宿主形状上验证委托、回报、归档恢复、级联。
- `.script/smoke.mjs` 是端到端假宿主冒烟，覆盖可见性、解析、审批门禁、cache
  重建、回报、继续、级联。

测试只 import `../index.js`，所以模块拆分对它们不可见；在文件之间移动代码时，
行为必须保持不变。

相关文档：[tools.md](tools.md)、[lifecycle.md](lifecycle.md)、
[compatibility.md](compatibility.md)。
