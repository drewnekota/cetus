import AppKit
import SwiftUI

// The composer's `@` menu, after Cetus's mention-menu.tsx and the mention
// sources in composer.tsx (mentionItems): Functions, Automations (≤3 in All),
// Artifacts of this chat (≤3), workspace Files (≤5; root listing for an empty
// query, else a debounced search incl. folders), other Chats (≤4).

struct MentionItem: Identifiable, Equatable {
    var kind: MentionKind
    var label: String
    var refId: String
    var path: String?
    var isDir: Bool?
    var title: String
    var subtitle: String?
    var archived = false
    var meta: String?
    var id: String { "\(kind.rawValue):\(refId)" }

    var ref: MentionRef { MentionRef(kind: kind, label: label, id: refId, path: path, isDir: isDir, meta: meta) }
}

enum MentionTab: String, CaseIterable {
    case all, function, automation, artifact, file, conversation
    var label: String {
        switch self {
        case .all: "All"
        case .function: "Functions"
        case .automation: "Automations"
        case .artifact: "Artifacts"
        case .file: "Files"
        case .conversation: "Chats"
        }
    }
    func next(_ d: Int) -> MentionTab {
        let all = Self.allCases
        return all[(all.firstIndex(of: self)! + d + all.count) % all.count]
    }
}

enum MentionSources {
    static let functions = [MentionItem(kind: .function, label: "goal", refId: "goal", title: "goal", subtitle: Mentions.goalDescription)]

    /// describeSchedule.
    static func describe(_ s: Schedule) -> String {
        switch s {
        case .once(let at):
            return "runs once at \(isoMs(at))"
        case .interval: return "runs every \(s.everyMinutes) minutes"
        case .daily(let time, _): return "runs daily at \(time)"
        case .cron(let expr): return "cron \(expr)"
        }
    }

