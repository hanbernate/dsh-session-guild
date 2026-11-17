# 工具参考

本页面向维护者，以及想确切知道“助手到底能做什么”的用户。包 README 只描述
工作方式，不罗列工具名。

## 工具集合

| 工具 | 调用方 | 注册时机 | 作用 |
|---|---|---|---|
| `guild_list_workspaces` | 任意会话 | `apply` 时始终注册 | 列出已注册工作区，标出当前工作区 |
| `guild_publish_quest` | 委托人 | Session 服务就绪后 | 新建受托会话、写入初始权限、按需选模型、保存委托、投递任务 |
| `guild_list_quests` | 委托人 | Session 服务就绪后 | 查看委托状态与受托会话实时观测 |
| `guild_collect` | 委托人 | Session 服务就绪后 | 不等待地读取委托回报（含重启后补读） |
| `guild_append` | 委托人 | Session 服务就绪后 | 投递追加指令；已完成时开下一轮并登记新的回报任务 |
| `guild_resume` | 委托人 | Session 服务就绪后 | 用户要求后恢复/唤醒未完成的受托会话 |
| `guild_report` | 被委托人 | Session 服务就绪后 | 回报本轮摘要：结算该轮的后台任务，并把该轮置为 completed |

`guild_list_workspaces` 是唯一在 Session 服务挂载前就可用的工具；0.1.2 之前的宿主
上，它也是唯一注册的工具。

## 可见性

`guild_list_workspaces` 和 `guild_publish_quest` 在每个会话都可见。

其余四个工具在 DSH 0.2.2-rc.1+ 上按 step 准入，使用
`ToolRegistrationOptions.when`，由从 `Session.deriveMessages()` 重建的内存 cache 决定：

- 发布过委托的会话能看到 `guild_list_quests`、`guild_collect`、`guild_append`、`guild_resume`；
- 收到过委托的会话能看到 `guild_report`。投递的 `guild.quest` 块随需求进入消息，
  所以受托会话从第一步就能看到它。

Session log 只追加、不删除，cache 重建后工具仍然可见。这里没有角色层；cache 是
内存的，可随时从派生消息重建。工具从隐藏变为可见时，Host 会用 `tool-addition`
开发者消息告知模型。

0.2.1 及更早没有 `when`，七个 Session 相关工具在每个会话都注册。每个 `execute()` 内的归属检查
仍然生效，误用会被拒绝，只是省不下提示词。

## `guild_list_workspaces`

- 输入：无。
- 输出：`{ workspaces: [{ id, title, path, current }] }`。
- `current` 会在解析 symlink 后比较工作区路径与调用会话的目录。目录优先来自
  `workingDirectory.get`，不可用时退回会话头里的 cwd。
- `workspaceRegistry` 未挂载时直接报错。

## `guild_publish_quest`

- 输入：`workspace`（必填）、`quest`（必填）、`title`（必填）、`permission`（可选）、
  `provider` / `model` / `reasoning_effort`（可选，模型选择）。`quest` 是目标与验收标准，
  不应包含执行计划。`title` 是这次委托的名字：受托会话在侧边栏里用它、`guild_list_quests`
  也用它作为条目名，所以写成短标题（几个词，中文约 12 字以内），不要句子、不要复述需求、
  不带句末标点。旧调用只带 `description` 时仍按标签处理，重启重建也能还原。
- 标题按 UTF-8 字节预算组装（`titleMaxBytes`，默认 80）：放不下时先截断
  ` (from <来源工作区>)` 这一层——剩余空间够就保留缩短后的工作区名，不够就整个去掉——
  标题本身最后才截，截断处补 `…`。
- 工作区解析顺序：精确 id、大小写不敏感的标题、路径 basename、symlink 感知的
  绝对路径。找不到时错误信息会列出可用工作区。
- 允许当前工作区：目标就是调用方所在工作区时，在同一个工作区里新开一个与调用方并列的
  子会话，用来承接长任务、让主会话只留下目标和结果。子会话共用同一份 checkout，插件
  不做文件级冲突检测。
