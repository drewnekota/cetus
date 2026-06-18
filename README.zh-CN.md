<p align="center"><img src="docs/logo.png" width="120" alt="Cetus logo" /></p>

# Cetus

[English](./README.md) · **简体中文**

**一个用得起的桌面 agent —— 由 DeepSeek V4.1 成就。**

Cetus 看得见你的屏幕、记得住要紧的事、并能替你动手 —— 一个真正了解你处境、也真能把事做成的助手，而且便宜到可以整天开着陪你跑。

---

## 核心理念

一个 agent 的价值，是三件事的**乘积**：

```
agent  =  context  ×  intelligence  ×  abilities
          （感知）      （认知）          （行动）
```

是**乘积**，不是加和：三项缺一不可，最短的那一项决定整体上限；要赢，就去抬高最被忽视的那一项 —— 而不是把已经够强的那一项继续往极致推。

今天整个行业把大部分钱都砸在中间那一项上 —— 智力当然重要。但既然是乘积，当智力强到一定程度，用户接下来感受到的，就不再是又多出的那一点纯推理，而是这个 agent *懂不懂你的处境*、*能不能把事办成*。而 context 和 abilities 这两项，恰恰是大多数 agent 最匮乏的地方。所以 Cetus 做了一个有意为之的押注：

> **三项缺一不可。如今智力既强又便宜 —— 所以杠杆在那些被行业低估的维度上：更厚的 context、更多的 abilities，以及一个持续转动的循环。**

这正是 DeepSeek V4.1 解锁的东西。当 token 便宜一个数量级，那些用前沿模型在经济上做不起的事，就变成了日常：

- **持续地**截屏并做 OCR，以备日后回溯，
- 对一个任务**并行铺开** N 次尝试、只留最好的那个，
- **定时调度** agent，在你离开时自己醒来干活，
- 让一个 agent 为单次请求**编排子 agent**。

我们不是要拿智力去换什么 —— V4.1 让它依旧够强。我们只是把它省下来的，花在长期被饿着的那两项上。这种再平衡，就是整个产品。

### Context × Intelligence × Abilities —— 以及让它复利的那个循环

这三个因子描述的是**某一个瞬间**。真正让一个 agent 成为*你的* agent 的，是它如何**跨时间复利** —— 而这正是公式藏起来的第四样东西：

![Cetus —— the agent loop](docs/agent-loop.png)

- **Memory（记忆）** 是 agent 写回给自己的 context —— 它把一次性的任务，变成不断累积的理解，而不是每个 session 都从零开始。
- **Dreaming（做梦）** *（路线图）* 是在空闲时把智力作用于记忆：把原始经历压缩成持久的偏好，并提炼出新的技能。这是一个通用 agent 把自己打磨成*懂你*的那个 agent 的过程。

瞬间层面的那几个因子，正在对所有人变成商品。能复利的那个循环，才是属于你个人的 —— 也才是有护城河的。

## 这些理念在 app 里对应什么

| 维度 | Cetus 现在做到的 |
| --- | --- |
| **Context —— 感知** | Rewind 式的屏幕截取 + 设备端 Apple Vision OCR（默认关闭；屏幕内容是敏感的）· **会议记忆** —— Granola 式的设备端转写，把你的通话变成可搜索的纪要 · **带上下文的启动器**，自动附上截图、当前 app、浏览器 URL 与选中文本 · 通过 pi connectors 接入第三方数据 |
| **Intelligence —— 认知** | DeepSeek **V4.1 Flash** ⚡ / **V4.1 Pro** ✨ · pi harness · **Ultra Code** 模式（agent 自己编写 workflow 并编排子 agent）· **并行解法**（best-of-N 铺开 + 并排对比挑选） |
| **Abilities —— 行动** | pi 的 tools 与 skills · 30+ 模型供应商及任意 OpenAI 兼容端点 · 定时**自动化任务**，在后台开出新对话 · 设备端**语音听写** · 全局双击 ⌘ **启动器**，在桌面任何地方随手发起 |
| **循环 —— 复利** | **Memory**：持久笔记（身份、偏好、进行中的项目），你和 agent 都能编辑，每一轮都新鲜注入 · **Dreaming**：离线整合 —— *路线图* |

## 界面一览

### 对话 —— 一个输入框，什么都能干

