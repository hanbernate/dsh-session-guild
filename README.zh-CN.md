# dsh-session-guild

[English](README.md) | 中文

把任务委托给一个全新的普通会话：由它自己完善方案、在自己的上下文里完成细节，完成后先
把结果给你看，你确认后再把摘要带回原会话——原会话只留目标和结果。委托全程有一条可追踪
的记录。

> **状态：公测版（0.0.2）。** 已发布到 npm 的 `beta` 标签，安装用
> `dsh-session-guild@beta`；beta 之间工具契约仍可能变化。

## 与标准 subagent 的对比

标准 subagent 模式要求主会话先完成设计和计划；subagent 通常只负责执行，人很少
介入，主会话必须一直维持这些上下文。公会把分工反过来：

| | 标准 subagent | 受托子会话 |
|---|---|---|
| 主会话 | 完成设计与计划 | 只定目标和需求 |
| 设计在哪里完善 | 主会话 | 受托会话 |
| 人的介入 | 委派后较少介入 | 可以直接在受托会话里介入 |
| 主会话上下文 | 很大 | 相对较小 |

像冒险者公会一样：你贴出委托，插件新开一个普通会话；执行计划由受托会话自己决定，
需要写权限时你放权；完成后它先把结果给你看，**你确认后**才把摘要回报给发起委托的会话。

无人值守、不需要人介入的任务请直接用标准 subagent。委托（受托子会话）默认是**人在环**
（`review`）：插件会在委托末尾写明「先给用户确认再回报」；只有你明确要求无人值守、
而任务又必须发生在另一个工作区（subagent 去不了）时，才用 `mode: unattended` 发布。
委托方的模型不需要自己在 `quest` 里写回报指令；`quest` 正文里的旧写法与插件注入的这条
冲突时，以注入的 `mode` 行为准。

## 两个场景

### 1. 任务属于另一个工作区

仓库、插件、服务或路径在另一个工作区。把委托发过去，由那个工作区自己的会话去读、去跑、
去改；本会话不跨过去动手，只收摘要。

### 2. 本会话不需要细节

任务就在当前工作区，但会话已经很长，或者你不想在这里跟进方案和执行细节。委托会在同一个
工作区里并列开一个子会话：方案、读过的文件、改动都留在那边，这边只留目标和摘要。

## 要求与说明

- 要求 **DSH ≥ 0.1.5-rc.1**；本包 **0.0.2** 起支持发布时选模型、追加轮次、按字节预算的委托标题，以及 `mode` 回报模式（`review` / `unattended`，默认人在环）
- 无额外 npm 依赖；需要 DSH 的 `permission-presets` 插件（`ctx.permissionPresets`）
- 回报默认经 DSH 的后台任务插件（`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`）送达；
  缺少它们时自动退回消息投递
- 不需要学习新命令或新界面，助手会在你需要时使用插件
- 默认情况下，所有已注册工作区都可以作为委托目标
- 委托默认 `mode: review`（人在环）：受托会话完成或到达需要拍板的点时，先把结果发给
  那个会话里的用户，确认后才回报；`mode: unattended` 则完成即回报

关系双方：**委托人**（client）在自己的会话里发起委托；**被委托人**（contractor）
在自己的子会话里执行。

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
  │                                       完成后先把结果给你看
  ◀──────── 摘要结算一个后台任务 ───────── 你确认后才回报
  │
  委托标记为 completed
  你在原会话里继续