- 拒绝空委托，以及超过 `maxQuestChars` 的委托。
- **委托默认写成人在环，不写「自动回报」指令。** 子会话是用户可以打开、随时介入的场景：`quest`
  默认不要写成「完成直接回报」，受托会话会先给在场用户过目再回报；只有用户明确要求无人值守运行时，
  才在委托里写「report when done, do not interrupt」这类指令。
- 权限解析顺序：
  1. 显式 `permission` 参数，并按宿主权限目录校验；
  2. `defaultPermissionPreset`（配置值不存在时退回 `read-only` 或目录第一项）；
  3. `null` 表示继承调用方当前权限，包括自定义的沙箱/审批策略。
- `requireApproval: true` 时，在创建任何东西之前先弹确认卡。委托人会话的审批策略
  为 `never` 时，委托会被拒绝，而不是未经确认就启动。
- 在投递需求之前登记回报载体：`reportDelivery` 为 `auto`（默认）时，宿主有 `jobs`
  服务就用一个归属于调用方会话的后台任务（`guild-quest`），否则退回消息投递；
  `job` 强制后台任务（宿主不支持时发布失败），`prompt` 强制旧的消息投递。
- 工具结果带 `jobId`：结果就绪后由 `job_output` 读取，`guild_report` 不会往委托人
  会话投递用户消息，也不会因为等待委托而占用委托人会话的 turn。
- 模型选择（可选）：
  - `provider` 与 `model` 必须同时给出或同时省略；`reasoning_effort` 需要两者。
    只给一半会在创建会话之前失败，避免静默退回部署默认模型。
  - 顺序固定：创建会话 → 等 live → 写权限 → **选模型** → 重命名 → 登记回报任务 →
    投递。因此受托会话的第一个模型步就用该模型。
  - 可用性在投递前确认：优先 `sessionController.modelCatalog()`，没有它时用
    `llm.resolveCallConfig()`（`selectModel` 内部做的是同一项校验）。不可用时抛错，
    错误带 session id，需求不会投递，也就不会出现"跑了错误模型"的委托。
  - 设置优先用 `agents.get(sessionId).model.select(selection)`：只影响该会话，
    **不改部署默认模型**。宿主没有 Agent 级选择时才退回
    `sessionController.selectModel`，此时 `notes` 会明说该调用同时改写了部署默认模型。
  - 两者都没有时，带模型的发布直接失败（不静默降级）；目录与 `llm` 服务都没有时
    无法预检，会在 `notes` 里注明"无法确认可用性"后继续。
  - 选择会写进 `guild.quest` 块的 `selection` 字段、工具结果和委托记录；
    `guild_list_quests` 会显示模型。
- 用 `sessionController.create({ workspaceId })` 创建会话，短暂等待它变为 live，
  写入一次权限，按需选模型，重命名会话，写入内存 cache，最后才投递需求。
- 投递使用全新的、永不中止的信号：停止委托人 turn 不会取消一个已经创建了会话的
  委托。
- 投递失败时 cache 记录变为 `failed`（重启后不会重建失败记录），工具抛出带
  session id 的错误，方便手动清理空会话。
- 归档委托人会话时，`guild_publish_quest` 导出的 `cascadeArchive` 会级联归档该委托人的受托会话。

投递的提示词包含任务原文（目标/验收标准）和一个结构化的 `guild.quest` 块（委托 id、
委托人/受托会话 id、工作区、路径、权限、轮次、回报载体，带模型时还有 `selection`）；
不包含执行计划、方案或步骤。怎么执行由受托会话自己决定；任务完成后由它调用
`guild_report` 汇报结果。

## `guild_list_quests`

- 输入：无。
- 输出：`{ quests: [...] }`，包含调用方创建过的每条记录，按消息顺序（委托先后）排列。
- `status` 是委托状态：`in_progress`、`completed`、`failed` 或 `cancelled`。重建时 report 用户
  消息（`report:<questId>` / `report:<questId>:r<n>` / `guild.report` 块）会按轮次把记录置为
  `completed`。
- `round` 是当前轮次（publish 为 1，每次重开加 1）；`model` 是发布时指定的模型
  （`provider/model (effort)`），未指定时没有该字段。
- `archived` 和 `running` 只是实时观测。宿主没有 `sessionController.state` 时，
  `running` 恒为 `false`。
- 投递或权限警告会放在 `note` 里。

## `guild_append`

