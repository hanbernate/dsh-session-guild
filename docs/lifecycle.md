# 生命周期

一次委托有两条独立的生命周期：**委托记录**（从 Session log 重建的内存状态）和**受托会话**（普通会话，
可能空闲、执行中、暂停或归档）。把两者分开是本插件的核心设计规则。

## 委托状态

| 状态 | 何时写入 | 含义 |
|---|---|---|
| `in_progress` | 投递前保存记录，以及投递成功后 | 受托会话还没有回报 |
| `completed` | 受托会话调用 `guild_report` | 摘要已送达，委托完成 |
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

1. 解析受托工作区，拒绝当前工作区。
2. 解析初始权限（显式参数、配置默认值，或继承调用方权限）。
3. 可选地请求审批（`requireApproval: true`）。
4. 在受托工作区创建普通会话。
5. 等待会话 live，写入权限，重命名会话，保存委托记录。
6. 用全新的、永不中止的信号投递需求。
7. 写入 `deliveredAt`；失败则置为 `failed` 并返回 session id。

先保存后投递是刻意的：在第 4 步和第 6 步之间崩溃时，会留下一条可见记录和一个
可识别的会话，而不是一个被静默遗弃的会话。

## 回报

受托会话调用 `guild_report(summary)`：

1. 摘要作为 queue 模式的用户消息投递到委托人会话。
2. 记录置为 `completed`，写入 `reportedAt`。

投递发生在委托状态写入之前，所以之后即使存储失败，摘要也不会丢。report 标记
留在 client 的 Session log 里；`guild_list_quests` 和 `guild_resume` 会用它校正 `completed`，
因此存储状态写入失败也不会把已回报的委托当成未完成。同一条委托重复回报会被拒绝。

## 追加指令

`guild_append` 用新指令唤醒受托会话，并在那边开始一轮。它使用工具调用自己的信号，
所以中止委托人 turn 会取消追加指令。委托保持当前状态。

委托变为 `completed` 之后，追加指令**不会**重开委托，受托会话也不能对同一条委托
再次回报。如果新工作需要独立追踪，请新开一条委托。

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
- client log 保存 `guild_publish_quest` 的 tool result `meta`（委托元数据）和
  `[guild report #...]` 完成标记；contractor log 保存
  `[guild quest #...]` 投递标记和 `guild_report` result meta。
- 进程内只保留一个可重建的 cache；DSH 重启后 cache 为空，第一次访问某个 Session
  时从它的日志重建。
- 不追加自定义 Session 事件。外部插件写入未标记的新事件类型，会让该会话在
  重启后拒绝加载（`unknown event type ... refusing to interpret the log`）。
- 由旧版本插件写入、没有 `presentationMeta` 的委托无法从日志重建。

代码文件用途和模块划分见 [architecture.md](architecture.md)；每个工具的具体
行为见 [tools.md](tools.md)。
