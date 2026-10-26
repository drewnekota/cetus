<p align="center"><img src="docs/logo.png" width="120" alt="Cetus logo" /></p>

<h1 align="center">Human in the loop is the bottleneck.</h1>

<p align="center"><strong>Cetus</strong> 是一个桌面客户端，用来审阅和管理你在用的所有 agent 的工作 —— Claude Code、Codex、DeepSeek Harness、OpenCode、Grok Build、Kimi CLI，或内置 runtime。</p>

<p align="center"><a href="https://cetus.run">官方网站 · cetus.run</a></p>

<p align="center">
  <a href="https://github.com/drewnekota/cetus/releases/latest/download/Cetus.dmg"><img alt="下载 Cetus macOS 版" src="https://img.shields.io/badge/下载-Cetus-111111?style=for-the-badge&logo=apple" /></a>
  <a href="https://github.com/drewnekota/cetus/releases/download/swift/Cetus-Swift.dmg"><img alt="下载 Cetus Swift (Beta) macOS 版" src="https://img.shields.io/badge/下载-Cetus_Swift_(Beta)-F05138?style=for-the-badge&logo=swift&logoColor=white" /></a>
</p>

<p align="center">
  <a href="https://github.com/drewnekota/cetus/releases/latest"><img alt="最新版本" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fdrewnekota%2Fcetus%2Fmain%2Fsrc-tauri%2Ftauri.conf.json&query=%24.version&prefix=v&label=release&color=blue" /></a>
  <a href="https://github.com/drewnekota/cetus/releases"><img alt="下载量" src="https://img.shields.io/github/downloads/drewnekota/cetus/total" /></a>
  <a href="https://github.com/drewnekota/cetus/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/drewnekota/cetus/ci.yml" /></a>
  <a href="https://github.com/drewnekota/cetus/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/drewnekota/cetus" /></a>
  <a href="LICENSE"><img alt="MIT 协议" src="https://img.shields.io/github/license/drewnekota/cetus" /></a>
</p>

<p align="center"><a href="./README.md">English</a> · <strong>简体中文</strong></p>

![Cetus 操作演示 —— 唤起 agent、创建自动化任务并切换 runtime](docs/cetus-demo.gif)

## 社区

⭐️ 给仓库点个 Star，第一时间收到新版本通知。想交流使用体验和建议，欢迎微信扫码加入群聊。

<p align="center"><img src="docs/cetus-community-wechat.jpg" width="280" alt="Cetus 社区微信群二维码" /></p>

<details>
<summary>友情链接</summary>

