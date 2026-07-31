# Agent Harness 的扩展性与理想 UI：深度调研与产品判断

> 调研日期：2026-07-31  
> 研究对象：Codex / ChatGPT、Claude Code、GitHub Copilot、Cursor、Devin、LangGraph、MCP，以及 Cetus 当前实现  
> 说明：文中“事实”尽量引用官方资料；“判断”“建议”是基于这些事实和 Cetus 当前代码、界面的产品推演。

## 结论先行

我的核心判断有两个。

第一，当前 agent harness 的扩展机制已经解决了“增加能力”的前半程，但还没有解决“改变产品语义”的后半程。

Skills、instructions、MCP tools、hooks、subagents、plugins 分别擅长增加知识、工具、生命周期回调和专家角色。它们足以做出大量有用扩展，却很难优雅地实现下列东西：

- 一个可以暂停数天、升级插件后继续、失败后从中间恢复的业务工作流；
- 一个在 Codex、Claude Code、内置 runtime 之间行为一致的审计或记忆中间件；
- 一个插件自带完整工作台、导航入口、后台服务、数据库迁移和通知策略；
- 多个插件共同修改 prompt、tool input、permission decision 时，可预测、可调试的组合；
- 精确到“哪一个账号、哪一个文件夹、哪一类记录、有效多久”的权限；
- 对 agent 运行进行可复现回放、分叉、对比和自动评测。

这些需求缺的不是另一种 prompt 文件，而是 host 级的扩展平台：稳定事件模型、持久状态机、能力协商、UI slot、权限策略、插件生命周期和调试工具。

第二，理想 UI 不应该是“更漂亮的 ChatGPT”，而应该是“以注意力和工作产物为中心的 agent 操作系统”。

聊天仍然重要，但不应再同时承担需求、日志、进度、审批、产物、导航和历史记录七种职责。理想产品应该有两个入口：

1. 一个极轻的 ambient launcher，让用户在任何 app 中用当前上下文发起任务；
2. 一个 mission control，把所有运行按“现在是否需要我”排序，并把计划、执行、产物、证据、审批、分叉分别呈现。

Cetus 已经拥有这两个方向的雏形：Quick Launcher 和 Kanban/Needs review。下一步最有价值的不是继续横向增加孤立功能，而是把它们收束到同一个 Run/Artifact/Attention 模型中。

---

## 一、今天的扩展机制究竟覆盖了什么

主流产品正在快速趋同到一套“六件套”：

| 机制 | 本质 | 最适合 | 不适合 |
|---|---|---|---|
| Instructions / Rules | 始终或按路径注入的约束 | 编码规范、团队约定、默认偏好 | 有状态流程、外部动作、复杂交互 |
| Skills | 按需加载的说明、脚本、资源 | 可复用方法论和工作流配方 | 强确定性、可靠调度、跨步骤事务 |
| MCP | 标准化工具、资源、prompts 和远程连接 | 外部系统、结构化工具、认证服务 | 深入修改 agent loop 或 host 导航 |
| Hooks / Middleware | 生命周期中的确定性拦截点 | 审计、校验、权限、上下文加工 | 长期任务编排、复杂 UI、插件间协调 |
| Subagents / Custom agents | 隔离上下文和角色 | 并行研究、专业审查、减少主线程污染 | 稳定 DAG、共享事务状态、可重复执行 |
| Plugin | 上述机制的分发和安装单元 | 版本化、共享、市场、团队部署 | 如果 manifest 只做“文件打包”，它本身并不增加运行语义 |

这个趋同非常明显：

