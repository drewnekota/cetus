<p align="center"><img src="docs/logo.png" width="120" alt="Cetus logo" /></p>

<h1 align="center">Cetus</h1>

<p align="center"><strong>把你惯用的 agent runtime，变成一个常驻桌面的智能助手。</strong></p>

<p align="center">Codex、Claude Code 或内置 runtime 仍是核心；Cetus 在它们之外补上桌面助手这一层：从任何 app 随时唤起、定时安排工作，并理解你在屏幕上看过的内容。</p>

<p align="center"><strong>Quick Launcher</strong> · <strong>Automations</strong> · <strong>Global Quick Reply</strong> · <strong>Screen Context</strong></p>

<p align="center">
  <a href="https://github.com/drewnekota/cetus/releases/latest"><img alt="下载 macOS 版" src="https://img.shields.io/badge/下载_macOS_版-Apple_Silicon-111111?style=for-the-badge&logo=apple" /></a>
</p>

<p align="center">
  <a href="https://github.com/drewnekota/cetus/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/drewnekota/cetus" /></a>
  <a href="https://github.com/drewnekota/cetus/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/drewnekota/cetus/ci.yml" /></a>
  <a href="https://github.com/drewnekota/cetus/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/drewnekota/cetus" /></a>
  <a href="LICENSE"><img alt="MIT 协议" src="https://img.shields.io/github/license/drewnekota/cetus" /></a>
</p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

![Cetus runtime 选择器 —— Claude Code、Codex、OpenCode、Grok Build、Kimi CLI 都在同一个 macOS app 里](docs/screenshot-runtime-picker.png)

![Cetus 操作演示 —— 唤起 agent、创建自动化任务并切换 runtime](docs/cetus-demo.gif)

## Cetus 为你的 agent 补上的四件事

### Quick Launcher：一个快捷键，随时叫出 agent

**同时按住左右 ⌘**，即可在任意 app 之上唤出 agent。Cetus 会把当前截图、前台 app、浏览器 URL 和选中文字作为可移除的 context 一起带进来，让你直接就地提问，不必先花时间解释自己正在看什么。

![Cetus 快捷启动器演示](docs/quick-launcher.gif)

### Automations：你不在时，也让它继续工作

把任意 prompt 变成单次或周期任务（`at` / `every` / `cron` / `daily`）。每次运行都保留所选 runtime 和模型设置，在新的后台对话中完成工作，并把结果留在审阅队列里。

![Cetus 自动化任务演示](docs/automation.gif)

### Global Quick Reply：不用离开对话，就把回复写好

在任意对话上**双击右 ⌥** —— 团队频道、邮件、工单后台都行 —— Cetus 会读懂屏幕上正在发生什么，然后把草稿流式写进一个可编辑的面板。它跟随对话本身的语言和语气，并且是真的在回答对方问的问题：对面抛了三个待决问题，回来的就不会是一句"好的"。按 **⏎** 直接填进你原本所在的输入框，按 **⇥** 则用另一个 runtime 重写同一屏。

![Cetus 全局快速回复演示](docs/quick-reply.gif)

### Screen Context：让它记得你之前在做什么

开启后，Cetus 会定期截帧、去重，并在设备端使用 Apple Vision 完成 OCR。Agent 之后可以回忆屏幕上出现过什么，也可以按文字或 app 检索历史。图片和文字都留在你的 Mac 上；这项能力默认关闭，并提供保留时长和敏感 app 排除列表。

![Cetus 屏幕 context 设置](docs/screenshot-screen-history.png)

## 立即使用

预编译版本支持 **Apple Silicon** 和 **macOS 13 或更高版本**。

