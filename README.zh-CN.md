# dsh-workspace-guild

[English](README.md) | 中文

把任务委托给另一个工作区的全新会话执行，保留一条可追踪的委托记录，并在完成后
拿回摘要。

## 与标准 subagent 的对比

标准 subagent 模式要求主会话先完成设计和计划；subagent 通常只负责执行，人很少
介入，主会话必须一直维持这些上下文。公会把分工反过来：

| | 标准 subagent | 公会受托会话 |
|---|---|---|
| 主会话 | 完成设计与计划 | 只定目标和需求 |
| 设计在哪里完善 | 主会话 | 受托会话 |
| 人的介入 | 委派后较少介入 | 可以直接在受托会话里介入 |
| 主会话上下文 | 很大 | 相对较小 |

像冒险者公会一样：你贴出委托，插件在受托工作区新开一个普通会话；执行计划由受托
会话自己决定，需要写权限时你放权；完成后它把结果回报给发起委托的会话。

- 要求 **DSH ≥ 0.1.5-rc.1**
- 无额外 npm 依赖；需要 DSH 的 `permission-presets` 插件（`ctx.permissionPresets`）
- 不需要学习新命令或新界面，助手会在你需要时使用插件
- 默认情况下，所有已注册工作区都可以作为委托目标

关系双方：**委托人**（client）在自己的会话里发起委托；**被委托人**（contractor）
在受托工作区的普通会话里执行。

## 安装后的工作方式

```
你的会话（委托人）                        受托工作区（被委托人）
─────────────────                        ─────────────────────
你描述任务
  │
  ├─ 在那里打开一个普通会话 ─────────────▶ 出现在该工作区侧栏
  │  （默认只读）                          自己决定方案
  │
  │                                       你在受托会话里放权
  │                                       受托会话开始执行
  │
  ◀──────── 摘要作为一条消息回到委托人 ─── 完成后主动回报
  │
  委托标记为 completed
  你在原会话里继续
```

1. 让助手把任务委托给另一个工作区。说清仓库、插件、服务或路径；目标不明确时，
   它会先列出已注册的工作区。
2. 受托工作区里会出现一个**普通会话**，标题形如
   `🏰 <标签> (from <来源工作区>)`。它不是隐藏的子 agent：你可以打开它、和它对话、
   随时改它的权限。
3. 受托会话默认以**只读**权限启动；怎么计划和执行是它的事，需要写权限时它会提出，
   你在那个会话里放权即可。
4. 完成后，受托会话把摘要发回你的会话，委托完成；你继续在原会话里工作。

可以同时有多个委托在跑。工作区之间文件与状态互相独立，受托会话也彼此独立。

## 委托状态不等于会话状态

只要受托会话没有回报，委托就一直是 **in_progress**。受托会话空闲、等权限、被中断
或被归档，都不会让委托完成；只有受托会话的回报会。

DSH 重启后不会自动续跑。需要继续时，让助手恢复未完成的委托；归档的受托会话会从
归档里找回，而不是新建一个。

## 配置

配置写在 profile 的插件行 patch 里：

```yaml
- id: workspace-guild
  config:
    defaultPermissionPreset: read-only   # 默认；null 表示继承调用方权限
    maxTaskChars: 20000
    summaryChars: 4000
    requireApproval: false               # true 才弹确认卡
    approveAppend: false                   # true 时每条追加指令都确认
```

| 键 | 默认 | 作用 |
|---|---|---|
| `defaultPermissionPreset` | `read-only` | 受托会话初始权限；`null` 表示继承调用方当前权限 |
| `maxTaskChars` | `20000` | 需求文本上限 |
| `summaryChars` | `4000` | 回传摘要上限 |
| `requireApproval` | `false` | 新建受托会话前是否弹确认卡 |
| `approveAppend` | `false` | 每条追加指令是否也要确认 |

权限只在创建受托会话时写入一次；之后受托会话的权限由你决定。
W
## 限制

在生产环境依赖它之前，请先读这些限制。

- **回报看起来像你的消息。** DSH 的用户消息类型只有一种，受托会话的摘要会以
  用户消息的形式出现在委托人会话里。