- [LINUX DO](https://linux.do) —— 有理想的新社区。

</details>

## 为什么做 Cetus

agent 已经不是慢的那一环了。Claude Code、Codex、DeepSeek Harness 都能自己连续干一个小时。真正拖慢它们的，是它们在等的那个人：一个权限请求、一个澄清问题、一个做完了却还没人审阅的任务。

而这个人通常同时在用好几个产品：Claude Code 开一个窗口，Codex 开另一个，定时任务各自在不同的客户端里汇报结果。每切换一次都要消耗注意力；agent 在等你而你没注意到的每一分钟，它都在空转。

也有像 Superset 这样把不同 runtime 放到一起的工具，但它是 TUI。终端很适合 agent 运行，却不适合人阅读：所有内容都是等宽文字，计划、diff 和提问看起来都差不多，滚出屏幕就找不回来了。

Cetus 是为环里"人"这一侧做的：一个真正的桌面 app，让每个 agent 的工作都容易读、容易回应、容易审阅。

## 一个客户端，接住所有 runtime

![Cetus runtime 选择器 —— Claude Code、Codex、DeepSeek Harness、OpenCode、Grok Build、Kimi CLI 都在同一个 macOS app 里](docs/screenshot-runtime-picker.png)

- **所有 runtime 在一个窗口里。** 直接用你已经装好、登录好的 CLI。Cetus 复用它的登录、模型和工具，不用再配第二个账号。
- **在一个地方响应。** 任何 runtime 的权限请求、提问和计划，都以卡片形式出现在对话里。turn 还在跑也能插话引导，或者把下一条消息排进队列。
- **在一块看板上审阅。** 每个对话都是 **进行中 · 待审阅 · 已完成** 里的一张卡片。做完的工作会等着你，不会在终端里被滚走。
- **并行但不打架。** 每个对话可以有独立的 git worktree，多个 agent 能同时改同一个仓库。

## 围绕同一个环做的能力

Cetus 的其它能力，都是为了缩短你在环里的那一段。

### Threads：一眼看到你所有的会话

一个以工作区为单位的信息流：每发一条消息就开一个独立会话，`@` 哪个 runtime 就用哪个。任意 thread 都能停靠在信息流旁边打开，跟着活动角标就能跳到下一个需要你的会话。

![Cetus Threads 视图](docs/screenshot-threads.png)

### Quick Launcher：一个快捷键，唤起任意 runtime

**同时按住左右 ⌘**，即可在任意 app 之上唤出 agent。Cetus 会把当前截图、前台 app、浏览器 URL 和选中文字作为可移除的 context 一起带进来，让你就地提问，不必切窗口、也不必先解释自己在看什么。

![Cetus 快捷启动器演示](docs/quick-launcher.gif)

### Automations：定时任务也回到同一个地方

把任意 prompt 变成单次或周期任务（`at` / `every` / `cron` / `daily`），可以跑在任意 runtime 上。每次运行都在新的后台对话中完成，结果落到看板上等你审阅，而不是又在另一个客户端里汇报。

![Cetus 自动化任务演示](docs/automation.gif)

### 少解释一点

需要你手动交代的上下文越少，你就越快能离开这个环。

- **屏幕上下文。** Cetus 采集画面、去重，并用 Apple Vision 在本地做 OCR，agent 能回忆屏幕上出现过什么。需手动开启，提供保留时长设置和排除 app 列表。
- **会议记忆。** 通话在本地转写成可搜索的笔记 —— 只存文字，不存音频。问一句"发布日期最后怎么定的？"，agent 就会在本地检索会议历史。默认关闭。
- **听写。** 在任何 app 里按住快捷键说话，Cetus 会把整理好的文字输入到光标所在位置。
- **持久记忆**：你和 agent 都能编辑，会带进之后的对话。

### 还有更多

- **并行方案**：一个 prompt 分出 N 个候选运行，留一个、归档其余
- **Cetus Remote**：可选的手机端伴侣（基于 Tailscale），离开电脑也能跟进运行、处理审批
- **电脑与浏览器控制**：执行任何关键操作前都会确认，停止按钮始终可用
- 内置 runtime 支持 **30+ 模型供应商**，包括 Anthropic、OpenAI、Google、Bedrock、Ollama、LM Studio 和 OpenRouter

所有涉及屏幕、麦克风或其它 app 的能力都需要你手动开启，数据都留在你的 Mac 上。

## 立即使用

Cetus 支持 **Apple Silicon** Mac，同一个 app 有两个版本：

| 版本 | 下载 | 系统要求 |
| --- | --- | --- |
| **Cetus** —— 最早的版本，基于 Tauri | [Cetus.dmg](https://github.com/drewnekota/cetus/releases/latest/download/Cetus.dmg) | macOS 13+ |
| **Cetus Swift**（Beta）—— 原生 SwiftUI 版本，仍在打磨中 | [Cetus-Swift.dmg](https://github.com/drewnekota/cetus/releases/download/swift/Cetus-Swift.dmg) | macOS 15+ |

两个版本都会自动更新。然后：

1. 打开 DMG，把 Cetus 拖进「应用程序」。
2. 使用内置 runtime，或选择一个已安装并登录的 `claude`、`codex` 或 `dsh`（DeepSeek Harness）CLI。
3. 选一个工作区，给 agent 布置第一个任务。

> **早期版本：** Cetus 仍在快速迭代中。遇到问题或缺少某个工作流，欢迎[提 issue](https://github.com/drewnekota/cetus/issues)。

## 许可证

MIT
