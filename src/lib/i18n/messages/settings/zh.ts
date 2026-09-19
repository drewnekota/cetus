export const zh = {
  "appearance.wallpaper.label": "背景图片",
  "appearance.wallpaper.description":
    "上传图片作为首页和聊天背景。支持 JPG、PNG、WebP，最大 20 MB，仅保存在本机。",
  "appearance.wallpaper.preview": "聊天背景预览",
  "appearance.wallpaper.upload": "上传图片",
  "appearance.wallpaper.replace": "更换图片",
  "appearance.wallpaper.remove": "移除",
  "appearance.wallpaper.saving": "保存中…",
  "appearance.wallpaper.fade": "背景淡化",
  "appearance.wallpaper.uploadError":
    "图片保存失败。请选择 20 MB 以内的有效 JPG、PNG 或 WebP 图片，并检查可用存储空间。",
  "appearance.wallpaper.saveError": "背景设置保存失败，请重试。",

  "models.model.reasoningHint":
    "有推理力度参数的模型请打开“推理”，然后勾选端点支持的档位。每个档位默认按档位名发送，也可填 token 覆盖（比如把档位映射到只认 low/medium/high 的端点）。“格式”选你的供应商期望的 effort 字段形态；未启用的档位会自动就近钳制到启用档。",
  "models.model.format": "格式",
  "models.model.reasoning": "推理",
  "nav.models": "模型",
  "models.title": "模型",
  "models.description":
    "添加你自己的 OpenAI 兼容模型供应商——填入 Base URL、API key 和模型 id，即可在会话的模型选择器里和内置档位一起使用。",
  "models.empty": "还没有自定义供应商。",
  "models.add": "添加供应商",
  "models.noKey": "未配 key",
  "models.footnote":
    "后台任务（自动标题、会议纪要）在配置了 DeepSeek key 时用 DeepSeek，否则用你的第一个自定义供应商。",
  "models.name.label": "名称",
  "models.name.placeholder": "OpenRouter、我的 vLLM 机器……",
  "models.baseUrl.label": "Base URL",
  "models.baseUrl.hint": "OpenAI 兼容端点，不带 /chat/completions。",
  "models.key.label": "API key",
  "models.key.placeholder": "sk-…（本地端点可留空）",
  "models.key.keepStored": "••••••••（已保存——输入即替换）",
  "models.models.label": "模型",
  "models.model.idPlaceholder": "模型 id",
  "models.model.namePlaceholder": "显示名（可选）",
  "models.model.vision": "视觉",
  "models.model.visionHint":
    "支持图片输入的模型请打开“视觉”——附件将直接发给模型。",
  "models.model.add": "添加模型",
  "page.title": "设置",

  "group.general": "通用",
  "group.intelligence": "智能",
  "group.inputCapture": "输入与采集",
  "group.app": "应用",
  "group.data": "数据",
  "nav.general": "通用",
  "nav.runtimes": "Runtime",
  "nav.remote": "远程访问",
  "general.title": "通用",
  "remote.title": "远程访问",
  "remote.description": "通过 Tailscale 在手机上安全地继续 Cetus 对话。",
  "remote.enable": "启用手机伴侣",
  "remote.enableDescription":
    "启动仅监听本机的服务，并在可用时自动配置 Tailscale Serve。",
  "remote.keepAwake.label": "远程访问开启时保持 Mac 唤醒",
  "remote.keepAwake.description":
    "手机伴侣开启期间阻止 Mac 进入睡眠，确保手机随时能连上这台 Mac。屏幕仍会正常关闭并锁定。",
  "remote.ready": "Tailnet 地址已就绪",
  "remote.localOnly": "本地服务已就绪",
  "remote.scanHint": "首次扫描二维码完成配对，之后手机会保留已认证的会话。",
  "remote.phoneRequirement":
    "手机需安装 Tailscale App，并登录与这台 Mac 相同的 tailnet。",
  "remote.proxyHint":
    "手机开着代理（Clash、Shadowrocket、Surge 等）时，请先把 *.ts.net 设为直连——fake-IP DNS 会劫持 Tailscale 域名，导致配对页面打不开。",
  "remote.copy": "复制配对链接",
  "remote.rotate": "撤销手机访问",
  "remote.security":
    "远程端只开放对话功能；API Key、终端控制、本地文件浏览和 Cetus 设置仍只保留在这台 Mac 上。",
  "general.description": "语言和应用级基础设置。",
  "runtimes.title": "Runtime",
  "runtimes.description":
    "选择哪些编程智能体显示在 Runtime 选择器中，并按你的偏好调整顺序。顺序同时决定 ⌃1…⌃9 快捷键：谁排在上面谁拿到靠前的键位，preset 也参与排序。",
  "runtimes.builtIn": "始终可用",
  "runtimes.installed": "已安装",
  "runtimes.notInstalled": "未安装",
  "runtimes.codexNotSignedIn": "未登录",
  "runtimes.codexNotSignedIn.hint":
    "已安装 Codex 但没有可用凭据——请在终端运行 codex login，否则会话会报缺少 OPENAI_API_KEY 的错误。Codex 桌面应用的登录不共享给 CLI。",
  "diagnostics.label": "诊断信息",
  "diagnostics.description":
    "复制一份脱敏报告（版本、PATH、运行时状态、最近日志），反馈问题时附上。",
  "diagnostics.copy": "复制报告",
  "diagnostics.copied": "已复制",
  "runtimes.dragToReorder": "拖拽排序",
  "runtimes.shortcutHint": "该位置的快捷键——调整顺序会跟着变",
  "runtimes.enabled": "启用 {runtime}",
  "runtimes.behavior.title": "Runtime 行为",
  "runtimes.behavior.description":
    "适用于外部 CLI 与 ACP Runtime 的共享执行设置。",
  "general.autoSortConversations.label": "有新消息时将对话移到顶部",
  "general.autoSortConversations.description":
    "对话收到新消息时自动重新排序。关闭后按创建顺序固定排列，新建的对话位于顶部。",
  "general.autoUpdate.label": "自动更新",
  "general.autoUpdate.description":
    "在后台检查并安装更新，下次打开 Cetus 时生效。",
  "general.confirmQuit.label": "退出前确认",
  "general.confirmQuit.description":
    "按 Cmd+Q 退出 Cetus 前先询问，避免误触打断正在运行的智能体。",
  "general.keepAwake.label": "任务运行时保持唤醒",
  "general.keepAwake.description":
    "智能体回合或会议录制进行中时阻止 Mac 进入睡眠。屏幕仍会正常关闭并锁定，合盖仍会睡眠。",
  "general.cliAgents.label": "CLI 智能体：跳过权限确认",
  "general.cliAgents.description":
    "允许外部 Runtime 跳过逐项确认。关闭后工具调用会通过聊天中的审批卡片先询问。",
  "general.cliWorktree.label": "CLI 智能体：隔离在 git worktree 中",
  "general.cliWorktree.description":
    "每个会话在独立的 git worktree 和分支上运行，智能体不会触碰你当前检出的文件。关闭时智能体直接修改工作区，就像在终端里运行 CLI 一样。已有 worktree 的会话会继续使用原有 worktree。",
  "update.check.label": "更新",
  "update.check.current": "当前版本 v{version}。",
  "update.check.button": "检查更新",
  "update.check.checking": "检查中…",
  "update.check.upToDate": "已是最新版本。",
  "update.check.available": "有新版本 v{version}。",
  "update.check.install": "下载并安装",
  "update.check.restart": "立即重启",
  "update.installing": "正在下载更新…",
  "update.installed": "更新已下载 — 重启以应用。",
  "update.failed": "更新失败，请稍后重试。",
  "nav.api-keys": "API 密钥",
  "nav.memory": "记忆",
  "nav.plugins": "插件",
  "nav.skills": "技能",
  "nav.slash-commands": "斜杠命令",
  "nav.connectors": "MCP",
  "nav.launcher": "启动器",
  "nav.voice": "语音",
  "nav.screen": "屏幕上下文",
  "notifications.event.meeting.label": "会议记录",
  "notifications.event.meeting.description": "开始转写时提醒，纪要生成后通知。",
  "nav.meetings": "会议",
  "nav.agent-control": "电脑与浏览器",
  "nav.appearance": "外观",
  "nav.keyboard-shortcuts": "键盘快捷键",
  "nav.notifications": "通知",
  "nav.permissions": "权限",
  "nav.archived": "已归档对话",

  // --- 权限（与首次引导共用）-------------------------------------------
  "permissions.title": "权限",
  "permissions.description":
    "cetus 在这台 Mac 上能访问什么，以及每项权限分别解锁哪些功能。按需授权即可——少给某项不会影响其它功能。",
  "permissions.note":
    "授予某项权限后，macOS 可能需要你退出并重新打开 cetus 才会生效。",
  "permissions.recheck": "重新检查",
  "permissions.grant": "授权",
  "permissions.openSettings": "打开系统设置",
  "permissions.status.granted": "已授权",
  "permissions.status.needed": "待授权",
  "permissions.notifications.label": "通知",
  "permissions.notifications.description":
    "任务完成、需要你确认、或会议被记录时弹出提醒。",
  "permissions.accessibility.label": "辅助功能",
  "permissions.accessibility.description":
    "全局快捷键、快速启动器，以及把听写或智能体生成的文字输入到其它应用。",
  "permissions.screen.label": "屏幕录制",
  "permissions.screen.description":
    "截图启动器与屏幕上下文记忆（捕捉屏幕上的内容）。",
  "permissions.microphone.label": "麦克风",
  "permissions.microphone.description": "语音听写与会议转录。",
  "permissions.fullDisk.label": "完全磁盘访问",
  "permissions.fullDisk.description":
    "允许智能体读取其它应用目录里的文件（邮件、微信、备忘录等），不再反复弹出「访问其他 App 的数据」。",

  // --- 首次引导 ---------------------------------------------------------
  "onboarding.welcome.title": "选择 cetus 的思考方式",
  "onboarding.welcome.subtitle":
    "使用内置智能体，或复用这台 Mac 上已有的 Claude Code 与 Codex，之后可以随时切换。",
  "onboarding.welcome.start": "继续设置权限",
  "onboarding.runtime.cetus.description":
    "基于 pi、由 DeepSeek 驱动，适合低成本的日常 Agent 工作。",
  "onboarding.runtime.cli.description":
    "复用这台 Mac 上已安装并登录的 {name} CLI。",
  "onboarding.runtime.ready": "已就绪",
  "onboarding.runtime.notInstalled": "未安装",
  "onboarding.runtime.keyNeeded": "需要密钥",
  "onboarding.runtime.configure": "配置 DeepSeek 密钥",
  "onboarding.runtime.deepseekKey": "DeepSeek API 密钥",
  "onboarding.runtime.save": "保存密钥",
  "onboarding.runtime.keyNote": "密钥会安全地保存在 macOS 钥匙串中。",
  "onboarding.skip": "暂时跳过",
  "onboarding.back": "返回",
  "onboarding.done": "完成",
  "onboarding.permissions.title": "授予权限",
  "onboarding.permissions.subtitle":
    "现在授予你想用的权限即可。这些都能稍后在「设置 → 权限」里随时更改。",
  "onboarding.permissions.note":
    "全部可选——没有它们 cetus 也能正常运行，每项功能只需要它自己用到的权限。",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa（网页搜索）",
  "providers.tavily": "Tavily（网页搜索）",
  "providers.doubao": "豆包（语音）",
  "providers.volcArk": "Volcano Ark（改写）",
  "apiKeys.title": "API 密钥",
  "apiKeys.description":
    "密钥保存在系统钥匙串中。保存后会重启 pi 子进程，新密钥即刻生效。",
  "apiKeys.stored": "● 已保存",
  "apiKeys.unsaved": "● 未保存",
  "apiKeys.replace": "替换",
  "apiKeys.deepseekUrl.label": "DeepSeek API 地址",
  "apiKeys.deepseekUrl.hint":
    "可选。将所有 DeepSeek 请求（主 agent，以及标题生成、会议纪要）改走自定义的 OpenAI 兼容地址（代理或自建）。留空则使用默认 api.deepseek.com。",

  "notifications.title": "通知",
  "notifications.description":
    "后台任务完成或需要你处理时收到桌面通知——长时间运行看板任务时很实用。",
  "notifications.enable.label": "启用通知",
  "notifications.enable.description": "所有桌面通知的总开关。",
  "notifications.blocked":
    "系统已屏蔽通知。请在系统设置中允许 Cetus 发送通知。",
  "notifications.recheck": "重新检查",
  "notifications.notifyAbout": "通知我以下情况",
  "notifications.behavior": "行为",
  "notifications.mute.label": "Cetus 处于前台时静音",
  "notifications.mute.description": "仅在窗口处于后台时通知。",
  "notifications.event.task_finished.label": "任务完成",
  "notifications.event.task_finished.description":
    "一次智能体运行已结束——可能是对话回复、看板任务或定时任务（无论成功或出错）。",
  "notifications.event.awaiting_input.label": "需要你的输入",
  "notifications.event.awaiting_input.description":
    "智能体正在等待你回应提示。",

  "launcher.title": "快速启动器",
  "launcher.description":
    "随时随地唤出悬浮面板开始会话——还可以把屏幕截图作为上下文一并发送。",
  "launcher.needAccessibility":
    "启动器需要辅助功能权限，才能在全系统范围内识别 ⌘ 手势。",
  "launcher.grantAccess": "授予权限",
  "launcher.openSettings": "打开系统设置",
  "launcher.accessibilityGranted": "● 已授予辅助功能权限",
  "launcher.needScreenRecording":
    "截图需要屏幕录制权限——否则 Cetus 只能截取桌面壁纸，看不到屏幕上的窗口。",
  "launcher.screenRecordingGranted": "● 已授予屏幕录制权限",
  "launcher.macOnly": "全局 ⌘ 手势仅在 macOS 上可用。",
  "launcher.enable.label": "启用快速启动器",
  "launcher.enable.description":
    "触发方式：{gesture}。即便 Cetus 在后台也能使用。",
  "launcher.startup.label": "开机时启动",
  "launcher.startup.description": "登录时自动在托盘中启动 Cetus。",
  "launcher.gesture.doubleCmd": "双击 ⌘",
  "launcher.gesture.bothCmd": "同时按住两个 ⌘ 键",
  "launcher.gesture.label": "触发手势",
  "launcher.gesture.description": "随时随地唤出面板的方式。",
  "launcher.gesture.opt.both": "双 ⌘",
  "launcher.gesture.opt.bothOpt": "双 ⌥",
  "launcher.gesture.opt.double": "双击 ⌘",
  "launcher.gesture.opt.off": "关闭",
  "launcher.gesture.opt.doubleOpt": "双击右 ⌥",
  "launcher.fn.plain.label": "快速启动",
  "launcher.fn.plain.description": "唤出启动器（不带截图）。",
  "launcher.fn.shot.label": "快速启动 + 截图",
  "launcher.fn.shot.description":
    "先框选屏幕区域作为截图（单击=全屏），再唤出启动器。",
  "launcher.fn.reply.label": "视觉快速回复",
  "launcher.fn.reply.description":
    "读取当前屏幕与 AX 上下文，交给所选 agent runtime 生成回复候选，并将选中的回复写回原应用。",
  "launcher.replyRuntime.label": "快速回复 Runtime",
  "launcher.replyRuntime.description":
    "从「设置 → Runtimes」中已启用的 agent runtime 里选择。",
  "launcher.summon.label": "唤起 Cetus",
  "launcher.summon.description":
    "全局快捷键，将 Cetus 切到最前；若它在其他桌面会直接切换过去。",
  "launcher.summon.placeholder": "设置快捷键",
  "launcher.summon.recording": "请按下按键…",
  "launcher.summon.clear": "清除快捷键",
  "launcher.session.label": "默认会话",
  "launcher.session.description": "开启全新对话，或继续最近一次对话。",
  "launcher.session.opt.new": "新建",
  "launcher.session.opt.last": "最近",
  "launcher.screenshot.label": "默认截图",
  "launcher.screenshot.description":
    "每次打开面板时都把屏幕截图作为上下文。你仍可在每次启动时单独切换。",

  "appearance.title": "外观",
  "appearance.description": "设置 Cetus 各处使用的主题，更改即时生效。",
  "appearance.theme.label": "主题",
  "appearance.theme.description": "跟随系统外观，或锁定为浅色或深色。",
  "appearance.fontSize.label": "字体大小",
  "appearance.fontSize.description":
    "界面文字的基准字号，对话正文和标签随之缩放。与 ⌘+/⌘− 窗口缩放相互独立。",
  "appearance.fontSize.default": "{size} px（默认）",
  "appearance.fontSize.option": "{size} px",
  "appearance.lineHeight.label": "行高",
  "appearance.lineHeight.description": "界面文字与对话正文的行间距。",
  "appearance.lineHeight.compact": "紧凑",
  "appearance.lineHeight.default": "默认",
  "appearance.lineHeight.relaxed": "宽松",
  "appearance.lineHeight.loose": "更宽松",
  "appearance.permaLayers.label": "平滑悬停渲染",
  "appearance.permaLayers.description":
    "为悬停淡入淡出保留专用合成层，避免分数缩放下的行抖动。会占用更多图形内存；可关闭以对比。",
  "appearance.skin.label": "皮肤",
  "appearance.skin.description":
    "先选一个模板，再微调这几个种子颜色，其余颜色都由它们推导。浅色和深色分别设置。",
  "appearance.skin.customized": "已自定义",
  "appearance.skin.variant.light": "浅色",
  "appearance.skin.variant.dark": "深色",
  "appearance.skin.reset": "重置为 {preset}",
  "appearance.skin.seed.surface": "背景",
  "appearance.skin.seed.ink": "文字",
  "appearance.skin.seed.accent": "强调色",
  "appearance.skin.seed.diffAdded": "Diff 新增",
  "appearance.skin.seed.diffRemoved": "Diff 删除",
  "appearance.skin.seed.skill": "技能",
  "appearance.skin.seed.contrast": "对比度",

  "keyboard.title": "键盘快捷键",
  "keyboard.description":
    "自定义 Cetus 处于前台时使用的应用内快捷键。启动器和会议的全局快捷键仍在各自页面里设置。",
  "keyboard.search": "搜索快捷键",
  "keyboard.resetAll": "全部恢复默认",
  "keyboard.column.command": "命令",
  "keyboard.column.keybinding": "快捷键",
  "keyboard.empty": "没有匹配的快捷键。",
  "keyboard.unassigned": "未分配",
  "keyboard.clear": "清除快捷键",
  "keyboard.reset": "恢复默认",
  "keyboard.conflict": "也分配给了 {commands}。",
  "keyboard.runtimeSlot.current": "当前是 {runtime}。",
  "keyboard.runtimeSlot.pinned":
    "固定为 {runtime}——内置 Runtime 始终占第一位。",
  "keyboard.runtimeSlot.empty": "空位——可在「设置 › Runtime」中启用更多。",

  "voice.title": "语音听写",
  "voice.description":
    "用说话代替打字。在下方选择识别引擎，然后按住快捷键即可向当前应用听写。",
  "voice.macOnly": "语音听写仅在 macOS 上可用。",
  "voice.needPerms": "听写需要麦克风和语音识别权限。",
  "voice.grantAccess": "授予权限",
  "voice.openSettings": "打开系统设置",
  "voice.permsGranted": "● 已授予麦克风和语音识别权限",
  "voice.engine.label": "识别引擎",
  "voice.engine.doubaoDesc":
    "豆包（火山引擎）实时流式识别——最快（约 90 毫秒），边说边出文字，擅长中英文混说，在中国大陆可用。需要豆包 API 密钥（X-Api-Key）。",
  "voice.engine.appleDesc":
    "Apple 本地识别——即时响应，音频不会离开你的 Mac，但中英文混说能力较弱。",
  "voice.engine.opt.doubao": "豆包（云端）",
  "voice.engine.opt.apple": "Apple（本地）",
  "voice.gesture.rightOption": "右 ⌥",
  "voice.gesture.fn": "fn（地球键）",
  "voice.gesture.rightCmd": "右 ⌘",
  "voice.enable.label": "全系统听写",
  "voice.enable.description":
    "在任意位置按住 {gesture} 即可听写；松开后文字会插入当前应用。",
  "voice.needAccessibility":
    "向其他应用输入文字需要辅助功能权限（与启动器所用权限相同）。",
  "voice.triggerKey.label": "触发键",
  "voice.triggerKey.holdDesc":
    "按住该修饰键说话，松开后插入。短按不会触发，正常组合键仍可照常使用。",
  "voice.triggerKey.opt.rightCmd": "右 ⌘",
  "voice.triggerKey.opt.rightOption": "右 ⌥",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Caps Lock",
  "voice.triggerKey.capsNote":
    "选用后，Cetus 运行期间会把 Caps Lock 专用于语音听写，退出时自动恢复。",
  "voice.handsfreeShortcut.label": "双击进入免手持模式",
  "voice.handsfreeShortcut.description":
    "可选，默认关闭。双击 {gesture} 可开始或停止免手持听写。若同一双击已分配给快速回复或启动器，则后者优先。仅豆包引擎支持。",
  "voice.insert.label": "插入方式",
  "voice.insert.description":
    "“键入”发送模拟按键；“粘贴”使用剪贴板 + ⌘V（在某些应用中更可靠，但会短暂占用剪贴板）。",
  "voice.insert.opt.type": "键入",
  "voice.insert.opt.paste": "粘贴",
  "voice.cleanup.label": "AI 智能润色",
  "voice.cleanup.description":
    "把口语整理成你想打的字：自动折叠口误改正（“约三点…啊不对，五点”只保留五点）、去除口头语、修正标点。需要 Volcano Ark (rewrite) API 密钥——这是独立的大模型密钥，和豆包语音密钥不是同一个。仅按住说话模式可用——免手持模式会逐句实时插入。",
  "voice.cleanup.modelLabel": "润色模型",
  "voice.cleanup.modelHint":
    "用于润色的 Ark 模型 ID。留空使用内置默认；若快照下线会自动回退到上一代模型。",
  "voice.biasing.label": "偏向你的词汇",
  "voice.biasing.description":
    "把热词和当前输入框的内容一起发给豆包，提升你常用术语和当前语境的识别准确率。同时从你的修改中学习：插入后片刻会回读同一输入框，把你手动改正的拼写（如人名）存入本地纠错词典。仅豆包引擎可用；绝不读取密码框。",
  "voice.biasing.hotwordsLabel": "热词",
  "voice.biasing.hotwordsHint":
    "每行一个词，每个少于 10 个字符——你常说的人名、术语、产品名（中英文均可）。Cetus 也会自动从你的听写中学习新词。",
  "voice.biasing.hotwordsPlaceholder": "DeepSeek\nTauri\ncetus",
  "voice.biasing.tableLabel": "热词词表 ID",
  "voice.biasing.tableHint":
    "需要比上面列表更大的个人词典时：在火山控制台创建热词词表，把它的 ID 粘贴到这里。上面的内联列表仍然优先生效。",
  "voice.biasing.tablePlaceholder": "例如 6543210abcdef",
  "voice.startSound.label": "启动音效",
  "voice.startSound.description":
    "胶囊出现时播放一声轻柔的气泡音，让你知道开始听写了。",
  "voice.history.label": "保存听写历史",
  "voice.history.description":
    "记录你听写的内容，方便你和智能体（通过 recall_dictation 工具）日后回顾。默认关闭。",
  "voice.history.empty": "还没有听写内容——你的转写记录会显示在这里。",
  "voice.history.clear": "清空历史（{n}）",

  "screen.title": "屏幕上下文",
  "screen.description":
    "定期截取屏幕并在本地识别（Apple Vision OCR），让智能体能回忆你当时在做什么。图像和文字都保留在你的 Mac 上——不会上传。",
  "screen.macOnly": "屏幕采集针对 macOS 优化；本地 OCR 使用 Apple Vision。",
  "screen.browse": "浏览已采集画面",
  "screen.enable.label": "启用屏幕采集",
  "screen.enable.description":
    "默认关闭。开启后，Cetus 会在关键时刻采集——按下回车、保存或复制、切换窗口、输入停顿——外加一个兜底计时器。",
  "screen.interval.label": "兜底间隔",
  "screen.interval.description":
    "没有事件触发时计时采集的秒数。几乎相同的画面会自动跳过。",
  "screen.interval.unit": "秒",
  "screen.retention.label": "文字保留时长",
  "screen.retention.description":
    "早于该时长的可检索屏幕文字会被删除。文字很小，可以放心设长。设为 0 则永久保留。",
  "screen.retention.unit": "天",
  "screen.frameRetention.label": "图像保留时长",
  "screen.frameRetention.description":
    "早于该时长的完整画面和缩略图会从磁盘删除；上面的可检索文字仍会保留。图像约占磁盘用量的 99%。设为 0 则图像与文字保留一样久。",
  "screen.frameRetention.unit": "天",
  "screen.ocr.label": "本地识别文字（OCR）",
  "screen.ocr.description":
    "用 Apple Vision 提取屏幕上的文字，方便智能体检索。在本地运行。",
  "screen.excluded.label": "排除的应用",
  "screen.excluded.description":
    "以逗号分隔的应用名称或 bundle id。这些应用处于最前台时会跳过采集（如 1Password、信息）。",
  "screen.frames.one":
    "已采集 {count} 张画面 · 首次采集时 macOS 会请求屏幕录制权限。",
  "screen.frames.other":
    "已采集 {count} 张画面 · 首次采集时 macOS 会请求屏幕录制权限。",

  "ambient.title": "环境上下文",
  "ambient.description":
    "通过读取前台应用的辅助功能树（窗口标题、可见文字、浏览器网址）维护一份滚动的纯文本活动记忆。不截屏、不记录按键、绝不读取密码框。数据只留在本机。",
  "ambient.enable.label": "启用环境上下文",
  "ambient.enable.description":
    "默认关闭。开启后，对话可通过输入框的雷达开关附带最近活动摘要。",
  "ambient.retention.label": "历史保留时长",
  "ambient.retention.description": "较早的记录会自动删除。设为 0 则永久保留。",
  "ambient.retention.unit": "天",
  "ambient.excluded.label": "排除的应用",
  "ambient.excluded.description":
    "以逗号分隔的应用名称或 bundle id。这些应用处于最前台时不读取任何内容（如 1Password、银行类应用）。",
  "ambient.clear": "删除全部历史",
  "ambient.entries.one":
    "已存储 {count} 条记录 · 读取窗口文字使用辅助功能权限。",
  "ambient.entries.other":
    "已存储 {count} 条记录 · 读取窗口文字使用辅助功能权限。",

  "agentControl.title": "电脑与浏览器控制",
  "agentControl.description":
    "让智能体操作你的浏览器和 Mac 应用。需要辅助功能权限（实时预览还需屏幕录制权限）。",
  "agentControl.browser.label": "启用浏览器控制",
  "agentControl.browser.description":
    "启用 Browser Use 插件，由它提供 chrome-devtools MCP 工具来操作托管 Chrome。智能体会在执行重要操作前确认，你也可随时让它停止。",
  "agentControl.computer.label": "启用电脑控制",
  "agentControl.computer.description":
    "添加 computer_* 工具，通过辅助功能控制本机应用。智能体会在执行重要操作前确认，你也可随时让它停止。",
  "agentControl.ax.label": "辅助功能权限",
  "agentControl.ax.notGranted":
    "未授予——智能体无法读取应用界面或按索引点击/输入。",
  "agentControl.ax.granted": "已授予。",
  "agentControl.checking": "检查中…",
  "agentControl.enabled": "已启用",
  "agentControl.grant": "授予",
  "agentControl.openSettings": "打开系统设置",
  "agentControl.screen.label": "屏幕录制权限",
  "agentControl.screen.notGranted": "未授予——实时截图预览将无法显示。",
  "agentControl.screen.granted": "已授予。",
  "agentControl.footnote":
    "智能体通过编号元素列表操作，绝不直接操作像素，并会在执行任何重要操作（发送、删除、购买、提交、认证）前征求同意。它运行期间，对话中会出现停止按钮。",

  "plugins.title": "插件",
  "plugins.description":
    "能力包，可提供提示词指导、工具、MCP 服务器、技能和受信任的原生集成。",
  "plugins.import": "导入文件夹",
  "plugins.importing": "导入中…",
  "plugins.empty": "未找到插件",
  "plugins.source.builtIn": "内置",
  "plugins.source.user": "用户",
  "plugins.openFolder": "打开文件夹",
  "plugins.delete": "删除插件",
  "plugins.deleteConfirm": "确定删除这个插件？",
  "plugins.surface.title": "选择合适的操作入口",
  "plugins.surface.computer":
    "原生桌面应用、跨应用 GUI 流程，或结构化工具够不到的任务。",
  "plugins.surface.browser":
    "Cetus 托管浏览器：本地开发服务器、公开页面和隔离的临时会话。",

  "archived.title": "已归档对话",
  "archived.description":
    "你从侧边栏归档的对话。可恢复某个对话，或全部清除以释放空间——删除不可恢复。",
  "archived.loading": "加载中…",
  "archived.empty": "暂无已归档对话。",
  "archived.count.one": "{count} 个已归档对话",
  "archived.count.other": "{count} 个已归档对话",
  "archived.deleteAllPrompt": "删除全部 {count} 个？",
  "archived.deleting": "删除中…",
  "archived.deleteAll": "全部删除",
  "archived.untitled": "无标题",
  "archived.archivedOn": "归档于 {date}",
  "archived.restore": "恢复",
  "archived.deleteAria": "删除对话",

  "autoArchive.enable.label": "自动归档闲置对话",
  "autoArchive.enable.description":
    "把你长时间未处理的对话自动移入归档。归档后仍可在此恢复。",
  "autoArchive.threshold.label": "归档阈值",
  "autoArchive.threshold.description":
    "对话闲置多久后自动归档。正在打开的对话、还没读的运行结果，以及定时任务（Automation）产生的对话不会被归档。",
  "autoArchive.unit.hours": "小时",
  "autoArchive.unit.days": "天",

  "autoDelete.enable.label": "自动删除已归档对话",
  "autoDelete.enable.description":
    "把在归档里放了一段时间的对话永久删除。删除后无法恢复。",
  "autoDelete.threshold.label": "删除阈值",
  "autoDelete.threshold.description":
    "对话归档多久后自动删除。只影响已归档的对话，侧栏里的对话不会被动。",

  "memory.title": "记忆",
  "memory.description":
    "关于你的持久笔记——你的偏好、进行中的项目和决定——智能体会跨对话携带这些信息。它会在学习中不断补充；你也可在此添加、编辑、静音或删除任意一条。",
  "memory.enable.label": "启用记忆",
  "memory.enable.description":
    "开启后，下方启用的笔记会在每一轮注入智能体的上下文。关闭可暂停记忆而不丢失笔记。",
  "memory.add.label": "添加记忆",
  "memory.add.placeholder": "例如：偏好用 pnpm 而非 npm，且提交信息要简洁。",
  "memory.category.placeholder": "分类（可选）",
  "memory.adding": "添加中…",
  "memory.add.button": "添加",
  "memory.loading": "加载中…",
  "memory.empty": "暂无记忆",
  "memory.count.one": "{count} 条记忆",
  "memory.count.other": "{count} 条记忆",
  "memory.deleteAllPrompt": "删除全部？",
  "memory.clearAll": "全部清除",
  "memory.saving": "保存中…",
  "memory.save": "保存",
  "memory.tag.agent": "智能体",
  "memory.tag.you": "你",
  "memory.editedOn": "编辑于 {date}",
  "memory.muteAria": "静音记忆",
  "memory.enableAria": "启用记忆",
  "memory.editAria": "编辑记忆",
  "memory.deleteAria": "删除记忆",

  "skills.title": "技能",
  "skills.description":
    "智能体可按需调用的可复用指令——一个包含 SKILL.md（名称 + 描述 + 步骤）的文件夹，遵循开放的 Agent Skills 标准。可从文件夹导入或自行编写；启用的技能会在每一轮提供给智能体。",
  "skills.enable.label": "启用技能",
  "skills.enable.description":
    "开启后，下方启用的技能会提供给智能体。关闭可暂停所有技能而无需卸载。",
  "skills.importing": "导入中…",
  "skills.import": "导入文件夹",
  "skills.write": "自行编写",
  "skills.learn": "了解技能",
  "skills.loading": "加载中…",
  "skills.empty": "未安装任何技能",
  "skills.count.one": "{count} 个技能",
  "skills.count.other": "{count} 个技能",
  "skills.source.written": "自建",
  "skills.source.imported": "导入",
  "skills.source.proposed": "推荐",
  "skills.source.byAgent": "AI 创建",
  "skills.updatedOn": "更新于 {date}",
  "skills.disableAria": "停用技能",
  "skills.enableAria": "启用技能",
  "skills.openFolderAria": "打开技能文件夹",
  "skills.delete": "删除",
  "skills.uninstallAria": "卸载技能",
  "skills.editor.title": "编写技能",
  "skills.editor.namePlaceholder": "名称，例如：提交信息风格",
  "skills.editor.descPlaceholder": "智能体何时该用它？（一行）",
  "skills.editor.bodyPlaceholder":
    "技能正文，使用 Markdown。步骤、示例、规则……",
  "skills.editor.saving": "保存中…",
  "skills.editor.create": "创建技能",
  "skills.discovered.title": "已发现的技能",
  "skills.discovered.description":
    "在标准 .agents、.claude、.codex 文件夹或下方附加文件夹中发现的技能。这里仅作只读展示，请在来源文件夹中管理。",
  "skills.discovered.badge": "全局",
  "skills.discovered.repoTitle": "仓库技能",
  "skills.discovered.userTitle": "用户技能",
  "skills.discovered.repoBadge": "仓库",
  "skills.discovered.userBadge": "用户",
  "skills.discovered.count.one": "{count} 个已发现技能",
  "skills.discovered.count.other": "{count} 个已发现技能",
  "skills.discovered.viewAria": "查看技能内容",

  "connectors.title": "MCP",
  "connectors.description":
    "通过 MCP（Model Context Protocol）服务器将智能体连接到外部工具——本地命令或远程 URL。添加服务器后点击“测试”可执行一次真实握手并查看它提供的工具。每个启用的 MCP 服务器的工具都会加载到智能体中，使其能像调用内置工具一样调用它们；更改在新对话中生效。",
  "connectors.loading": "加载中…",
  "connectors.empty": "暂无 MCP 服务器",
  "connectors.count.one": "{count} 个 MCP 服务器",
  "connectors.count.other": "{count} 个 MCP 服务器",
  "connectors.add": "添加 MCP 服务器",
  "connectors.disableAria": "停用 MCP 服务器",
  "connectors.enableAria": "启用 MCP 服务器",
  "connectors.editAria": "编辑 MCP 服务器",
  "connectors.removeAria": "移除 MCP 服务器",
  "connectors.editor.name": "名称",
  "connectors.editor.namePlaceholder": "例如：GitHub、Filesystem、Linear……",
  "connectors.editor.transport": "传输方式",
  "connectors.editor.transportDesc":
    "本地进程（stdio）或远程 MCP 端点（HTTP/SSE）。",
  "connectors.editor.command": "命令",
  "connectors.editor.commandPlaceholder": "例如：npx",
  "connectors.editor.args": "参数",
  "connectors.editor.argsHint": "每行一个",
  "connectors.editor.env": "环境变量",
  "connectors.editor.envHint": "传递给进程",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "请求头",
  "connectors.editor.headersHint": "随每个请求发送",
  "connectors.test.connected": "已连接",
  "connectors.test.tools.one": "{count} 个工具：{names}",
  "connectors.test.tools.other": "{count} 个工具：{names}",
  "connectors.test.noTools": "握手成功——服务器未提供任何工具。",
  "connectors.test.failed": "连接失败。",
  "connectors.editor.saving": "保存中…",
  "connectors.testing": "测试中…",
  "connectors.test.button": "测试",
  "connectors.editor.envName": "KEY",
  "connectors.editor.envValue": "值",
  "connectors.editor.addEnv": "添加变量",
  "connectors.editor.headerName": "名称",
  "connectors.editor.headerValue": "值",
  "connectors.editor.addHeader": "添加请求头",
  "connectors.editor.removeRow": "移除",
  "connectors.details.toggleAria": "展开/收起工具",
  "connectors.details.loading": "正在加载工具…",
  "connectors.details.connected": "已连接",
  "connectors.details.toolCount.one": "{count} 个工具",
  "connectors.details.toolCount.other": "{count} 个工具",
  "connectors.oauth.auth": "认证",
  "connectors.oauth.authDesc":
    "静态请求头，或 OAuth（由 Cetus 完成登录流程）。",
  "connectors.oauth.none": "无",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "自动（动态注册）",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "可选",
  "connectors.oauth.authorize": "授权",
  "connectors.oauth.authorizing": "授权中…",
  "connectors.oauth.authorized": "已授权——令牌已缓存。",
  "connectors.oauth.hint": "将打开浏览器登录。",
  "connectors.oauth.saveHint":
    "先保存 MCP 服务器，然后在下方展开它并点击 Authorize。",
  "discovery.mcp.none": "未找到服务器（配置文件不存在）。",
  "discovery.mcp.title": "从其他应用导入",
  "discovery.mcp.description":
    "同时加载这些应用中配置的 MCP 服务器。仅对新对话生效。",
  "skills.discovered.loadLabel": "加载发现的技能",
  "skills.discovered.loadDesc":
    "在新对话中包含下方文件夹，以及标准 .agents、.claude 和 .codex 文件夹中的技能。",
  "skills.discovered.chooseFolder": "选择文件夹",
};
