import AppKit
import SwiftUI

/// The composer, after Cetus's composer.tsx: Enter sends, Shift+Enter breaks a
/// line, `/` opens the slash menu, `@` the mention menu, `!` runs a shell
/// command, Tab cycles the runtime. Messages typed while a turn runs queue up
/// and can be steered in. Drafts persist per conversation.
struct ComposerView: View {
    let convId: String?
    var hero = false
    @Environment(AppState.self) private var app
    @Environment(\.fontScale) private var scale
    @Environment(\.lineScale) private var lineScale
    @Environment(\.composerSent) private var onSent // New task dialog: stay on the board
    @Environment(\.composerPlaceholder) private var placeholderOverride

    @State private var text = ""
    @State private var attachments: [Attachment] = []
    @State private var refs: [MentionRef] = []
    /// Starts at the last height measured for this draft (else the 56pt
    /// minimum): the real one only arrives a frame after layout, and switching
    /// chats rebuilds the composer, so a stale start made it (and the queued
    /// list above it) jump on every switch.
    @State private var height: CGFloat
    nonisolated(unsafe) private static var lastHeight: [String: CGFloat] = [:]
    @State private var menuIndex = 0
    @State private var dismissed: String?
    @State private var files: [WorkspaceFile] = []
    @State private var filesRoot = ""
    @State private var branch: String?
    @State private var loadedKey: String?
    @State private var workspaceFrame = CGRect.zero
    @State private var runtimeFrame = CGRect.zero
    @State private var modelFrame = CGRect.zero
    @State private var dropHover = false
    @State private var menus = ComposerMenus()

    init(convId: String?, hero: Bool = false) {
        self.convId = convId
        self.hero = hero
        _height = State(initialValue: Self.lastHeight[convId ?? "new"] ?? 56)
    }

    private var controller: Controller { app.controller }
    private var draftKey: String { convId ?? "new" }
    private var conversation: Conversation? { controller.conversation(convId) }
    private var chat: ChatModel? { convId.map { controller.chat($0) } }
    private var busy: Bool { chat?.isStreaming ?? false }
    private var selection: Selection { app.selection }
    private var runtime: Runtime { Runtimes.byId(selection.runtime) }
    private var workspace: String { conversation.map { $0.workspaceDir.isEmpty ? app.selection.workspace : $0.workspaceDir } ?? selection.workspace }
    private var bashMode: Bool { text.hasPrefix("!") }

    enum Menu: Equatable { case slash(String, start: Int), mention(String, start: Int) }

    /// The open `/` or `@` token at the caret (ComposerMenus.token).
    private var menu: Menu? {
        switch menus.token(text, bash: bashMode) {
        case .slash(let q, let start): return .slash(q, start: start)
        case .mention(let q, let start): return .mention(q, start: start)
        case nil: return nil
        }
    }

    /// Live session catalog, else the runtime probe (keyed to this runtime + cwd).
    private var nativeCommands: [SlashCommand] {
        if let c = chat?.commands, !c.isEmpty { return c }
        return SlashProbe.shared.catalog(selection.runtime, workspace)
    }

    private var slashItems: [SlashItem] {
        guard case .slash(let q, _) = menu else { return [] }
        return SlashCatalog.items(backend: selection.runtime, query: q, native: nativeCommands, local: menus.local, skills: menus.skills)
    }

    private var mentionItems: [MentionItem] {
        guard case .mention(let q, _) = menu else { return [] }
        return MentionSources.items(tab: menus.tab, query: q, automations: menus.automations, artifacts: menus.artifacts,
                                    files: menus.files, conversations: menus.conversations, current: convId)
    }

    static func isChatWorkspace(_ dir: String) -> Bool { dir.isEmpty || dir == Env.chatDir }
    static func workspaceLabel(_ dir: String) -> String { isChatWorkspace(dir) ? "Chat" : Env.folderName(dir) }