1. [下载最新版本](https://github.com/drewnekota/cetus/releases/latest)。
2. 打开 DMG，将 Cetus 移入 Applications。
3. 使用 Cetus 内置 runtime，或选择本机已经安装并登录的 `claude` / `codex` CLI。
4. 选择一个 workspace，交给 agent 第一个任务。

Claude Code 和 Codex 会复用现有 CLI 登录，不需要再配置一个账号。从源码构建请参阅[参与开发](#参与开发)。

> **早期版本：** Cetus 仍在快速开发。如果遇到问题或缺少需要的工作流，欢迎[提交 Issue](https://github.com/drewnekota/cetus/issues)。

## 其它能力

### 继续用你已经信任的 runtime

内置 pi runtime、**Claude Code** 或 **Codex** 都可以直接使用，并沿用你现有的模型、工具和登录状态。Cetus 把不同 runtime 的事件转换成一致的桌面工作流，同时让对话 context 和后台终端跨回复继续存在。

选择 **workspace** 和 runtime，可选附上文件或截图，然后发送。并行处理代码任务时，还可以为每个对话启用独立 git worktree。

![Cetus 对话](docs/screenshot-chat.png)

### 在一个地方审阅所有后台工作

每个对话都是一张卡片，按**进行中 · 待审阅 · 已完成**跟踪。自动化任务、长时间运行的工作和并行解法都会集中到这里，不会埋在终端 session 中。

![Cetus 看板](docs/screenshot-kanban.png)

### 继续扩展你的 runtime

- **持久记忆**：用户和 agent 都能编辑，并注入未来的对话
- **并行解法**：把一个 prompt 铺开成 N 个候选运行，然后留一个、归档其余
- **独立 git worktree**：隔离每个 coding session 的改动
- **视觉快速回复**：根据当前屏幕起草回复，不必启动完整 agent run
- **Cetus Remote**：可选的 Tailscale 手机伴侣，用于跟踪运行和处理确认
- **语音听写**与**会议记忆**：在设备端完成处理
- **电脑与浏览器控制**：执行有后果的操作前请求确认
- **30+ 模型供应商**：包括 Anthropic、OpenAI、Google、Bedrock、Ollama、LM Studio 和 OpenRouter

### 在任意 app 中听写

在任意 app 里按住热键开口说话 —— Cetus 弹出一个随声音起伏的悬浮均衡器 HUD，在设备端用 Seed-ASR 转写，并把整理好的文字落到你光标所在的位置。和 app 内麦克风用同一套管线，只不过它跟着你跑遍整个桌面。

![Cetus 语音听写 HUD](docs/voice-hud.jpeg)

这张图是用手机拍的，因为这个悬浮层截不到。

### 把会议变成可搜索的上下文

打开**会议记忆**，Cetus 会安静地把通话转写成可搜索的纪要 —— 全程设备端、只存文字、不保存音频。

- **自动识别** —— 当别的 app 占用麦克风（Zoom、Teams、FaceTime、飞书……），Cetus 自己开始会话，通话结束时停止。什么都不用按。
- **手动** —— 全局热键（默认 **⌘⇧M**）手动开关，用于无法被自动识别的线下面对面会议。
- **对话双方都收录** —— 你的麦克风是你；系统音频是其他所有人，分轨采集，纪要知道每句话是谁说的（需 macOS 14.2+；更低版本回退为仅麦克风）。

转写 100% 在设备端完成，走 Apple 的 Speech 框架，流式、带标点、在自然停顿处分段。会话进行中，屏幕顶部浮出一个小药丸（红点 + 计时 + 停止按钮），不抢焦点。

这些纪要会成为 agent 能触达的 context：直接问"我们关于上线日期定了什么？"，Cetus 就会检索会议历史（`search_meeting_history`）—— 全部来自本地日志，没有东西离开这台机器。默认关闭；总开关意味着在你显式开启前，Cetus 绝不监听。目前仅支持 macOS。

![Cetus 会议记忆](docs/screenshot-meetings.png)

### 始终保有控制权

每项能力都是显式开启的。**Computer & Browser control** 让 agent 通过编号的元素列表（而非原始像素）驱动你的浏览器和 Mac app，在任何有后果的操作（发送、删除、购买、提交、认证）前需要确认，Stop 按钮始终触手可及。

![Cetus 设置](docs/screenshot-settings.png)

## 为什么做 Cetus

Codex、Claude Code 这样的通用 agent 已经足够强大，Cetus 并不打算取代它们。它补上那些不适合待在终端里的桌面助手能力：随时可用的入口、来自 Mac 的环境 context、跨 session 的连续性、后台调度，以及统一审阅完成结果的地方。

Runtime 继续负责智能与执行，Cetus 则成为包在它周围的 assistant layer。你可以为每项任务选择合适的 runtime，只加入自己愿意提供的 context，并让那些跨越数小时甚至数天的工作始终可见、可检查。

这样，一些不适合塞在终端标签页里的工作流就变得可行：

- 你离开时继续运行 agent，回来后审阅结果。
- 比较彼此独立的方案，而不让 git 改动相互冲突。
- 把项目决策与个人偏好带入下一次对话。
- 把编码工作与周围的会议、屏幕和 app 连接起来。

### Memory 与 Dreaming

上面三样东西描述的是某一个时刻。让 agent 跨时间真正有用的，是它能不能积累什么。

![Cetus — the agent loop](docs/agent-loop.png)

- **Memory（记忆）** 是 agent 写回给自己的 context —— 下一个 session 从上次停下的地方继续，而不是从零开始。
- **Dreaming（做梦）** 在你闲着的时候跑：Cetus 回顾最近的对话，把它们整合成持久的笔记，让原始聊天记录沉淀为可以复用的偏好。默认开启。

## 参与开发

### 环境要求

- **Node** ≥ 20、**pnpm**、**bun**（用于构建 pi sidecar 二进制）
- **Rust** stable（`rustc`、`cargo`）
- **Tauri** 前置依赖：<https://v2.tauri.app/start/prerequisites/>
- 一个 **`DEEPSEEK_API_KEY`**（或你选用的供应商；pi 会自动读取 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等）
- **可选**：本机安装并登录过 **Claude Code**（`claude`）和/或 **Codex**（`codex`）CLI，即可把它们用作对话 runtime —— Cetus 复用其现有登录，无需额外配置

### 首次配置

```bash
pnpm install
# 把 pi 构建为单文件二进制，输出到 src-tauri/binaries/pi-<target>。
# 约 30 秒。每台开发机跑一次即可；二进制已被 gitignore。
./scripts/build-pi-sidecar.sh
```

### 开发运行

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm tauri dev
```

Tauri 会启动 Next.js 开发服务器（端口 3000）并打开一个指向它的窗口。pi sidecar 会从打包好的二进制自动派生。

#### 开发后门：`PI_BIN`

如果你在迭代 pi 本身，可以指向任意 pi 构建来绕过 sidecar：

```bash
export PI_BIN=/absolute/path/to/your/pi
pnpm tauri dev
```

这会完全跳过 `tauri-plugin-shell`，改用原始的 `tokio::process::Command`。

### 构建

```bash
./scripts/build-pi-sidecar.sh   # 如果还没跑过
pnpm tauri build
```

在 macOS 上输出 `.app` / `.dmg`。`tauri build` 需要一套完整的多尺寸图标（存于 `src-tauri/icons/`，用 `pnpm tauri icon <path-to-1024px.png>` 重新生成）。

## 架构

```
┌──────────────────────────────── Tauri window ──────────────────────────────────┐
│                                                                                │
│  Next.js (static export)              Rust (Tokio + tauri-plugin-shell)        │
│  ┌─────────────────────────┐          ┌──────────────────────────────────────┐ │
│  │ React UI                │  invoke  │  Tauri commands                      │ │
│  │ - ConversationList      │ ───────► │  (list, new, switch, send,           │ │
│  │ - Chat (text/thinking/  │          │   archive, set_model,                │ │
│  │   tool cards), Composer │ ◄─────── │   extension_ui_respond, …)           │ │
│  │ - ModelPicker (DeepSeek)│  event   │                                      │ │
│  │ - DialogHost (ext UI)   │          │  PiRpc: sidecar(plugin-shell) OR     │ │
│  │ - chatReducer (deltas → │          │    PI_BIN(tokio::process)            │ │
│  │   RenderedMessage[])    │          │  Store: SQLite metadata              │ │
│  └─────────────────────────┘          └─────────────────┬────────────────────┘ │
│                                                         │ stdin/stdout         │
│                                                         ▼ (LF-framed JSON)     │
│                                       ┌──────────────────────────────────────┐ │
│                                       │  pi --mode rpc subprocess            │ │
│                                       │  (bundled binary, any-model engine)  │ │
│                                       └──────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **对话** 是 `<app-data>/sessions/` 下的 pi `.jsonl` session 文件。我们在 `<app-data>/cetus.db` 的 SQLite 里为它们建索引（id、title、session_file、model、时间戳、archived_at）。
- **切换**：`switch_session` + `get_messages` 重放历史。整个 app 生命周期里只有一个 pi 进程。
- **流式**：pi 发出 `agent_start`、带 `assistantMessageEvent` 增量的 `message_update`，以及 `tool_execution_*` 事件。前端的 `chatReducer` 把这些折叠成按 `contentIndex` 索引的稳定 `RenderedMessage[]`，并用一张 `toolCallId → block` 旁表来路由执行更新。
- **分帧**：严格 LF 的 JSONL。`tauri-plugin-shell` 以任意字节块投递 stdout，所以读取端维护自己的累加缓冲，按每个 `\n` 吐出一行，并剥掉可选的 `\r`。按 Unicode 分隔符切分的通用行读取器（Node `readline`）不符合规范。
- **Sidecar 打包**：`src-tauri/binaries/pi-<target>` 打进 `.app/Contents/Resources/`。`PI_BIN` 环境变量是迭代 pi 的开发后门。
- **CLI runtime**：跑在 **Claude Code** / **Codex** 上的对话完全绕过 pi RPC —— `cetus-bridge::cli_agent` 为每个对话保持 Claude streaming session 或 Codex app-server thread，由带单测的 `EventTranslator` 把事件翻译成 `chatReducer` 已经在消费的 PiEvent 流。上下文与后台终端通过 vendor session/thread 跨轮延续；可选的 per-conversation git worktree 用于隔离改动。
- **Extension UI**：当某个 pi extension 调用 `ctx.ui.select()` 等，pi 会通过事件流发出 `extension_ui_request`。前端 `DialogHost` 渲染一个对话框，并通过 `extension_ui_respond` Tauri 命令回复。

## 可复用的 bridge 包

host/extension bridge 被拆成了两个独立、与具体 provider 无关的包，可以单独依赖，无需引入整个 app：

- **[`cetus-bridge`](src-tauri/cetus-bridge)**（Rust crate）—— 产品无关的 host 运行时：围绕 `pi --mode rpc` 的 JSONL 子进程 RPC、确定性的 extension 加载、host tunnel 分类，以及可注入的 `EventSink` / `TaskSpawner` trait。Tauri、app 存储、模型 provider 选择都留在 crate 之外，由 app 侧适配器承接（`tauri_bridge.rs`、`app_event.rs`、`model_bridge.rs`）。`examples/minimal_host.rs` 给出了最小集成示例。
- **[`@cetus/bridge-protocol`](packages/cetus-bridge-protocol)**（TypeScript）—— extension 侧协议：共享的 `HOST_TUNNELS` 哨兵列表、`callHost()`、`toolResult()`，以及 host tunnel 的类型定义。

两个包都是 MIT 协议，且不含任何 Cetus / DeepSeek 专属代码，其他 agent host 也可以复用同一套 bridge。协议与安全边界详见 [docs/bridge.md](docs/bridge.md)。

## 许可证

MIT（与 pi 一致）。
