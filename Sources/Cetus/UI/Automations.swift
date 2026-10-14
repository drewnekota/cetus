import AppKit
import SwiftUI

func describeSchedule(_ s: Schedule) -> String { AutomationText.describe(s) }

/// Scheduled prompts (Cetus's automations-view.tsx): title row, a two-column
/// grid of cards with switch / Run now / ⋯, and an editor dialog.
struct AutomationsView: View {
    @Environment(AppState.self) private var app
    @State private var editing: Automation?
    @AppStorage("cetus.automationSort") private var sortBy = "updatedAt"
    @State private var sortFrame: CGRect = .zero

    var body: some View {
        let list = app.controller.automations.sorted {
            let (x, y) = sortBy == "createdAt" ? ($0.createdAt, $1.createdAt) : ($0.updatedAt, $1.updatedAt)
            return x != y ? x > y : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        GeometryReader { g in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text("Automations").font(.system(size: 14, weight: .semibold)).lineBox(20.02)
                            Text("Saved prompts that run on a schedule. Each run starts a fresh task.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                        }
                        Spacer()
                        HStack(spacing: 8) {
                            if !list.isEmpty { sortSelect }
                            Button { editing = newAutomation() } label: {
                                HStack(spacing: 6) { Glyph(name: "plus", size: 16, color: Theme.primaryForeground); Text("New automation") }
                            }
                            .buttonStyle(CetusButtonStyle(variant: .primary, height: 32))
                            .testID("new-automation")
                        }
                    }
                    .padding(.bottom, 12)
                    if list.isEmpty {
                        Button { editing = newAutomation() } label: { EmptyAutomations() }.buttonStyle(.plain)
                    } else {
                        // md:grid-cols-2 with row-stretched cards.
                        let cols = g.size.width >= 768 ? 2 : 1
                        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
                            ForEach(Array(stride(from: 0, to: list.count, by: cols)), id: \.self) { i in
                                GridRow {
                                    ForEach(i ..< min(i + cols, list.count), id: \.self) { j in
                                        AutomationCard(a: list[j], edit: { editing = list[j] })
                                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                                    }
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: 1024, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
            }
            .scrollIndicators(.never)
        }
        // The editor is a window-level dialog (DialogAutomation.swift).
        .onChange(of: editing) { _, draft in
            guard let draft else { if DialogHost.openId == "automation" { DialogHost.dismiss() }; return }
            DialogHost.present("automation", app: app) {
                AutomationEditor(draft: draft, onClose: { DialogHost.dismiss() })
                    .onDisappear { editing = nil }
            }
        }
    }

    /// SelectTrigger size sm, w-36: h-8, input border, transparent fill, px-3, chevron-down 16 @50%.
    private var sortSelect: some View {
        Button {
            if app.popup?.id == "automation-sort" { app.popup = nil; return }
            let items = [("updatedAt", "Recently updated"), ("createdAt", "Recently created")].map { id, title in
                MenuItem(id: id, title: title, checked: sortBy == id, testID: "sort-\(id)") { app.popup = nil; sortBy = id }
            }
            app.popup = PopupSpec(id: "automation-sort", anchor: sortFrame, style: .select,
                                  content: AnyView(MenuList(items: items, style: .select, minWidth: sortFrame.width)))
        } label: {
            HStack(spacing: 8) {
                // SelectValue overflows its 94px slot and is clipped, not ellipsized.
                Text(sortBy == "createdAt" ? "Recently created" : "Recently updated").font(.system(size: 14)).foregroundStyle(Theme.foreground)
                    .fixedSize().lineBox(20.02).frame(width: 94, alignment: .leading).clipped()
                Glyph(name: "chevron-down", size: 16).opacity(0.5)
            }
            .padding(.leading, 13).padding(.trailing, 13)
            .frame(width: 144, height: 32)
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
            .shadow(color: .black.opacity(0.05), radius: 0.5, y: 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .readFrame($sortFrame)
        .testID("automation-sort")
    }

    private func newAutomation() -> Automation {
        Automation(id: UUID().uuidString.lowercased(), name: "", prompt: "", backend: app.selection.runtime, model: app.selection.model, effort: app.selection.effort,
                   workspaceDir: app.prefs.workspace, schedule: .daily(time: "09:00", weekdays: []), enabled: true, lastRunAt: nil, lastConversationId: nil,
                   lastError: nil, createdAt: 0, updatedAt: 0)
    }
}

private struct EmptyAutomations: View {
    @State private var hover = false
    var body: some View {
        VStack(spacing: 12) {
            Circle().fill(Theme.muted).frame(width: 44, height: 44).overlay(Glyph(name: "clock", size: 20))
            Text("No automations yet").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground)
            Text("Schedule a prompt to run daily, on an interval, or at a fixed time — like a morning news digest or a nightly repo summary.")
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center).frame(maxWidth: 384)
        }
        .padding(.horizontal, 24).padding(.vertical, 64)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 14).fill(hover ? Theme.muted.opacity(0.3) : .clear))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border.opacity(hover ? 1 : 0.7), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

private struct AutomationCard: View {
    @Environment(AppState.self) private var app
    let a: Automation
    let edit: () -> Void
    @State private var moreFrame: CGRect = .zero

    var body: some View {
        let next = a.enabled ? a.nextRunAt : nil
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Glyph(name: "clock", size: 14)
                    Text(a.name.isEmpty ? "Untitled automation" : a.name).font(.system(size: 14, weight: .medium)).lineLimit(1).lineBox(20.02)
                }
                // line-clamp-2, leading-snug (16.5)
                Text(a.prompt).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(2)
                    .lineSpacing(16.5 - NSFont.systemFont(ofSize: 12).boundingRectForFont.height.rounded())
                    .padding(.top, 1).padding(.bottom, 0.5) // CSS half-leading of leading-snug
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
                FlowLayout(spacing: 0) {
                    chip { Text(describeSchedule(a.schedule)) }
                    if a.backend != "pi" {
                        chip { HStack(spacing: 4) { RuntimeIcon(id: a.backend, size: 12); Text(Runtimes.byId(a.backend).label) } }
                    }
                    if a.enabled {
                        meta { Text("Next: \(next.map(Self.nextLabel) ?? "—")") }
                    } else {
                        meta { Text("Paused").foregroundStyle(Theme.primary.opacity(0.8)) }
                    }
                    meta {
                        HStack(spacing: 4) {
                            Glyph(name: ComposerView.isChatWorkspace(a.workspaceDir) ? "message-square" : "folder", size: 12)
                            Text(ComposerView.workspaceLabel(a.workspaceDir)).lineLimit(1)
                        }
                    }
                }
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                .padding(.top, 8)
                HStack(spacing: 12) {
                    Text(a.runCount > 0 ? "\(a.runCount) run\(a.runCount == 1 ? "" : "s") · \(a.lastRunAt.map(Self.ago) ?? "never")" : "Never run")
                        .foregroundStyle(Theme.mutedForeground)
                    if a.lastStatus == "error" { Text("last run failed").foregroundStyle(Theme.destructive).help(a.lastError ?? "") }
                    if let id = a.lastConversationId {
                        Button("View last run") { app.openChat(id) }.buttonStyle(.plain).foregroundStyle(Theme.primary)
                    }
                }
                .font(.system(size: 12)).lineBox(16.2)
                .padding(.top, 6)
            }
            HStack(spacing: 6) {
                CetusSwitch(isOn: Binding(get: { a.enabled }, set: { v in var x = a; x.enabled = v; app.controller.saveAutomation(x) }), testID: "automation-enabled-\(a.id)")
                GhostIconButton(icon: "play", box: 32, glyph: 16, color: Theme.foreground, tip: "Run now", testID: "run-\(a.id)") { run() }
                GhostIconButton(icon: "ellipsis", box: 28, glyph: 16, hoverFill: Theme.accent, testID: "more-\(a.id)", radius: 4) { more() }
                    .readFrame($moreFrame)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .padding(1) // border-box: the 1px border takes layout space
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .compositingGroup()
        .opacity(a.enabled ? 1 : 0.7)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { edit() }
    }

    /// The ⋯ menu (system NSMenu): Edit / Run now / Delete.
    private func more() {
        let items = [
            MenuItem(id: "edit", title: "Edit", glyph: "pencil", action: edit),
            MenuItem(id: "run", title: "Run now", glyph: "play", action: run),
            MenuItem(id: "delete", title: "Delete", glyph: "trash-2", action: { app.controller.deleteAutomation(a.id) }),
        ]
        NativeMenu.show(items, anchor: moreFrame, placement: .belowEnd, app: app, id: "more-\(a.id)")
    }

    private func chip<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c().font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground.opacity(0.8)).lineBox(16.2)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted))
            .padding(.trailing, 12)
    }

    private func meta<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c().lineBox(16.2).frame(height: 20.2).padding(.trailing, 12)
    }

    private func run() { if let id = app.controller.runAutomation(a.id) { app.openChat(id) } }

    static func nextLabel(_ ms: Double) -> String { AutomationText.nextRun(ms) }

    static func ago(_ ms: Double) -> String { AutomationText.lastRun(ms) }
}