- OpenAI 的 plugin 由 skills、MCP server 和可选 UI 组成；Codex plugin 还可以携带 hooks。[OpenAI Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- Claude Code plugin 可以打包 skills、agents、hooks 和 MCP servers。[Claude Code Plugins](https://code.claude.com/docs/en/plugins)
- GitHub Copilot 同样提供 custom instructions、skills、custom agents、subagents、hooks、MCP 和 plugins，但不同 surface 的支持并不一致。[GitHub Copilot customization cheat sheet](https://docs.github.com/en/copilot/reference/customization-cheat-sheet)
- MCP 本身有 tools、resources、prompts、sampling、elicitation、通知与生命周期协商，但明确“不规定 AI 应用如何管理模型与上下文”。[MCP Architecture](https://modelcontextprotocol.io/docs/learn/architecture)

这套分层是合理的。问题不在于它们没用，而在于插件作者一旦想跨越“模型可见能力”去改变“host 如何运行与呈现”，就会碰到边界。

---

## 二、现有扩展机制的关键不足

### 1. Skill 是概率性路由，不是可执行契约

Skill 最大的优点是低门槛和渐进披露。Codex 会先让模型看到 skill 的名称与描述，再按需读取完整 `SKILL.md`；但初始 skill 列表有上下文预算，数量太多时会缩短描述甚至省略部分 skill。[OpenAI Build skills](https://developers.openai.com/codex/build-skills)

由此带来四个结构性问题：

1. **是否触发不确定。** 描述再好，也仍由模型判断相关性。
2. **输入输出没有强类型。** Skill 常用自然语言说明“需要哪些输入、应产出什么”，host 无法在运行前验证。
3. **完成条件不具机器语义。** “确保测试通过”是指令，不是持久化的 completion predicate。
4. **组合依赖隐式。** Skill A 依赖 Skill B、某个 MCP、特定模型或本机 binary，通常只能写进说明，由模型临场处理。

因此，下列想法用 skill 能做 demo，却不容易做成可靠产品：

- 每周财务关账：必须依次拉数据、对账、让人确认异常、写回系统；
- 发布流程：只有测试、审计、审批都满足才允许 deploy；
- SLA monitor：持续观察直到一个条件成立，超时升级；
- “录一次就可靠复现”的桌面工作流。

OpenAI 的 Record & Replay 会把演示转成 skill，这对捕捉隐性偏好很聪明；但回放时仍是 agent 根据 skill 和当前工具重新推理，而不是事件级 deterministic replay。[OpenAI Record & Replay](https://developers.openai.com/codex/extend/record-and-replay)

**建议：** 在 skill 之上增加可选的 `contract`：

```yaml
inputs:
  report_date: { type: date, required: true }
requires:
  tools: [finance.read_ledger, drive.write_file]
  capabilities: [network:finance.example.com]
outputs:
  report: { media_type: application/pdf }
completion:
  all:
    - artifact_exists: report
    - check: reconciliation_errors == 0
```

Skill 仍是面向模型的操作手册，contract 则供 host 做表单生成、依赖检查、权限预授权、验收和自动化。

### 2. Hook 有事件，却通常没有完整的组合语义

Hook 是当前生态中最接近真正 runtime extension 的机制。Claude Code 已经覆盖 session、turn、tool、permission、compaction、subagent、task、worktree、file/config change 等大量事件，而且支持 command、HTTP、MCP tool、单轮 prompt 和实验性的 agent hook。[Claude Code Hooks](https://code.claude.com/docs/en/hooks)

Codex hooks 也覆盖 `PreToolUse`、`PermissionRequest`、`PostToolUse`、compact、prompt、subagent、stop 和 session 生命周期。但其官方文档明确指出：多个匹配的 command hook 会并发启动，所以一个 hook 不能阻止另一个同时开始。[Codex Hooks](https://developers.openai.com/codex/hooks)

这暴露出一个普遍难题：hook API 经常回答“什么时候调用”，却没有完整回答：

- 多个 hook 的先后顺序是什么？
- 哪些是 observer，哪些可以 transform，哪些可以 veto？
- 两个 hook 都改 tool input 时如何 merge？
- 一个 hook 失败，是 fail-open、fail-closed、重试还是隔离？
- hook 的副作用如何保证幂等？
- 能否在 replay 时选择“不重放外部副作用”？
- hook 版本升级后，旧 session 恢复时用旧逻辑还是新逻辑？

LangChain middleware 的 wrap-style hook 更强，可以包裹 model/tool call、短路、重试，并修改 agent state；但官方最佳实践仍需要作者自己考虑 execution order 和 state property 冲突。[LangChain Custom middleware](https://docs.langchain.com/oss/python/langchain/middleware/custom)

**很难方便实现的例子：** DLP 插件先脱敏、审计插件记录脱敏前还是脱敏后、权限插件再判断域名、缓存插件决定是否真的调用工具。没有 phase、priority、数据版本和冲突规则时，安装顺序会悄悄改变安全语义。

**建议：** 把 hook 升级成显式 pipeline：

```text
observe.before
→ transform.input (ordered, typed patches)
→ policy.decide (deny > ask > allow)
→ execute
→ transform.output
→ observe.after
→ commit state
```

每个 handler 声明 `phase / priority / reads / writes / failurePolicy / replayPolicy / timeout`。Host 在启用插件前就能显示冲突图，而不是运行时才发现。

### 3. MCP 标准化了工具边界，但没有标准化整个 agent loop

MCP 是生态里最成功的互操作层。它已经有能力协商、工具/资源发现、进度通知、sampling 和 elicitation；MCP Apps 又让工具能返回跨 host 的 sandboxed iframe UI。[MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)

但 MCP 的设计目标是 context/tool exchange，不是控制 host 的：

- prompt 组装与压缩策略；
- memory 读取、写入和冲突解决；
- agent 何时停止、何时自动继续；
- subagent 调度与预算；
- session checkpoint 和 branch；
- artifact 版本与 review 状态；
- host 导航、全局通知和后台服务。

这意味着“把某个外部服务接进来”很适合 MCP；“让所有 agent 在压缩前先生成可验证 memory patch，并把它显示在统一审阅 UI 中”则需要每个 runtime 单独适配。

MCP Apps 缓解了 UI 可移植性，但它仍然是**工具返回的内嵌视图**。它不等于插件可以贡献：

- 左侧一级导航；
- 全局 inbox 类型；
- persistent side panel；
- run detail 的新 tab；
- 状态栏；
- 系统级快捷键；
- 跨会话 dashboard。

**建议：** Cetus 应支持 MCP Apps，作为插件内嵌 UI 的公共底座；同时定义一个更窄、更严格的 host UI extension manifest，用于注册预先审核的 slot，而不是允许任意插件接管整个 shell。

### 4. Plugin 目前更像压缩包，而不是完整的应用生命周期

Cetus 当前 plugin manifest 能声明 prompt、extensions、MCP、apps、skills、native capabilities、risk level 和 activation；第三方 native capability 被限制在信任边界外。这是正确的安全起点。

不足之处在于，一个真正的“应用型插件”还会需要：

- install / enable / disable / uninstall hook；
- schema migration 和 rollback；
- durable plugin state；
- secrets 与 OAuth account binding；
- 后台 worker / watcher；
- cron、webhook、file event 等 trigger；
- notification channel；
- health check；
- dependency / conflict / minimum host version；
- data export 与删除；
- upgrade 时对进行中 runs 的兼容策略。

如果缺少这些，一些想法只能被硬编码为 Cetus 内置模块。例如会议、屏幕历史、浏览器控制、自动化和 dreaming 都不仅仅是“模型多了一个工具”：它们有 native 权限、后台生命周期、设置页、数据存储、通知和 review surface。

**建议：** 将 plugin 分成三种明确等级：

1. **Recipe plugin**：skills / prompts，几乎零权限；
2. **Connector plugin**：MCP / OAuth / optional MCP App；
3. **Host app plugin**：审核或签名后可使用 state、trigger、notification、UI slot 和有限 native capability。

不要让第三种能力偷偷借由 extension script 获得；应有清楚的 capability grant 和审核路径。

### 5. 缺少“持久工作流”这一等公民

大多数 coding harness 的基本循环仍是：

```text
user prompt → model → tool loop → final response
```

长任务往往通过“继续 prompting”、stop hook 或后台 session 延长。Claude Code 的 `/goal` 已开始将 completion condition 一等化；LangGraph 则从底层提供 checkpoint、interrupt、resume、fault tolerance、replay 和 fork。[Claude Code What's New: /goal](https://code.claude.com/docs/en/whats-new/2026-w20) [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

这两者揭示了普通 harness 的缺口：**会话持久化不等于流程持久化**。

一个真正长期运行的任务需要保存：

- 当前 state，而不只是 transcript；
- 下一步等待什么；
- 哪些副作用已经 commit；
- 哪一步可以安全重试；
- 当前使用的 plugin/runtime/model 版本；
- deadline、budget、retry、escalation policy；
- human input schema；
- 恢复时如何处理已经变化的外部世界。

Cetus 的 automation 当前以“按计划新开一个后台对话”为主，这很适合日报，但不等于 durable workflow engine。若要实现“每小时检查 CI，失败则修复，修复后等待 reviewer，批准后合并”，需要持久状态机。

**建议：** 不必一开始做通用可视化 DAG。先把以下 primitives 放进 Run API：

- `checkpoint(state, resume_token)`
- `interrupt(schema, reason, deadline)`
- `wait_for(event | time | predicate)`
- `spawn(children, join_policy)`
- `commit(effect_id)`
- `retry(policy)`
- `complete(artifacts, evidence)`

Skill 可以生成或调用这些 primitives；UI 则天然知道当前 run 是在执行、等待外部事件、等待人、重试还是完成。

### 6. 权限仍以“工具名”而非“能力 + 资源范围”思考

当前许多产品允许按命令、工具或高风险动作批准。这个方向正确，但粒度经常不够：

- `drive.write` 是写哪一个文件夹？
- `email.send` 可以发给谁？
- `browser` 可以访问哪些域？
- token 可用多久、能否被 subagent 继承？
- 插件能否把从 A 系统读到的数据发往 B 系统？

单纯的 “allow tool once / always allow” 对跨 SaaS 工作流过于粗糙。背景 agent 尤其危险：Cursor 官方文档说明其 background agent 默认可联网并自动执行终端命令，也直接提醒存在 prompt injection 和数据外泄风险。[Cursor Background Agents](https://docs.cursor.com/background-agent)

**建议：** 使用 capability token：

```text
action: google_drive.write
resource: folder/quarterly-reports/**
data_classification: internal
destination: same_service
principal: run/123 + descendants
expires: 2h
approval: user
```

权限 UI 显示的是“这次任务要做什么、对什么数据、发往哪里”，而不是底层函数名。

### 7. 缺少跨 runtime 的语义协议

Cetus 的定位是保留用户选择的 runtime，并将它们翻译到统一桌面工作流。这比绑定一个 agent engine 更有价值，也更困难。

目前最容易统一的是 text、thinking、tool start/end。最难统一的是：

- plan 与 todo；
- permission request；
- subagent tree；
- context usage / compaction；
- checkpoints；
- background task；
- artifact；
- review request；
- runtime-specific UI / slash commands；
- hook 与 plugin lifecycle。

如果只对齐最小公分母，Cetus 会丢掉每个 runtime 最有价值的能力；如果 UI 到处写 provider 特例，产品会越来越难维护。

**建议：** 建立 versioned Agent Run Protocol，采用“稳定核心 + vendor extension”：

```text
run.created / run.state_changed
turn.started / turn.completed
plan.proposed / plan.updated
step.started / step.progress / step.completed
tool.requested / permission.requested / tool.completed
artifact.created / artifact.revised
checkpoint.created / branch.created
child_run.created / child_run.joined
review.requested / review.resolved
context.compacted
run.failed / run.completed

vendor.codex.*
vendor.claude.*
```

UI 消费稳定核心；高级视图可以按 capability negotiation 渐进增强。

### 8. 可观测性有日志，但缺少可解释的因果链和可复现测试

很多 harness 能展示 tool card、terminal output 和 token usage，但插件作者仍很难回答：

- 这个 skill 为什么触发/为什么没触发？
- 哪一段 instruction 最终进入了 model context？
- tool input 被哪些 hooks 改过？
- permission 为什么被允许？
- compact 前后丢了哪些信息？
- 相同输入在升级 plugin 后行为差在哪里？

LangGraph 的 checkpoint/time travel UI 思路值得借鉴：每一个 state change 都可成为检查点，并能从中恢复或分叉。[LangGraph Time travel UI](https://docs.langchain.com/oss/python/langchain/frontend/time-travel)

**建议：** 为插件开发者提供：

- context inspector（来源、优先级、token 占用、是否被截断）；
- hook waterfall（原始输入、patch、decision、耗时）；
- capability/permission trace；
- record fixture + mocked tool replay；
- old/new plugin version trajectory diff；
- skill trigger eval、tool contract test、UI snapshot test；
- 一键导出脱敏 run bundle。

---

## 三、哪些产品 UI 我非常喜欢

### 1. Claude Code Agent View：按“是否需要你”排序，而不是按时间排序

Agent View 把后台 session 显示为表格，区分 working、waiting on you、done；可以 peek、直接回复，也可以 attach 进入完整会话。它还会把需要输入的 session 排到前面。[Claude Code Agent View](https://code.claude.com/docs/en/agent-view)

我非常喜欢这个设计，因为它抓住了多 agent UI 的第一原则：

> 用户不是要“观看所有 agent 工作”，而是要尽快发现哪些地方需要自己的判断。

它比无限 chat sidebar 更接近运维控制台。Peek/attach 的层级也很好：先低成本看摘要，需要时再沉浸进去。

不足是 TUI 表格天然不适合审阅复杂 artifact、diff、截图和依赖图；它擅长 dispatch/status，不是完整 workbench。

### 2. Codex App：把 diff 审阅放回 thread，并支持原位 annotation

Codex App 的突出优点不是“多 agent”，而是让 agent 的改动、讨论和 review 保持在同一工作上下文里，并允许对 diff 评论、在编辑器打开；内置 worktree 隔离并行任务。[Introducing the Codex App](https://openai.com/index/introducing-the-codex-app/)

后来扩展到 documents、slides、sites 的 annotation 更重要：用户指向产物的具体位置给反馈，而不是在聊天框中描述“第三页右下角那张图”。[Codex annotations and Sites](https://openai.com/index/codex-for-every-role-tool-workflow/)

这是我认为所有 general-purpose agent UI 都应该学习的交互：

> 反馈应尽量附着在对象上，而不是被迫翻译成文本坐标。

### 3. Cursor：IDE 内的 diff、checkpoint 和“本地接管”

Cursor 最强的地方是 agent 没有把开发者从原有工作对象中拉走。代码仍在编辑器里，diff 可审，terminal 可见，checkpoint 可以快速回退，chat tab 可以并行。[Cursor Agent overview](https://docs.cursor.com/chat/overview) [Cursor Checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints)

其 background agent 又提供 web/mobile → desktop IDE 的 handoff：外出时发起，回来后在完整开发环境中接手、review、merge。[Cursor Web & Mobile](https://docs.cursor.com/en/background-agent/web-and-mobile)

我喜欢的是这种“自主与接管连续谱”，而不是二选一的自动驾驶/手动驾驶。

### 4. Devin：计划可以先成为一个共同检查的对象

Devin 的 interactive planning 会先展示相关文件、发现、问题和带代码引用的详细计划；用户可以要求等待批准，引用可直接跳到 embedded IDE 验证。[Devin Interactive Planning](https://docs.devin.ai/work-with-devin/interactive-planning)

这比单纯显示“Thinking…”好得多。计划不是为了制造仪式感，而是把高成本误解暴露在执行前。

我尤其喜欢“计划中的引用可以打开实际代码”——plan 的每一项都应尽量可验证。

### 5. MCP Apps：让插件结果成为可直接操作的对象

MCP Apps 让工具返回图表、表单、dashboard、文档 review 等 sandboxed UI，并通过标准桥与 host、server、model 双向通信。[MCP Apps Overview](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html)

它是当前生态中最有希望缓解“所有东西都挤进文本 transcript”问题的标准化方案。Cetus 值得直接支持，而不是再发明一种只属于 Cetus 的 iframe 协议。

### 6. Cetus：ambient context 和 review queue 的方向是对的

Cetus 的 Quick Launcher 会把截图、前台 app、浏览器 URL 和选中文字变成可移除的 context；这比让用户先解释“我现在在看什么”更自然。Kanban 的 In progress / Needs review / Done 则已经尝试把后台任务从 chat history 中抽出来。

我喜欢这两点，因为它们分别解决了 agent 工作的入口摩擦和回收摩擦：

- 入口：在当前工作现场发起；
- 回收：回来后知道看什么。

这是 Cetus 相较“又一个 IDE agent”的独特资产。

---

## 四、当前 UI 普遍做得不好的地方

### 1. Chat transcript 被迫承担太多职责

今天一个典型 transcript 同时包含：

- 用户需求；
- agent 的解释；
- tool 调用；
- terminal 日志；
- permission；
- plan/todo；
- subagent 结果；
- artifact 链接；
-错误和重试；
-最终答案。

这导致两个问题：运行中噪音太多，运行后又很难复盘。折叠 tool card 只能降低视觉噪音，并没有解决信息架构问题。

理想方式是 transcript 只保留协作对话和关键决策；执行事件进入 timeline，产物进入 artifact pane，权限进入 decision log，日志进入 diagnostics。

### 2. “正在工作”不是有用的进度

转圈、流式 token、不断增长的 tool list 会给人 activity 感，却未必回答：

- 它当前目标是什么？
- 已完成哪些验收条件？
- 距离下一次需要我还有多远？
- 卡在哪里？
- 是否在重复尝试？
- 预算消耗是否值得？

好的 progress 必须锚定计划节点或 completion criteria，而不是锚定模型正在吐什么。

### 3. 多 agent 通常只有列表，没有拓扑

当用户同时发起几个独立任务时，列表/看板够用；但一个主任务内部有 researcher、implementer、reviewer、browser QA 时，用户需要看到：

- 谁由谁创建；
- 谁依赖谁；
- 哪些在并行；
- 哪个结果被主 agent 接受或丢弃；
- 哪些 agent 正在写同一资源；
- 汇总是否漏掉 dissenting result。

现有 UI 常把 subagent 折叠成一张 tool card，或把所有 session 平铺。二者都丢失协作结构。

### 4. Approval UI 过于底层，容易造成疲劳

“允许运行这条 shell command 吗？”对安全专家有价值，对普通用户常常不是正确问题。用户真正能判断的是：

- 是否允许本任务读取整个 repo？
- 是否允许把报告写入某个 Drive 文件夹？
- 是否允许给这三个收件人发草稿？
- 是否允许在满足这些检查后自动部署 staging？

权限应围绕意图、数据和影响展示，底层命令作为可展开证据。

### 5. Review queue 缺少“审什么、凭什么通过”

Needs review 是好方向，但一张只有标题、workspace 和时间的卡片信息密度太低。review card 应直接显示：

- 请求你做的决定；
- 变化摘要；
- 风险等级；
- 验收条件通过数；
- 失败/未运行的检查；
- 主要 artifact；
- agent 信心和已知缺口；
- approve 后会发生什么。

否则用户必须逐张打开长对话，queue 失去意义。

### 6. 配置散落在 model、runtime、mode、skill、plugin、permission 之间

用户发起任务时真正需要的是“执行 profile”，例如：

> 本地 Codex；高推理；允许改 workspace；网络仅官方文档；使用 frontend 和 browser skills；完成后必须截图并请求 review；预算 45 分钟。

今天这些设置往往分散在 composer 下拉框、全局 settings、repo 文件和 permission dialog。用户很难知道这次 run 最终继承了什么。

### 7. 历史记录按 conversation 组织，但用户按 goal 和 artifact 回忆

用户更可能记得“上周的发布方案”“那份市场报告”“修支付 bug 的几个尝试”，而不是 chat 标题。Conversation 只是执行容器，不应是唯一一级对象。

### 8. 很少有真正可用的时间旅行与分叉对比

Cursor checkpoint 解决了 agent 代码修改的快速回退，LangGraph 能从 state checkpoint fork。但普通 harness 很少把：

- 需求版本；
- plan 版本；
- filesystem checkpoint；
-外部 tool response；
- artifact version；
-模型/runtime/plugin version

统一到一个 branch 中。因此“回到这里，换个假设继续”常会得到半真的回放。

---

## 五、我理想中的 Agent Harness UI

## 设计原则

1. **Attention-first**：首页回答“现在什么需要我”。
2. **Artifact-first**：用户审的是结果，不是 agent 的表演。
3. **Conversation is control, not storage**：聊天用于意图、澄清和判断；结构化状态另存。
4. **Progressive transparency**：默认简洁，计划、事件、命令、原始 trace 可逐层展开。
5. **Reversible by default**：高影响步骤前 checkpoint，任何分叉有清楚 lineage。
6. **Runtime-plural, semantics-stable**：不同 engine 能力不同，但核心 run/review 模型一致。

## 整体结构：Ambient Launcher + Mission Control

### A. Ambient Launcher

保持 Cetus 现在的优势，但 composer 不只是 prompt：

```text
┌──────────────────────────────────────────────┐
│ 帮我分析这个报错并给出修复                   │
│ [截图] [Chrome · localhost:3000] [选中文本]  │
│                                              │
│ Profile: Local coding ▾   Review: Before merge│
│ 预计：Codex · repo write · browser · 30 min  │
└──────────────────────────────────────────────┘
```

关键是用一行“执行预览”把 runtime、权限、skills、预算和 review policy 汇总出来。高级设置仍可展开，但用户在发送前知道自己委托了什么。

### B. Mission Control 首页

首页不是 Chats，而是 Inbox：

```text
Needs you (3)
  [Approval] 发布 staging：将写入 Vercel，2 checks passed
  [Question] 客户名单中有 2 个同名联系人
  [Review] 支付 bug 修复：12 files，tests 184/184

At risk (2)
  CI flaky-test investigation · retry 4/5 · 18 min

Working (5)
  …

Ready / Recent
  …
```

允许按 Goal、Project、Workspace、Runtime、Automation、Risk 分组，但默认永远把 attention 排序放第一。

## Run Workbench

打开一个 run 后，界面由四类对象组成，而不是一条混合消息流：

```text
┌ Goal / scope / branch / runtime / budget / Stop ───────────────┐
│                                                                │
│  Plan & status          Artifact / Workspace        Context     │
│  ✓ Reproduce            [Diff | Site | PDF | Sheet]  Chat       │
│  ✓ Find cause                                      Decisions    │
│  ● Implement                                       Evidence     │
│  ○ Verify                                           Timeline    │
│                                                                │
│  “Tests pass; visual regression remains.”                       │
│  [Give feedback] [Request alternative] [Review when ready]      │
└────────────────────────────────────────────────────────────────┘
```

### 左侧：Plan / Agent graph

- 默认展示 5–10 个语义步骤，不展示每次 grep；
- 每步有状态、产物、验收、耗时；
- 展开后显示 child agents 和依赖；
- 允许用户改顺序、取消一步、增加约束；
- agent 更新计划时显示 diff，而不是静默重写。

### 中间：Artifact / Workspace

中心区域随任务切换：

- 代码：diff + file tree + tests；
- 网站：browser + annotation；
- 文档：分页预览 + comments；
- 表格：sheet + formulas + source lineage；
- 研究：report + citations + evidence table；
- 纯诊断：findings board。

Chat 不应长期占据最宝贵的中央画布。

### 右侧：Context / Decisions / Evidence / Timeline

- **Chat**：需求、澄清、策略反馈；
- **Decisions**：人和 agent 做过的关键选择及原因；
- **Evidence**：测试、截图、引用、指标；
- **Timeline**：tool/event trace，可过滤；
- **Context**：本次 run 使用了哪些文件、screen、memory、skills，以及来源和 token 占用。

### 顶栏：永远可见的控制

- 当前 run state；
- runtime/model/profile；
- elapsed / budget / tokens 或 credits；
- sandbox / branch / workspace；
- Stop；
- checkpoint / fork；
- “下一次需要我”的预测。

## Review Mode

当 run 请求 review，界面切成专门模式：

1. **What changed**：3–7 条摘要；
2. **Why**：需求与 plan 的映射；
3. **Evidence**：验收矩阵；
4. **Risks / gaps**：未验证和退路；
5. **Artifacts**：可原位 annotation；
6. **Decision**：
   - Approve and finish
   - Approve next action
   - Request changes
   - Fork an alternative
   - Take over

其中“Approve”必须显示之后会发生什么。批准一个报告完成和批准 deploy 不是同一按钮。

## Plugin UI

插件 UI 分三层：

1. **Inline component**：MCP Apps，跟随 tool result；
2. **Workbench tab**：如 Security Findings、Browser、Figma、Data explorer；
3. **Inbox item type**：如“合同条款待确认”“CI incident 待处理”。

Plugin manifest 声明：

```yaml
ui:
  inline: mcp-app
  workbenchTabs:
    - id: findings
      title: Findings
      resource: ui://security/findings
      when: artifact.type == "security.findings"
  inbox:
    - type: security.review
      renderer: ui://security/review-card
```

Host 决定布局、尺寸、主题、权限和 sandbox；插件提供内容，不应任意改整个 app shell。

---

## 六、对 Cetus 的具体建议

## P0：先统一运行语义，再继续堆功能

### 1. 建立 Agent Run Protocol

把 Pi、Codex、Claude 的事件转换目标从“能渲染同一种聊天”提升为“能表示同一种 run”。

首批核心对象：

- `Goal`
- `Run`
- `PlanStep`
- `AttentionRequest`
- `Decision`
- `Artifact`
- `Evidence`
- `Checkpoint`
- `ChildRun`

当前的 `PiEvent`、CLI control request、board review state、artifact、background task 已经是素材，但还需要一个上层 domain model。

### 2. 把 Needs review 升级为统一 Attention Inbox

不要只做三列 Kanban。至少区分：

- `question`
- `permission`
- `review`
- `failure`
- `conflict`
- `credential/setup`
- `budget`

每种 item 有 schema、priority、deadline、recommended action 和 resume token。这样来自 extension UI、CLI runtime、automation、MCP elicitation 的请求都进入同一队列。

### 3. 给 review card 增加 evidence

最小可行字段：

- 2 行 change summary；
- artifact chips；
- checks passed / failed / skipped；
- risk；
- requested decision；
- approve side effect。

这会立刻提高 Kanban 的实际价值。

## P1：把 plugin 从“能力包”升级成“受控 host app”

### 4. 用正式 Host RPC 取代 sentinel title tunnel

Cetus 当前通过 `ctx.ui.input("__cetus_skill__", JSON)` 把请求送到 Rust host。它是聪明且实用的过渡方案，但存在：

- transport 与 UI 语义混用；
- payload 藏在 placeholder；
- capability discovery 不明确；
- 很难版本协商；
- 很难自动生成权限和调试信息；
- runtime 不支持该 UI 方法时需要特例。

建议定义正式协议：

```json
{
  "type": "host.call",
  "protocol": "cetus.host/1",
  "capability": "skills.manage",
  "method": "list",
  "params": {},
  "requestId": "..."
}
```

启动时 host/runtime 做 capability negotiation；未知 capability 返回结构化错误。Bridge 可以继续 transport-neutral。

### 5. 增加 plugin lifecycle、state、migration 和 dependency

Manifest 至少新增：

- `minHostVersion`
- `dependencies`
- `conflicts`
- `stateSchemaVersion`
- `migrations`
- `triggers`
- `notificationTypes`
- `ui`
- `dataRetention`
- `uninstallBehavior`

第三方 host app plugin 先只支持签名/开发者模式，避免为了开放性破坏 native trust boundary。

### 6. 实现 MCP Apps host

Cetus 当前 extension UI 主要支持 select / confirm / input / editor modal；`setStatus`、`setWidget` 等在桌面 UI 中直接忽略。这个模型不足以承载数据表、dashboard、复杂审批和文档 review。

直接支持 MCP Apps 可以获得：

- 跨 ChatGPT / Claude / VS Code 等 host 的 UI 生态；
- sandbox、CSP、postMessage bridge 的已有规范；
- 工具在不支持 UI 的 host 中仍能降级为文本。

Cetus 自己只需补充 host-specific extensions，例如打开 workspace tab、创建 annotation、发起 review。

## P2：工作流与可调试性

### 7. 增加 durable run primitives

先服务 Cetus automation 和 Ultra workflow，不急着对用户暴露 DAG 编辑器。让 run 能：

- 等待时间/事件/人；
- checkpoint；
- resume；
- fork；
- 重试；
- join child runs；
- 记录幂等 effect。

### 8. 做 Plugin Inspector

这是生态形成前的基础设施：

- 安装来源、版本、签名、风险；
- 实际贡献的 skills/tools/hooks/UI；
- 本次 run 激活了哪些；
- hook waterfall；
- capability grants；
- 健康状态和错误；
- “在测试会话中运行”；
- 导出脱敏 trace。

### 9. 引入可保存的 Execution Profile

例如：

- Local Safe
- Local Full Build
- Research
- Browser QA
- Background Trusted

Profile 汇总 runtime、model、reasoning、sandbox、network、skills、plugins、review policy 和 budget。Composer 只选一个 profile，并允许本次覆盖。

---

## 七、建议优先级与产品路线

| 阶段 | 目标 | 关键交付 | 为什么先做 |
|---|---|---|---|
| 0–6 周 | 让后台工作更可管理 | Attention Inbox、review evidence、统一 run states | 用户立即感知，且为后续协议提供真实需求 |
| 6–12 周 | 建立跨 runtime 核心 | Agent Run Protocol v1、capability negotiation、正式 Host RPC | 防止 provider 特例继续扩散 |
| 3–5 个月 | 让插件能做真正产品 | MCP Apps host、plugin UI slots、state/lifecycle/dependency | 解锁 dashboard、表单、review 等非聊天体验 |
| 5–8 个月 | 支持长期可靠工作 | checkpoint/interrupt/resume/fork、effect idempotency | 让 automation 从定时 prompt 进化为持久 workflow |
| 持续 | 形成生态与信任 | Inspector、fixtures、evals、签名、权限 scopes、审计 | 没有调试与治理，插件数量越多体验越差 |

我不建议 Cetus 近期先做一个通用节点式 workflow builder。节点画布很容易显得“强大”，却会迫使用户理解 agent 内部结构。更好的顺序是先把 durable primitives 和 run state 做对，让 agent/skill 生成流程，让 UI 只在需要审查或诊断时显示结构。

---

## 最后的产品判断

Agent harness 的竞争将从“模型能调用多少工具”转向三个更难复制的能力：

1. **委托质量**：用户能否低摩擦地给足上下文、边界和验收标准；
2. **监督密度**：用户每花一分钟注意力，能推进多少 agent 工作；
3. **扩展可信度**：第三方能力能否被组合、审计、升级、恢复和撤销。

Skills 和 MCP 会成为生态公共层，单独支持它们不会构成长久差异。真正的产品护城河在 host：

- 怎样组织 attention；
- 怎样表达 durable work；
- 怎样让 artifact 成为协作中心；
- 怎样把不同 runtime 翻译成同一种可监督语义；
- 怎样让插件获得足够能力，却不能越过用户理解和信任的边界。

Cetus 当前最独特的机会，是把 ambient desktop context、runtime pluralism 和 background review 三者合在一起。它不需要成为另一个 IDE，也不应只是一个多 runtime chat client。它可以成为用户桌面上的 agent control plane：在工作现场发起，在后台可靠运行，在需要判断时回来找你，并把可审阅的成果而不是冗长过程交到你手上。

---

## 主要资料

- [OpenAI：Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [OpenAI：Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI：Codex Hooks](https://developers.openai.com/codex/hooks)
- [OpenAI：Build skills](https://developers.openai.com/codex/build-skills)
- [OpenAI：Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Claude Code：Hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code：Create plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code：Agent View](https://code.claude.com/docs/en/agent-view)
- [GitHub Copilot：Customization cheat sheet](https://docs.github.com/en/copilot/reference/customization-cheat-sheet)
- [Cursor：Agent overview](https://docs.cursor.com/chat/overview)
- [Cursor：Background Agents](https://docs.cursor.com/background-agent)
- [Devin：Interactive Planning](https://docs.devin.ai/work-with-devin/interactive-planning)
- [MCP：Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP Apps：Overview](https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html)
- [LangGraph：Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph：Time travel](https://docs.langchain.com/oss/python/langchain/frontend/time-travel)