一切都从同一个输入框开始：选 **workspace**（工作目录）、选 **preset**（Daily ⚡ / High / Max / UltraCode ✨）、附上文件或截图，然后发出去。回复实时流式输出，配可折叠的 **thinking** 块和 **tool use** 卡片（参数、结果、错误高亮、局部输出）。

![Cetus 对话 —— What should we work on?](docs/screenshot-chat.png)

### 看板 —— 让长任务有个落脚处

每个对话都是一张卡片，按 **进行中 · 待审阅 · 已完成** 跟踪 —— 可只看一个 workspace，也可看全部。后台运行（自动化任务、并行解法）都会落在这里，让跨越多次坐下才完成的工作不会淹没在聊天列表里。

![Cetus 看板](docs/screenshot-kanban.png)

### 自动化任务 —— 按计划跑起来的 prompt

按计划触发（`at` / `every` / `cron` / `daily`）的保存 prompt。每次触发都会开出一个**全新的后台对话** —— 比如工作日 09:00 的 *Daily news digest*，在你不在时搜索过去 24 小时的新闻并渲染成 HTML 摘要。

![Cetus 自动化任务](docs/screenshot-automations.png)

### 快捷启动器 —— 带上下文，在任何地方随手发起

全局**双击 ⌘** 唤出的磨砂面板：不离开当前 app，就能 *Ask Cetus anything* —— 而且它一出现就已经了解你的处境。Cetus 会读取你眼前的内容，并以**可移除的 context 标签**形式附上：你正在看的画面**截图**、**当前 app**、当前**浏览器 URL**、以及任何**选中的文本**。留下要紧的、去掉多余的，然后开启 **New（新对话）** 或接着 **Last（上一次）** —— workspace + preset 就地选好，↵ 开始，esc 关闭。

![Cetus 快捷启动器](docs/screenshot-launcher.png)

### 语音输入 —— 全局、Wispr-Flow 式的按住说话

在*任意* app 里按住热键开口说话即可 —— Cetus 会弹出一个随声音起伏的悬浮均衡器 HUD，在设备端转写，并把整理好的文字直接落到你光标所在的位置。它用的是和 app 内麦克风同一套 Seed-ASR + 清洗管线，只不过它跟着你跑遍整个桌面，而不是困在某一个输入框里。

![Cetus 语音 HUD —— 你说话时随声起伏的悬浮均衡器](docs/voice-hud.jpeg)

> 📸 没错，这是一张*用手机拍屏幕*的照片。这个 HUD 是一个无边框、永远置顶的悬浮层，把我试过的每一个截图工具都礼貌地躲开了 —— 于是我做了任何正常人都会做的事：举起相机对着显示器拍。真实胜过像素。😄

### 会议记忆 —— Granola 式的通话纪要

打开**会议记忆**，Cetus 会安静地把你的会议转写成可搜索的纪要 —— 全程设备端、只存文字、绝不保存音频。它有三种工作方式：

- **自动识别** —— 当别的 app 占用麦克风时（Zoom、Teams、FaceTime、飞书……），Cetus 自己开始一段会话，并在通话结束时停止。不用记着去按任何键。
- **手动** —— 一个全局热键（默认 **⌘⇧M**）手动开关会话，用于那些无法被自动识别的线下面对面会议。
- **对话双方都收录** —— *你的*麦克风是你；**系统音频**是其他所有人，分轨采集，所以纪要知道每句话是谁说的（需 macOS 14.2+；更低版本会优雅地回退为仅麦克风）。

转写**100% 在设备端**完成，走 Apple 的 Speech 框架 —— 流式、带标点、在自然停顿处分段。会话进行中，屏幕顶部会浮出一个小药丸（红点 + 计时 + 停止按钮），不抢焦点。会议一结束，一次 **DeepSeek V4.1 Pro** 调用把转写蒸馏成标题和干净的 markdown **纪要** —— 要点、决议、待办事项。

最妙的是，这些纪要会成为 **agent 能够触达的 context**：直接问*"我们关于上线日期定了什么？"*或*"把今早站会的待办拉出来"*，Cetus 就会检索你的会议历史（`search_meeting_history`）—— 全部来自本地日志，没有任何东西离开这台机器。默认关闭；总开关意味着在你显式开启之前，Cetus 绝不监听，自动识别也不例外。目前仅支持 macOS。

![Cetus 会议记忆 —— 设置 → Meetings](docs/screenshot-meetings.png)

