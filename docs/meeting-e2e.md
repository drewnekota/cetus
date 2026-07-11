# 会议听写端到端测试

这份测试覆盖真实的 macOS 音频采集、云端/本地 ASR、实时逐字稿、停止保存和会后纪要，不使用伪造的前端数据。

## 准备

- macOS 14.2 或更高版本（系统音频采集需要）。
- 在“系统设置 → 隐私与安全性”中允许 Cetus 使用麦克风、语音识别和系统音频录制。
- 若要测云端高精度路径，在 Cetus“设置 → API Keys”配置豆包密钥。没有密钥时，“自动”会降级到 Apple 本地识别。
- 测试真实会议前先取得参会者同意。

开发版启动命令：

```bash
pnpm app
```

首次启动会编译会议采集 helper，等待终端出现 `devtest UDS bridge listening` 后再操作。

## 手动测试（推荐）

1. 打开“设置 → Meetings/会议”，启用“会议记忆”。
2. 暂时关闭“自动开始”，避免 Zoom、微信等正在占用麦克风的应用干扰手动用例。
3. “转写质量”选择“自动 · 最佳可用”，点击“立即开始记录”。
4. 确认顶部状态是“手动会话”，并显示以下之一：
   - `SeedASR 云端`：已配置豆包密钥；
   - `Apple 本地`：没有密钥或选择了“仅本地”。
5. 自己对麦克风说一句：“Cetus 会议测试，Alice 周五前准备发布说明。”
6. 在另一个应用播放一段清晰人声（浏览器视频、Zoom 测试会议均可）。
7. 在实时逐字稿中确认：
   - 麦克风内容显示为绿色右侧气泡“我”；
   - 系统音频显示为灰色左侧气泡“对方”；
   - 时间、段数持续更新；
   - 搜索和“复制全部”可用。
8. 点击“停止并保存”。确认实时面板消失，最近会议出现新记录。
9. 展开记录，确认纪要和完整逐字稿存在。配置了 DeepSeek 且文本超过 200 字时，还应生成标题、要点、决定和待办。

## 本地降级测试

1. 将“转写质量”改为“仅本地”。
2. 开始新会话，确认状态显示 `Apple 本地`。
3. 重复麦克风与系统音频用例，然后停止保存。
4. 此路径不发送音频到云端；仍然只保存文本。

## 自动开始/停止测试

1. 打开“自动开始”。
2. 加入 Zoom、Teams、FaceTime、飞书或微信通话。
3. 持续占用麦克风约 6–10 秒后，Cetus 应自动开始，状态显示触发应用。
4. 结束通话。应用释放麦克风约 30 秒后，Cetus 应自动停止并保存。
5. 若两个会议无缝衔接且通话应用一直占用麦克风，请手动停止以免两场会议合并。

## 开发版 DOM 冒烟测试

`pnpm app` 已启用仅开发环境存在的 Unix socket 测试桥。另开终端执行：

```bash
node scripts/cetus-devtest.mjs ping
node scripts/cetus-devtest.mjs dom --op eval --js 'Array.from(document.querySelectorAll("button")).find(b=>b.textContent?.trim()==="Settings")?.click()'
node scripts/cetus-devtest.mjs click --selector '[data-testid="nav-meetings"]'
node scripts/cetus-devtest.mjs getText --selector main
```

开始说话后，可以用下面的断言检查真实链路：

```bash
node scripts/cetus-devtest.mjs dom --op eval --js '({recording:Array.from(document.querySelectorAll("button")).some(b=>b.textContent?.includes("Stop & save")||b.textContent?.includes("停止并保存")),hasTranscript:Boolean(document.querySelector("input[placeholder=\"Search transcript\"],input[placeholder=\"搜索逐字稿\"]")),text:document.querySelector("main")?.innerText.slice(0,800)})'
```

代码级回归检查：

```bash
pnpm lint
swiftc -typecheck -framework Speech -framework AVFoundation -framework CoreAudio -framework AudioToolbox src-tauri/meeting/cetus-meeting-helper.swift
cargo check --manifest-path src-tauri/Cargo.toml
```

## 常见问题

- 一直没有“对方”：确认 macOS 14.2+，并在系统设置里给 Cetus 系统音频录制权限；蓝牙或聚合音频设备切换后重新开始一次。
- 一直没有“我”：检查麦克风权限和输入音量；耳机可减少扬声器回声被重复识别。
- “自动”仍显示 Apple 本地：豆包密钥未配置或不可读；到 API Keys 重新保存。
- 第一次开始慢：首次会编译 Swift helper，并初始化 CoreAudio tap；后续会复用已编译 helper。
- 自动开始误触发：关闭“自动开始”做手动测试，并检查是否有通话应用长期占用麦克风。
