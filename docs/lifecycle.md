# 生命周期

一次委托有两条独立的生命周期：**委托记录**（从 Session log 重建的内存状态）和**受托会话**（普通会话，
可能空闲、执行中、暂停或归档）。把两者分开是本插件的核心设计规则。

## 委托状态

| 状态 | 何时写入 | 含义 |
|---|---|---|
| `in_progress` | 投递前保存记录；`guild_append` 重开一轮时 | 当前轮（`round`）还没有回报 |
| `completed` | 受托会话调用 `guild_report` | 该轮摘要已记录：job 投递由委托方 `job_output` 读取，旧式 prompt 投递则是消息已送达 |
| `cancelled` | 委托方的 `guild-quest` 任务被终止（`job_kill`、owner 释放） | 委托方不再等待；受托会话当前 turn 会被尽力取消 |
| `failed` | 需求投递失败 | 会话可能存在，但委托从未开始 |

受托会话执行中报错不会产生 `failed`。只有受托会话主动回报，委托人会话才知道；否则
需要去读受托会话。

实时观测不是委托状态：

| 观测 | 数据来源 | 对委托的影响 |
|---|---|---|
| `running` / `active` | `sessionController.state`（0.2.2+） | 无 |
| `archived` | `workspaceRegistry.archivedSessionIds` | 无 |
| `live` | sessions/agents 服务 | 无 |

空闲、等权限、被中断、被归档的受托会话，委托仍是 `in_progress`。只有回报会完成
委托。

## 委托流程

1. 解析受托工作区。当前工作区也是合法目标：委托会在同一个工作区里开一个并列子会话。
2. 解析初始权限（显式参数、配置默认值，或继承调用方权限）。
3. 可选地请求审批（`requireApproval: true`）。
4. 在受托工作区创建普通会话。
5. 等待会话 live，写入权限。
6. 可选：把发布时指定的 `provider` / `model` / `reasoning_effort` 只写到该会话
   （`agents.get(sessionId).model.select`）。可用性在这之前确认，不可用就在投递前
   失败；宿主没有 Agent 级选择时才退回 `sessionController.selectModel`（会改写部署
   默认模型，`notes` 里明说）。
7. 重命名会话。
8. 登记回报载体：默认在委托方会话名下开一个 `guild-quest` 后台任务（宿主没有
   `jobs` 服务时退化为消息投递），把 `jobId` / `delivery` / `round` / `selection`
   写进委托记录和 `guild.quest` 块。
9. 用全新的、永不中止的信号投递需求。
10. 写入 `deliveredAt`；失败则结算任务为 failed、置为 `failed` 并返回 session id。

先保存后投递是刻意的：在第 4 步和第 8 步之间崩溃时，会留下一条可见记录和一个
可识别的会话，而不是一个被静默遗弃的会话。

## 回报

受托会话调用 `guild_report(summary)`。默认（`delivery: "job"`）：

1. 用摘要结算委托方会话的 `guild-quest` 任务：`JobOutcome.result = summary`。
2. 记录置为 `completed`，写入 `reportedAt` 与 `summary`。

委托方会话**不会**收到 `user/message`，也不会因为等待而进入 running：任务注册后
publish 立即返回，turn 正常结束；结果就绪时 Host 投递一条 notice（`form: "notice"`）
唤醒会话，模型用 `job_output` 读到工具结果。若模型当时正 `job_output(wait)`，
Host 会跳过 notice，结果由那次工具调用返回。

接收任务不存在时（重启、owner 释放、被终止），第一步退化为"只记录"：状态与摘要
写进 cache 和受托会话工具结果里的 `guild.report` 块，不推送任何消息；委托方之后用
`guild_collect` 读取（live 会话走派生消息，冷会话走历史页）。

`reportDelivery: "prompt"` 保留旧行为：摘要作为 queue 模式的用户消息投递到委托人
会话，请求身份是 `report:<questId>`（第 1 轮）或 `report:<questId>:r<n>`（第 n 轮），
cache 重建时用它和 `guild.report` 块（含 `round`）按轮次判定 `completed`。摘要按
`summaryChars` 截断。**一轮只能回报一次**：同一轮重复回报被拒绝；下一轮用
`guild_append` 打开。

## 追加指令与轮次

`guild_append` 用新指令唤醒受托会话。它使用工具调用自己的信号，所以中止委托人 turn
会取消追加指令。行为取决于当前状态：

- `in_progress`：当前轮还开着，只投递（steering）。不登记新任务、`round` 不变；受托
  会话这一轮的回报照旧结算原来那个 `guild-quest` 任务。