/// Kanban (board-view.tsx): three columns — In progress (streaming), Needs
/// review (unread, failed, stopped), Done — filtered by the sidebar folder.
/// Cetus's board-view.tsx: three columns (In progress / Needs review / Done)
/// of conversation cards. Streaming → In progress; a pending request_review →
/// Needs review; everything else → Done.
struct KanbanView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        let folder = app.kanbanFilter
        let convs = app.controller.conversations.filter { folder == nil || $0.workspaceDir == folder }.sorted { $0.updatedAt > $1.updatedAt }
        let running = convs.filter { $0.runState == .running }
        let review = convs.filter { $0.runState != .running && $0.reviewState == "pending" }
        let done = convs.filter { $0.runState != .running && $0.reviewState != "pending" }
        HStack(alignment: .top, spacing: 12) {
            column("In progress", running, color: Theme.primary)
            column("Needs review", review, color: Theme.info)
            column("Done", done, color: Theme.success)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .testID("kanban")
    }

    private func column(_ title: String, _ items: [Conversation], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(.system(size: 12, weight: .medium)).tracking(-0.2).foregroundStyle(color).lineBox(16.2)
                    .padding(.horizontal, 10).padding(.vertical, 2)
                    .background(Capsule().fill(color.opacity(0.15)))
                Spacer()
                Text("\(items.count)").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            }
            .padding(.horizontal, 4).padding(.bottom, 8)
            ScrollView {
                LazyVStack(spacing: 6) {
                    if items.isEmpty {
                        Text("Empty").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                            .frame(maxWidth: .infinity).padding(.vertical, 17)
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    }
                    ForEach(items) { c in KanbanCard(c: c, pendingReview: c.reviewState == "pending" && c.runState != .running) }
                }
                .padding(.trailing, 2)
            }
            .scrollIndicators(.never)
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.muted.opacity(0.3)))
        .testID("kanban-\(title)")
    }
}

