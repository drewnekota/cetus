import AppKit
import SwiftUI

// The composer's `/` menu, after Cetus's slash-menu.tsx, composer.tsx
// (slashItems / applySlash), composer-utils.tsx and slash-command-dialog.tsx,
// plus the pre-session runtime catalog probe (src-tauri cli_backend/catalog.rs
// probe_cli_commands, cetus-bridge probe_codex_skills).

/// One row: a command (expands to a prompt) or a skill (inserts its token).
struct SlashItem: Identifiable, Equatable {
    enum Kind { case command, skill }
    var kind: Kind
    var id: String
    var name: String
    var description: String
    var prompt = ""
    /// Set only for Cetus-stored commands (editable from the menu).
    var commandId: String?
}

enum SlashCatalog {
    /// CLAUDE_CLI_COMMANDS: built-ins that work headless.
    static let claude: [SlashItem] = [
        .init(kind: .command, id: "cli:usage", name: "usage", description: "Claude subscription usage and limits", prompt: "/usage "),
        .init(kind: .command, id: "cli:cost", name: "cost", description: "Token spend and usage for this session", prompt: "/cost "),
        .init(kind: .command, id: "cli:context", name: "context", description: "Context window usage breakdown", prompt: "/context "),
        .init(kind: .command, id: "cli:compact", name: "compact", description: "Compact conversation history to free up context", prompt: "/compact "),
    ]

    /// CODEX_CLI_COMMANDS: handled by the composer itself (status/model/reasoning) or passed through.
    static let codex: [SlashItem] = [
        .init(kind: .command, id: "codex:status", name: "status", description: "Show chat ID, model, reasoning, and context usage", prompt: "/status"),
        .init(kind: .command, id: "codex:model", name: "model", description: "Choose the model for this chat", prompt: "/model"),
        .init(kind: .command, id: "codex:reasoning", name: "reasoning", description: "Choose the reasoning effort for this chat", prompt: "/reasoning"),
        .init(kind: .command, id: "codex:compact", name: "compact", description: "Compact the Codex thread and free context", prompt: "/compact "),
    ]

    /// Cetus-stored commands (app_settings.slash_commands).
    static func localCommands() -> [SlashItem] {
        IntelSlash.load().map { .init(kind: .command, id: $0.id, name: $0.name, description: $0.description, prompt: $0.prompt, commandId: $0.id) }
    }

    /// Enabled library skills + discovered ones (when loaded), deduped by name.
    static func localSkills() -> [SlashItem] {
        let state = IntelSkills.state()
        let libs = state.enabled ? state.entries.filter(\.enabled).map { ($0.id, $0.name, $0.description) } : []
        let loadDiscovered = IntelSkills.discovery()["skillsLoadDiscovered"] as? Bool ?? false
        let found = loadDiscovered ? IntelSkills.discovered().map { ($0.id, $0.name, $0.description) } : []
        var seen = Set<String>()
        var out: [SlashItem] = []
        for (id, name, desc) in libs + found where seen.insert(name.lowercased()).inserted {
            out.append(.init(kind: .skill, id: id, name: name, description: desc))
        }
        return out
    }

    /// Native catalog rows (CliSlashCommand) → menu rows; the argument hint rides the description.
    static func native(_ commands: [SlashCommand]) -> [SlashItem] {
        commands.map { c in
            let d = c.argumentHint.isEmpty ? c.description : "\(c.description) — \(c.argumentHint)"
            return c.kind == "skill"
                ? .init(kind: .skill, id: "cli:\(c.name)", name: c.name, description: d)
                : .init(kind: .command, id: "cli:\(c.name)", name: c.name, description: d, prompt: "/\(c.name) ")
        }
    }

