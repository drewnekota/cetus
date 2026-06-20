# Cetus 新人上手指南

> 最后更新：2026-06-01 · 对应 commit `2bf3337`

本文档面向第一次接触 Cetus 仓库的开发者，帮助你快速理解项目结构、核心数据流，以及从哪里开始贡献代码。

---

## 目录

1. [项目概览](#1-项目概览)
2. [架构总览](#2-架构总览)
3. [关键数据流：一条用户消息从输入到出结果](#3-关键数据流一条用户消息从输入到出结果)
4. [开发环境搭建](#4-开发环境搭建)
5. [3 个最适合新人上手的 Good-First-Issue](#5-3-个最适合新人上手的-good-first-issue)

---

## 1. 项目概览

**Cetus**（Key of the Twilight）是一个 macOS 桌面 AI Agent，利用 DeepSeek V4 的极致性价比，把屏幕感知、记忆、工具执行、自动化调度整合成一个本地原生应用。

| 维度 | 技术选型 |
| --- | --- |
| **桌面壳** | Tauri v2（Rust 后端 + WebView 前端） |
| **前端** | Next.js 16（静态导出 / SSG），React 19，Tailwind v4，Zustand |
| **后端** | Rust + Tokio 异步运行时 |
| **AI 引擎** | 内嵌 **pi**（`@earendil-works/pi-coding-agent`），以 `--mode rpc` 子进程运行，通过 stdin/stdout JSONL 通信 |
| **本地存储** | SQLite（对话元数据 + 截屏索引 + 应用设置），JSON 文件（跨进程 Memory），macOS Keychain（API 密钥） |
| **包管理** | pnpm（全项目统一） |

**核心公式**：`agent = context × intelligence × abilities` —— 三个因子相乘，最弱的一项决定了整体天花板。Cetus 的选择是在 intelligence（DeepSeek V4）已经够强够便宜的前提下，把资源投入到 context（屏幕感知、Memory）和 abilities（工具、技能、自动化）上。

---

## 2. 架构总览

```
┌─────────────────────────────── Tauri 窗口 ────────────────────────────────┐
│                                                                            │
│  Next.js 前端 (React 19, static export)                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  page.tsx — 应用主入口，路由到 Chat / Board / Automations / Settings │ │
│  │  ├─ components/chat/    聊天界面（气泡、thinking、tool cards）       │ │
│  │  ├─ components/board/   Kanban 看板（In progress / Needs review / …）│ │
│  │  ├─ components/automation/  自动化定时任务管理                        │ │
│  │  ├─ components/settings/    设置页                                    │ │
│  │  ├─ components/quick/       全局启动器 (double-⌘)                     │ │
│  │  ├─ components/extension-ui/ 扩展 UI（pi 扩展触发的对话框）           │ │
│  │  └─ components/sidebar/     侧边栏（对话列表、视图切换）              │ │
│  │                                                                       │ │
│  │  lib/                                                                 │ │
│  │  ├─ chat-state.ts    Reducer：pi 流事件 → RenderedMessage[]          │ │
│  │  ├─ chat-store.ts    Zustand store（按 messageKey 精准重渲染）       │ │
│  │  ├─ tauri.ts         Tauri invoke 封装（api.*）                      │ │
│  │  ├─ types.ts         共享类型定义                                    │ │
│  │  ├─ i18n/            国际化（10 语言，按功能拆分消息文件）            │ │
│  │  └─ ...              附件、通知、markdown 渲染等                     │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                    │ Tauri invoke / event                    │
│                                    ▼                                        │
│  Rust 后端 (Tokio 异步)                                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  lib.rs              AppState、pi 进程池、窗口生命周期、启动逻辑    │ │
│  │  commands.rs         Tauri commands（前端 invoke 的入口）            │ │
│  │  pi_rpc.rs           pi --mode rpc 子进程封装（spawn/send/receive）  │ │
│  │  store.rs            SQLite 元数据存储（对话、截屏、应用设置）        │ │
│  │  agent.rs            浏览器/电脑控制设置 + host-tunnel handler        │ │
│  │  ultra.rs            Ultra Code 模式设置                             │ │
│  │  run_engine.rs       Ultra 子 Agent 编排引擎（并发池 + 结果注册表）   │ │
│  │  scheduler.rs        自动化定时任务调度器（20s 间隔 tick）            │ │
│  │  memory.rs           跨进程 Memory（JSON 文件, 原子写入）             │ │
│  │  ocr.rs              Apple Vision OCR（Swift 辅助程序）              │ │
│  │  capture.rs          屏幕定期截取（感知哈希去重 + OCR 索引）          │ │
│  │  voice.rs            语音输入（macOS 语音识别）                       │ │
│  │  cua.rs              Computer-Use Agent（macOS AX API）               │ │
│  │  quick.rs            全局启动器设置 + 截屏                            │ │
│  │  secrets.rs          macOS Keychain 操作                              │ │
│  │  mcp.rs              MCP 连接器（本地命令或远程 URL）                 │ │
│  │  skills.rs           技能（SKILL.md）管理                             │ │
│  │  titling.rs          对话自动标题（DeepSeek 生成）                    │ │
│  │  dream.rs            Dreaming（空闲时反思并整合 Memory）              │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                    │ stdin/stdout (JSONL, LF 分隔)           │
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  pi --mode rpc 子进程 (Bun 运行时)                                   │ │
│  │  └─ cetus-extensions/  (自定义扩展，部署到 pi-install 目录)           │ │
│  │     ├─ browser-use.ts      浏览器自动化                               │ │
│  │     ├─ computer-use.ts     桌面自动化（macOS）                        │ │
│  │     ├─ vision-bridge.ts    视觉 / 图片处理                            │ │
│  │     ├─ web-search.ts       网络搜索                                   │ │
│  │     ├─ ultra-runtime.ts    Ultra Code 工作流引擎                      │ │
│  │     ├─ emit-result.ts      子 Agent 结果上报                          │ │
│  │     ├─ mcp-bridge.ts       MCP 协议桥接                               │ │
│  │     ├─ automation-tools.ts 自动化管理工具                             │ │
│  │     └─ dictation-recall.ts 语音输入历史查询                           │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 前端模块（`src/`）

| 模块 | 路径 | 职责 |
| --- | --- | --- |
| **应用入口** | `src/app/page.tsx` | 顶层路由：根据 sidebar 选择的视图渲染 Chat / Board / Automations / Settings / ScreenHistory。同时是 `app-event` 事件流的中央消费者，将 pi 事件分发给当前活跃对话的 reducer。 |
| **聊天界面** | `src/components/chat/` | 消息气泡（Markdown 渲染 + 代码高亮）、thinking 折叠块、tool-use 卡片（参数 + 结果 + 错误高亮）、agent-control 卡片（浏览器/桌面操作直播）、附件/artifacts 面板。 |
| **聊天状态** | `src/lib/chat-state.ts` | 纯函数 reducer：将 pi 的流式 JSON 事件（`agent_start`、`message_update`、`tool_execution_start` 等）折叠为稳定的 `RenderedMessage[]` 数组，按 `contentIndex` 索引块，用 `toolCallId → block` 侧表快速路由工具执行更新。 |
| **聊天 Store** | `src/lib/chat-store.ts` | Zustand store 封装 reducer，支持按 `(convId, messageKey)` 精准订阅（流式 token 更新只重渲染当前气泡，不重渲整个列表）。附带 IndexedDB 缓存，启动时秒开上次会话。 |
| **看板** | `src/components/board/` | Kanban 三列视图（In progress / Needs review / Done），卡片 = 一次对话。支持侧-by-side 比较 Ultra Code 的并行候选方案。 |
| **自动化** | `src/components/automation/` | 定时任务管理：cron / every / daily / at 四种调度模式，每次触发生成一条新的后台对话。 |
| **全局启动器** | `src/components/quick/` | double-⌘ 唤出的浮动面板：非激活 NSPanel，自动附带当前屏幕截屏。 |
| **设置** | `src/components/settings/` | 左侧分组导航（Intelligence / Input & Capture / App），管理 API Keys、Memory、Dreaming、Skills、Connectors、Voice、Screen Context、Appearance 等。 |
| **i18n** | `src/lib/i18n/` | 10 种语言（zh-CN、en、ja、ko 等），按功能拆分为独立消息文件（`chat.ts`、`settings.ts`、`board.ts` 等），支持系统默认 + 应用内切换。 |

### 2.2 Rust 后端模块（`src-tauri/src/`）

| 模块 | 职责 |
| --- | --- |
| **`lib.rs`** | 应用启动入口。初始化 SQLite、pi 安装树、各子系统（scheduler、dreamer、capture、hotkey、MCP、skills、agent-control），管理 `AppState`（pi 进程池、store、inflight 去重集）。关闭窗口仅隐藏（保持后台运行）。 |
| **`commands.rs`** | 所有 Tauri command 处理器：对话 CRUD、sendPrompt、abort、retry、auto-title、API key 管理、文件读写、automation CRUD、screen capture 设置、主题切换等。前端通过 `invoke()` 调用。 |
| **`pi_rpc.rs`** | pi 子进程的生命周期管理：spawn（cwd 设为 pi-install 目录、注入 env、可选 Ultra/agent 系统提示词）、JSON-RPC 请求/响应（`send_prompt`、`switch_session`、`get_messages`、`abort` 等）、stdout 流读取（严格 LF JSONL 分割，不依赖 Node readline）。定义了所有 `AppEvent` 类型和 sentinel title 常量。 |
| **`store.rs`** | SQLite 封装：conversations 表（id、title、session_file、workspace_dir、model、timestamps、review_state 等）、screenshots 表（OCR 文本 + 感知哈希索引）、app_settings 键值表。Schema 版本管理，大版本变更自动重建。 |
| **`agent.rs`** | 浏览器/电脑控制的两层 gate：设置持久化 + env 标记导出（`CETUS_BROWSER_USE` / `CETUS_COMPUTER_USE`），host-tunnel handler（接收 pi 扩展的 `agent_control_request` 事件，分发给 cua.rs 执行或推向 UI 直播）。 |
| **`scheduler.rs`** | 后台定时器（20s tick）：扫描 `next_run_at` 到期的 automation → 创建新对话 → spawn pi → 发送 prompt → 更新调度状态。与手动触发共享 `inflight` 去重集。 |
| **`ultra.rs`** + **`run_engine.rs`** | Ultra Code 模式：模型编写 JS workflow → `run_workflow` 工具在 pi 的 Bun 运行时执行 → `agent()` 原语通过 sentinel title 隧穿回 Rust host → `run_agent_node` 创建子 Agent（独立 pi 子进程、独立 Conversation）→ 子 Agent 通过 `emit_node_result` 工具上报结果 → host 的 `app-event` 监听器 resolve pending oneshot。 |
| **`memory.rs`** | 跨进程 Memory 存储（JSON 文件 + 原子写入 rename）。pi 扩展和 Rust 后端共享同一文件（通过 `CETUS_MEMORY_PATH` env），每个 turn 前注入到系统提示词。 |
| **`ocr.rs`** + **`capture.rs`** | 屏幕上下文：定期截图（感知哈希去重）→ 调 Apple Vision OCR（Swift 辅助程序，首次使用时 `swiftc` 编译）→ 存入 SQLite + 磁盘 → 前端可按文本/时间/应用搜索。 |
| **`voice.rs`** | 语音输入：macOS 语音识别 + Swift 辅助程序。支持应用内和全局 push-to-talk。 |
| **`cua.rs`** | Computer-Use Agent：通过 macOS Accessibility API（`cetus-cua-helper.swift`）dump 元素树、执行点击/键入等操作。支持 OCR 降级（AX-blind 应用如 Chrome）。 |
| **`secrets.rs`** | macOS Keychain 操作：存储/读取/删除 DeepSeek、Groq、Tavily 等 API 密钥。密钥变更时 recycle 所有 pi 子进程以应用新 env。 |
| **`mcp.rs`** | MCP 连接器管理：本地命令或远程 URL。`mcp-bridge.ts` 扩展通过 mcporter 读取配置并注册工具。 |

### 2.3 pi 扩展层（`src-tauri/cetus-extensions/`）

这些是 TypeScript 文件，在构建时被拷贝到 `<app_data>/pi-install/cetus-extensions/`，由 pi 的 Bun 运行时加载执行。它们通过 pi 的扩展 API 注册工具、hook 生命周期事件，并通过 sentinel `ctx.ui.input` title 与 Rust host 通信。

| 扩展 | 功能 |
| --- | --- |
| `browser-use.ts`（~50KB）| 浏览器自动化工具集：`browser_open`、`browser_observe`、`browser_click`、`browser_type` 等，通过 numbered element list 操作（非像素坐标）。 |
| `computer-use.ts`（~25KB）| 桌面自动化工具集：`computer_observe`、`computer_click`、`computer_type` 等，通过 macOS AX API 操作。 |
| `ultra-runtime.ts` | Ultra Code JS workflow 运行时：提供 `Cetus` 全局（`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`），在 pi 的 Bun 中执行模型编写的脚本。 |
| `emit-result.ts` | 子 Agent 结果上报：`emit_node_result` 工具，将结构化结果通过 `app-event` 发送回 host。 |
| `vision-bridge.ts` | 视觉桥接：处理图片输入，调用 Gemini 视觉模型生成描述。 |
| `web-search.ts` | 网络搜索：`web_search` 和 `web_fetch` 工具（Tavily / DDG）。 |
| `mcp-bridge.ts` | MCP 协议桥接：读取 `CETUS_MCP_CONFIG`，通过 mcporter 连接各 MCP server 并注册其工具。 |
| `automation-tools.ts` | 自动化管理：让 Agent 能读取/修改自身的 Automation 配置。 |
| `dictation-recall.ts` | 语音历史：让 Agent 能查询用户的语音输入历史。 |

---

## 3. 关键数据流：一条用户消息从输入到出结果

以下追踪一条用户消息从键入到 Agent 回复渲染完成的完整路径——这是理解整个系统最核心的 "happy path"。

### 阶段一：前端发送

```
用户在 Composer 输入 → 按 Enter
  │
  ├─ page.tsx 的 handleSend():
  │   1. 拼接附件引用（read_document 路径块）
  │   2. chatStore.userSent(convId, text, images, files)
  │      → chatReducer 追加一条 role="user" 的 RenderedMessage
  │      → UI 立即渲染用户气泡（乐观更新）
  │   3. chatStore.piEvent(convId, { type: "stream_start" })
  │      → reducer 设置 isStreaming=true, awaitingAssistant=true
  │      → UI 显示 "thinking…" 占位符
  │   4. await api.sendPrompt(convId, piMessage, piImages)
  │      → Tauri invoke("send_prompt", { id, message, images })
  │
  ▼
```

### 阶段二：Rust 后端接收与转发

```
commands::send_prompt() 被调用
  │
  ├─ state.pi_for(&id).await
  │   ├─ 检查 pi 进程池：若该 conv 尚无 pi 子进程 → spawn
  │   │   ├─ pi_rpc::PiRpc::spawn()
  │   │   │   ├─ 计算 cwd = <app_data>/pi-install/
  │   │   │   ├─ 加载 env (DEEPSEEK_API_KEY 等，从 Keychain)
  │   │   │   ├─ 拼接系统提示词（Cetus 身份 + 产品指南 + 可选 Ultra/Agent）
  │   │   │   ├─ 启动 tokio::process::Command("pi", ["--mode", "rpc"])
  │   │   │   ├─ 启动 stdout 读取循环（BufReader, 按 \n 分割 JSONL）
  │   │   │   └─ 等待 pi 的 ready 信号
  │   │   ├─ 新对话：pi.new_session() → 创建 .jsonl session 文件
  │   │   └─ 已有对话：pi.switch_session(session_file) → 恢复历史
  │   └─ pi.apply_choice(model) → 推送模型选择
  │
  ├─ pi.send_prompt(&message, images).await
  │   ├─ 构造 JSON-RPC 请求：{ "jsonrpc": "2.0", "method": "sendPrompt", ... }
  │   ├─ 写入 pi stdin（一行 JSON + \n）
  │   └─ 等待 JSON-RPC 响应（ack，表示 pi 已接收）
  │
  ├─ state.store.touch(&id, now) → 更新 updated_at
  └─ 若首次发送 → spawn_auto_title() 后台任务
```

### 阶段三：pi 子进程处理

```
pi --mode rpc 处理流程（不在此仓库，但关键行为如下）：
  │
  ├─ 解析 sendPrompt 请求
  ├─ 加载 provider (DeepSeek)、模型 (v4-flash/v4-pro)、工具、skills、memory
  ├─ 构造消息列表（系统提示词 + Memory + 历史消息 + 当前用户消息）
  ├─ 调用 DeepSeek API（支持流式）
  └─ 流式输出 JSONL 事件到 stdout：
      │
      ├─ { "type": "agent_start", "entryId": "..." }
      ├─ { "type": "message_update", "entryId": "...",
      │    "event": { "type": "assistantMessageEvent",
      │                "contentIndex": 0, "delta": { "type": "textDelta", "text": "你好" } } }
      ├─ ... 更多 textDelta ...
      ├─ { "type": "message_update", ... "delta": { "type": "thinkingDelta", ... } }
      ├─ { "type": "tool_execution_start", "toolCallId": "...", "name": "read", ... }
      ├─ { "type": "tool_execution_update", "toolCallId": "...", "result": "..." }
      ├─ { "type": "extension_ui_request", ... }  ← 如 pi 扩展调用 ctx.ui.select()
      ├─ { "type": "agent_end", "entryId": "..." }
      └─ ...
```

### 阶段四：Rust 后端解析与路由

```
pi_rpc.rs 的 stdout 读取循环（read_loop）：
  │
  ├─ BufReader 逐行读取，按 \n 分割 JSONL
  ├─ 每行解析为 serde_json::Value
  ├─ dispatch_line() 分发：
  │   │
  │   ├─ 大多数事件 → 包裹为 AppEvent::PiEvent { conversation_id, event }
  │   │   └─ app_handle.emit("app-event", app_event)
  │   │       → Tauri 全局事件，前端 page.tsx 的监听器收到
  │   │
  │   ├─ 特定 sentinel title（Ultra agent / Agent step / CUA）→ 路由到 Rust handler
  │   │   ├─ __cetus_ultra_agent__ → ultra.rs → run_engine.rs 启动子 Agent
  │   │   ├─ __cetus_agent_step__ → agent.rs → 推送到前端 AgentControlCard
  │   │   └─ __cetus_cua_request__ → agent.rs → cua.rs 执行 AX 操作
  │   │
  │   └─ extension_ui_request → 包裹为 AppEvent::ExtensionUIRequest
  │       └─ 前端 DialogHost 渲染对话框
  │
  ├─ agent_end → 触发 auto-title（若尚未生成）
  └─ pi_exited → 清理
```

### 阶段五：前端渲染

```
page.tsx 的 app-event 监听器：
  │
  ├─ 过滤：仅处理 conversationId 匹配当前活跃对话的事件
  ├─ 对 PiEvent：chatStore.piEvent(convId, event)
  │   │
  │   ├─ chatReducer 处理各事件类型：
  │   │   ├─ agent_start → 清空之前的 assistant 消息，设置 awaitingAssistant=false
  │   │   ├─ message_update.assistantMessageEvent { contentIndex, delta }
  │   │   │   ├─ textDelta → 追加文本到 blocks[contentIndex].text
  │   │   │   ├─ thinkingDelta → 追加到 blocks[contentIndex].thinking
  │   │   │   └─ toolCallDelta → 创建新的 tool_use block
  │   │   ├─ tool_execution_start → 设置 tool block 的 status: "running"
  │   │   ├─ tool_execution_update → 追加 args / result，设置 status: "done"
  │   │   ├─ tool_execution_error → 设置 error 字段
  │   │   └─ agent_end → isStreaming=false
  │   │
  │   └─ Zustand store 更新 → React 重渲染
  │       └─ 由于按 messageKey 精准订阅，只重渲染当前活跃的 assistant 气泡
  │
  ├─ 对 AgentStep（浏览器/桌面操作直播）：
  │   └─ 推送到 AgentControlCard 组件（截屏 + 操作摘要）
  │
  └─ 对 ExtensionUIRequest（如 send_artifact 确认）：
      └─ DialogHost 渲染对话框，用户操作后通过 extension_ui_respond 回复
```

### 数据流全景图

```
用户键入 ──→ React Composer ──→ Tauri invoke ──→ Rust commands.rs
                                                      │
                                                   pi_for() (lazy spawn)
                                                      │
                                                   pi_rpc.rs (stdin JSON-RPC)
                                                      │
                                                      ▼
                                            pi --mode rpc 子进程
                                            (DeepSeek API 调用 + 工具执行)
                                                      │
                                                   stdout JSONL
                                                      │
                                                      ▼
                                            pi_rpc.rs (read_loop + dispatch)
                                                   ╱        ╲
                                                  ╱          ╲
                                     Tauri app-event      Rust handlers
                                           │              (Ultra / Agent / CUA)
                                           ▼
                                     page.tsx 监听器
                                           │
                                     chatReducer (Zustand)
                                           │
                                           ▼
                                     React 重渲染
                                  (text/thinking/tool cards)
```

---

## 4. 开发环境搭建

### 前置条件

- **Node** ≥ 20，**pnpm**（`npm i -g pnpm`），**bun**（构建 pi sidecar）
- **Rust** stable（`rustup` 安装）
- **Tauri 前提**：https://v2.tauri.app/start/prerequisites/（macOS 需要 Xcode Command Line Tools）
- **DEEPSEEK_API_KEY**（核心功能必需）

### 首次启动

```bash
cd ~/Developer/cetus

# 安装前端依赖
pnpm install

# 构建 pi sidecar 二进制（约 30 秒，只需执行一次）
./scripts/build-pi-sidecar.sh

# 启动开发环境
export DEEPSEEK_API_KEY=sk-...
pnpm tauri dev
```

Tauri 会自动启动 Next.js dev server（端口 17381）并打开窗口。

### 开发技巧

- **迭代 pi 本身**：设置 `PI_BIN=/absolute/path/to/your/pi`，绕过 sidecar 直接用你的 pi 构建。
- **迭代 pi 扩展**：修改 `src-tauri/cetus-extensions/*.ts` 后重启应用，`lib.rs` 中的 `sync_cetus_extensions()` 会自动将新文件拷贝到 pi-install 目录。
- **Devtest 模式**（评估/调试用）：`NEXT_PUBLIC_CETUS_DEVTEST=1 CETUS_DEVTEST=1 pnpm tauri dev --features devtest`，详见 `docs/devtest-bridge.md`。
- **前端热更新**：Next.js 的 Fast Refresh 正常工作，修改 `src/` 下文件立即生效。
- **Rust 热重载**：Tauri dev 模式下修改 Rust 代码后会自动重编译并重启应用。

### 关键文件路径（运行时）

| 用途 | 路径 |
| --- | --- |
| pi 安装树 | `<app_data>/pi-install/` |
| pi 二进制 | `<app_data>/pi-install/pi` |
| 对话 session 文件 | `<app_data>/sessions/<id>.jsonl` |
| SQLite 数据库 | `<app_data>/pi-desktop.db` |
| Memory 文件 | `<app_data>/memory.json` |
| 截屏存储 | `<app_data>/screenshots/` |
| 用户附件 | `<app_data>/attachments/<conv_id>/` |
| 默认工作区 | `~/cetus/` |
| MCP 配置 | `<app_data>/mcp-config.json` |

> `<app_data>` 在 macOS 上通常为 `~/Library/Application Support/dev.cetus.app/`

---

## 5. 3 个最适合新人上手的 Good-First-Issue

### Issue ①：增强 `derive_title` 的 Markdown 清理能力

**位置**：`src-tauri/src/commands.rs:derive_title()`（约第 340 行）

**当前代码**：
```rust
pub(crate) fn derive_title(prompt: &str) -> String {
    let first_line = prompt.lines().next().unwrap_or("").trim();
    let title: String = first_line.chars().take(60).collect();
    if first_line.chars().count() > 60 {
        format!("{title}…")
    } else {
        title
    }
}
```

**为什么适合新人**：
- 这是一个纯函数，无状态、无异步、无外部依赖。
- 输入输出明确，容易写单元测试。
- 只改 Rust 一个文件，不需要理解 Tauri 或 pi 通信机制。
- 但能直接改善用户体验——当你输 `## 帮我分析一下` 时，标题不会再是 `## 帮我分析一下` 而是 `帮我分析一下`。

**建议改进内容**：
1. 去除行首的 Markdown 标题标记（`#`、`##` 等）
2. 去除行首的列表标记（`-`、`*`、`1.` 等）
3. 去除常见的 prompt 前缀（如 `/code`、`@`）
4. 若去除后为空字符串，回退到原 first_line
5. 添加单元测试覆盖以上场景

**涉及技能**：Rust 基础语法、字符串处理、单元测试

---

### Issue ②：为聊天消息添加一键复制按钮

**位置**：`src/components/chat/message-bubble.tsx`

**为什么适合新人**：
- 这是一个纯前端 React 组件改进，不需要理解后端或 pi 通信。
- 功能边界清晰：在消息气泡的右上角（hover 时出现）加一个复制按钮，点击后把消息的全部文本内容写入剪贴板。
- 可以立即在浏览器中预览效果（Next.js dev server）。
- React 19 + Tailwind v4 的技术栈在社区中有丰富的参考资源。
- Copy-to-clipboard 是标准的 UI 模式，实现路径非常成熟。

**建议实现**：
1. 在 `message-bubble.tsx` 中给 assitant 消息气泡添加一个 hover 可见的按钮（`lucide-react` 中有 `Copy` / `Check` 图标）
2. 使用 `navigator.clipboard.writeText()` 写入文本（从 `RenderedMessage.blocks` 中提取纯文本）
3. 点击后按钮短暂切换为 ✓ 表示已复制（1.5 秒后恢复）
4. 用户消息的气泡也加上同样的按钮（可选）
5. 处理 tool_use 和 thinking 块中的文本提取

**涉及技能**：React、Tailwind CSS、Clipboard API

---

### Issue ③：为 Skills 系统添加一个内置示例 Skill

**位置**：`src-tauri/src/skills.rs` + 新建 `SKILL.md` 文件

**当前状态**：Skills 基础设施已完成（CRUD、启用/禁用、导入/创建、pi 自动发现），但目前没有预置的内置 Skill 供用户参考。

**为什么适合新人**：
- 主要是内容创作（写一个高质量的 SKILL.md 文件），搭配少量 Rust 代码将示例自动导入。
- 可以深入了解 Cetus 的 Skills 机制——这对后续开发很有价值。
- 产物是一个独立文件，评审和迭代都很快。
- 影响力大：一个好的内置 Skill 会被所有用户看到和使用。

**建议方案（任选其一）**：
- **方案 A：「Git 提交信息生成器」** —— 让 Agent 根据暂存区 diff 自动生成 conventional commits 格式的提交信息。
- **方案 B：「代码审查助手」** —— 指导 Agent 按照特定检查清单审查 PR diff。
- **方案 C：「每日站报模板」** —— 让 Agent 根据今天的日程和任务生成标准化的每日工作报告。

**SKILL.md 结构参考**：
```markdown
# Skill Name
简短描述

## When to use
触发条件（Agent 看到什么关键词会激活此 skill）

## Instructions
对 Agent 的详细指令

## References（可选）
引用的辅助文件
```

**涉及技能**：Markdown 写作、对 AI Agent 行为的设计思维、少量 Rust（在 `skills.rs` 中添加自动导入逻辑或修改 `resync_active_dir`）

---

## 附录：额外资源

| 资源 | 路径 |
| --- | --- |
| README（英文） | `README.md` |
| README（中文） | `README.zh-CN.md` |
| Devtest 桥接文档 | `docs/devtest-bridge.md` |
| E2E 测试计划 | `docs/e2e-test-plan.md` |
| 构建 pi sidecar | `scripts/build-pi-sidecar.sh` |
| Devtest CLI | `scripts/cetus-devtest.mjs` |
