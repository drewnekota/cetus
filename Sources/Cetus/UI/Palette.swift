import SwiftUI

/// Cmd+K: search chats by title and content, plus app actions (command-palette.tsx).
struct PaletteView: View {
    @Environment(AppState.self) private var app
    @State private var query = ""
    @State private var index = 0
    @FocusState private var focused: Bool

    private struct Row: Identifiable {
        let id: String
        let group: String
        let icon: String
        let title: String
        var subtitle = ""
        var time: Double? = nil
        var hint = ""
        var archived = false
        var current = false
        var checked = false
        var chat = false
        /// A screen-history hit (command-palette.tsx's screen group).
        var screen: ScreenFrame? = nil
        let run: () -> Void
    }

    /// command-palette.tsx's actions, in order; a query filters them.
    private var actions: [(icon: String, label: String, keywords: String, hint: String, run: () -> Void)] {
        let p = app.prefs
        return [
            ("plus", "New task", "new chat conversation start", Shortcuts.hint("newChat", p), { app.newChat() }),
            ("message-square", "Go to Chats", "chats conversations view switch", Shortcuts.hint("switchChats", p), { app.setView(ViewState(page: .chats, active: app.active)) }),
            ("layout-grid", "Go to Board", "board kanban view switch", Shortcuts.hint("switchBoard", p), { app.setView(ViewState(page: .kanban, active: app.active)) }),
            ("clock", "Go to Automations", "automations scheduled view switch", Shortcuts.hint("switchAutomations", p), { app.setView(ViewState(page: .automations, active: app.active)) }),
            ("settings", "Open Settings", "settings preferences config", Shortcuts.hint("openSettings", p), { app.settings = true }),
            ("monitor", "Open screen history", "screen history recall capture", "", { ScreenHistoryModel.shared.show(app) }),
        ]
    }

    /// The built-in runtime's reasoning level (the palette's Reasoning group drives pi's ModelChoice).
    private var piReasoning: String {
        app.selection.runtime == "pi" ? (app.selection.effort.isEmpty ? "high" : app.selection.effort) : (app.prefs.tuning["pi"]?.effort ?? "high")
    }

    private func setPiReasoning(_ level: String) {
        if app.selection.runtime == "pi" { app.setSelection { $0.effort = level }; return }
        app.controller.setPrefs { p in
            let model = p.tuning["pi"]?.model ?? "flash"
            p.tuning["pi"] = Tuning(model: model, effort: level)
        }
    }

    private var isDark: Bool { NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }

    private func chatRow(_ c: Conversation, group: String, snippet: String = "") -> Row {
        let archived = c.archivedAt != nil
        return Row(id: "chat:\(c.id)", group: group, icon: archived ? "archive" : "message-square", title: c.title.isEmpty ? "Untitled" : c.title,
                   subtitle: archived ? "\(ComposerView.workspaceLabel(c.workspaceDir)) · Archived · Enter to restore and open" : (snippet.isEmpty ? ComposerView.workspaceLabel(c.workspaceDir) : snippet),
                   time: archived ? nil : c.updatedAt, archived: archived, current: c.id == app.active, chat: true) {
            if archived { app.controller.restore(c.id) }
            app.openChat(c.id)
        }
    }