    /// composer.tsx slashItems: rank (exact, prefix, segment start, substring,
    /// description), partition Commands → Skills, per-runtime sources.
    static func items(backend: String, query: String, native nativeCommands: [SlashCommand], local: [SlashItem], skills: [SlashItem]) -> [SlashItem] {
        let q = query.lowercased()
        // Runs on every keystroke while the menu is open: compile the segment pattern once.
        let segment = q.isEmpty ? nil : try? NSRegularExpression(pattern: "(^|[-_:/.])" + NSRegularExpression.escapedPattern(for: q))
        func rank(_ it: SlashItem) -> Int {
            if q.isEmpty { return 1 }
            let name = it.name.lowercased()
            if name == q { return 1 }
            if name.hasPrefix(q) { return 2 }
            if let segment, segment.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil { return 3 }
            if name.contains(q) { return 4 }
            if it.description.lowercased().contains(q) { return 5 }
            return 0
        }
        /// Rank once, drop misses, stable-sort by rank.
        func byRank(_ list: [SlashItem]) -> [SlashItem] {
            list.enumerated().compactMap { i, it -> (Int, Int, SlashItem)? in
                let r = rank(it)
                return r > 0 ? (r, i, it) : nil
            }
            .sorted { $0.0 != $1.0 ? $0.0 < $1.0 : $0.1 < $1.1 }
            .map(\.2)
        }
        func byKind(_ list: [SlashItem]) -> [SlashItem] {
            byRank(list.filter { $0.kind == .command }) + byRank(list.filter { $0.kind == .skill })
        }
        let native = native(nativeCommands)
        switch backend {
        case "claude-code": return byKind((native.isEmpty ? claude : native) + local)
        case "codex": return byKind(codex + native + local)
        case "pi": return byKind(local + skills)
        default: return byKind(native + local)
        }
    }

    /// detectSlashToken: a `/` at line start or after whitespace, no whitespace up to the caret.
    /// Runs several times per keystroke: walks back from the caret over the token
    /// only, instead of copying the whole draft.
    static func detect(_ value: String, caret: Int, trigger: Character = "/") -> (start: Int, query: String)? {
        let ns = value as NSString
        let end = min(caret, ns.length)
        let t = trigger.utf16.first!
        func space(_ c: unichar) -> Bool { Unicode.Scalar(c).map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? false }
        var i = end - 1
        while i >= 0 {
            let c = ns.character(at: i)
            if c == t { break }
            if space(c) { return nil }
            i -= 1
        }
        guard i >= 0 else { return nil }
        if i > 0, let s = Unicode.Scalar(ns.character(at: i - 1)), !CharacterSet.whitespacesAndNewlines.contains(s) { return nil }
        return (i, ns.substring(with: NSRange(location: i + 1, length: end - i - 1)))
    }

    /// Claude's catalog tags a skill's origin with a "(user)"-style suffix: lift it into a scope tag.
    static func splitScope(_ description: String) -> (text: String, scope: String?) {
        var trimmed = description
        while trimmed.last?.isWhitespace == true { trimmed.removeLast() }
        for scope in ["user", "project", "plugin", "builtin", "local"] where trimmed.hasSuffix("(\(scope))") {
            var t = String(trimmed.dropLast(scope.count + 2))
            while t.last?.isWhitespace == true { t.removeLast() }
            return (t, scope)
        }
        return (trimmed, nil)
    }
}

/// The menu's Cetus-stored commands and library skills. Reading them hits the
/// shared settings db (and, with discovery on, walks every workspace's parents
/// for skill folders): the menu opens on the last read while a fresh one loads.
@MainActor
enum SlashSources {
    private static var cached: (local: [SlashItem], skills: [SlashItem])?
    private static var loading = false
    /// Asked again mid-read (e.g. a command was just saved): read once more after.
    private static var again = false
    private static var waiting: [(([SlashItem], [SlashItem]) -> Void)] = []

    static func load(_ apply: @escaping ([SlashItem], [SlashItem]) -> Void) {
        if let c = cached { apply(c.local, c.skills) } else {
            let c = (SlashCatalog.localCommands(), SlashCatalog.localSkills())
            cached = c
            apply(c.0, c.1)
        }
        waiting.append(apply)
        refresh()
    }

    private static var readAt = Date.distantPast

    /// Composer appeared: read ahead unless a recent read is still fresh.
    static func prewarm() {
        if cached == nil || Date().timeIntervalSince(readAt) > 30 { refresh() }
    }

    /// Revalidate (the menu opened, a command was saved).
    static func refresh() {
        guard !loading else { again = true; return }
        loading = true
        DispatchQueue.global(qos: .userInitiated).async {
            let c = (SlashCatalog.localCommands(), SlashCatalog.localSkills())
            DispatchQueue.main.async {
                cached = c
                readAt = Date()
                loading = false
                if again {
                    again = false
                    refresh()
                    return
                }
                let w = waiting
                waiting = []
                for apply in w { apply(c.0, c.1) }
            }
        }
    }
}

/// Pre-session runtime catalog (probe_cli_commands), cached per (backend, cwd).
@MainActor @Observable
final class SlashProbe {
    static let shared = SlashProbe()
    private(set) var catalogs: [String: [SlashCommand]] = [:]
    @ObservationIgnored private var checkedAt: [String: Date] = [:]
    @ObservationIgnored private var inFlight: Set<String> = []