```

1. 让助手把任务委托出去。说清仓库、插件、服务或路径；目标不明确时，它会先列出
   已注册的工作区。
2. 受托工作区里会出现一个**普通会话**，标题形如
   `📜 <标题> (from <来源工作区>)`；标题由发起委托的模型在 `title` 参数里给出。
   它不是隐藏的子 agent：你可以打开它、和它对话、随时改它的权限。
3. 受托会话默认以**只读**权限启动；怎么计划和执行是它的事，需要写权限时它会提出，
   你在那个会话里放权即可。
4. 受托会话完成后先把结果发在它自己的会话里，等你确认（或让它直接报）才回报。回报结算
   你会话上的一个后台任务：`job_output` 拿到摘要，或稍后用 `guild_collect` 补读；不会插入
   一条用户消息，你继续在原会话里工作。确认前委托保持 `in_progress`，这是正常状态。

可以同时有多个委托在跑。工作区之间文件与状态互相独立，受托会话也彼此独立。

## 委托状态不等于会话状态

只要受托会话没有回报，委托就一直是 **in_progress**。受托会话空闲、等用户确认、等权限、
被中断或被归档，都不会让委托完成；只有受托会话的回报会。

DSH 重启后不会自动续跑。需要继续时，让助手恢复未完成的委托；归档的受托会话会从
归档里找回，而不是新建一个。已 `completed` 委托的受托会话被归档时同样找得回来
（恢复只是为 `guild_append` 追加下一轮做准备，不会改掉已完成状态）。

## 指定模型与追加轮次

0.0.2 起，委托可以只在**这一条委托**上指定模型：

- `guild_publish_quest` 接受可选的 `provider` / `model` / `reasoning_effort`。
  受托会话的第一个模型步就用该模型，**部署默认模型不变**（插件用 Agent 级选择，
  不调用会改写默认模型的接口）。
- 模型不可用时，发布在投递前失败，错误里带 session id：不会出现"跑错模型"的委托。
- 宿主没有 Agent 级选择时才会退回 `sessionController.selectModel`，此时结果里的
  `notes` 会明说部署默认模型被一并改写；两种能力都没有时带模型的发布直接失败。

补问/复评用 `guild_append`：

- 委托还在 `in_progress`：追加消息只投递（steering），不新开任务、轮次不变。
- 委托已 `completed`：追加会开第 N+1 轮——先登记一个新的回报后台任务，再把委托改回
  `in_progress`，最后投递消息。受托会话再次 `guild_report` 时，你的 `job_output`
  拿到的是新一轮摘要。
- 受托会话已归档时追加会被拒绝，错误信息给出路径：先 `guild_resume`（带上该委托的
  `questIds`，`completed` 的委托也能恢复）再追加。
- 同一轮只能回报一次；`cancelled` / `failed` 的委托不能再追加。

典型用法：主线会话把 CR 评审委托给只读子会话，并用主会话当前模型；CR 报告后对同一
子会话追加追问，拿第二轮报告。

## 配置

配置写在 profile 的插件行 patch 里：

```yaml
- id: session-guild
  config:
    defaultPermissionPreset: read-only   # 默认；null 表示继承调用方权限
    titleMaxBytes: 80                    # 受托会话标题的字节预算
    requireApproval: false               # true 才弹确认卡
    approveAppend: false                   # true 时每条追加指令都确认