    private var rows: [Row] {
        let q = query.trimmingCharacters(in: .whitespaces)
        var out: [Row] = []
        if q.isEmpty {
            out += app.controller.conversations.prefix(7).map { chatRow($0, group: "Recent") }
        } else {
            let hits = app.controller.store.search(q, limit: 24)
            let live = hits.filter { $0.0.archivedAt == nil }.prefix(12)
            let archived = hits.filter { $0.0.archivedAt != nil }
            out += live.map { chatRow($0.0, group: "Conversations · \(live.count)", snippet: $0.1) }
            out += archived.map { chatRow($0.0, group: "Archived · \(archived.count)") }
        }
        // commandMatches: every query token appears in label + keywords.
        let tokens = q.lowercased().split(separator: " ").map(String.init)
        let matches: (String) -> Bool = { text in tokens.allSatisfy { text.lowercased().contains($0) } }
        let acts = actions.filter { matches("\($0.label) \($0.keywords)") }
        out += acts.enumerated().map { i, a in Row(id: "action:\(i):\(a.label)", group: "Actions", icon: a.icon, title: a.label, hint: a.hint, run: a.run) }
        let levels: [(String, String, String, String)] = [("gauge", "Quick", "No thinking, fastest replies", "off"), ("brain-circuit", "Think", "High thinking, stronger reasoning", "high"), ("flame", "Max", "Maximum thinking, deepest reasoning", "max")]
        let current = piReasoning
        for l in levels where matches("\(l.1) \(l.2) reasoning thinking effort") {
            out.append(Row(id: "effort:\(l.3)", group: "Reasoning", icon: l.0, title: l.1, subtitle: l.2, checked: current == l.3) { setPiReasoning(l.3) })
        }
        // Screen-context frames by keyword (OCR text), or the most recent ones.
        let hits = q.isEmpty ? ScreenStore.shared.recentScreenshots(limit: 6) : ScreenStore.shared.searchScreenshots(q, limit: 6)
        let screenGroup = q.isEmpty ? "Screen history · recent" : "Screen history · \(hits.count)"
        out += hits.map { f in Row(id: "screen:\(f.id)", group: screenGroup, icon: "", title: f.appName ?? "", screen: f) { ScreenHistoryModel.shared.show(app, query: q, frame: f) } }
        return out
    }