- 输入：`sessionId`（必填）、`message`（必填）。
- 只有该委托的委托人会话可以发送。
- 受托会话已归档时拒绝，并提示改用 `guild_resume`。
- `approveAppend: true` 时，投递前先请求审批。
- 追加消息作为用户消息投递，并在受托会话里开始一轮。
- `in_progress`：只投递（steering），不新开任务、轮次不变；受托会话这一轮的回报照旧
  结算原有的后台任务。
- `completed`：开第 N+1 轮。**先**登记新的 `guild-quest` 后台任务（owner 仍是委托方），
  把记录改回 `in_progress`（带 `round` 与新 `jobId`），**再**投递；投递的消息附
  `guild.quest` 块（含 `round` / `jobId`）。登记不了新任务时在投递前失败，记录保持
  `completed`；投递失败则回滚到上一轮的 `completed` 状态并结算失败的新任务。
- `cancelled` / `failed`：拒绝，提示新开一条委托。
- 返回 `{ delivered, running, round, jobId? }`。

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
- **一轮一次**：同一轮重复回报会被拒绝。`guild_append` 开的下一轮可以再报一次。
- **回报前先给在场用户过目（默认）。** 任务包含属于会话内活跃用户的决策或待其确认的结论时，
  先把摘要贴给用户，经其同意（或用户明确说「直接报」）再调用。回报结算本轮且不可重发（委托方要
  `guild_append` 才开下一轮）：晚报只多一个往返，早报不可撤销。委托书显式要求不要停顿时以委托书
  为准；没有活跃用户时本指引不适用、回报行为不变——无人值守、不需要人介入的任务不属于委托场景，
  请直接用标准 subagent。
- 后台任务投递（`delivery: "job"`）：用摘要结算委托人会话的 `guild-quest` 任务
  （`JobOutcome.result`），并把记录置为 `completed`。`job_output` 会一次性交出该
  结果；正在 `job_output(wait)` 上的等待者会让 Host 跳过完成通知。整个过程不产生
  `user/message`，委托人会话不会因为等待而处于 running。
- 接收任务已不存在（重启、owner 释放、任务被终止）时，只记录状态与摘要，不投递
  消息；委托人之后用 `guild_collect` 读取。旧的 `prompt` 委托保持原来的消息投递。
- 回报文本（仅 `prompt` 模式）是纯文本，刻意避免 Host 的 `dsh-session:` 引用形式：
  裸 id 会让接收 turn 解析失败，而规范化 URI 会让受托会话的 surface 被反复注入
  委托人会话的后续 turn。
- 摘要会按 `summaryChars` 截断，并写进 `guild.report` 记录块（受托会话自己的工具
  结果里，含 `round`），作为重启后的补读来源。prompt 投递的请求身份按轮次区分：
  第 1 轮是 `report:<questId>`，第 n 轮是 `report:<questId>:r<n>`。

## `guild_collect`

- 输入：`questId`（可选；省略表示本会话的全部委托）。
- 不等待、不轮询、不开启 turn：`completed` 的委托返回摘要，`in_progress` 表示
  本轮回报还没到。结果含 `round`，`jobId` 是当前轮的回报任务。
- 冷读历史页时按轮次取最新一条 `guild.report`；只有旧轮回报时不会把新轮置为
  `completed`，而是返回说明性 `note`。
- 摘要来源按顺序：内存 cache（`guild_report` 写入）→ live 受托会话的派生消息 →
  冷读受托会话的历史页（`sessionController.events`，找 `guild.report` 块）。
- 解释性 `note` 会说明受托会话未加载、历史读取失败等无法确认的情况。

## 注册细节

- `guild_list_workspaces` 在 `apply` 里用 `ctx.effect` 注册，随插件一起释放。
- `permissionPresets` 由插件级 `inject` 保证；六个 Session 相关工具再等待
  `sessionController`、`workspaceRegistry` 就绪后注册。
- `permission-presets/catalog-changed` 事件会触发重新注册，让
  `guild_publish_quest` 的权限 enum 与实时目录一致。
- 注销只释放最近一次注册创建的定义。

委托/会话状态转换见 [lifecycle.md](lifecycle.md)；代码文件用途见
[architecture.md](architecture.md)。