    static func key(_ backend: String, _ cwd: String) -> String { "\(backend)\n\(cwd)" }

    func catalog(_ backend: String, _ cwd: String) -> [SlashCommand] { catalogs[Self.key(backend, cwd)] ?? [] }

    /// Prewarm (refreshIfStale false) or revalidate a >30s-old catalog (menu open).
    func probe(_ backend: String, _ cwd: String, refreshIfStale: Bool) {
        guard backend == "claude-code" || backend == "codex" else { return }
        let key = Self.key(backend, cwd)
        guard !inFlight.contains(key) else { return }
        let checked = checkedAt[key]
        let force = refreshIfStale && Date().timeIntervalSince(checked ?? .distantPast) >= 30
        if checked != nil && !force { return }
        inFlight.insert(key)
        DispatchQueue.global(qos: .userInitiated).async {
            let result = backend == "claude-code" ? Self.probeClaude(cwd) : Self.probeCodex(cwd, force: force)
            DispatchQueue.main.async {
                self.inFlight.remove(key)
                self.checkedAt[key] = Date()
                // A transient failure keeps the last good catalog.
                if let result { self.catalogs[key] = result }
            }
        }
    }

    /// Spawn `exe args`, write `lines`, and hand every stdout JSON line to `until`
    /// until it returns a value (10s cap). The child is killed afterwards.
    nonisolated private static func converse(_ args: [String], cwd: String, lines: [Any], replyTo: ((Any) -> [Any]?)? = nil,
                                             until: @escaping ([String: Any]) -> [SlashCommand]?) -> [SlashCommand]? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        p.environment = Env.shell
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        func send(_ obj: Any) {
            if let d = try? JSONSerialization.data(withJSONObject: obj) { inPipe.fileHandleForWriting.write(d + Data("\n".utf8)) }
        }
        lines.forEach(send)
        let sem = DispatchSemaphore(value: 0)
        var result: [SlashCommand]?
        let lock = NSLock()
        DispatchQueue.global().async {
            var buf = Data()
            while true {
                let chunk = outPipe.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                buf.append(chunk)
                while let nl = buf.firstIndex(of: 0x0A) {
                    let line = buf[buf.startIndex ..< nl]
                    buf.removeSubrange(buf.startIndex ... nl)
                    guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    if let follow = replyTo?(obj) { follow.forEach(send) }
                    if let r = until(obj) {
                        lock.lock(); result = r; lock.unlock()
                        sem.signal()
                        return
                    }
                }
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10)
        if p.isRunning { p.terminate() }
        lock.lock(); defer { lock.unlock() }
        return result
    }

    /// claude initialize handshake → commands (claude_commands_from_initialize).
    nonisolated static func probeClaude(_ cwd: String) -> [SlashCommand]? {
        converse(["claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio"],
                 cwd: cwd, lines: [["type": "control_request", "request_id": "cetus-models", "request": ["subtype": "initialize"]]]) { v in
            guard let resp = v["response"] as? [String: Any], let inner = resp["response"] as? [String: Any] else { return nil }
            let list = inner["commands"] as? [[String: Any]] ?? []
            return list.compactMap { c in
                guard let name = c["name"] as? String else { return nil }
                let d = c["description"] as? String ?? ""
                var t = d
                while t.last?.isWhitespace == true { t.removeLast() }
                let skill = ["(user)", "(project)", "(plugin)", "(builtin)"].contains { t.hasSuffix($0) }
                return SlashCommand(name: name, description: d, argumentHint: c["argumentHint"] as? String ?? "", kind: skill ? "skill" : "command")
            }
        }
    }

