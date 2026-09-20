export const en = {
  "search.placeholder": "Search settings…",
  "search.clear": "Clear search",
  "search.empty": "No matching settings",

  "appearance.wallpaper.label": "Background image",
  "appearance.wallpaper.description":
    "Choose a local image for the home and chat background. JPG, PNG or WebP, up to 20 MB. Images stay on this device.",
  "appearance.wallpaper.preview": "Chat background preview",
  "appearance.wallpaper.upload": "Upload image",
  "appearance.wallpaper.replace": "Replace image",
  "appearance.wallpaper.remove": "Remove",
  "appearance.wallpaper.saving": "Saving…",
  "appearance.wallpaper.fade": "Fade background",
  "appearance.wallpaper.uploadError":
    "Could not save this image. Choose a valid JPG, PNG or WebP under 20 MB and check available storage.",
  "appearance.wallpaper.saveError":
    "Could not save the background setting. Please try again.",

  "models.model.reasoningHint":
    "Turn on Reasoning for models with an effort knob, then enable the levels your endpoint supports. Each level sends its own name by default — type a token to override (e.g. map cetus's levels onto an endpoint that only knows low/medium/high). Pick the effort format your vendor expects; disabled levels are clamped to the nearest enabled one.",
  "models.model.format": "Format",
  "models.model.reasoning": "Reasoning",
  "nav.models": "Models",
  "models.title": "Models",
  "models.description":
    "Add your own OpenAI-compatible model providers — a base URL, an API key, and model ids. Their models then appear in the chat model picker alongside the built-in tiers.",
  "models.empty": "No custom providers yet.",
  "models.add": "Add provider",
  "models.noKey": "No key",
  "models.footnote":
    "Background tasks (auto-titles, meeting notes) use DeepSeek when its key is set, otherwise your first custom provider.",
  "models.name.label": "Name",
  "models.name.placeholder": "OpenRouter, my vLLM box, …",
  "models.baseUrl.label": "Base URL",
  "models.baseUrl.hint":
    "OpenAI-compatible endpoint, without /chat/completions.",
  "models.key.label": "API key",
  "models.key.placeholder": "sk-… (leave empty for local endpoints)",
  "models.key.keepStored": "•••••••• (stored — type to replace)",
  "models.models.label": "Models",
  "models.model.idPlaceholder": "model id",
  "models.model.namePlaceholder": "display name (optional)",
  "models.model.vision": "Vision",
  "models.model.visionHint":
    "Turn on Vision for models that accept images — attachments are sent directly to the model.",
  "models.model.add": "Add model",
  // --- Chrome -----------------------------------------------------------
  "page.title": "Settings",

  // --- Section rail -----------------------------------------------------
  "group.general": "General",
  "group.intelligence": "Intelligence",
  "group.inputCapture": "Input & Capture",
  "group.app": "App",
  "group.data": "Data",
  "nav.general": "General",
  "nav.runtimes": "Runtimes",
  "nav.remote": "Remote access",
  "nav.api-keys": "API Keys",
  "nav.memory": "Memory",
  "nav.plugins": "Plugins",
  "nav.skills": "Skills",
  "nav.slash-commands": "Slash commands",
  "nav.connectors": "MCP",
  "nav.launcher": "Launcher",
  "nav.voice": "Voice",
  "nav.screen": "Screen context",
  "notifications.event.meeting.label": "Meeting capture",
  "notifications.event.meeting.description":
    "Transcription started, and the notes are ready afterwards.",
  "nav.meetings": "Meetings",
  "nav.agent-control": "Computer & Browser",
  "nav.appearance": "Appearance",
  "nav.keyboard-shortcuts": "Keyboard shortcuts",
  "nav.notifications": "Notifications",
  "nav.permissions": "Permissions",
  "nav.archived": "Archived chats",

  // --- Permissions (shared with first-run onboarding) -------------------
  "permissions.title": "Permissions",
  "permissions.description":
    "What cetus can access on this Mac, and what each unlocks. Grant only what you need — every feature works without the others.",
  "permissions.note":
    "macOS may ask you to quit and reopen cetus after granting a permission for it to take effect.",
  "permissions.recheck": "Re-check",
  "permissions.grant": "Grant",
  "permissions.openSettings": "Open Settings",
  "permissions.status.granted": "Granted",
  "permissions.status.needed": "Needed",
  "permissions.notifications.label": "Notifications",
  "permissions.notifications.description":
    "Alerts when a task finishes, needs your input, or a meeting is captured.",
  "permissions.accessibility.label": "Accessibility",
  "permissions.accessibility.description":
    "Global hotkeys, the quick launcher, and typing dictated or agent text into other apps.",
  "permissions.screen.label": "Screen Recording",
  "permissions.screen.description":
    "Screenshot launcher and screen-context memory (capturing what's on screen).",
  "permissions.microphone.label": "Microphone",
  "permissions.microphone.description":
    "Voice dictation and meeting transcription.",
  "permissions.fullDisk.label": "Full Disk Access",
  "permissions.fullDisk.description":
    'Lets agents read files inside other apps\' folders (Mail, WeChat, Notes…) without macOS asking "access data from other apps" every time.',

  // --- Onboarding (first run) -------------------------------------------
  "onboarding.welcome.title": "Choose how cetus thinks",
  "onboarding.welcome.subtitle":
    "Use the built-in agent or your existing Claude Code and Codex installations. You can switch anytime.",
  "onboarding.welcome.start": "Continue to permissions",
  "onboarding.runtime.cetus.description":
    "Built on pi and powered by DeepSeek for affordable everyday agent work.",
  "onboarding.runtime.cli.description":
    "Use the {name} CLI already installed and signed in on this Mac.",
  "onboarding.runtime.ready": "Ready",
  "onboarding.runtime.notInstalled": "Not installed",
  "onboarding.runtime.keyNeeded": "Key needed",
  "onboarding.runtime.configure": "Configure DeepSeek key",
  "onboarding.runtime.deepseekKey": "DeepSeek API key",
  "onboarding.runtime.save": "Save key",
  "onboarding.runtime.keyNote": "Stored securely in your macOS Keychain.",
  "onboarding.skip": "Skip for now",
  "onboarding.back": "Back",
  "onboarding.done": "Done",
  "onboarding.permissions.title": "Grant permissions",
  "onboarding.permissions.subtitle":
    "Grant what you'd like to use now. You can change any of these later in Settings → Permissions.",
  "onboarding.permissions.note":
    "All optional — cetus runs fine without them, and each feature only needs the ones it uses.",

  // --- General ----------------------------------------------------------
  "general.title": "General",
  "remote.title": "Remote access",
  "remote.description":
    "Continue Cetus conversations securely from your phone through Tailscale.",
  "remote.enable": "Enable mobile companion",
  "remote.enableDescription":
    "Starts a localhost-only server and configures Tailscale Serve when available.",
  "remote.keepAwake.label": "Keep this Mac awake for remote access",
  "remote.keepAwake.description":
    "While the mobile companion is on, hold off system sleep so your phone can always reach this Mac. The display still sleeps and locks.",
  "remote.ready": "Tailnet address ready",
  "remote.localOnly": "Local server ready",
  "remote.scanHint":
    "Scan this QR code once. Your phone keeps an authenticated session afterwards.",
  "remote.phoneRequirement":
    "Your phone needs the Tailscale app, signed into the same tailnet as this Mac.",
  "remote.proxyHint":
    "Running a proxy app on the phone (Clash, Shadowrocket, Surge…)? Add a DIRECT rule for *.ts.net first — fake-IP DNS hijacks Tailscale addresses and the pairing page won't open.",
  "remote.copy": "Copy pairing link",
  "remote.rotate": "Revoke phones",
  "remote.security":
    "Only conversation features are exposed. API keys, terminal control, local file browsing and Cetus settings stay on this Mac.",
  "general.description": "Language and app-level basics.",
  "runtimes.title": "Runtimes",
  "runtimes.description":
    "Choose which coding agents appear in runtime pickers and arrange them in your preferred order. The order also sets the ⌃1…⌃9 keyboard shortcuts: whoever is on top gets the first key, presets included.",
  "runtimes.builtIn": "Always available",
  "runtimes.installed": "Installed",
  "runtimes.notInstalled": "Not installed",
  "runtimes.codexNotSignedIn": "Not signed in",
  "runtimes.codexNotSignedIn.hint":
    "Codex is installed but has no credentials — run `codex login` in a terminal, or sessions will fail with a missing OPENAI_API_KEY error. Signing in to the Codex desktop app is not enough; the CLI keeps its own login.",
  "diagnostics.label": "Diagnostics",
  "diagnostics.description":
    "Copy a sanitized report (versions, PATH, runtime status, recent log) to attach when reporting a bug.",
  "diagnostics.copy": "Copy report",
  "diagnostics.copied": "Copied",
  "runtimes.dragToReorder": "Drag to reorder",
  "runtimes.shortcutHint":
    "Keyboard shortcut for this position — reordering moves it",
  "runtimes.enabled": "Enable {runtime}",
  "runtimes.preset": "Preset",
  "runtimes.presets.title": "Presets",
  "runtimes.presets.description":
    "Pin a runtime to a fixed model and reasoning effort. Presets appear in runtime pickers alongside the runtimes above and never change what they launch.",
  "runtimes.presets.add": "Add preset",
  "runtimes.presets.delete": "Delete preset",
  "runtimes.presets.runtime": "Runtime",
  "runtimes.presets.model": "Model",
  "runtimes.presets.reasoning": "Reasoning",
  "runtimes.behavior.title": "Runtime behavior",
  "runtimes.behavior.description":
    "Shared execution settings for external CLI and ACP runtimes.",
  "general.autoSortConversations.label": "Move active chats to the top",
  "general.autoSortConversations.description":
    "Reorder chats when they receive new messages. Turn this off to keep chats in creation order, with newly created chats at the top.",
  "general.autoUpdate.label": "Automatic updates",
  "general.autoUpdate.description":
    "Check for and install updates in the background. Applied the next time you open Cetus.",
  "general.confirmQuit.label": "Confirm before quitting",
  "general.confirmQuit.description":
    "Ask before Cmd+Q closes Cetus, so a slip of the hand doesn't interrupt running agents.",
  "general.keepAwake.label": "Keep Mac awake while working",
  "general.keepAwake.description":
    "Hold off system sleep while an agent turn or meeting recording is running. The display still sleeps and locks; closing the lid still sleeps.",
  "general.cliAgents.label": "CLI agents: skip permission prompts",
  "general.cliAgents.description":
    "Let external runtimes run without approval prompts. Off = tool calls ask first through approval cards in the chat.",
  "general.cliWorktree.label": "CLI agents: isolate in git worktrees",
  "general.cliWorktree.description":
    "Run each conversation on its own branch in a separate git worktree, so agents never touch your checked-out files. Off = agents edit the workspace directly, like running the CLI in a terminal. Conversations that already have a worktree keep it.",
  "update.check.label": "Updates",
  "update.check.current": "You're on v{version}.",
  "update.check.button": "Check for updates",
  "update.check.checking": "Checking…",
  "update.check.upToDate": "You're up to date.",
  "update.check.available": "v{version} is available.",
  "update.check.install": "Download & install",
  "update.check.restart": "Restart now",
  "update.installing": "Downloading update…",
  "update.installed": "Update downloaded — restart to apply.",
  "update.failed": "Update failed. Try again later.",

  // --- API keys ---------------------------------------------------------
  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (web search)",
  "providers.tavily": "Tavily (web search)",
  "providers.doubao": "Doubao (voice)",
  "providers.volcArk": "Volcano Ark (rewrite)",
  "apiKeys.title": "API keys",
  "apiKeys.description":
    "Keys are stored in your OS keychain. Saving restarts the pi subprocess so new keys take effect immediately.",
  "apiKeys.stored": "● stored",
  "apiKeys.unsaved": "● unsaved",
  "apiKeys.replace": "Replace",
  "apiKeys.deepseekUrl.label": "DeepSeek API URL",
  "apiKeys.deepseekUrl.hint":
    "Optional. Routes all DeepSeek traffic — the agent plus titling and meeting minutes — through a custom OpenAI-compatible base URL (proxy or self-host). Blank uses the default api.deepseek.com.",

  // --- Notifications ----------------------------------------------------
  "notifications.title": "Notifications",
  "notifications.description":
    "Get a desktop notification when a background task finishes or needs you — handy for long agent runs on the board.",
  "notifications.enable.label": "Enable notifications",
  "notifications.enable.description":
    "Master switch for all desktop notifications.",
  "notifications.blocked":
    "Notifications are blocked by your system. Allow them for Cetus in your OS settings.",
  "notifications.recheck": "Re-check",
  "notifications.notifyAbout": "Notify me about",
  "notifications.behavior": "Behavior",
  "notifications.mute.label": "Mute while Cetus is focused",
  "notifications.mute.description":
    "Only notify when the window is in the background.",
  // Event catalog (notifications.ts).
  "notifications.event.task_finished.label": "Task finished",
  "notifications.event.task_finished.description":
    "An agent run finished — a chat reply, a board task, or a scheduled automation (whether it succeeded or errored).",
  "notifications.event.awaiting_input.label": "Needs your input",
  "notifications.event.awaiting_input.description":
    "The agent is waiting for you to answer a prompt.",

  // --- Launcher ---------------------------------------------------------
  "launcher.title": "Quick launcher",
  "launcher.description":
    "Summon a floating panel from anywhere to start a session — optionally with a screenshot of your screen as context.",
  "launcher.needAccessibility":
    "The launcher needs Accessibility access to detect the ⌘ gesture system-wide.",
  "launcher.grantAccess": "Grant access",
  "launcher.openSettings": "Open Settings",
  "launcher.accessibilityGranted": "● Accessibility access granted",
  "launcher.needScreenRecording":
    "Screenshots need Screen Recording access — without it Cetus can only capture your wallpaper, not the windows on screen.",
  "launcher.screenRecordingGranted": "● Screen Recording access granted",
  "launcher.macOnly": "The global ⌘ gesture is available on macOS only.",
  "launcher.enable.label": "Enable quick launcher",
  "launcher.enable.description":
    "Trigger: {gesture}. Works even when Cetus is in the background.",
  "launcher.startup.label": "Launch on startup",
  "launcher.startup.description":
    "Start Cetus in the tray automatically when you log in.",
  "launcher.gesture.doubleCmd": "Double-tap ⌘",
  "launcher.gesture.bothCmd": "Hold both ⌘ keys",
  "launcher.gesture.label": "Trigger gesture",
  "launcher.gesture.description": "How you summon the panel from anywhere.",
  "launcher.gesture.opt.both": "Both ⌘",
  "launcher.gesture.opt.bothOpt": "Both ⌥",
  "launcher.gesture.opt.double": "Double-tap ⌘",
  "launcher.gesture.opt.off": "Off",
  "launcher.gesture.opt.doubleOpt": "Double-tap right ⌥",
  "launcher.fn.plain.label": "Quick launch",
  "launcher.fn.plain.description": "Open the launcher (no screenshot).",
  "launcher.fn.shot.label": "Quick launch + screenshot",
  "launcher.fn.shot.description":
    "Select a screen area to attach — click for the full screen — then launch.",
  "launcher.fn.reply.label": "Visual quick reply",
  "launcher.fn.reply.description":
    "Capture the current screen and AX context, ask your chosen agent runtime for reply options, and insert one back into the focused app.",
  "launcher.replyRuntime.label": "Quick-reply runtime",
  "launcher.replyRuntime.description":
    "Use one of the agent runtimes enabled in Settings → Runtimes.",
  "launcher.summon.label": "Summon Cetus",
  "launcher.summon.description":
    "Global shortcut to bring Cetus to the front, switching desktops if it's on another.",
  "launcher.summon.placeholder": "Set shortcut",
  "launcher.summon.recording": "Press keys…",
  "launcher.summon.clear": "Clear shortcut",
  "launcher.session.label": "Default session",
  "launcher.session.description":
    "Start a fresh chat or continue your most recent one.",
  "launcher.session.opt.new": "New",
  "launcher.session.opt.last": "Last",
  "launcher.screenshot.label": "Screenshot by default",
  "launcher.screenshot.description":
    "Capture the screen as context each time the panel opens. You can still toggle it per launch.",

  // --- Appearance -------------------------------------------------------
  "appearance.title": "Appearance",
  "appearance.description":
    "Set the theme used across cetus. Changes apply instantly.",
  "appearance.theme.label": "Theme",
  "appearance.theme.description":
    "Follow the system appearance, or lock to light or dark.",
  "appearance.fontSize.label": "Font size",
  "appearance.fontSize.description":
    "Base size for interface text; chat text and labels scale with it. Independent of ⌘+/⌘− window zoom.",
  "appearance.fontSize.default": "{size} px (default)",
  "appearance.fontSize.option": "{size} px",
  "appearance.lineHeight.label": "Line height",
  "appearance.lineHeight.description":
    "Spacing between lines of interface and chat text.",
  "appearance.lineHeight.compact": "Compact",
  "appearance.lineHeight.default": "Default",
  "appearance.lineHeight.relaxed": "Relaxed",
  "appearance.lineHeight.loose": "Loose",
  "appearance.permaLayers.label": "Smooth hover rendering",
  "appearance.permaLayers.description":
    "Keeps hover fades on dedicated compositing layers so rows don't twitch at fractional zoom. Uses extra graphics memory; turn off to compare.",
  "appearance.skin.label": "Skin",
  "appearance.skin.description":
    "Pick a template, then fine-tune the handful of colors everything else derives from. Light and dark are set separately.",
  "appearance.skin.customized": "customized",
  "appearance.skin.variant.light": "Light",
  "appearance.skin.variant.dark": "Dark",
  "appearance.skin.reset": "Reset to {preset}",
  "appearance.skin.seed.surface": "Surface",
  "appearance.skin.seed.ink": "Ink",
  "appearance.skin.seed.accent": "Accent",
  "appearance.skin.seed.diffAdded": "Diff added",
  "appearance.skin.seed.diffRemoved": "Diff removed",
  "appearance.skin.seed.skill": "Skill",
  "appearance.skin.seed.contrast": "Contrast",

  // --- Keyboard shortcuts ----------------------------------------------
  "keyboard.title": "Keyboard shortcuts",
  "keyboard.description":
    "Customize app shortcuts used while Cetus is focused. Global shortcuts for the launcher and meetings stay in their own sections.",
  "keyboard.search": "Search shortcuts",
  "keyboard.resetAll": "Reset all",
  "keyboard.column.command": "Command",
  "keyboard.column.keybinding": "Keybinding",
  "keyboard.empty": "No shortcuts match your search.",
  "keyboard.unassigned": "Unassigned",
  "keyboard.clear": "Clear shortcut",
  "keyboard.reset": "Reset to default",
  "keyboard.conflict": "Also assigned to {commands}.",
  "keyboard.runtimeSlot.current": "Currently {runtime}.",
  "keyboard.runtimeSlot.pinned":
    "Always {runtime} — the built-in runtime keeps the first slot.",
  "keyboard.runtimeSlot.empty":
    "Empty — enable more runtimes in Settings › Runtimes.",

  // --- Voice dictation --------------------------------------------------
  "voice.title": "Voice dictation",
  "voice.description":
    "Speak instead of type. Pick the recognition engine below, then hold the push-to-talk key to dictate into the focused app.",
  "voice.macOnly": "Voice dictation is available on macOS only.",
  "voice.needPerms":
    "Dictation needs Microphone and Speech Recognition access.",
  "voice.grantAccess": "Grant access",
  "voice.openSettings": "Open Settings",
  "voice.permsGranted": "● Microphone & Speech Recognition access granted",
  "voice.engine.label": "Recognition engine",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) real-time streaming — fastest (~90ms), live text as you speak, great at mixed Chinese/English, works in mainland China. Needs a Doubao API key (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple on-device — instant, audio never leaves your Mac, but weaker at Chinese/English code-switching.",
  "voice.engine.opt.doubao": "Doubao (cloud)",
  "voice.engine.opt.apple": "Apple (on-device)",
  "voice.gesture.rightOption": "Right ⌥",
  "voice.gesture.fn": "fn (Globe)",
  "voice.gesture.rightCmd": "Right ⌘",
  "voice.enable.label": "System-wide dictation",
  "voice.enable.description":
    "Hold {gesture} anywhere to dictate; release to insert the text into the focused app.",
  "voice.needAccessibility":
    "Typing into other apps needs Accessibility access (the same grant the launcher uses).",
  "voice.triggerKey.label": "Trigger key",
  "voice.triggerKey.holdDesc":
    "Hold this modifier to talk and release to insert. A short tap is ignored, so normal shortcuts keep working.",
  "voice.triggerKey.opt.rightCmd": "Right ⌘",
  "voice.triggerKey.opt.rightOption": "Right ⌥",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Caps Lock",
  "voice.triggerKey.capsNote":
    "Cetus reassigns Caps Lock to dictation while it's running and restores it when you quit.",
  "voice.handsfreeShortcut.label": "Hands-free double-tap shortcut",
  "voice.handsfreeShortcut.description":
    "Optional and off by default. Double-tap {gesture} to start or stop hands-free dictation. If that double-tap is assigned to quick reply or the launcher, that action takes priority. Requires Doubao.",
  "voice.insert.label": "Insert with",
  "voice.insert.description":
    "Type sends synthetic keystrokes; Paste uses the clipboard + ⌘V (more robust in some apps, briefly replaces your clipboard).",
  "voice.insert.opt.type": "Type",
  "voice.insert.opt.paste": "Paste",
  "voice.cleanup.label": "Clean up with AI",
  "voice.cleanup.description":
    "Turn raw speech into what you meant to type: collapse self-corrections (“make it 3pm… no wait, 5pm”), drop filler words, fix punctuation. Requires a Volcano Ark (rewrite) API key — a separate LLM key from the Doubao voice key. Push-to-talk only — hands-free inserts each sentence live.",
  "voice.cleanup.modelLabel": "Cleanup model",
  "voice.cleanup.modelHint":
    "Ark model id used for the rewrite. Leave empty for the built-in default; if a snapshot is retired, Cetus automatically falls back to the previous one.",
  "voice.biasing.label": "Bias to your vocabulary",
  "voice.biasing.description":
    "Boost recognition of your terms and what you're writing by sending hotwords plus the focused field's text to Doubao. Also learns from your edits: shortly after inserting, Cetus re-reads the same field and saves spelling fixes you made (e.g. names) to a local correction dictionary. Doubao engine only; password fields are never read.",
  "voice.biasing.hotwordsLabel": "Hotwords",
  "voice.biasing.hotwordsHint":
    "One term per line, under 10 characters each — names, jargon, and product names you say often (English or Chinese). Cetus also learns terms from your dictation automatically.",
  "voice.biasing.hotwordsPlaceholder": "DeepSeek\nTauri\ncetus",
  "voice.biasing.tableLabel": "Hotword table ID",
  "voice.biasing.tableHint":
    "For a larger personal dictionary than the list above holds: create a hotword table (热词词表) in the Volcano console and paste its ID here. The inline list above still takes priority.",
  "voice.biasing.tablePlaceholder": "e.g. 6543210abcdef",
  "voice.startSound.label": "Start sound",
  "voice.startSound.description":
    "Play a soft bubble pop when the dictation capsule appears, so you know it's listening.",
  "voice.history.label": "Save dictation history",
  "voice.history.description":
    "Keep a log of what you dictate so you — and the agent (via the recall_dictation tool) — can refer back to it. Off by default.",
  "voice.history.empty":
    "Nothing dictated yet — your transcripts will show up here.",
  "voice.history.clear": "Clear history ({n})",

  // --- Screen context ---------------------------------------------------
  "screen.title": "Screen context",
  "screen.description":
    "Periodically capture your screen and read it on-device (Apple Vision OCR) so the agent can recall what you were working on. Images and text stay on your Mac — nothing is uploaded.",
  "screen.macOnly":
    "Screen capture is tuned for macOS; on-device OCR uses Apple Vision.",
  "screen.browse": "Browse captured frames",
  "screen.enable.label": "Enable screen capture",
  "screen.enable.description":
    "Off by default. When on, Cetus captures at the moments that matter — pressing Enter, saving or copying, switching windows, pausing after typing — plus a fallback timer.",
  "screen.interval.label": "Fallback interval",
  "screen.interval.description":
    "Seconds between timer captures when no event fires. Near-identical frames are skipped automatically.",
  "screen.interval.unit": "sec",
  "screen.retention.label": "Keep text for",
  "screen.retention.description":
    "Searchable on-screen text older than this is deleted. Text is tiny — this can be long. Set 0 to keep forever.",
  "screen.retention.unit": "days",
  "screen.frameRetention.label": "Keep images for",
  "screen.frameRetention.description":
    "Full frames and thumbnails older than this are deleted from disk; the searchable text above stays. Images are ~99% of the disk use. Set 0 to keep images as long as the text.",
  "screen.frameRetention.unit": "days",
  "screen.ocr.label": "Read text on-device (OCR)",
  "screen.ocr.description":
    "Use Apple Vision to extract on-screen text so the agent can search it. Runs locally.",
  "screen.excluded.label": "Excluded apps",
  "screen.excluded.description":
    "Comma-separated app names or bundle ids. Capture is skipped while one of these is frontmost (e.g. 1Password, Messages).",
  "screen.frames.one":
    "{count} frame captured · macOS asks for Screen Recording permission the first time capture runs.",
  "screen.frames.other":
    "{count} frames captured · macOS asks for Screen Recording permission the first time capture runs.",

  // --- Ambient text context (accessibility collector) --------------------
  "ambient.title": "Ambient context",
  "ambient.description":
    "Keep a rolling, text-only memory of what you're looking at by reading the frontmost app's accessibility tree — window titles, visible text, browser URLs. No screenshots, no keystrokes, never password fields. Everything stays on your Mac.",
  "ambient.enable.label": "Enable ambient context",
  "ambient.enable.description":
    "Off by default. When on, chats can attach a summary of your recent activity via the composer's radar toggle.",
  "ambient.retention.label": "Keep history for",
  "ambient.retention.description":
    "Older entries are deleted automatically. Set 0 to keep forever.",
  "ambient.retention.unit": "days",
  "ambient.excluded.label": "Excluded apps",
  "ambient.excluded.description":
    "Comma-separated app names or bundle ids. Nothing is read while one of these is frontmost (e.g. 1Password, banking apps).",
  "ambient.clear": "Delete all history",
  "ambient.entries.one":
    "{count} entry stored · reading window text uses the Accessibility permission.",
  "ambient.entries.other":
    "{count} entries stored · reading window text uses the Accessibility permission.",

  // --- Computer & Browser control ---------------------------------------
  "agentControl.title": "Computer & Browser control",
  "agentControl.description":
    "Lets the agent drive your browser and Mac apps. Requires Accessibility (and Screen Recording for the live view).",
  "agentControl.browser.label": "Enable browser control",
  "agentControl.browser.description":
    "Enables the Browser Use plugin, which contributes the chrome-devtools MCP tools for driving a managed Chrome. The agent confirms consequential actions and you can stop it any time.",
  "agentControl.computer.label": "Enable computer control",
  "agentControl.computer.description":
    "Adds the computer_* tools for controlling this Mac's apps via accessibility. The agent confirms consequential actions and you can stop it any time.",
  "agentControl.ax.label": "Accessibility access",
  "agentControl.ax.notGranted":
    "Not granted — the agent can't read app UIs or click/type by index.",
  "agentControl.ax.granted": "Granted.",
  "agentControl.checking": "Checking…",
  "agentControl.enabled": "Enabled",
  "agentControl.grant": "Grant",
  "agentControl.openSettings": "Open Settings",
  "agentControl.screen.label": "Screen Recording access",
  "agentControl.screen.notGranted":
    "Not granted — the live screenshot preview won't show.",
  "agentControl.screen.granted": "Granted.",
  "agentControl.footnote":
    "The agent acts through numbered element lists, never raw pixels, and asks before anything consequential (sending, deleting, purchasing, submitting, authenticating). A Stop button appears in the chat while it's active.",

  // --- Plugins ----------------------------------------------------------
  "plugins.title": "Plugins",
  "plugins.description":
    "Capability packages that can contribute prompt guidance, tools, MCP servers, skills, and trusted native integrations.",
  "plugins.import": "Import folder",
  "plugins.importing": "Importing…",
  "plugins.empty": "No plugins found",
  "plugins.source.builtIn": "Built-in",
  "plugins.source.user": "User",
  "plugins.openFolder": "Open folder",
  "plugins.delete": "Delete plugin",
  "plugins.deleteConfirm": "Delete this plugin?",
  "plugins.surface.title": "Choose the right surface",
  "plugins.surface.computer":
    "Native desktop apps, cross-app GUI work, or anything no structured tool can reach.",
  "plugins.surface.browser":
    "Cetus-managed browser for local dev servers, public pages, and isolated temporary sessions.",

  // --- Archived chats ---------------------------------------------------
  "archived.title": "Archived chats",
  "archived.description":
    "Conversations you've archived from the sidebar. Restore one to bring it back, or clear them all to free up space — deletion is permanent.",
  "archived.loading": "Loading…",
  "archived.empty": "No archived chats.",
  "archived.count.one": "{count} archived chat",
  "archived.count.other": "{count} archived chats",
  "archived.deleteAllPrompt": "Delete all {count}?",
  "archived.deleting": "Deleting…",
  "archived.deleteAll": "Delete all",
  "archived.untitled": "Untitled",
  "archived.archivedOn": "Archived {date}",
  "archived.restore": "Restore",
  "archived.deleteAria": "Delete chat",

  "autoArchive.enable.label": "Auto-archive idle chats",
  "autoArchive.enable.description":
    "Automatically move conversations you haven't touched in a while into the archive. They stay restorable here.",
  "autoArchive.threshold.label": "Archive after",
  "autoArchive.threshold.description":
    "How long a conversation can sit untouched before it's archived. Open chats, unread results, and automation results are left alone.",
  "autoArchive.unit.hours": "hours",
  "autoArchive.unit.days": "days",

  "autoDelete.enable.label": "Auto-delete archived chats",
  "autoDelete.enable.description":
    "Permanently delete chats that have sat in the archive for a while. This can't be undone.",
  "autoDelete.threshold.label": "Delete after",
  "autoDelete.threshold.description":
    "How long a chat stays in the archive before it's deleted. Only archived chats are affected; anything still in the sidebar is never touched.",

  // --- Memory -----------------------------------------------------------
  "memory.title": "Memory",
  "memory.description":
    "Durable notes about you — your preferences, ongoing projects, and decisions — that the agent carries across conversations. The agent adds to these as it learns; you can add, edit, mute, or delete any of them here.",
  "memory.enable.label": "Enable memory",
  "memory.enable.description":
    "When on, enabled notes below are injected into the agent's context every turn. Turn off to pause memory without losing your notes.",
  "memory.add.label": "Add a memory",
  "memory.add.placeholder":
    "e.g. Prefers pnpm over npm, and concise commit messages.",
  "memory.category.placeholder": "Category (optional)",
  "memory.adding": "Adding…",
  "memory.add.button": "Add",
  "memory.loading": "Loading…",
  "memory.empty": "No memories yet",
  "memory.count.one": "{count} memory",
  "memory.count.other": "{count} memories",
  "memory.deleteAllPrompt": "Delete all?",
  "memory.clearAll": "Clear all",
  "memory.saving": "Saving…",
  "memory.save": "Save",
  "memory.tag.agent": "Agent",
  "memory.tag.you": "You",
  "memory.editedOn": "Edited {date}",
  "memory.muteAria": "Mute memory",
  "memory.enableAria": "Enable memory",
  "memory.editAria": "Edit memory",
  "memory.deleteAria": "Delete memory",

  // --- Skills -----------------------------------------------------------
  "skills.title": "Skills",
  "skills.description":
    "Reusable instructions the agent can pull in on demand — a folder with a SKILL.md (name + description + steps), following the open Agent Skills standard. Install one from a folder or write your own; enabled skills are offered to the agent every turn.",
  "skills.enable.label": "Enable skills",
  "skills.enable.description":
    "When on, enabled skills below are made available to the agent. Turn off to pause all skills without uninstalling them.",
  "skills.importing": "Importing…",
  "skills.import": "Import folder",
  "skills.write": "Write one",
  "skills.learn": "Learn about skills",
  "skills.loading": "Loading…",
  "skills.empty": "No skills installed",
  "skills.count.one": "{count} skill",
  "skills.count.other": "{count} skills",
  "skills.source.written": "Written",
  "skills.source.imported": "Imported",
  "skills.source.proposed": "Proposed",
  "skills.source.byAgent": "By agent",
  "skills.updatedOn": "Updated {date}",
  "skills.disableAria": "Disable skill",
  "skills.enableAria": "Enable skill",
  "skills.openFolderAria": "Open skill folder",
  "skills.delete": "Delete",
  "skills.uninstallAria": "Uninstall skill",
  "skills.editor.title": "Write a skill",
  "skills.editor.namePlaceholder": "Name, e.g. Commit message style",
  "skills.editor.descPlaceholder": "When should the agent use this? (one line)",
  "skills.editor.bodyPlaceholder":
    "The skill itself, in markdown. Steps, examples, rules…",
  "skills.editor.saving": "Saving…",
  "skills.editor.create": "Create skill",
  "skills.discovered.title": "Discovered skills",
  "skills.discovered.description":
    "Skills found in standard .agents, .claude, and .codex folders or the additional folder below. They're shown here read-only; manage them in their source folder.",
  "skills.discovered.badge": "Global",
  "skills.discovered.repoTitle": "Repo skills",
  "skills.discovered.userTitle": "User skills",
  "skills.discovered.repoBadge": "Repo",
  "skills.discovered.userBadge": "User",
  "skills.discovered.count.one": "{count} discovered skill",
  "skills.discovered.count.other": "{count} discovered skills",
  "skills.discovered.viewAria": "View skill contents",

  // --- Slash commands ---------------------------------------------------
  "slashCmd.title": "Slash commands",
  "slashCmd.description":
    "Reusable prompt snippets you trigger by typing /name in the composer — picking one expands it into the message before it's sent. Stored locally on this device, they appear alongside your skills in the composer's slash menu.",
  "slashCmd.new": "New command",
  "slashCmd.loading": "Loading…",
  "slashCmd.empty": "No commands yet",
  "slashCmd.count.one": "{count} command",
  "slashCmd.count.other": "{count} commands",
  "slashCmd.editAria": "Edit command",
  "slashCmd.delete": "Delete",
  "slashCmd.deleteAria": "Delete command",
  "slashCmd.editor.newTitle": "New slash command",
  "slashCmd.editor.editTitle": "Edit slash command",
  "slashCmd.editor.namePlaceholder": "name, e.g. summarize",
  "slashCmd.editor.descPlaceholder": "What does it do? (one line, optional)",
  "slashCmd.editor.promptPlaceholder":
    "The prompt this expands to. Write it as you'd type the message.",
  "slashCmd.editor.saving": "Saving…",
  "slashCmd.editor.save": "Save",

  // --- MCP --------------------------------------------------------------
  "connectors.title": "MCP",
  "connectors.description":
    "Connect the agent to external tools through MCP (Model Context Protocol) servers — a local command or a remote URL. Add a server and Test it to run a real handshake and see the tools it offers. Every enabled MCP server's tools are loaded into the agent so it can call them like its built-ins; changes take effect in new conversations.",
  "connectors.loading": "Loading…",
  "connectors.empty": "No MCP servers yet",
  "connectors.count.one": "{count} MCP server",
  "connectors.count.other": "{count} MCP servers",
  "connectors.add": "Add MCP server",
  "connectors.disableAria": "Disable MCP server",
  "connectors.enableAria": "Enable MCP server",
  "connectors.editAria": "Edit MCP server",
  "connectors.removeAria": "Remove MCP server",
  "connectors.editor.name": "Name",
  "connectors.editor.namePlaceholder": "e.g. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Transport",
  "connectors.editor.transportDesc":
    "A local process (stdio) or a remote MCP endpoint (HTTP/SSE).",
  "connectors.editor.command": "Command",
  "connectors.editor.commandPlaceholder": "e.g. npx",
  "connectors.editor.args": "Arguments",
  "connectors.editor.argsHint": "one per line",
  "connectors.editor.env": "Environment",
  "connectors.editor.envHint": "passed to the process",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "Headers",
  "connectors.editor.headersHint": "sent with each request",
  "connectors.test.connected": "Connected",
  "connectors.test.tools.one": "{count} tool: {names}",
  "connectors.test.tools.other": "{count} tools: {names}",
  "connectors.test.noTools": "Handshake OK — server exposes no tools.",
  "connectors.test.failed": "Connection failed.",
  "connectors.editor.saving": "Saving…",
  "connectors.testing": "Testing…",
  "connectors.test.button": "Test",
  "connectors.editor.envName": "KEY",
  "connectors.editor.envValue": "value",
  "connectors.editor.addEnv": "Add variable",
  "connectors.editor.headerName": "Name",
  "connectors.editor.headerValue": "Value",
  "connectors.editor.addHeader": "Add header",
  "connectors.editor.removeRow": "Remove",
  "connectors.details.toggleAria": "Toggle tools",
  "connectors.details.loading": "Loading tools…",
  "connectors.details.connected": "Connected",
  "connectors.details.toolCount.one": "{count} tool",
  "connectors.details.toolCount.other": "{count} tools",
  "connectors.oauth.auth": "Authentication",
  "connectors.oauth.authDesc":
    "Static headers, or OAuth (Cetus runs the sign-in flow).",
  "connectors.oauth.none": "None",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "auto (dynamic registration)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "optional",
  "connectors.oauth.authorize": "Authorize",
  "connectors.oauth.authorizing": "Authorizing…",
  "connectors.oauth.authorized": "Authorized — tokens cached.",
  "connectors.oauth.hint": "Opens your browser to sign in.",
  "connectors.oauth.saveHint":
    "Save the MCP server, then expand it below and click Authorize.",
  "discovery.mcp.none": "No servers found (config file absent).",
  "discovery.mcp.title": "Import from other apps",
  "discovery.mcp.description":
    "Also load MCP servers configured in these apps. Applies to new chats only.",
  "skills.discovered.loadLabel": "Load discovered skills",
  "skills.discovered.loadDesc":
    "Include skills from the folder below plus standard .agents, .claude, and .codex skill folders in new chats.",
  "skills.discovered.chooseFolder": "Choose folder",
};