    /// The menu's items are rebuilt on every keystroke and hover: one formatter.
    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func isoMs(_ ms: Double) -> String {
        iso.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// Artifacts the agent delivered in this conversation, newest first, deduped by path.
    static func artifacts(_ state: ChatState?) -> [MentionItem] {
        guard let state else { return [] }
        var seen = Set<String>()
        var out: [MentionItem] = []
        for m in state.messages.reversed() {
            for b in m.blocks where b.kind == .toolUse {
                guard let r = b.result else { continue }
                for a in ArtifactDetails.from(r.details) where seen.insert(a.path).inserted {
                    out.append(MentionItem(kind: .artifact, label: a.name, refId: a.path, path: a.path, title: a.name,
                                           subtitle: a.caption ?? a.path, meta: "\(a.mimeType), \(workspaceFormatBytes(Int64(a.sizeBytes)))"))
                }
            }
        }
        return out
    }

    /// Root listing (folders first) for an empty query, else a relative-path
    /// search that includes folders (search_workspace_files, ≤100).
    static func files(_ workspace: String, query: String, completion: @escaping ([WorkspaceEntry]) -> Void) {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let root = (workspace as NSString).resolvingSymlinksInPath
        if q.isEmpty {
            DispatchQueue.global(qos: .userInitiated).async {
                let r = WorkspaceListing.list(root: root, dir: root).entries
                DispatchQueue.main.async { completion(r) }
            }
            return
        }
        WorkspaceFiles.list(root) { files in
            DispatchQueue.global(qos: .userInitiated).async {
                var hits: [WorkspaceEntry] = []
                for f in files where f.rel.lowercased().contains(q) {
                    hits.append(WorkspaceEntry(name: f.name, path: f.path, relativePath: f.rel, isDir: f.isDir))
                    if hits.count > 100 { break }
                }
                hits = hits.enumerated().sorted { a, b in
                    let ia = a.element.name.lowercased().range(of: q).map { a.element.name.lowercased().distance(from: a.element.name.lowercased().startIndex, to: $0.lowerBound) } ?? Int.max
                    let ib = b.element.name.lowercased().range(of: q).map { b.element.name.lowercased().distance(from: b.element.name.lowercased().startIndex, to: $0.lowerBound) } ?? Int.max
                    if ia != ib { return ia < ib }
                    if a.element.relativePath.count != b.element.relativePath.count { return a.element.relativePath.count < b.element.relativePath.count }
                    return a.offset < b.offset
                }.map(\.element)
                let out = Array(hits.prefix(100))
                DispatchQueue.main.async { completion(out) }
            }
        }
    }

    /// composer.tsx mentionItems.
    static func items(tab: MentionTab, query: String, automations: [Automation], artifacts: [MentionItem], files: [WorkspaceEntry],
                      conversations: [Conversation], current: String?) -> [MentionItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        func hit(_ fields: String?...) -> Bool { q.isEmpty || fields.contains { $0?.lowercased().contains(q) == true } }
        let all = tab == .all
        func want(_ k: MentionKind) -> Bool { all || tab.rawValue == k.rawValue }
        func cap(_ rows: [MentionItem], _ n: Int) -> [MentionItem] { all ? Array(rows.prefix(n)) : rows }
        var out: [MentionItem] = []
        if want(.function) { out += functions.filter { hit($0.label, $0.subtitle) } }
        if want(.automation) {
            out += cap(automations.filter { hit($0.name, $0.prompt) }.map { a in
                MentionItem(kind: .automation, label: a.name, refId: a.id, title: a.name,
                            subtitle: a.prompt.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression),
                            meta: describe(a.schedule) + (a.enabled ? "" : ", disabled"))
            }, 3)
        }
        if want(.artifact) { out += cap(artifacts.filter { hit($0.title, $0.subtitle) }, 3) }
        if want(.file) {
            out += cap(files.filter { hit($0.relativePath, $0.name) }.map { f in
                let label = f.isDir ? (f.relativePath.hasSuffix("/") ? String(f.relativePath.dropLast()) : f.relativePath) + "/" : f.relativePath
                return MentionItem(kind: .file, label: label, refId: f.path, path: f.path, isDir: f.isDir, title: f.name, subtitle: f.relativePath)
            }, 5)
        }
        if want(.conversation) {
            let sorted = conversations.filter { $0.id != current && hit($0.title) }.sorted { a, b in
                let aa = a.archivedAt != nil ? 1 : 0, ba = b.archivedAt != nil ? 1 : 0
                return aa != ba ? aa < ba : a.updatedAt > b.updatedAt
            }
            // Cap before building rows: only the shown ones need their meta formatted.
            let rows = (all ? Array(sorted.prefix(4)) : sorted).map { c in
                MentionItem(kind: .conversation, label: c.title, refId: c.id, title: c.title,
                            subtitle: c.workspaceDir.split(separator: "/").last.map(String.init) ?? c.workspaceDir,
                            archived: c.archivedAt != nil,
                            meta: "runtime \(c.backend.isEmpty ? "pi" : c.backend), last updated \(isoMs(c.updatedAt))")
            }
            out += rows
        }
        return out
    }
}