    var body: some View {
        let slash = slashItems
        let mentions = mentionItems
        let slashOpen = menu?.isSlash == true && !slash.isEmpty
        let mentionOpen = menu?.isSlash == false
        VStack(spacing: 8) {
            if let chat, !chat.queue.isEmpty { queueList(chat) }
            frame(menuOpen: slashOpen || mentionOpen)
                .overlay(alignment: .top) {
                    if slashOpen || mentionOpen {
                        // Zero-height anchor at the frame's top: the menu grows upward, 8px above.
                        Group {
                            if slashOpen { slashMenu(slash) } else { mentionMenu(mentions) }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        // absolute inset-x-0 bottom-full mb-2 against the frame's padding box (inside the 1px border).
                        .padding(.bottom, 7)
                        .padding(.horizontal, 1)
                        .frame(height: 0, alignment: .bottom)
                    }
                }
                .zIndex(1)
        }
        .onAppear { loadDraft() }
        .onChange(of: draftKey) { _, _ in loadDraft() }
        .onChange(of: text) { old, new in
            menus.edited()
            if let (t, pos) = ComposerMenus.pillBackspace(old: old, new: new, refs: refs) {
                text = t
                ComposerMenus.placeCaret(app, pos)
                return
            }
            let live = Mentions.inText(new, refs: refs)
            if live.count != refs.count { refs = live }
            saveDraft()
        }
        .onChange(of: attachments) { _, _ in saveDraft() }
        .onChange(of: height) { _, h in Self.lastHeight[draftKey] = h }
        .onReceive(NotificationCenter.default.publisher(for: NSTextView.didChangeSelectionNotification)) { n in
            guard let v = n.object as? NSTextView, v === app.composerView else { return }
            menus.caret = v.selectedRange().location
        }
        .onChange(of: menu) { old, m in
            menus.slashActive = 0
            menus.mentionActive = 0
            app.composerMenuOpen = m != nil
            if m?.isSlash == true && old?.isSlash != true {
                menus.slashOpened()
                if chat?.commands.isEmpty ?? true { SlashProbe.shared.probe(selection.runtime, workspace, refreshIfStale: true) }
            }
            if m?.isSlash == false && (old == nil || old?.isSlash == true) {
                menus.mentionOpened(controller, state: chat?.state)
                menus.resetFiles()
            }
            loadMentionFiles()
        }
        .onChange(of: menus.tab) { _, _ in menus.mentionActive = 0; loadMentionFiles() }
        .onChange(of: workspace, initial: true) { _, w in WorkspaceFiles.gitBranch(w) { branch = $0 } }
        .onChange(of: selection.runtime, initial: true) { _, r in
            controller.loadCliDefaults(r)
            // Prewarm the runtime's slash catalog for a composer with no live session.
            if chat?.commands.isEmpty ?? true { SlashProbe.shared.probe(r, workspace, refreshIfStale: false) }
        }
        .onChange(of: app.composerDrop?.token) { _, _ in
            if let d = app.composerDrop { app.composerDrop = nil; addPaths(d.paths) }
        }
        .onChange(of: app.composerInsert?.token) { _, _ in
            guard let ins = app.composerInsert else { return }
            setText(ins.replace ? ins.text : (text.isEmpty ? ins.text : text + (text.hasSuffix("\n") ? "" : "\n") + ins.text))
            app.composerInsert = nil
            app.focusComposer()
        }
    }

    // MARK: - Menus

    private func slashMenu(_ items: [SlashItem]) -> some View {
        SlashMenuView(items: items, active: min(menus.slashActive, max(0, items.count - 1)),
                      onSelect: { applySlash($0) }, onHover: { menus.slashActive = $0 },
                      onCreate: { openCommandDialog(nil) }, onEdit: { openCommandDialog($0) })
    }

    private func mentionMenu(_ items: [MentionItem]) -> some View {
        MentionMenuView(tab: menus.tab, items: items, active: max(0, min(menus.mentionActive, items.count - 1)),
                        loading: (menus.tab == .all || menus.tab == .file) && menus.filesLoading,
                        onTab: { menus.tab = $0; menus.mentionActive = 0 },
                        onSelect: { applyMention($0) }, onHover: { menus.mentionActive = $0 })
    }

    private func loadMentionFiles() {
        guard case .mention(let q, _) = menu, menus.tab == .all || menus.tab == .file else { return }
        menus.loadFiles(workspace, query: q)
    }

    /// Replace the `/token` with the picked item: a command expands to its prompt;
    /// a skill inserts the runtime's invocation token (`$name` on Codex).
    private func applySlash(_ item: SlashItem) {
        guard case .slash(_, let start) = menu else { return }
        let insert = item.kind == .command ? item.prompt : selection.runtime == "codex" ? "$\(item.name) " : "/\(item.name) "
        let (t, pos) = menus.replace(text, start: start, insert: insert)
        text = t
        menus.slashSuppress = true
        ComposerMenus.placeCaret(app, pos)
        app.focusComposer()
    }

    /// Replace the `@token` with `@label ` and record what the label points at.
    private func applyMention(_ item: MentionItem) {
        guard case .mention(_, let start) = menu else { return }
        var r = item.ref
        r.label = Mentions.uniqueLabel(item.label, existing: refs, incoming: r)
        if !refs.contains(where: { $0.label == r.label }) { refs.append(r) }
        let (t, pos) = menus.replace(text, start: start, insert: "@\(r.label) ")
        text = t
        menus.mentionSuppress = true
        ComposerMenus.placeCaret(app, pos)
        app.focusComposer()
    }

    /// The slash menu's "New command" (seeded with the typed token) / row pencil.
    private func openCommandDialog(_ item: SlashItem?) {
        guard case .slash(let q, let start) = menu else { return }
        menus.slashSuppress = true
        DialogHost.present("slash-command", app: app) {
            SlashCommandDialogView(command: item, initialName: q) { saved, created in
                if created {
                    // The token that opened the menu expands to the new prompt.
                    let ns = text as NSString
                    let end = min(start + 1 + (q as NSString).length, ns.length)
                    text = ns.replacingCharacters(in: NSRange(location: start, length: max(0, end - start)), with: saved.prompt)
                    ComposerMenus.placeCaret(app, start + (saved.prompt as NSString).length)
                } else {
                    menus.slashSuppress = false
                    menus.slashOpened()
                }
                app.focusComposer()
            }
        }
    }

    // MARK: - Frame

    private var placeholder: String {
        if bashMode { return "Send a shell command to Terminal. ⏎ run, ⇧⏎ newline." }
        if hero { return HeroCopy.withFocusHint(placeholderOverride ?? HeroCopy.placeholders[app.placeholderIndex % HeroCopy.placeholders.count]) }
        if busy { return "Agent is running… ⏎ to queue a follow-up (⇧⏎ newline). Press / to focus." }
        return "Message the agent. ⏎ send, ⇧⏎ newline. Press / to focus."
    }

    @ViewBuilder
    private func frame(menuOpen: Bool) -> some View {
        let tint = Theme.runtimeColor(selection.runtime)
        let shape = RoundedRectangle(cornerRadius: 16)
        VStack(alignment: .leading, spacing: 0) {
            if bashMode {
                HStack(spacing: 6) {
                    Glyph(name: "terminal", size: 12, color: Theme.primary)
                    Text("Terminal mode — opens Terminal and runs this command").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.primary).lineBox(16.2)
                }
                .padding(.horizontal, 10).padding(.top, 6)
            }
            if !attachments.isEmpty {
                HStack(spacing: 8) { ForEach(attachments) { a in attachmentTile(a) } }
                    .padding(.horizontal, 6).padding(.top, 4).padding(.bottom, 6)
            }
            ComposerTextView(
                text: $text, height: $height,
                placeholder: placeholder,
                fontSize: 14 * scale, lineScale: lineScale, mono: false, mentionLabels: refs.map(\.label),
                minHeight: 56, maxHeight: hero ? 320 : 240,
                inset: hero ? NSSize(width: 12, height: 12) : NSSize(width: 10, height: 8),
                onCommand: { handle($0, menuOpen: menuOpen) },
                onPasteFiles: { addPaths($0) },
                onPasteImage: { pasteImage($0) },
                register: { app.composerView = $0 })
                .frame(height: height)
                .testID("composer")
            toolbar
        }
        .padding(hero ? 9 : 7) // 1px border + p-2 / p-1.5
        .background(shape.fill(Theme.card))
        .overlay(shape.strokeBorder(bashMode ? Theme.primary.opacity(0.6) : tint.opacity(0.6), lineWidth: 1))
        .overlay {
            if bashMode { RoundedRectangle(cornerRadius: 17).strokeBorder(Theme.primary.opacity(0.4), lineWidth: 1).padding(-1) }
            else if busy { StreamingRing(color: tint) }
        }
        .overlay {
            if dropHover || app.fileDragActive {
                ZStack {
                    shape.fill(Theme.primary.opacity(0.1))
                    Text("Drop files to attach").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.primary)
                }
                .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.primary, lineWidth: 2).padding(-4))
            }
        }
        .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
        .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
        .onDrop(of: [.fileURL], isTargeted: $dropHover) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { DispatchQueue.main.async { addPaths([url.path]) } }
                }
            }
            return true
        }
        .testID("composer-frame")
    }

    /// 56px image thumb or file tile with a hover-only remove badge.
    private func attachmentTile(_ a: Attachment) -> some View {
        AttachmentTile(a: a) { attachments.removeAll { $0.path == a.path } }
            .testID("attachment-chip")
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                GhostIconButton(icon: "paperclip", box: 32, glyph: 12, tip: "Attach file", testID: "attach") { pickFiles() }
                pill(id: "workspace", frame: $workspaceFrame, enabled: true, maxWidth: 208) {
                    Glyph(name: Self.isChatWorkspace(workspace) ? "message-square" : "folder", size: 12, color: Theme.mutedForeground)
                    Text(clip(Self.workspaceLabel(workspace), 22)).lineLimit(1)
                    if let branch, !Self.isChatWorkspace(workspace) {
                        HStack(spacing: 4) {
                            Text("/")
                            Text(clip(branch, 16)).lineLimit(1)
                        }
                        .foregroundStyle(Theme.mutedForeground.opacity(0.7))
                    }
                }
                pill(id: "runtime", frame: $runtimeFrame, color: Theme.runtimeColor(runtime.id)) {
                    RuntimeIcon(id: runtime.id, size: 12)
                    Text(runtime.label).lineLimit(1)
                }
                if Runtimes.hasModelMenu(runtime.id) {
                    pill(id: "model", frame: $modelFrame, chevron: 12, chevronOpacity: 0.6, gap: 4) {
                        Text(tuningLabel).lineLimit(1)
                    }
                }
                AmbientChip()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let warn = rateWarning {
                Text(warn).font(.system(size: 11)).foregroundStyle(Theme.amber).help("Rate limit status from \(runtime.label)")
            }
            sendButton
        }
        .padding(.horizontal, 4).padding(.top, 2).padding(.bottom, 4)
    }

    private func clip(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n - 1)) + "…" : s }

    private var defaults: CliDefaults? { controller.cliDefaults[runtime.id] }
    private var modelCatalog: [Option] { defaults?.catalog(runtime) ?? runtime.models }
    /// The checked model row: the persisted choice, else what the CLI runs by default.
    private var currentModel: Option? {
        if runtime.id == "pi" {
            // ModelPicker: the built-in tier ("pro" is the retired alias), else a custom "<provider>/<model>".
            let m = selection.model
            if m.isEmpty || m == "flash" || m == "pro" { return runtime.models.first }
            return Option(id: m, label: m.split(separator: "/").dropFirst().joined(separator: "/").nonEmpty ?? m)
        }
        return runtime.id == "dsh" ? runtime.models.first : CliDefaults.resolve(selection.model, modelCatalog, defaults)
    }
    private var currentEffort: Option? {
        if runtime.id == "pi" {
            // A level the model lacks is clamped host-side (up the axis first, then down); mirror it.
            let axis = Runtimes.piReasoningAxis
            let want = axis.contains(selection.effort) ? selection.effort : "high"
            guard currentModel?.id == "flash" else { return nil }
            let i = axis.firstIndex(of: want)!
            for id in Array(axis[i...]) + axis[..<i].reversed() { if let hit = runtime.efforts.first(where: { $0.id == id }) { return hit } }
            return nil
        }
        return runtime.efforts.first { $0.id == selection.effort } ?? CliDefaults.resolveDefault(defaults?.effort, runtime.efforts)
    }

    /// `${model} · ${effort}`; raw ids stand in for unknown ones, "Model" when nothing is known.
    private var tuningLabel: String {
        if runtime.id == "pi" { return [currentModel?.label ?? "Flash", currentEffort?.label].compactMap { $0 }.joined(separator: " · ") }
        let m = currentModel?.label ?? (selection.model.isEmpty ? nil : selection.model) ?? defaults?.model ?? "Model"
        let e = currentEffort?.label ?? (selection.effort.isEmpty ? nil : selection.effort) ?? defaults?.effort
        return e.map { "\(m) · \($0)" } ?? m
    }

    private var rateWarning: String? {
        guard let info = controller.rateLimits[selection.runtime] else { return nil }
        let status = info["status"].stringValue
        guard status == "allowed_warning" || status == "rejected" else { return nil }
        let pct = info["utilization"].double.map { " \(Int($0 * 100))%" } ?? ""
        return status == "rejected" ? "Rate limited" : "Quota\(pct)"
    }

    private func pill<Label: View>(id: String, frame: Binding<CGRect>, enabled: Bool = true, color: Color? = nil, maxWidth: CGFloat? = nil,
                                   chevron: CGFloat = 16, chevronOpacity: Double = 0.5, gap: CGFloat = 6, @ViewBuilder label: () -> Label) -> some View {
        Button {
            guard enabled else { return }
            if app.popup?.id == id { app.popup = nil; return }
            let content: AnyView
            switch id {
            case "workspace": content = AnyView(MenuList(items: workspaceMenu(), style: .select, minWidth: frame.wrappedValue.width, maxWidth: 352))
            case "runtime": content = AnyView(MenuList(items: runtimeMenu(), style: .select, minWidth: frame.wrappedValue.width))
            default: content = AnyView(MenuList(items: modelMenu(), style: .dropdown, minWidth: 176))
            }
            app.popup = PopupSpec(id: id, anchor: frame.wrappedValue, style: id == "model" ? .dropdown : .select, content: content)
        } label: {
            PillLabel(color: color, enabled: enabled, chevron: chevron, chevronOpacity: chevronOpacity, gap: gap, active: false) { label() }
                .fixedSize()
        }
        .buttonStyle(.plain)
        .readFrame(frame)
        .if(!enabled) { $0.tip("The workspace is fixed once a chat starts", side: .top) }
        .testID(id)
    }

    private func close(_ f: @escaping () -> Void) -> () -> Void { { app.popup = nil; f() } }

    /// Current workspace, Chat, then the recents (WorkspacePicker's options),
    /// followed by the Remote SSH… / Add folder… actions.
    /// page.tsx onWorkspaceChange: the selection, plus the open chat's folder.
    private func setWorkspace(_ d: String) {
        app.setSelection { $0.workspace = d }
        if let c = conversation { controller.setWorkspace(c.id, d) }
    }

    private func workspaceMenu() -> [MenuItem] {
        var dirs: [String] = []
        for d in [workspace, Env.chatDir] + app.prefs.recentWorkspaces where !dirs.contains(d) { dirs.append(d) }
        var items = dirs.enumerated().map { i, d in
            let chat = Self.isChatWorkspace(d)
            let remote = d.hasPrefix("ssh://") || d.range(of: #"^[^/:\s]+@?[^/:\s]+:"#, options: .regularExpression) != nil
            return MenuItem(id: d, title: Self.workspaceLabel(d),
                            icon: AnyView(Glyph(name: chat ? "message-square" : remote ? "server" : "folder", size: 16)),
                            checked: d == workspace || (chat && Self.isChatWorkspace(workspace)), testID: chat ? "workspace-chat" : "workspace-\(i)",
                            action: close { setWorkspace(d) })
        }
        items.append(MenuItem(id: "remote", title: "Remote SSH…", icon: AnyView(Glyph(name: "server", size: 16)), group: " ", testID: "workspace-remote", muted: true,
                              action: close { app.remoteSSH = true }))
        items.append(MenuItem(id: "choose", title: "Add folder…", icon: AnyView(Glyph(name: "folder-plus", size: 16)), group: " ", testID: "workspace-choose", muted: true,
                              action: close { chooseFolder() }))
        return items
    }

    /// BackendPicker: runtimes and saved presets in the unified order; the check
    /// sits on the preset whose fixed tuning matches, else on the runtime.
    private func runtimeMenu() -> [MenuItem] {
        let matched = ChatRuntimeEntries.matchedPreset(app.prefs, selection)
        var items = ChatRuntimeEntries.entries(app.prefs).enumerated().map { i, e -> MenuItem in
            let hint = i < 9 ? Shortcuts.hint("runtime\(i + 1)", app.prefs) : nil
            switch e {
            case .preset(let p):
                return MenuItem(id: p.id, title: p.label, icon: AnyView(RuntimeIcon(id: p.backend, size: 16)), checked: matched?.id == p.id,
                                hint: hint, testID: "runtime-\(i)", action: close { ChatRuntimeEntries.apply(p, app: app) })
            case .runtime(let id):
                let r = Runtimes.byId(id)
                let quota = controller.rateLimits[r.id]?["utilization"].double.map { "\(Int($0 * 100))% used" }
                return MenuItem(id: r.id, title: r.label, subtitle: quota, icon: AnyView(RuntimeIcon(id: r.id, size: 16)), checked: matched == nil && r.id == selection.runtime,
                                hint: hint, testID: "runtime-\(i)", action: close { app.selectRuntime(r.id) })
            }
        }
        items.append(MenuItem(id: "runtime-settings", title: "Runtime settings…", icon: AnyView(Glyph(name: "settings-2", size: 16)), testID: "runtime-settings",
                              action: close { app.settingsSection = "Runtimes"; app.settings = true }))
        return items
    }

    /// CliTuningMenu: reasoning levels flat on top, the model catalog in a submenu.
    private func modelMenu() -> [MenuItem] {
        let pi = runtime.id == "pi"
        let effortRows = pi && currentModel?.id != "flash" ? [] : runtime.efforts
        let efforts = effortRows.enumerated().map { i, e in
            MenuItem(id: "e:\(e.id)", title: e.label, checked: e.id == currentEffort?.id, group: "Reasoning", testID: "effort-\(i)",
                     action: close { app.setSelection { $0.effort = e.id } })
        }
        let models = modelCatalog.enumerated().map { i, m in
            MenuItem(id: "m:\(m.id)", title: m.label, icon: pi ? AnyView(Glyph(name: "zap", size: 16, color: Theme.foreground)) : nil,
                     checked: m.id == currentModel?.id, group: "Model", testID: "model-\(i)",
                     action: close { app.setSelection { $0.model = m.id } })
        }
        let shown = currentModel?.label ?? (selection.model.isEmpty ? nil : selection.model) ?? defaults?.model ?? "Model"
        return efforts + [MenuItem(id: "models", title: shown, group: efforts.isEmpty ? nil : " ", testID: "model-sub", submenu: models)]
    }

    private var sendButton: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty
        // Terminal mode always offers Run; a running turn always offers Abort (⏎ still queues).
        let stop = busy && !bashMode
        let bashEmpty = String(text.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return SendButton(kind: stop ? .stop : bashMode ? .bash : .send, disabled: !stop && (bashMode ? bashEmpty : empty)) {
            if stop, let convId { controller.abort(convId) } else { submit() }
        }
        .tip(stop ? "Abort" : bashMode ? "Run in Terminal" : "Send", side: .top)
        .testID(stop ? "stop" : "send")
    }

    // MARK: - Queue

    private func queueList(_ chat: ChatModel) -> some View {
        VStack(spacing: 4) {
            ForEach(Array(chat.queue.enumerated()), id: \.element.id) { i, q in
                HStack(spacing: 8) {
                    Text("QUEUED").font(.system(size: 11, weight: .medium)).tracking(0.55).foregroundStyle(Theme.mutedForeground)
                    Text(q.text.isEmpty ? (q.attachments.isEmpty ? "(empty)" : "\(q.attachments.count) attachment\(q.attachments.count == 1 ? "" : "s")") : q.text)
                        .font(.system(size: 12)).foregroundStyle(Theme.foreground.opacity(0.8)).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    GhostIconButton(icon: "pencil", box: 16, glyph: 12, hoverFill: Theme.muted, tip: "Edit queued message") {
                        if let item = controller.unqueue(chat.id, queuedId: q.id) {
                            setText(item.text)
                            attachments = item.attachments
                            refs = item.mentions
                            app.focusComposer()
                        }
                    }
                    if ChatSteer.supports(conversation?.backend ?? selection.runtime) {
                    Button { controller.steer(chat.id, queuedId: q.id) } label: {
                        HStack(spacing: 4) {
                            Glyph(name: "arrow-up", size: 12, color: Theme.primary)
                            Text("Steer now").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.primary)
                        }
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .hoverFill(Theme.primary.opacity(0.1), radius: 8)
                    }
                    .buttonStyle(.plain)
                    .help("Send now — inject into the current run (steer)")
                    .testID("steer-\(i)")
                    }
                    GhostIconButton(icon: "x", box: 18, glyph: 14, hoverFill: Theme.muted, tip: "Remove from queue") { controller.unqueue(chat.id, queuedId: q.id) }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
            }
        }
        .testID("queue")
    }

    // MARK: - Actions

    /// composer-view.tsx onKeyDown: the open menu owns ↑/↓/⏎/Tab/Esc; otherwise
    /// Tab walks the runtime picker rows (runtimes and presets).
    private func handle(_ cmd: ComposerCommand, menuOpen: Bool) -> Bool {
        if menu?.isSlash == true {
            let items = slashItems
            if !items.isEmpty {
                switch cmd {
                case .down: menus.slashActive = (min(menus.slashActive, items.count - 1) + 1) % items.count; return true
                case .up: menus.slashActive = (min(menus.slashActive, items.count - 1) - 1 + items.count) % items.count; return true
                case .submit, .newline, .tab, .backtab: applySlash(items[min(menus.slashActive, items.count - 1)]); return true
                case .escape: menus.slashSuppress = true; return true
                }
            }
        } else if menu != nil {
            let items = mentionItems
            let n = max(1, items.count)
            switch cmd {
            case .down: menus.mentionActive = min(menus.mentionActive + 1, n - 1); return true
            case .up: menus.mentionActive = max(menus.mentionActive - 1, 0); return true
            case .tab: menus.tab = menus.tab.next(1); menus.mentionActive = 0; return true
            case .backtab: menus.tab = menus.tab.next(-1); menus.mentionActive = 0; return true
            case .submit, .newline:
                if items.isEmpty { menus.mentionSuppress = true } // nothing to pick: Enter sends as usual
                else { applyMention(items[max(0, min(menus.mentionActive, items.count - 1))]); return true }
            case .escape: menus.mentionSuppress = true; return true
            }
        }
        switch cmd {
        case .submit: submit(); return true
        case .newline:
            app.composerView?.insertText("\n", replacementRange: app.composerView?.selectedRange() ?? NSRange(location: 0, length: 0))
            return true
        case .tab: ChatRuntimeEntries.cycle(1, app: app); return true
        case .backtab: return false
        case .escape:
            if app.popup != nil { app.popup = nil; return true }
            return app.escape()
        case .up, .down: return false
        }
    }

    private func setText(_ t: String) {
        text = t
        dismissed = nil
    }

    private func loadDraft() {
        guard loadedKey != draftKey else { return }
        loadedKey = draftKey
        let d = controller.prefStore.value.drafts[draftKey]
        text = d?.text ?? ""
        attachments = (d?.attachments ?? []).compactMap { try? Attachment.make($0).get() }
        refs = d?.mentions ?? []
        dismissed = nil
    }

    private func saveDraft() {
        guard loadedKey == draftKey else { return }
        controller.prefStore.setDraft(draftKey, Draft(text: text, attachments: attachments.map(\.path), mentions: refs.isEmpty ? nil : refs))
    }

    /// Clear and persist the empty draft now: sending from a new chat switches
    /// the draft key in the same update, which would skip the save.
    private func clear() {
        controller.prefStore.setDraft(draftKey, nil)
        text = ""
        attachments = []
        refs = []
        dismissed = nil
    }

    private func submit() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if bashMode {
            let command = String(body.dropFirst()).trimmingCharacters(in: .whitespaces)
            guard !command.isEmpty else { return }
            clear()
            let id = controller.runBash(SendOptions(conversationId: convId, text: command, backend: selection.runtime, model: selection.model, effort: selection.effort, workspaceDir: workspace))
            sent(id)
            return
        }
        if selection.runtime == "codex" && attachments.isEmpty {
            // Codex's composer-handled commands: /status toasts, /model and /reasoning open the tuning menu.
            if body == "/status" { CodexStatus.show(app: app, convId: convId); text = ""; return }
            if body == "/model" || body == "/reasoning" {
                text = ""
                DispatchQueue.main.async {
                    app.popup = PopupSpec(id: "model", anchor: modelFrame, style: .dropdown, content: AnyView(MenuList(items: modelMenu(), style: .dropdown, minWidth: 176)))
                }
                return
            }
        }
        let mentions = Mentions.inText(body, refs: refs)
        var bare = body
        for m in mentions { bare = bare.replacingOccurrences(of: "@\(m.label)", with: "") }
        let onlyFunctions = bare.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && !mentions.contains { $0.kind != .function }
        if body.isEmpty || onlyFunctions {
            // Enter on an empty composer steers the first queued message.
            if body.isEmpty, let convId, let first = chat?.queue.first { controller.steer(convId, queuedId: first.id) }
            return
        }
        let id = controller.send(SendOptions(conversationId: convId, text: AmbientCollector.composeForSend(body), backend: selection.runtime, model: selection.model, effort: selection.effort, workspaceDir: workspace, attachments: attachments, mentions: mentions))
        controller.prefStore.touchWorkspace(workspace)
        clear()
        sent(id)
    }

    private func sent(_ id: String) {
        if let onSent { onSent(id); return }
        if convId != id { app.setView(ViewState(page: .chats, active: id)) }
        app.scrollToBottomToken += 1
    }

    private func addPaths(_ paths: [String]) {
        for p in paths {
            switch Attachment.make(p) {
            case .success(let a): if !attachments.contains(where: { $0.path == a.path }) { attachments.append(a) }
            case .failure(let e): app.toast("Can't attach", e.message, kind: .error)
            }
        }
    }

    private func pasteImage(_ img: NSImage) {
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return }
        let dir = Env.dataDir.appendingPathComponent("pasted")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let url = dir.appendingPathComponent("Pasted image \(f.string(from: Date())).png")
        try? png.write(to: url)
        addPaths([url.path])
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Attach"
        if let w = app.window {
            panel.beginSheetModal(for: w) { r in if r == .OK { addPaths(panel.urls.map(\.path)) } }
        } else if panel.runModal() == .OK {
            addPaths(panel.urls.map(\.path))
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        let done: (NSApplication.ModalResponse) -> Void = { r in
            guard r == .OK, let dir = panel.url?.path else { return }
            controller.prefStore.touchWorkspace(dir)
            setWorkspace(dir)
        }
        if let w = app.window { panel.beginSheetModal(for: w, completionHandler: done) } else { done(panel.runModal()) }
    }
}