```

| 键 | 默认 | 作用 |
|---|---|---|
| `defaultPermissionPreset` | `read-only` | 受托会话初始权限；`null` 表示继承调用方当前权限 |
| `titleMaxBytes` | `80` | 受托会话标题的 UTF-8 字节预算；放不下时先截 `(from 工作区)`，标题本身最后才截。应与部署里 `session-title` 的 `maxTitleBytes` 保持一致或更小 |
| `requireApproval` | `false` | 新建受托会话前是否弹确认卡 |
| `approveAppend` | `false` | 每条追加指令是否也要确认 |

委托文本和回报摘要没有插件层的长度上限，需要多长由模型自行决定；宿主自身的
工具输出策略仍会限制单次工具结果展示给模型的大小。

权限只在创建受托会话时写入一次；之后受托会话的权限由你决定。

## 限制

在生产环境依赖它之前，请先读这些限制。

- **回报是后台任务的结果，不是消息。** 发起委托时会以你的会话为 owner 登记一个
  `guild-quest` 后台任务并立即返回，所以受托会话干活期间你的会话保持空闲。
  受托会话回报后任务结算：`job_output` 拿到摘要，`guild_collect` 可事后补读，
  不会产生用户消息。这个任务需要会话存活、占用该会话的后台任务名额（默认 10 个），
  结算前该会话不可归档。宿主没有 `jobs` 服务时退回旧的消息投递（可配
  `reportDelivery`）。插件代码热重载（HMR）不影响结算：结算句柄跨插件实例存活；
  若遇到「委托已 completed、任务却仍 running」的僵尸任务，`guild_collect` 的
  `note` 会点名它，用 `job_kill` 释放名额即可（不会改动已完成的委托记录）。
- **只有受托会话回报，委托才会完成。** 受托会话做完但没回报，委托仍是
  in_progress；空闲或归档都不会改变它。
- **不会自动续跑。** 重启后不会扫描、唤醒或重放；需要你明确要求继续。
- **一轮只能回报一次；追加可以开下一轮。** `guild_append` 在 in_progress 时只
  steering，在 completed 时开 N+1 轮并登记新的回报任务，所以可以再报一次；同一轮
  重复回报会被拒绝。cancelled/failed 的委托不能追加，需要新开一条委托。
  默认的 `mode: review`（人在环）要求受托会话先把结果发在自己的会话里、等用户确认
  再回报；只有 `unattended` 才完成即回报。
- **受托会话默认只读。** 你要在受托会话里放权，或把 `defaultPermissionPreset`
  设成可写预设。插件不会绕过沙箱或审批策略。
- **默认不弹确认卡。** 任何已注册工作区都可以接收委托；如果这对你的部署太宽松，
  设置 `requireApproval: true`。
- **跨会话委托依赖宿主服务。** `permissionPresets` 是硬依赖；没有 DSH 的
  `permission-presets` 插件时公会不会挂载。`sessionController` 和
  `workspaceRegistry` 也是委托工具必需的；headless 或最小化部署缺少它们时可能
  只剩工作区发现。
- **当前工作区也可以是委托目标。** 开出来的是与本会话并列的子会话，用来把长任务从
  主会话上下文里移出去；它共用同一份 checkout，插件不做文件级冲突检测，别让两边同时
  改同一批文件。
- **模型选择按宿主能力降级（0.0.2 起）。** Agent 级选择不改变部署默认模型；只有
  退回 `sessionController.selectModel` 时才会改写它（`notes` 会说明）。宿主没有模型
  目录时无法在投递前预检，会在 `notes` 里注明；所有选择能力都没有时，带模型的发布
  直接失败，不会静默跑默认模型。
- **旧版 DSH 会降级。** 0.2.1 及更早没有实时 `running` 状态，委托列表里看不出
  受托会话是否正在执行；0.2.1 及更早助手在所有会话里都能看到委托操作，即使当前
  会话用不上（有一点上下文成本）；0.1.5 上归档的受托会话可以被唤醒但不能取消归档，
  归档委托人会话也不会级联。
- **0.1.2-rc.1 本身无法完成委托。** 该版本创建会话时会挂载 `standard` preset
  失败，这是宿主 bug，不是插件问题；请使用 0.1.5-rc.1 或更新版本。
- **没有插件层的长度上限。** 委托文本和回报摘要的长度由模型自行决定；宿主自身的
  工具输出策略仍会限制单次工具结果展示给模型的大小。

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
[COMPATIBILITY.md](COMPATIBILITY.md)。

## 安装

从 npm 安装公测版，或把 `0.0.x` 目录 link 进 profile 做开发：

```bash
dsh plugin --profile <name> add dsh-session-guild@beta
# 或者从 checkout 安装：
dsh plugin --profile <name> add /path/to/dsh-session-guild/0.0.x
```

在 profile 里启用即可；工作区注册表和会话服务由 Harness 提供，不需要额外配置。

`0.0.2` 是首个公测版，`0.0.1` 从未发布。旧安装在不传新参数时仍然可用；需要
`provider`/`model`、追加轮次、`review` 回报模式或按字节预算的委托标题的调用方要求
`0.0.2` 或更新版本。

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
- `lib/quest-mode.js` — `review` / `unattended` 回报模式，以及投递/追加/唤醒三处注入文案
- `lib/models.js` — 发布时的模型选择与预检

## 发布

推送 `v*` 标签即由 GitHub Actions 发布（[.github/workflows/publish.yml](.github/workflows/publish.yml)）：

1. 改 `package.json` 的 `version` 并提交。
2. 创建并推送同名标签：
   `git tag -a v0.0.2 -m "dsh-session-guild 0.0.2" && git push origin v0.0.2`。
3. CI 校验标签与 `package.json` 一致、跑测试，然后发布。

npm dist-tag 默认 `beta`，所以打标签不会顶掉 `latest`；正式版发布前把仓库变量
`NPM_DIST_TAG` 设成 `latest`。例外：全新包走 npm 的 staged publishing 时，首个通过
审核的版本会被同时提升到 `latest`，所以首次发布会同时出现在两个 tag 上。发布需要仓库 secret `NPM_TOKEN`：一个对本包有读写权限、
开启 2FA bypass 的 granular access token（或 Automation token）。工作流同时生成 npm
provenance，发布版本会链接回本仓库和提交。

## 文档

- [docs/tools.md](docs/tools.md) — 工具参考与可见性
- [docs/lifecycle.md](docs/lifecycle.md) — 委托/会话生命周期、归档、恢复
- [docs/architecture.md](docs/architecture.md) — 各代码文件的用途与状态模型
- [docs/compatibility.md](docs/compatibility.md) — 适配器矩阵与降级行为
- [docs/limitations.md](docs/limitations.md) — 详细限制