private struct KanbanCard: View {
    @Environment(AppState.self) private var app
    let c: Conversation
    let pendingReview: Bool
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 6) {
                if c.runState == .running { PulseDot().padding(.top, 6) }
                if c.sourceAutomationId != nil { Glyph(name: "clock", size: 14).padding(.top, 2) }
                // text-sm leading-snug (19.25), line-clamp-2
                Text(c.title.isEmpty ? "Untitled" : c.title).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground)
                    .lineSpacing(19.25 - NSFont.systemFont(ofSize: 14).boundingRectForFont.height.rounded()).lineLimit(2)
                    .padding(.top, 1).padding(.bottom, 1.5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if c.reviewState == "approved" {
                HStack(spacing: 4) { Glyph(name: "check", size: 12, color: Theme.success); Text("Reviewed") }
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.success).lineBox(15.4)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Capsule().fill(Theme.success.opacity(0.15)))
                    .padding(.top, 6)
            }
            if let preview = app.controller.lastReply(c) {
                Text(preview).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                    .lineSpacing(16.5 - NSFont.systemFont(ofSize: 12).boundingRectForFont.height.rounded()).lineLimit(2)
                    .padding(.top, 0.5).padding(.bottom, 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
            }
            if pendingReview {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 4) { Glyph(name: "message-circle-question", size: 14, color: Theme.info); Text("Needs your review") }
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.info).lineBox(16.2)
                    HStack(spacing: 6) {
                        Button { app.controller.approveReview(c.id) } label: { HStack(spacing: 4) { Glyph(name: "check", size: 14, color: Theme.primaryForeground); Text("Approve") }.frame(maxWidth: .infinity) }
                            .buttonStyle(CetusButtonStyle(variant: .primary, height: 28, fontSize: 12, fullWidth: true))
                        Button { app.openChat(c.id) } label: { HStack(spacing: 4) { Glyph(name: "rotate-ccw", size: 14, color: Theme.foreground); Text("Request changes") }.frame(maxWidth: .infinity) }
                            .buttonStyle(CetusButtonStyle(variant: .outline, height: 28, fontSize: 12, fullWidth: true))
                    }
                    .padding(.top, 8)
                }
                .padding(.horizontal, 8).padding(.vertical, 6).padding(1)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.info.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.info.opacity(0.3), lineWidth: 1))
                .padding(.top, 8)
            }
            HStack {
                HStack(spacing: 4) {
                    Glyph(name: ComposerView.isChatWorkspace(c.workspaceDir) ? "message-square" : "folder", size: 12)
                    Text(ComposerView.workspaceLabel(c.workspaceDir)).lineLimit(1)
                }
                Spacer()
                Text(Self.time(c.updatedAt)).monospacedDigit()
            }
            .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            .padding(.top, 6)
        }
        .padding(.horizontal, 12).padding(.vertical, 10).padding(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border.opacity(hover ? 0.8 : 1), lineWidth: 1))
        .shadow(color: .black.opacity(hover ? 0.06 : 0.04), radius: hover ? 4 : 1.5, y: hover ? 3 : 1)
        .overlay(alignment: .topTrailing) {
            GhostIconButton(icon: c.archivedAt != nil ? "archive-restore" : "archive", box: 24, glyph: 14, hoverFill: Theme.accent, tip: c.archivedAt != nil ? "Unarchive" : "Archive", radius: 4) {
                if c.archivedAt != nil { app.controller.restore(c.id) } else { app.controller.archive(c.id) }
            }
            .opacity(hover ? 1 : 0)
            .padding(6)
        }
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { SessionDetailDialog.present(app, id: c.id) } // board-view onOpen → session detail dialog
        .testID("kanban-card-\(c.id)")
    }

    /// formatTimestamp: "hh:mm AM" today (toLocaleTimeString 2-digit), else "Mon d".
    static func time(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = Calendar.current.isDateInToday(d) ? "hh:mm a" : "MMM d"
        return f.string(from: d)
    }
}

private struct PulseDot: View {
    @State private var on = false
    var body: some View {
        Circle().fill(Theme.primary).frame(width: 6, height: 6)
            .opacity(on ? 0.4 : 1)
            .animation(.easeInOut(duration: 1).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}