    /// codex app-server initialize → skills/list (codex_skill_commands).
    nonisolated static func probeCodex(_ cwd: String, force: Bool) -> [SlashCommand]? {
        var isDir: ObjCBool = false
        let dir = FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir) && isDir.boolValue ? cwd : FileManager.default.currentDirectoryPath
        let initialize: [String: Any] = ["id": 1, "method": "initialize", "params": [
            "clientInfo": ["name": "cetus", "title": "Cetus", "version": "0.1.0"],
            "capabilities": ["experimentalApi": true, "requestAttestation": false]]]
        return converse(["codex", "app-server", "--listen", "stdio://"], cwd: dir, lines: [initialize], replyTo: { v in
            guard let v = v as? [String: Any], (v["id"] as? Int) == 1 else { return nil }
            return [["method": "initialized"], ["id": 2, "method": "skills/list", "params": ["cwds": [dir], "forceReload": force]]]
        }) { v in
            guard (v["id"] as? Int) == 2 else { return nil }
            var seen = Set<String>()
            var out: [SlashCommand] = []
            for entry in (v["result"] as? [String: Any])?["data"] as? [[String: Any]] ?? [] {
                for s in entry["skills"] as? [[String: Any]] ?? [] where (s["enabled"] as? Bool) ?? true {
                    guard let name = s["name"] as? String, seen.insert(name.lowercased()).inserted else { continue }
                    out.append(SlashCommand(name: name, description: s["description"] as? String ?? "", argumentHint: "", kind: "skill"))
                }
            }
            return out
        }
    }
}

// MARK: - Menu

/// absolute bottom-full mb-2 max-h-80 rounded-lg border bg-popover p-1 shadow-lg.
struct SlashMenuView: View {
    let items: [SlashItem]
    let active: Int
    let onSelect: (SlashItem) -> Void
    let onHover: (Int) -> Void
    var onCreate: (() -> Void)?
    var onEdit: ((SlashItem) -> Void)?
    @State private var hoverDriven = false

    /// Rows are at least 28pt, so past this many the list always overflows the
    /// 318pt cap: build it lazily at a fixed height instead of laying out every
    /// row (a big skill catalog) on each keystroke.
    private static let lazyThreshold = 12

    var body: some View {
        let lazy = items.count > Self.lazyThreshold
        ScrollViewReader { proxy in
            ScrollView {
                Group {
                    if lazy {
                        LazyVStack(alignment: .leading, spacing: 0) { rows }
                    } else {
                        VStack(alignment: .leading, spacing: 0) { rows }
                    }
                }
                .padding(4)
            }
            .scrollIndicators(.never)
            .frame(height: lazy ? 318 : nil)
            .frame(maxHeight: 318)
            .fixedSize(horizontal: false, vertical: true)
            .onChange(of: active) { _, h in
                if hoverDriven { hoverDriven = false; return }
                if items.indices.contains(h) { proxy.scrollTo(items[h].id) }
            }
        }
        .padding(1)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.popover))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
        .shadow(color: .black.opacity(0.1), radius: 3, y: 4)
        .testID("slash-menu")
    }

    @ViewBuilder private var rows: some View {
        ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
            if i == 0 || items[i - 1].kind != item.kind {
                heading(item.kind == .command ? "Commands" : "Skills", create: item.kind == .command ? onCreate : nil)
            }
            SlashRow(item: item, active: i == active, editable: item.kind == .command && item.commandId != nil && onEdit != nil,
                     onSelect: { onSelect(item) }, onEdit: { onEdit?(item) },
                     onHover: { if i != active { hoverDriven = true; onHover(i) } })
                .id(item.id)
                .testID("slash-row-\(i)")
        }
    }

    /// px-3 pb-1 pt-2, text-2xs muted; the Commands heading carries "+ New command".
    private func heading(_ label: String, create: (() -> Void)?) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineBox(15.4)
            Spacer(minLength: 0)
            if let create { SlashNewCommandButton(action: create) }
        }
        .frame(minHeight: 19.4)
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 4)
    }
}

private struct SlashNewCommandButton: View {
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Glyph(name: "plus", size: 12, color: hover ? Theme.foreground : Theme.mutedForeground)
                Text("New command").font(.system(size: 11, weight: .medium)).foregroundStyle(hover ? Theme.foreground : Theme.mutedForeground).lineBox(15.4)
            }
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(hover ? Theme.muted : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("New command")
        .testID("slash-new-command")
    }
}

private struct SlashRow: View {
    let item: SlashItem
    let active: Bool
    let editable: Bool
    let onSelect: () -> Void
    let onEdit: () -> Void
    let onHover: () -> Void
    @State private var hover = false