### 屏幕 context —— Rewind 式回溯，由你掌控

开启屏幕 context 后，Cetus 会周期性截帧、用感知哈希去重，并在**设备端用 Apple Vision 做 OCR** —— 这样 agent 就能回忆起你当时在做什么，你也能**按 OCR 文本或 app 搜索**这段历史。图像和文本都留在你的 Mac 上，不会上传。它**默认关闭**（屏幕内容是敏感的），并且一切都由你掌控：截取间隔、历史保留时长、设备端 OCR，以及一份**排除 app** 列表 —— 当 1Password、Messages 这类敏感 app 处于前台时自动暂停截取。

![Cetus 屏幕 context 设置](docs/screenshot-screen-history.png)

### 设置 —— 能力与权限，逐项开关

每项能力都是显式开启的。**Computer & Browser control（电脑与浏览器控制）** 让 agent 驱动你的浏览器和 Mac app —— 通过*编号的元素列表，而非原始像素*，并在任何有后果的操作前（发送、删除、购买、提交、认证）二次确认，Stop 按钮始终触手可及。同列还有：API Keys、Memory、Dreaming、Skills、Connectors、Voice、Screen context。

![Cetus 设置 —— Computer & Browser control](docs/screenshot-settings.png)

## 还有这些

- **持久记忆**：用户和 agent 都能编辑，每一轮都新鲜注入（身份、偏好、进行中的项目）
- **并行解法**：把一个 prompt 铺开成 N 个候选运行，然后留一个、归档其余
- **Ultra Code** 模式：host 编排的 workflow 引擎，agent 自己派生子 agent
- **语音听写**（设备端，macOS），既在 app 内，也支持全局按住说话
- **会议记忆**（设备端，macOS）：Granola 式转写，支持自动识别、系统音频采集，以及由 DeepSeek 蒸馏、agent 可检索的纪要
- 新建 / 切换 / 重命名 / 归档 / 删除对话（元数据存于 SQLite）
- 中断进行中的运行 · 通过 `switch_session` 在多对话间共享同一个 pi RPC 子进程
- pi 二进制以 Tauri sidecar 形式打包 —— 终端用户无需依赖 PATH
- **底层 any-model**：pi 原生支持 30+ 供应商（Anthropic、OpenAI、Google、Bedrock、Ollama、LM Studio、OpenRouter…）及任意 OpenAI 兼容端点。当前 UI 仅暴露 DeepSeek；在 `model-picker.tsx` 里改一行即可切换模型。

## 环境要求

- **Node** ≥ 20、**pnpm**、**bun**（用于构建 pi sidecar 二进制）
- **Rust** stable（`rustc`、`cargo`）
- **Tauri** 前置依赖：<https://v2.tauri.app/start/prerequisites/>
- 一个 **`DEEPSEEK_API_KEY`**（或你选用的供应商；pi 会自动读取 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等）

## 首次配置

```bash
pnpm install
# 把 pi 构建为单文件二进制，输出到 src-tauri/binaries/pi-<target>。
# 约 30 秒。每台开发机跑一次即可；二进制已被 gitignore。
./scripts/build-pi-sidecar.sh
```

## 开发运行

```bash
export DEEPSEEK_API_KEY=sk-...
pnpm tauri dev
```

Tauri 会启动 Next.js 开发服务器（端口 3000）并打开一个指向它的窗口。pi sidecar 会从打包好的二进制自动派生。

### 开发后门：`PI_BIN`

如果你在迭代 pi 本身，可以指向任意 pi 构建以绕过 sidecar：

```bash
export PI_BIN=/absolute/path/to/your/pi
pnpm tauri dev
```

这会完全跳过 `tauri-plugin-shell`，改用原始的 `tokio::process::Command`。

## 构建

```bash
./scripts/build-pi-sidecar.sh   # 如果还没跑过
pnpm tauri build
```

在 macOS 上输出 `.app` / `.dmg`。`tauri build` 需要一套真实的多尺寸图标（我们在 `src-tauri/icons/` 下附了占位图标）。

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
- **Extension UI**：当某个 pi extension 调用 `ctx.ui.select()` 等，pi 会通过事件流发出 `extension_ui_request`。前端 `DialogHost` 渲染一个对话框，并通过 `extension_ui_respond` Tauri 命令回复。

## 许可证

MIT（与 pi 一致）。