    var body: some View {
        let list = rows
        let q = query.trimmingCharacters(in: .whitespaces)
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Glyph(name: "search", size: 16)
                // placeholder:text-muted-foreground/70 (NSTextField ignores prompt styling).
                TextField("", text: $query)
                    .background(alignment: .leading) {
                        if query.isEmpty {
                            Text("Search conversations or type a command…").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground.opacity(0.7)).allowsHitTesting(false)
                        }
                    }
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .focused($focused)
                    .onSubmit { pick(list) }
                    .onKeyPress(.downArrow) { index = min(list.count - 1, index + 1); return .handled }
                    .onKeyPress(.upArrow) { index = max(0, index - 1); return .handled }
                    .onKeyPress(.escape) { close(); return .handled }
                    .onChange(of: query) { _, _ in index = 0 }
                    .testID("palette-input")
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border.opacity(0.6)).frame(height: 1) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if list.isEmpty {
                            Text(q.isEmpty ? "No results." : "No results for “\(q)”.").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                                .frame(maxWidth: .infinity).padding(.vertical, 48)
                        }
                        ForEach(Array(list.enumerated()), id: \.element.id) { i, row in
                            if i == 0 || list[i - 1].group != row.group {
                                // CommandSeparator between the conversation groups and the commands.
                                if i > 0 && ((list[i - 1].chat && !row.chat) || (row.screen != nil && list[i - 1].screen == nil)) {
                                    Rectangle().fill(Theme.border.opacity(0.6)).frame(height: 1).padding(.horizontal, -8).padding(.vertical, 4)
                                }
                                Text(row.group).font(.system(size: 12, weight: .medium)).tracking(0.3).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                                    .padding(.horizontal, 8).padding(.top, i == 0 || (list[i - 1].chat && !row.chat) || (row.screen != nil && list[i - 1].screen == nil) ? 4 : 8).padding(.bottom, 6)
                            }
                            Button { index = i; pick(list) } label: { rowView(row, selected: i == index, query: q) }
                                .buttonStyle(.plain)
                                .onHover { if $0 { index = i } }
                                .id(row.id)
                                .testID("palette-row-\(i)")
                        }
                    }
                    .padding(8)
                }
                .scrollIndicators(.never)
                .frame(maxHeight: 384)
                .fixedSize(horizontal: false, vertical: true)
                .onChange(of: index) { _, i in if list.indices.contains(i) { proxy.scrollTo(list[i].id) } }
            }
            HStack {
                Text("cetus").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground.opacity(0.8)).lineBox(16.2)
                Spacer()
                HStack(spacing: 12) {
                    HStack(spacing: 4) { Kbd(text: "↑"); Kbd(text: "↓"); Text("navigate").padding(.leading, 2) }
                    HStack(spacing: 4) { KbdIcon(name: "corner-down-left"); Text("open").padding(.leading, 2) }
                    HStack(spacing: 4) { Kbd(text: "esc"); Text("close").padding(.leading, 2) }
                }
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            }
            .padding(.horizontal, 12).padding(.vertical, 8).padding(.top, 1)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border.opacity(0.6)).frame(height: 1) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.popover))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        // ring-1 ring-foreground/10 sits outside the box; shadow-2xl.
        .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(Theme.foreground.opacity(0.1), lineWidth: 1).padding(-1))
        .shadow(color: .black.opacity(0.25), radius: 19, y: 25)
        .onAppear { DispatchQueue.main.async { focused = true } }
        .testID("palette")
    }

    /// CommandItem: gap-2.5, px-2.5 py-2, rounded-lg, accent when selected; svgs muted (accent-foreground when selected).
    @ViewBuilder
    private func rowView(_ row: Row, selected: Bool, query: String) -> some View {
        let iconColor = selected ? Theme.foreground : Theme.mutedForeground
        if let f = row.screen { PaletteScreenRow(frame: f, selected: selected) } else {
        HStack(alignment: row.chat ? .top : .center, spacing: 10) {
            Glyph(name: row.icon, size: 16, color: iconColor)
                .opacity(row.archived ? 0.7 : 1)
                .padding(.top, row.chat ? 2 : 0)
            if row.chat {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        highlighted(row.title, query).font(.system(size: 14, weight: .medium))
                            .foregroundStyle(row.archived ? Theme.foreground.opacity(0.8) : Theme.foreground).lineLimit(1).lineBox(20.02)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if row.current { Circle().fill(Theme.foreground.opacity(0.4)).frame(width: 6, height: 6) }
                        if let t = row.time { Text(Fmt.relative(t)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground.opacity(0.7)).lineBox(16.2) }
                    }
                    Text(row.subtitle).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground.opacity(row.archived ? 1 : 0.6)).lineLimit(1).lineBox(16.2)
                }
            } else {
                Text(row.title).font(.system(size: 14)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                    .frame(maxWidth: row.subtitle.isEmpty ? .infinity : nil, alignment: .leading)
                if !row.subtitle.isEmpty {
                    Text(row.subtitle).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground.opacity(0.7)).lineLimit(1).lineBox(16.2)
                    Spacer(minLength: 0)
                }
                if row.checked { Glyph(name: "check", size: 14, color: iconColor).opacity(0.7) }
                if !row.hint.isEmpty { Kbd(text: row.hint) }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(selected ? Theme.accent : .clear))
        .contentShape(Rectangle())
        }
    }

    /// Query matches as `bg-foreground/20` marks.
    private func highlighted(_ text: String, _ q: String) -> Text {
        guard !q.isEmpty else { return Text(text) }
        var a = AttributedString(text)
        var from = a.startIndex
        while let r = a[from...].range(of: q, options: .caseInsensitive) {
            a[r].backgroundColor = Theme.foreground.opacity(0.2)
            from = r.upperBound
        }
        return Text(a)
    }

    private func pick(_ list: [Row]) {
        guard list.indices.contains(index) else { return }
        let row = list[index]
        close()
        row.run()
    }

    private func close() {
        app.palette = false
    }
}

/// A Kbd holding a 10px lucide glyph (the footer's ⏎).
private struct KbdIcon: View {
    let name: String
    var body: some View {
        Glyph(name: name, size: 10, color: Theme.mutedForeground.opacity(0.8))
            .padding(.horizontal, 5)
            .frame(height: 16)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted.opacity(0.4)))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border.opacity(0.5), lineWidth: 1))
    }
}