/// absolute bottom-full mb-2 h-80 rounded-xl border bg-popover shadow-lg; tab strip + list.
struct MentionMenuView: View {
    let tab: MentionTab
    let items: [MentionItem]
    let active: Int
    var loading = false
    let onTab: (MentionTab) -> Void
    let onSelect: (MentionItem) -> Void
    let onHover: (Int) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 2) {
                ForEach(MentionTab.allCases, id: \.self) { k in MentionTabButton(label: k.label, on: k == tab) { onTab(k) } }
                Spacer(minLength: 0)
                Text("Tab to switch").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground.opacity(0.8)).lineBox(15.4)
                    .padding(.leading, 12).padding(.trailing, 4).padding(.top, 4).padding(.bottom, 6)
                    .fixedSize()
            }
            .padding(.horizontal, 6).padding(.top, 4)
            .background(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                            if tab == .all, i == 0 || items[i - 1].kind != item.kind {
                                Text(Self.heading(item.kind).uppercased())
                                    .font(.system(size: 11, weight: .medium)).tracking(0.275).foregroundStyle(Theme.mutedForeground)
                                    .lineBox(15.4)
                                    .padding(.horizontal, 8).padding(.top, i == 0 ? 6 : 10).padding(.bottom, 4)
                            }
                            MentionRow(item: item, active: i == active, onSelect: { onSelect(item) }, onHover: { onHover(i) })
                                .id(item.id)
                                .testID("mention-row-\(i)")
                        }
                        if items.isEmpty {
                            Text(loading ? "Searching…" : "No matches").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                                .frame(maxWidth: .infinity).padding(.horizontal, 10).padding(.vertical, 12)
                        } else if loading {
                            Text("Searching…").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground).lineBox(15.4)
                                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 4)
                        }
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollIndicators(.never)
                .onChange(of: active) { _, h in if items.indices.contains(h) { proxy.scrollTo(items[h].id) } }
            }
        }
        .padding(1)
        .frame(height: 320)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.popover))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
        .shadow(color: .black.opacity(0.1), radius: 3, y: 4)
        .testID("mention-menu")
    }

    static func heading(_ k: MentionKind) -> String {
        switch k {
        case .function: "Functions"
        case .automation: "Automations"
        case .artifact: "Artifacts"
        case .file: "Files"
        case .conversation: "Chats"
        }
    }
}

/// -mb-px border-b-2 px-2 pb-1.5 pt-1 text-xs font-medium.
private struct MentionTabButton: View {
    let label: String
    let on: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Text(label).font(.system(size: 12, weight: .medium))
                .foregroundStyle(on || hover ? Theme.foreground : Theme.mutedForeground)
                .lineBox(16.2)
                .padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 8)
                .overlay(alignment: .bottom) { Rectangle().fill(on ? Theme.foreground : .clear).frame(height: 2) }
                .fixedSize()
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .testID("mention-tab-\(label)")
    }
}

/// flex items-start gap-2.5 rounded-lg px-2.5 py-1.5; active bg-accent, hover accent/50.
private struct MentionRow: View {
    let item: MentionItem
    let active: Bool
    let onSelect: () -> Void
    let onHover: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            icon.padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.kind == .function ? "@\(item.title)" : item.title)
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.tail)
                    if item.archived {
                        Text("ARCHIVED").font(.system(size: 11)).tracking(0.275).foregroundStyle(Theme.mutedForeground).fixedSize()
                    }
                }
                .frame(height: 20.02)
                if let s = item.subtitle, !s.isEmpty { IntelPara(text: s.breakAll) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(active ? Theme.accent : hover ? Theme.accent.opacity(0.5) : .clear))
        .compositingGroup()
        .opacity(item.archived ? 0.7 : 1)
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onContinuousHover { phase in
            if case .active = phase { hover = true; onHover() } else { hover = false }
        }
    }

    @ViewBuilder private var icon: some View {
        switch item.kind {
        case .function: Glyph(name: "target", size: 16, color: Theme.primary)
        case .automation: Glyph(name: "calendar-clock", size: 16, color: Theme.mutedForeground)
        case .artifact: Glyph(name: "package", size: 16, color: Theme.mutedForeground)
        case .file: Glyph(name: item.isDir == true ? "folder" : "file", size: 16, color: Theme.mutedForeground)
        case .conversation:
            if item.archived { Glyph(name: "archive", size: 16, color: Theme.mutedForeground.opacity(0.7)) }
            else { Glyph(name: "message-square", size: 16, color: Theme.mutedForeground) }
        }
    }
}

private extension String {
    /// `break-all`: allow a line break between any two characters.
    var breakAll: String { map(String.init).joined(separator: "\u{200B}") }
}