/// WorkspacePicker's "Remote SSH workspace" dialog: sm:max-w-md, an input and Connect.
struct RemoteSSHDialog: View {
    @Environment(AppState.self) private var app
    @State private var value = ""
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea().onTapGesture { app.remoteSSH = false }
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    Text("Remote SSH workspace").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(18)
                    Spacer()
                    GhostIconButton(icon: "x", box: 16, glyph: 16) { app.remoteSSH = false }.opacity(0.7)
                }
                HStack(spacing: 8) {
                    TextField("ssh://user@host:2222/work/repo", text: $value)
                        .textFieldStyle(.plain).font(.system(size: 14)).focused($focused)
                        .padding(.horizontal, 12).frame(height: 36)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.input.opacity(0.3)))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? Theme.mutedForeground.opacity(0.5) : Theme.input, lineWidth: 1))
                        .onSubmit(connect)
                        .testID("remote-ssh-input")
                    Button("Connect", action: connect).buttonStyle(CetusButtonStyle()).testID("remote-ssh-connect")
                }
            }
            .padding(24)
            .frame(width: 448)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
        }
        .onAppear { focused = true }
        .onExitCommand { app.remoteSSH = false }
    }

    private func connect() {
        let v = value.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        app.controller.prefStore.touchWorkspace(v)
        app.setSelection { $0.workspace = v }
        app.remoteSSH = false
    }
}

