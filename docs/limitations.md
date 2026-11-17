# 限制

README 汇总了用户在生产环境依赖本插件前必须知道的限制；本页保留逐版本的详细
清单。

## 委托状态

- 只有受托会话调用 `guild_report`，委托才会变为 `completed`。空闲、等权限、
  turn 被暂停、turn 被中断、受托会话被归档，都不算完成。
- 受托会话做完了但没有回报，委托会一直是 `in_progress`。
- 投递失败会把 cache 记录置为 `failed`；重启后失败记录不会重建。受托会话执行过程
  中的报错不会反映到委托状态，需要受托会话自己回报。
- **一轮只能回报一次。** 同一轮重复回报被拒绝。`guild_append` 在 `in_progress` 时只
  steering（不新开任务、轮次不变）；在 `completed` 时开下一轮并登记新的回报任务，所以
  下一个需要追踪的结果可以追加在同一会话里。`cancelled` / `failed` 的委托不能追加，
  需要新开一条委托。
- 委托状态来自 Session log 的派生消息，进程内 cache 可重建。重启后没有东西会自动续跑；
  被 compaction 遮蔽的旧委托，以及改名前的 `dsh-workspace-guild@0.0.2` 之前写下的旧记录，无法重建。

## 回报载体

- 默认（`reportDelivery: "auto"`/`"job"`）回报不产生用户消息：它结算委托方会话的
  `guild-quest` 后台任务，结果由 `job_output` 一次性交出，`guild_collect` 可补读。
- 任务归属于委托方会话，因此：该会话必须存活才能登记任务；会话被释放或宿主重启会
  取消任务（回报改走 `guild_collect`）；任务计入该会话的后台任务并发上限（默认
  10 个，与 bash 后台任务共用）；有未结算任务时该会话不可归档（Host 的归档准入）。
- 插件代码经 HMR 热重载（`hmr.root` 指向本插件 `lib/`）不影响回报结算：结算句柄存放在
  应用根上下文上、跨插件实例存活，重载后的新实例照样能结算重载前登记的任务。受此
  修复之前的版本热重载过、或宿主 `jobs` 服务被替换，会留下**僵尸任务**——委托已
  `completed`、任务却仍 `running`：结算从未发生，因此完成通知也从未发出。
  识别：`guild_collect` 会在这种记录的 `note` 里点名仍处 `running` 的任务；
  清理：委托方 `job_kill` 该任务是安全的——结算只向委托方会话日志写 `job/settled`
  事件，不会改动决定 `completed` 的 `guild.quest` / `guild.report` 块（cancel 回调
  只写释放前实例自己的内存 cache，当前视图由会话消息重建），代价是给委托方会话发
  一条 killed 通知。不清理则该名额一直被占，直到委托方会话销毁时被自动取消。
- 任务结算时若模型没有 `job_output(wait)`，Host 会投递一条 notice 唤醒会话。这
  不是用户消息，但仍是一条 fold 起来的会话行；不想要唤醒可在 tool-jobs 配置
  `completionDelivery: "quiet"`，代价是会话只有下次输入时才知道结果。
- 宿主要提供 `jobs` 服务（`@deepseek-ai/dsh-jobs` + `@deepseek-ai/dsh-tool-jobs`）；
  缺失时 `auto` 退回旧的消息投递，`job` 会让发布失败。
- `reportDelivery: "prompt"` 保留旧行为：摘要是用户消息（`kind: 'user'`），除了
  `[guild report ...]` 标记外和用户自己输入的消息没有区别。

## 模型选择

- `guild_publish_quest` 的 `provider` / `model` / `reasoning_effort` 只作用于受托会话：
  优先 `agents.get(sessionId).model.select`，不改部署默认模型。
- 宿主没有 Agent 级选择时才退回 `sessionController.selectModel`；该调用会把新模型
  同时保存为部署默认模型，`notes` 里会写明。部署若不允许改默认模型，请不要在只支持
  这条路径的宿主上使用模型参数。
- 投递前会用 `sessionController.modelCatalog()`（或 `llm.resolveCallConfig`）确认路由
  可用；两者都没有的宿主无法预检，会记录"无法确认可用性"的 `note` 后继续。
- 宿主既没有 `model.select` 也没有 `selectModel` 时，带模型的发布**直接失败**（错误带
  session id，需求不投递），不会静默跑默认模型。
- `reasoning_effort` 必须在该模型广告的 effort 列表里；模型不广告 reasoning 时不能
  指定 effort。

## 消息与可见性

- 回报文本刻意使用纯文本。`dsh-session:` URI 是会话引用：裸 id 会让接收 turn
  解析失败，规范化 URI 会让受托会话的 surface 被反复注入委托人会话的后续 turn。
