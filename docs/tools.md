# 工具参考

本页面向维护者，以及想确切知道“助手到底能做什么”的用户。包 README 只描述
工作方式，不罗列工具名。

## 工具集合

| 工具 | 调用方 | 注册时机 | 作用 |
|---|---|---|---|
| `guild_list_workspaces` | 任意会话 | `apply` 时始终注册 | 列出已注册工作区，标出当前工作区 |
| `guild_publish_quest` | 委托人 | Session 服务就绪后 | 新建受托会话、写入初始权限、保存委托、投递任务 |
| `guild_list_quests` | 委托人 | Session 服务就绪后 | 查看委托状态与受托会话实时观测 |
| `guild_append` | 委托人 | Session 服务就绪后 | 投递追加指令，让受托会话开始新一轮 |
| `guild_resume` | 委托人 | Session 服务就绪后 | 用户要求后恢复/唤醒未完成的受托会话 |
| `guild_report` | 被委托人 | Session 服务就绪后 | 回报摘要并把委托置为 completed |

`guild_list_workspaces` 是唯一在 Session 服务挂载前就可用的工具；0.1.2 之前的宿主
上，它也是唯一注册的工具。

## 可见性

`guild_list_workspaces` 和 `guild_publish_quest` 在每个会话都可见。

其余四个工具在 DSH 0.2.2-rc.1+ 上按 step 准入，使用
`ToolRegistrationOptions.when`，由从 `Session.deriveMessages()` 重建的内存 cache 决定：

- 发布过委托的会话能看到 `guild_list_quests`、`guild_append`、`guild_resume`；
- 收到过委托的会话能看到 `guild_report`。投递的 `guild.quest` 块随需求进入消息，
  所以受托会话从第一步就能看到它。

Session log 只追加、不删除，cache 重建后工具仍然可见。这里没有角色层；cache 是
内存的，可随时从派生消息重建。工具从隐藏变为可见时，Host 会用 `tool-addition`
开发者消息告知模型。

0.2.1 及更早没有 `when`，六个工具在每个会话都注册。每个 `execute()` 内的归属检查
仍然生效，误用会被拒绝，只是省不下提示词。

## `guild_list_workspaces`

- 输入：无。
- 输出：`{ workspaces: [{ id, title, path, current }] }`。
- `current` 会在解析 symlink 后比较工作区路径与调用会话的目录。目录优先来自
  `workingDirectory.get`，不可用时退回会话头里的 cwd。
- `workspaceRegistry` 未挂载时直接报错。

## `guild_publish_quest`

- 输入：`workspace`（必填）、`task`（必填）、`permission`（可选）、
  `description`（可选的标题标签）。`task` 是目标与验收标准，不应包含执行计划。
- 工作区解析顺序：精确 id、大小写不敏感的标题、路径 basename、symlink 感知的
  绝对路径。找不到时错误信息会列出可用工作区。
- 拒绝当前工作区。
- 拒绝空任务，以及超过 `maxTaskChars` 的任务。
- 权限解析顺序：
  1. 显式 `permission` 参数，并按宿主权限目录校验；
  2. `defaultPermissionPreset`（配置值不存在时退回 `read-only` 或目录第一项）；
  3. `null` 表示继承调用方当前权限，包括自定义的沙箱/审批策略。
- `requireApproval: true` 时，在创建任何东西之前先弹确认卡。委托人会话的审批策略
  为 `never` 时，委托会被拒绝，而不是未经确认就启动。
- 用 `sessionController.create({ workspaceId })` 创建会话，短暂等待它变为 live，
  写入一次权限，重命名会话，写入内存 cache，最后才投递需求。
- 投递使用全新的、永不中止的信号：停止委托人 turn 不会取消一个已经创建了会话的
  委托。
- 投递失败时 cache 记录变为 `failed`（重启后不会重建失败记录），工具抛出带
  session id 的错误，方便手动清理空会话。
- 归档委托人会话时，`guild_publish_quest` 导出的 `cascadeArchive` 会级联归档该委托人的受托会话。

投递的提示词包含任务原文（目标/验收标准）和一个结构化的 `guild.quest` 块（委托 id、
委托人/受托会话 id、工作区、路径、权限）；不包含执行计划、方案或步骤。怎么执行由
受托会话自己决定；任务完成后由它调用 `guild_report` 汇报结果。

## `guild_list_quests`

- 输入：无。
- 输出：`{ quests: [...] }`，包含调用方创建过的每条记录，按消息顺序（委托先后）排列。
- `status` 是委托状态：`in_progress`、`completed` 或 `failed`。重建时 report 用户
  消息（`report:<questId>` / `guild.report` 块）会直接把记录置为 `completed`。
- `archived` 和 `running` 只是实时观测。宿主没有 `sessionController.state` 时，
  `running` 恒为 `false`。
- 投递或权限警告会放在 `note` 里。

## `guild_append`

- 输入：`sessionId`（必填）、`message`（必填）。
- 只有该委托的委托人会话可以发送。
- 受托会话已归档时拒绝，并提示改用 `guild_resume`。
- `approveAppend: true` 时，投递前先请求审批。
- 追加消息作为用户消息投递，并在受托会话里开始新一轮。
- 委托保持当前状态。已完成的委托不会被重开，同一条委托也不能再次回报。

## `guild_resume`

- 输入：可选的 `questIds`；省略表示所有未完成委托。
- 只处理 `status: in_progress` 的记录。
- 受托会话已归档且宿主支持时，用 `workspaceRegistry.unarchiveSession` 恢复原会话，
  再投递“继续”消息。绝不会新建会话。
- 0.1.5 没有 `unarchiveSession`：适配器原地唤醒受托会话，并在结果里注明它仍在
  归档列表中。
- 已在执行的受托会话会被跳过，避免重复投递。
- 成功唤醒会更新 `resumedAt` 并递增 `resumeCount`。

## `guild_report`

- 输入：`summary`（必填，不能为空）。
- 只有收到过委托的受托会话可以回报。
- 同一条委托重复回报会被拒绝。
- 先把摘要投递到委托人会话，再把记录置为 `completed`；即使之后委托状态写入失败，
  摘要也已经送达。
- 回报文本是纯文本，刻意避免 Host 的 `dsh-session:` 引用形式：裸 id 会让接收
  turn 解析失败，而规范化 URI 会让受托会话的 surface 被反复注入委托人会话的后续
  turn。
- 摘要会按 `summaryChars` 截断。

## 注册细节

- `guild_list_workspaces` 在 `apply` 里用 `ctx.effect` 注册，随插件一起释放。
- `permissionPresets` 由插件级 `inject` 保证；五个 Session 相关工具再等待
  `sessionController`、`workspaceRegistry` 就绪后注册。
- `permission-presets/catalog-changed` 事件会触发重新注册，让
  `guild_publish_quest` 的权限 enum 与实时目录一致。
- 注销只释放最近一次注册创建的定义。

委托/会话状态转换见 [lifecycle.md](lifecycle.md)；代码文件用途见
[architecture.md](architecture.md)。