    var body: some View {
        let split = SlashCatalog.splitScope(item.description)
        HStack(alignment: .top, spacing: 8) {
            Glyph(name: item.kind == .skill ? "sparkles" : "square-slash", size: 12, color: Theme.mutedForeground).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text("/").font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                        Text(item.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.tail)
                    }
                    if let scope = split.scope {
                        Text(scope.uppercased()).font(.system(size: 11, weight: .medium)).tracking(0.275).foregroundStyle(Theme.mutedForeground)
                            .padding(.horizontal, 4).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.mutedForeground.opacity(0.1)))
                            .fixedSize()
                    }
                }
                .frame(height: 16.2)
                // line-clamp-1: full wraps made every row a multi-line text layout.
                if !split.text.isEmpty { IntelPara(text: split.text, lineLimit: 1) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .padding(.trailing, editable ? 24 : 0)
        .background(RoundedRectangle(cornerRadius: 8).fill(active ? Theme.muted : hover ? Theme.muted.opacity(0.6) : .clear))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .onContinuousHover { phase in
            if case .active = phase { hover = true; onHover() } else { hover = false }
        }
        .overlay(alignment: .trailing) {
            if editable {
                SlashEditButton(action: onEdit).padding(.trailing, 6).opacity(active || hover ? 1 : 0)
            }
        }
    }
}

private struct SlashEditButton: View {
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Glyph(name: "pencil", size: 12, color: hover ? Theme.foreground : Theme.mutedForeground)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 4).fill(hover ? Theme.background : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("Edit command")
    }
}

// MARK: - Command dialog

/// SlashCommandDialog: create (name seeded from the typed token) or edit a
/// Cetus-stored command without leaving the composer.
struct SlashCommandDialogView: View {
    let command: SlashItem?
    let initialName: String
    let onSaved: (SlashItem, Bool) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var prompt = ""
    @State private var error: String?

    init(command: SlashItem?, initialName: String, onSaved: @escaping (SlashItem, Bool) -> Void) {
        self.command = command
        self.initialName = initialName
        self.onSaved = onSaved
        _name = State(initialValue: command?.name ?? initialName)
        _description = State(initialValue: command?.description ?? "")
        _prompt = State(initialValue: command?.prompt ?? "")
    }

    private var valid: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            Text(command == nil ? "New slash command" : "Edit slash command")
                .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(20.02)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text("/").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                    IntelInput(placeholder: "name, e.g. summarize", text: $name, horizontal: 0, borderless: true, autofocus: true)
                }
                .padding(.leading, 10)
                .frame(height: 38)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
                IntelInput(placeholder: "What does it do? (one line, optional)", text: $description)
                IntelTextArea(placeholder: "The prompt this expands to. Write it as you'd type the message.", text: $prompt, rows: 6)
                if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.destructive) }
            }
            .padding(16)
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { DialogHost.dismiss() }.buttonStyle(CetusButtonStyle(variant: .ghost)).testID("slash-dialog-cancel")
                Button("Save") { save() }.buttonStyle(CetusButtonStyle()).disabled(!valid).testID("slash-dialog-save")
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        }
        .frame(width: 512)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
        .onAppear { DialogHost.onSubmit = { save() } }
        .testID("slash-command-dialog")
    }

    /// upsert_slash_command: name sans leading "/", ≤64 chars of [A-Za-z0-9_-], unique (case-insensitive).
    private func save() {
        guard valid else { return }
        var n = name.trimmingCharacters(in: .whitespaces)
        while n.hasPrefix("/") { n.removeFirst() }
        n = String(n.trimmingCharacters(in: .whitespaces).prefix(64))
        guard let first = n.first, first.isASCII, first.isLetter || first.isNumber,
              n.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else {
            error = n.isEmpty ? "a command needs a name" : "use letters, numbers, dashes or underscores only"; return
        }
        var list = IntelSlash.load()
        let idx = command?.commandId.flatMap { id in list.firstIndex { $0.id == id } } ?? list.firstIndex { $0.name.lowercased() == n.lowercased() }
        if list.enumerated().contains(where: { $0.offset != idx && $0.element.name.lowercased() == n.lowercased() }) {
            error = "a command named /\(n) already exists"; return
        }
        let now = IntelData.nowMs()
        let desc = description.trimmingCharacters(in: .whitespaces)
        var id = IntelData.uuid()
        if let i = idx {
            id = list[i].id
            list[i].raw["name"] = n
            list[i].raw["description"] = desc
            list[i].raw["prompt"] = prompt
            list[i].raw["updatedAt"] = now
        } else {
            list.append(IntelSlashCommand(["id": id, "name": n, "description": desc, "prompt": prompt, "createdAt": now, "updatedAt": now]))
        }
        IntelSlash.save(list)
        DialogHost.dismiss()
        onSaved(SlashItem(kind: .command, id: id, name: n, description: desc, prompt: prompt, commandId: id), command == nil)
    }
}