- `completed`：开第 N+1 轮。顺序是**先**登记新的 `guild-quest` 后台任务（owner 仍是
  委托方会话），把记录改回 `in_progress`（带 `round` 与新 `jobId`），**再**投递追加
  消息；消息里附 `guild.quest` 块（含 `round` / `jobId`）。因此委托方的 `job_output`
  能在新一轮报告后拿到新摘要。
  - 登记不了新任务时，投递前就失败，记录保持 `completed`（不会留下一个没人能结算的
    开放轮次）。
  - 投递失败时回滚到上一轮的 `completed` 状态（与新任务被结算为 `failed`）；这一轮
    从未在日志里落过 `guild.quest` 块，所以冷重建也不会出现它。
- `cancelled` / `failed`：拒绝，提示新开一条委托。

同一轮不能回报两次；`guild_append` 开出的下一轮可以再报一次（见上）。

## 停止、重启、归档与恢复

- **用户停止委托人 turn。** 只取消这一轮；受托会话继续跑。投递使用的是不可取消
  信号，所以委托仍会送达。委托人的工具结果可能被标记为 aborted，但委托仍是
  `in_progress`。
- **DSH 重启。** 插件启动时不扫描、不唤醒、不重放任何东西。委托保持
  `in_progress`；用户明确要求后，`guild_resume` 才逐个恢复。
- **委托人会话被归档。** 插件订阅当前代际的归档事件，把该委托人的受托会话一起归档：
  - 0.2.2+：`workspace/session-archived` 和 `workspace/session-stop`；
  - 0.1.7 – 0.2.1：只有 `workspace/session-stop`；
  - 0.1.2 – 0.1.5：没有归档事件，因此不级联。
  宿主接受时（0.1.7+）用 `{ stopActivity: true }` 归档受托会话；0.1.2 – 0.1.5
  只接受 id。
- **受托会话被归档。** `guild_resume` 用 `unarchiveSession` 恢复原会话并唤醒，
  绝不新建替代会话。0.1.5 没有取消归档的 API：受托会话原地唤醒，但仍留在归档
  列表里。
- **受托会话已在执行。** `guild_resume` 跳过它，而不是排队重复的继续消息。
- **工具调用未执行。** Host 报 `ABORTED_BEFORE_DISPATCH`，没有副作用。

## 为什么用普通会话而不是子 agent

子 agent 不出现在普通侧栏，委派时审批策略又被固定为 `never`。这让预期工作流
无法成立：子 agent 无法像普通会话那样先只读、再由用户放权。因此插件创建普通会话：它出现在
侧栏，可以接管，也可以在对话中途改权限。

## 权限

- 默认 `read-only`：执行计划由受托会话负责；需要写权限时由用户在那个会话里放权。
- `defaultPermissionPreset: null` 恢复“继承调用方权限”。
- 权限只在创建时写入一次；插件之后不会监控或回滚你的修改。
- 权限目录的形状随宿主代际变化；`lib/compat.js` 统一成
  `{ value, name, sandbox, approval }`。

## 状态与缓存

- 插件不写任何持久化存储；Session log 是唯一事实来源。
- client 会话保存 `guild_publish_quest` / `guild_append` 结果里的 `guild.quest` 块
  （含 `round`、`jobId`、`delivery`，带模型时还有 `selection`），以及旧式 prompt
  投递产生的 `report:<questId>`（或 `:r<n>`）+ `guild.report` 用户消息；contractor
  会话保存每轮投递消息里的 `guild.quest` 块和 `guild_report` 结果里的 `guild.report`
  块（含 `round` 与 `summary`，这是重启后补读的来源）。
- 冷重建**按消息顺序折叠**：quest 块把该轮置为 `in_progress`，report 把同一轮置为
  `completed`；更高轮次的 quest 块重开委托。折叠对轮次单调：同轮的 quest 块不会把
  `completed` 降级（被 compaction 遮掉的 report 不会让旧轮复活），旧轮 report 也不会
  结算新开的轮次。`publish → report → append → report` 重建后就是 `completed` 第 2 轮。
- 进程内只保留一个可重建的 cache；DSH 重启后 cache 为空，第一次访问某个 Session
  时从它的 `deriveMessages()`（模型可见 surface）重建，不扫事件日志。
- 被 compaction 遮蔽的旧委托不会重建；模型同样看不到它们。
- 不追加自定义 Session 事件。外部插件写入未标记的新事件类型，会让该会话在
  重启后拒绝加载（`unknown event type ... refusing to interpret the log`）。
- 改名前的 `dsh-workspace-guild@0.0.2` 及更早版本写下的 `presentationMeta` 不再被读取，那些旧委托无法重建。

代码文件用途和模块划分见 [architecture.md](architecture.md)；每个工具的具体
行为见 [tools.md](tools.md)。