extension ComposerView.Menu {
    var isSlash: Bool { if case .slash = self { return true }; return false }
}

/// Select trigger: h28, px8, 12px text, hover muted; trailing chevron.
private struct PillLabel<Content: View>: View {
    var color: Color?
    var enabled: Bool
    var chevron: CGFloat
    var chevronOpacity: Double
    var gap: CGFloat
    var active: Bool
    @ViewBuilder var content: Content
    @State private var hover = false
    var body: some View {
        HStack(spacing: gap) {
            content
            if enabled { Glyph(name: "chevron-down", size: chevron, color: Theme.mutedForeground).opacity(chevronOpacity) }
        }
        .font(.system(size: 12))
        .foregroundStyle(color ?? (hover || active ? Theme.foreground : Theme.mutedForeground))
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(RoundedRectangle(cornerRadius: 8).fill(hover || active ? Theme.muted : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// 32×32 send / stop / run button.
private struct SendButton: View {
    enum Kind { case send, stop, bash }
    let kind: Kind
    let disabled: Bool
    let action: () -> Void
    @State private var hover = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button(action: action) {
            Group {
                switch kind {
                case .send: Glyph(name: "arrow-up", size: 16, color: Theme.primaryForeground)
                case .bash: Glyph(name: "terminal", size: 16, color: Theme.primaryForeground)
                case .stop: Glyph(name: "square", size: 14, color: Theme.destructive)
                }
            }
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: 7).fill(fill).padding(1)) // bg-clip-padding
            .compositingGroup()
            .opacity(disabled ? 0.5 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .allowsHitTesting(!disabled)
        .onHover { hover = $0 }
    }
    private var fill: Color {
        if kind == .stop { return Theme.destructive.opacity((scheme == .dark ? 0.2 : 0.1) + (hover ? 0.1 : 0)) }
        return Theme.primary.opacity(hover && !disabled ? 0.8 : 1)
    }
}

/// Pending attachment: 56px image thumb or file tile; remove badge on hover.
private struct AttachmentTile: View {
    let a: Attachment
    let remove: () -> Void
    @State private var hover = false
    @Environment(AppState.self) private var app
    var body: some View {
        Group {
            if a.isImage, let img = NSImage(contentsOfFile: a.path) {
                Image(nsImage: img).resizable().scaledToFill().frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .opacity(hover ? 0.9 : 1)
                    .onTapGesture { ChatImagePreview.present(path: a.path, app: app) }
                    .help("Expand image")
            } else {
                HStack(spacing: 8) {
                    Glyph(name: "file", size: 16)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(a.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                        Text(Fmt.bytes(a.size)).font(.system(size: 11)).foregroundStyle(Theme.mutedForeground)
                    }
                }
                .padding(.horizontal, 10)
                // max-w-44, otherwise as wide as its content (border included).
                .frame(width: min(176, 10 + 16 + 8 + max(
                    ceil((a.name as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium)]).width),
                    ceil((Fmt.bytes(a.size) as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 11)]).width)) + 10 + 2), alignment: .leading)
                .frame(height: 56)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.4)))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
        .overlay(alignment: .topTrailing) {
            Button(action: remove) {
                Glyph(name: "x", size: 10, color: Theme.background).padding(2).background(Circle().fill(Theme.foreground))
            }
            .buttonStyle(.plain)
            .offset(x: 6, y: -6)
            .opacity(hover ? 1 : 0)
        }
        .onHover { hover = $0 }
    }
}

/// The conic highlight that circles the composer while the agent works (2.8s/turn).
private struct StreamingRing: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduce
    var body: some View {
        TimelineView(.animation(paused: reduce)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let angle = Angle.degrees((t.truncatingRemainder(dividingBy: 2.8)) / 2.8 * 360)
            RoundedRectangle(cornerRadius: 18)
                .strokeBorder(AngularGradient(stops: [
                    .init(color: .clear, location: 0), .init(color: .clear, location: 0.48),
                    .init(color: color.opacity(0.35), location: 0.62), .init(color: color, location: 0.8),
                    .init(color: color.opacity(0.45), location: 0.92), .init(color: .clear, location: 1),
                ], center: .center, angle: angle), lineWidth: 2)
                .padding(-2)
        }
        .allowsHitTesting(false)
    }
}