- 0.2.2-rc.1+ 上，追加类工具只在适用的会话出现；0.2.1 及更早，七个 Session
  相关工具在每个会话都出现，即使当前会话用不上，也会增加提示词成本。
- 0.2.1 及更早没有实时状态，`running` 恒为 `false`，委托列表无法显示受托会话
  正在执行。

## 权限与审批

- 受托会话默认只读。需要写文件的工作要等用户在受托会话里切换权限。
- `defaultPermissionPreset` 和显式 `permission` 参数只在创建时写入一次；插件
  不会监控或回滚之后的权限变更。
- 默认不弹确认卡，也没有按工作区的白名单。任何已注册工作区都可以作为目标，除非
  部署显式设置 `requireApproval: true`。
- `requireApproval: true` 时，委托人会话的审批策略为 `never` 会拒绝委托（无法弹
  卡）。请为该 profile 设置 `requireApproval: false`，或把会话切到 `ask`。
- 0.1.7-rc.1 的确认卡忽略 `displayReason`，只显示英文 `reason`。
- 插件不会绕过沙箱或审批策略。它只写入初始权限，其余交给 Host。

## 归档与恢复

- 启动时不扫描、不唤醒、不重放。用户必须明确要求继续未完成的委托。
- 0.1.7+ 上归档委托人会话会级联归档它的受托会话；0.1.2 – 0.1.5 没有归档事件，不级联。
- 级联在 0.1.7+ 上用 `{ stopActivity: true }` 归档受托会话；0.1.2 – 0.1.5 只传
  id。
- 0.1.5 没有 `unarchiveSession`：继续操作原地唤醒原会话，它仍留在归档列表里。
  插件绝不会新建替代会话。
- `guild_append` 拒绝已归档的受托会话，并提示改用 `guild_resume`（带 `questIds`）。
- `guild_resume` 默认只恢复 `in_progress` 的委托；**显式传 `questIds` 时也接受
  `completed` 的委托**：只做归档恢复与唤醒（唤醒消息注明等待下一轮追加），不改状态、
  不开轮次、不登记回报任务。这打通了「completed + 归档 → append 开下一轮」的路径——
  append 要求先 resume，而 resume 此前只认未结轮次、未结轮次又只能由 append 打开，
  形成循环依赖。0.1.5 没有 `unarchiveSession` 时该路径仍然不通（会话只能原地唤醒、
  仍留在归档列表里，append 会继续拒绝）。
- `guild_resume` 跳过已在执行的受托会话，避免排队重复的继续消息。
- 停止委托人 turn 不会停止受托会话。投递和回报使用不可取消信号；追加指令和继续操作
  使用工具调用自己的信号。

## 宿主与部署

- 跨会话委托需要 `sessionController`、`permissionPresets`、`workspaceRegistry`。
  `permissionPresets` 是硬依赖；没有它插件不会挂载。headless 或最小化部署若缺少
  其余服务，则只剩工作区发现。
- 0.1.2-rc.1 无法完成委托：Host 在创建会话时挂载 `standard` preset 失败
  （`Cannot read properties of undefined (reading 'parent')`）。这是宿主 bug；
  插件本身能加载。
- 0.1.0 / 0.1.1 没有 `sessionController`，只注册工作区发现。
- `engines.dsh` 定为 `>=0.1.5-rc.1`，因为这是第一个能完成文档所述生命周期的版本。

## 数据与打包

- 需求受 `maxQuestChars` 限制（默认 20000）；摘要按 `summaryChars` 截断
  （默认 4000）。
- 需求留在受托会话日志里；摘要在 job 投递下留在受托会话的 `guild_report` 工具结果
  里（prompt 投递下留在委托人会话的日志里）；委托元数据、`round`、`jobId` 与
  `selection` 来自 `guild_publish_quest` / `guild_append` 结果里的结构化
  `guild.quest` 块（经派生消息读取）。插件没有私有持久化文件。
- 插件不追加自定义 Session 事件。未标记的事件类型会让会话在重启后拒绝加载。
- 插件没有网络请求，只用 Node 内置模块。
- 禁用插件不会删除受托会话或委托记录。受托会话是普通会话，会保留自己的状态；但
  插件禁用期间，公会的委托列表不可用。

## 范围

- 同工作区委托会开出与调用方并列的子会话，共用同一份 checkout：两边的修改互相可见，
  插件不做文件级冲突检测，并发改同一批文件时会互相覆盖。
- 只有已注册工作区可以作为目标；未知名字会报错并列出可用工作区。
- 一条记录对应一次委托，可以有多轮（`round`）。多个独立任务请创建多条委托；它们可以
  并发执行。