- **只有受托会话回报，委托才会完成。** 受托会话做完但没回报，委托仍是
  in_progress；空闲或归档都不会改变它。
- **不会自动续跑。** 重启后不会扫描、唤醒或重放；需要你明确要求继续。
- **追加指令不会重开已完成的委托。** 你可以唤醒受托会话让它继续改，但委托仍是
  completed，同一条委托不能再次回报；需要新的追踪结果时请新开一条委托。
- **受托会话默认只读。** 你要在受托会话里放权，或把 `defaultPermissionPreset`
  设成可写预设。插件不会绕过沙箱或审批策略。
- **默认不弹确认卡。** 任何已注册工作区都可以接收委托；如果这对你的部署太宽松，
  设置 `requireApproval: true`。
- **跨会话委托依赖宿主服务。** `permissionPresets` 是硬依赖；没有 DSH 的
  `permission-presets` 插件时公会不会挂载。`sessionController` 和
  `workspaceRegistry` 也是委托工具必需的；headless 或最小化部署缺少它们时可能
  只剩工作区发现。
- **委托方和受托方不能是同一个工作区。** 委托自己的请求会被拒绝，请直接在当前会话
  里做。
- **旧版 DSH 会降级。** 0.2.1 及更早没有实时 `running` 状态，委托列表里看不出
  受托会话是否正在执行；0.2.1 及更早助手在所有会话里都能看到委托操作，即使当前
  会话用不上（有一点上下文成本）；0.1.5 上归档的受托会话可以被唤醒但不能取消归档，
  归档委托人会话也不会级联。
- **0.1.2-rc.1 本身无法完成委托。** 该版本创建会话时会挂载 `standard` preset
  失败，这是宿主 bug，不是插件问题；请使用 0.1.5-rc.1 或更新版本。
- **有长度上限。** 需求受 `maxTaskChars` 限制；摘要受 `summaryChars` 限制，超出
  会被截断。

逐版本细节见 [docs/limitations.md](docs/limitations.md)。

## 兼容性

| DSH 范围 | 可用能力 |
|---|---|
| 0.2.2-rc.1+ | 完整：委托操作只在需要时出现、受托会话实时状态、归档恢复、归档级联 |
| 0.1.7-rc.1 – 0.2.1 | 完整委托链路；无受托会话实时状态，委托操作常驻，0.2.1 起有 `workingDirectory` |
| 0.1.2-rc.1 – 0.1.5 | 从 0.1.5-rc.1 起委托与回报可用；继续操作原地唤醒归档受托会话但不能取消归档；不级联。0.1.2-rc.1 创建会话会因宿主 bug 失败。 |
| < 0.1.2 | 只提供工作区发现；插件会告警，不假装能发起委托 |

插件按运行时能力探测选择适配器，不读版本号。详见
[docs/compatibility.md](docs/compatibility.md) 和实测矩阵
[COMPATIBILITY.md](../COMPATIBILITY.md)。

## 安装

把 `0.0.x` 目录 link 进 profile，或用 Plugin Manager 添加本地插件目录：

```bash
dsh plugin --profile <name> add /path/to/dsh-workspace-guild/0.0.x
```

在 profile 里启用即可；工作区注册表和会话服务由 Harness 提供，不需要额外配置。

## 开发

```bash
node --test
node .script/smoke.mjs
npm run check
```

代码按职责拆分，便于逐个 review：

- `index.js` — 入口、宿主门面与 runtime 组装
- `lib/register.js` — 工具集合、注册生命周期、适配器挂载、事件订阅
- `lib/tools/` — 每个工具一个文件
- `lib/compat.js` — 宿主代际适配器

## 文档

- [docs/tools.md](docs/tools.md) — 工具参考与可见性
- [docs/lifecycle.md](docs/lifecycle.md) — 委托/会话生命周期、归档、恢复
- [docs/architecture.md](docs/architecture.md) — 各代码文件的用途与状态模型
- [docs/compatibility.md](docs/compatibility.md) — 适配器矩阵与降级行为
- [docs/limitations.md](docs/limitations.md) — 详细限制

