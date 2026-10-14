import AppKit
import SwiftUI

// MARK: - Skills (skills.tsx) — app_settings.skills + <app data>/skills/<id>, discovered SKILL.md folders

struct IntelSkillEntry: Identifiable {
    var id: String
    var name: String
    var description: String
    var enabled: Bool
    var source: String
    var updatedAt: Double
    var raw: [String: Any]

    init(_ d: [String: Any]) {
        raw = d
        id = d["id"] as? String ?? ""
        name = d["name"] as? String ?? ""
        description = d["description"] as? String ?? ""
        enabled = d["enabled"] as? Bool ?? true
        source = d["source"] as? String ?? "import"
        updatedAt = (d["updatedAt"] as? NSNumber)?.doubleValue ?? 0
    }
}

struct IntelDiscoveredSkill: Identifiable {
    var id: String { path }
    let name: String
    let description: String
    let scope: String // "repo" | "user"
    let root: String
    let path: String
}

enum IntelSkills {
    static let standardDirs = [".agents", ".claude", ".codex"]

    static func state() -> (enabled: Bool, entries: [IntelSkillEntry]) {
        let s = IntelData.settingJSON("skills") ?? [:]
        return (s["enabled"] as? Bool ?? true, (s["entries"] as? [[String: Any]] ?? []).map(IntelSkillEntry.init))
    }

    static func saveState(enabled: Bool, entries: [IntelSkillEntry]) {
        IntelData.setSettingJSON("skills", ["version": 1, "enabled": enabled, "entries": entries.map(\.raw)])
    }

    static func discovery() -> [String: Any] {
        var d = IntelData.settingJSON("discovery") ?? [:]
        if d["skillsFolder"] == nil { d["skillsFolder"] = "\(Env.home)/.agents/skills" }
        if d["skillsLoadDiscovered"] == nil { d["skillsLoadDiscovered"] = false }
        if d["mcpImports"] == nil { d["mcpImports"] = [String]() }
        return d
    }

    static func setDiscovery(_ d: [String: Any]) { IntelData.setSettingJSON("discovery", d) }

    static func libraryDir(_ id: String) -> URL { IntelData.file("skills").appendingPathComponent(id) }

    /// skills::parse_frontmatter — `name:` / `description:` from a leading `---` block.
    static func frontmatter(_ md: String) -> (String?, String?) {
        var lines = md.replacingOccurrences(of: "\u{feff}", with: "").components(separatedBy: "\n")
        guard let first = lines.first, first.trimmingCharacters(in: .whitespaces) == "---" else { return (nil, nil) }
        lines.removeFirst()
        var name: String?, desc: String?
        for line in lines {
            if line.trimmingCharacters(in: .whitespaces) == "---" { break }
            guard let c = line.firstIndex(of: ":") else { continue }
            let key = line[..<c].trimmingCharacters(in: .whitespaces).lowercased()
            var v = line[line.index(after: c)...].trimmingCharacters(in: .whitespaces)
            if v.count >= 2, (v.hasPrefix("\"") && v.hasSuffix("\"")) || (v.hasPrefix("'") && v.hasSuffix("'")) { v = String(v.dropFirst().dropLast()) }
            if v.isEmpty { continue }
            if key == "name" { name = v } else if key == "description" { desc = v }
        }
        return (name, desc)
    }

    static func clamp(_ s: String, _ n: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > n ? String(t.prefix(n)) : t
    }

    private static func canon(_ p: String) -> String { URL(fileURLWithPath: p).resolvingSymlinksInPath().path }

    private static func isDir(_ p: String) -> Bool {
        var d: ObjCBool = false
        return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue
    }

    /// skills::discovered_roots — user roots, then repo roots from ancestors of
    /// the cwd, the default workspace, and recent conversations' workspaces.
    static func roots() -> [(scope: String, path: String)] {
        var out: [(String, String)] = []
        var seen = Set<String>()
        let extra = discovery()["skillsFolder"] as? String ?? ""
        for p in standardDirs.map({ "\(Env.home)/\($0)/skills" }) + [extra] where !p.isEmpty {
            if seen.insert(canon(p)).inserted { out.append(("user", p)) }
        }
        let starts = [FileManager.default.currentDirectoryPath, "\(Env.home)/cetus"] + IntelData.conversationWorkspaces()
        for start in starts {
            var dir = URL(fileURLWithPath: start).standardizedFileURL
            while true {
                for d in standardDirs {
                    let root = dir.appendingPathComponent(d).appendingPathComponent("skills").path
                    if isDir(root), seen.insert(canon(root)).inserted { out.append(("repo", root)) }
                }
                let parent = dir.deletingLastPathComponent()
                if parent.path == dir.path || dir.path == "/" { break }
                dir = parent
            }
        }
        return out
    }

    static func discovered() -> [IntelDiscoveredSkill] {
        var out: [IntelDiscoveredSkill] = []
        let fm = FileManager.default
        for r in roots() {
            guard let items = try? fm.contentsOfDirectory(atPath: r.path) else { continue }
            // DirEntry::file_type doesn't follow symlinks: linked skill folders are skipped, as in Tauri.
            for folder in items where !folder.hasPrefix(".")
                && (try? fm.attributesOfItem(atPath: "\(r.path)/\(folder)")[.type] as? FileAttributeType) == .typeDirectory {
                let md = "\(r.path)/\(folder)/SKILL.md"
                guard let text = try? String(contentsOfFile: md, encoding: .utf8) else { continue }
                let (n, d) = frontmatter(text)
                let name = clamp(n ?? folder, 120)
                out.append(IntelDiscoveredSkill(name: name.isEmpty ? folder : name, description: clamp(d ?? "", 400), scope: r.scope, root: r.path, path: md))
            }
        }
        return out.sorted { a, b in a.scope != b.scope ? a.scope < b.scope : a.name.lowercased() < b.name.lowercased() }
    }

    /// Groups keyed by root, in order of first appearance.
    static func groups(_ list: [IntelDiscoveredSkill]) -> [(root: String, skills: [IntelDiscoveredSkill])] {
        var order: [String] = []
        var map: [String: [IntelDiscoveredSkill]] = [:]
        for s in list {
            if map[s.root] == nil { order.append(s.root) }
            map[s.root, default: []].append(s)
        }
        return order.map { ($0, map[$0]!) }
    }

    static func stripFrontmatter(_ md: String) -> String {
        let s = md.replacingOccurrences(of: "\u{feff}", with: "")
        guard s.hasPrefix("---") else { return s }
        guard let end = s.range(of: "\n---", range: s.index(s.startIndex, offsetBy: 3) ..< s.endIndex) else { return s }
        guard let nl = s.range(of: "\n", range: end.upperBound ..< s.endIndex) else { return "" }
        return String(s[nl.upperBound...]).replacingOccurrences(of: #"^\s+"#, with: "", options: .regularExpression)
    }

    static func yamlQuote(_ s: String) -> String {
        let one = s.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        return "\"" + one.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}

struct IntelSkillsSection: View {
    @State private var loaded = false
    @State private var enabled = true
    @State private var entries: [IntelSkillEntry] = []
    @State private var writing = false
    @State private var error: String?

    var body: some View {
        let sorted = entries.sorted { $0.updatedAt > $1.updatedAt }
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "Skills", description: "Reusable instructions the agent can pull in on demand — a folder with a SKILL.md (name + description + steps), following the open Agent Skills standard. Install one from a folder or write your own; enabled skills are offered to the agent every turn.")
            IntelToggleRow(label: "Enable skills", description: "When on, enabled skills below are made available to the agent. Turn off to pause all skills without uninstalling them.",
                           isOn: enabled, testID: "skills-enabled") { v in
                enabled = v
                let s = IntelSkills.state()
                IntelSkills.saveState(enabled: v, entries: s.entries)
            }
            .padding(.top, 24)

            HStack(spacing: 8) {
                Button { importFolder() } label: { IntelLabel(icon: "folder-open", text: "Import folder") }.buttonStyle(IntelButtonStyle()).testID("skills-import")
                Button { writing.toggle() } label: { IntelLabel(icon: "plus", text: "Write one") }.buttonStyle(IntelButtonStyle()).testID("skills-write")
                Button { System.openURL("https://agentskills.io") } label: { IntelLabel(icon: "external-link", text: "Learn about skills") }
                    .buttonStyle(IntelButtonStyle(variant: .ghost, muted: true))
            }
            .compositingGroup().opacity(enabled ? 1 : 0.6)
            .padding(.top, 16)

            if writing {
                IntelSkillEditor(onCancel: { writing = false }, onSaved: { writing = false; load() }, onError: { error = $0 })
                    .padding(.top, 16)
            }

            IntelCaption(text: !loaded ? "Loading…" : sorted.isEmpty ? "No skills installed" : intelCount(sorted.count, "skill", "skills"))
                .padding(.top, 24)
            if !sorted.isEmpty {
                IntelList {
                    ForEach(sorted) { s in
                        IntelSkillRow(entry: s, onToggle: toggle, onDelete: remove)
                    }
                }
                .padding(.top, 12)
            }

            IntelDiscoveredSkills().padding(.top, 32)
            IntelError(text: error)
        }
        .onAppear(perform: load)
    }

    private func load() {
        let s = IntelSkills.state()
        enabled = s.enabled
        entries = s.entries
        loaded = true
    }

    private func importFolder() {
        guard let path = IntelData.pickFolder() else { return }
        let md = "\(path)/SKILL.md"
        guard let text = try? String(contentsOfFile: md, encoding: .utf8) else { error = "that folder has no SKILL.md — not a skill"; return }
        let (n, d) = IntelSkills.frontmatter(text)
        let id = IntelData.uuid()
        do {
            try FileManager.default.createDirectory(at: IntelData.file("skills"), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: IntelSkills.libraryDir(id))
        } catch { self.error = error.localizedDescription; return }
        let name = IntelSkills.clamp(n ?? URL(fileURLWithPath: path).lastPathComponent, 120)
        let now = IntelData.nowMs()
        var s = IntelSkills.state()
        s.entries.append(IntelSkillEntry(["id": id, "name": name.isEmpty ? "Untitled skill" : name, "description": IntelSkills.clamp(d ?? "", 400),
                                          "enabled": true, "source": "import", "createdAt": now, "updatedAt": now]))
        IntelSkills.saveState(enabled: s.enabled, entries: s.entries)
        load()
    }

    private func toggle(_ id: String, _ on: Bool) {
        var s = IntelSkills.state()
        guard let i = s.entries.firstIndex(where: { $0.id == id }) else { return }
        s.entries[i].raw["enabled"] = on
        s.entries[i].raw["updatedAt"] = IntelData.nowMs()
        IntelSkills.saveState(enabled: s.enabled, entries: s.entries)
        load()
    }

    private func remove(_ id: String) {
        var s = IntelSkills.state()
        s.entries.removeAll { $0.id == id }
        try? FileManager.default.removeItem(at: IntelSkills.libraryDir(id))
        IntelSkills.saveState(enabled: s.enabled, entries: s.entries)
        load()
    }
}

private struct IntelSkillRow: View {
    let entry: IntelSkillEntry
    let onToggle: (String, Bool) -> Void
    let onDelete: (String) -> Void
    @State private var confirming = false
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                IntelLine(text: entry.name, weight: .medium)
                if !entry.description.isEmpty { IntelPara(text: entry.description, lh: 16.5) }
                HStack(spacing: 8) {
                    let agent = entry.source == "agent"
                    IntelTag(text: agent ? (entry.enabled ? "By agent" : "Proposed") : entry.source == "created" ? "Written" : "Imported",
                             fill: agent ? IntelColor.skill.opacity(0.1) : Theme.muted, color: agent ? IntelColor.skill : Theme.mutedForeground)
                    IntelLine(text: "Updated \(IntelData.localeDate(entry.updatedAt))", size: 12, lh: 16.2, color: Theme.mutedForeground)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 2) {
                IntelSwitch(isOn: entry.enabled, testID: "skill-toggle-\(entry.id)") { onToggle(entry.id, $0) }
                IntelIconButton(icon: "folder-open") { System.open(IntelSkills.libraryDir(entry.id).path) }
                if confirming {
                    Button { onDelete(entry.id) } label: { Text("Delete") }.buttonStyle(IntelButtonStyle(variant: .destructive))
                    Button { confirming = false } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle(variant: .ghost, muted: true))
                } else {
                    IntelIconButton(icon: "trash-2", destructiveHover: true) { confirming = true }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .compositingGroup()
        .opacity(entry.enabled ? 1 : 0.5)
    }
}

private struct IntelSkillEditor: View {
    let onCancel: () -> Void
    let onSaved: () -> Void
    let onError: (String) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var bodyText = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            IntelLine(text: "Write a skill", size: 12, lh: 16.2, weight: .medium, color: Theme.mutedForeground)
            IntelInput(placeholder: "Name, e.g. Commit message style", text: $name, autofocus: true)
            IntelInput(placeholder: "When should the agent use this? (one line)", text: $description)
            IntelTextArea(placeholder: "The skill itself, in markdown. Steps, examples, rules…", text: $bodyText, rows: 6, mono: true)
            HStack(spacing: 8) {
                Button { save() } label: { Text("Create skill") }.buttonStyle(IntelButtonStyle(variant: .primary))
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                Button { onCancel() } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle())
            }
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }

    private func save() {
        let n = IntelSkills.clamp(name, 120)
        guard !n.isEmpty else { return }
        let d = IntelSkills.clamp(description, 400)
        let id = IntelData.uuid()
        let dir = IntelSkills.libraryDir(id)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let md = "---\nname: \(IntelSkills.yamlQuote(n))\ndescription: \(IntelSkills.yamlQuote(d))\n---\n\n\(bodyText.trimmingCharacters(in: .whitespacesAndNewlines))\n"
            try md.write(to: dir.appendingPathComponent("SKILL.md"), atomically: true, encoding: .utf8)
        } catch { onError(error.localizedDescription); return }
        let now = IntelData.nowMs()
        var s = IntelSkills.state()
        s.entries.append(IntelSkillEntry(["id": id, "name": n, "description": d, "enabled": true, "source": "created", "createdAt": now, "updatedAt": now]))
        IntelSkills.saveState(enabled: s.enabled, entries: s.entries)
        onSaved()
    }
}

private struct IntelDiscoveredSkills: View {
    @State private var skills: [IntelDiscoveredSkill]?
    @State private var loadDiscovered = false
    @State private var folder = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            IntelLine(text: "Discovered skills", weight: .medium)
            IntelPara(text: "Skills found in standard .agents, .claude, and .codex folders or the additional folder below. They're shown here read-only; manage them in their source folder.", lh: 16.5)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 12) {
                IntelToggleRow(label: "Load discovered skills", description: "Include skills from the folder below plus standard .agents, .claude, and .codex skill folders in new chats.",
                               isOn: loadDiscovered, testID: "skills-load-discovered") { v in
                    loadDiscovered = v
                    var d = IntelSkills.discovery()
                    d["skillsLoadDiscovered"] = v
                    IntelSkills.setDiscovery(d)
                }
                HStack(spacing: 8) {
                    IntelInput(placeholder: "", text: .constant(folder), mono: true, readOnly: true)
                    Button { pick() } label: { IntelLabel(icon: "folder-open", text: "Choose folder") }.buttonStyle(IntelButtonStyle())
                }
            }
            .padding(13)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 16)

            IntelCaption(text: skills == nil ? "Loading…" : intelCount(skills!.count, "discovered skill", "discovered skills"))
                .padding(.top, 16)
            if let skills, !skills.isEmpty {
                let repo = IntelSkills.groups(skills.filter { $0.scope == "repo" })
                let user = IntelSkills.groups(skills.filter { $0.scope != "repo" })
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(repo, id: \.root) { g in group("Repo skills", g.root, g.skills) }
                    ForEach(user, id: \.root) { g in group("User skills", g.root, g.skills) }
                }
                .padding(.top, 12)
            }
        }
        .padding(.top, 25)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        .onAppear(perform: reload)
    }

    private func reload() {
        let d = IntelSkills.discovery()
        loadDiscovered = d["skillsLoadDiscovered"] as? Bool ?? false
        folder = d["skillsFolder"] as? String ?? ""
        skills = IntelSkills.discovered()
    }

    private func pick() {
        guard let dir = IntelData.pickFolder() else { return }
        var d = IntelSkills.discovery()
        d["skillsFolder"] = dir
        IntelSkills.setDiscovery(d)
        reload()
    }

    private func group(_ title: String, _ root: String, _ list: [IntelDiscoveredSkill]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                IntelLine(text: title, size: 12, lh: 16.2, weight: .medium).fixedSize()
                IntelLine(text: root, size: 12, lh: 16.2, mono: true, color: Theme.mutedForeground)
            }
            IntelList {
                ForEach(list) { s in IntelDiscoveredRow(skill: s) }
            }
        }
    }
}

private struct IntelDiscoveredRow: View {
    let skill: IntelDiscoveredSkill
    @State private var expanded = false
    @State private var bodyText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Button(action: toggle) {
                    VStack(alignment: .leading, spacing: 4) {
                        IntelLine(text: skill.name, weight: .medium)
                        if !skill.description.isEmpty {
                            IntelPara(text: skill.description, lh: 16.5, lineLimit: expanded ? nil : 2)
                        }
                        IntelTag(text: skill.scope == "repo" ? "Repo" : "User")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                HStack(spacing: 2) {
                    IntelIconButton(icon: "chevron-down", glyph: 16, rotate: expanded ? 180 : 0, testID: "discovered-expand-\(skill.path)", action: toggle)
                    IntelIconButton(icon: "folder-open") { System.reveal(URL(fileURLWithPath: skill.path).deletingLastPathComponent().path) }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        IntelIcon(name: "file-text", size: 12, color: Theme.mutedForeground)
                        IntelLine(text: skill.path, size: 12, lh: 16.2, mono: true, color: Theme.mutedForeground)
                    }
                    if let b = bodyText {
                        MarkdownView(text: IntelSkills.stripFrontmatter(b), baseSize: 14)
                    } else {
                        IntelLine(text: "Loading…", size: 12, lh: 16.2, color: Theme.mutedForeground)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.muted.opacity(0.2))
                .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
            }
        }
        .background(Theme.card)
    }

    private func toggle() {
        expanded.toggle()
        if expanded && bodyText == nil {
            let t = (try? String(contentsOfFile: skill.path, encoding: .utf8)) ?? ""
            bodyText = String(t.prefix(200_000))
        }
    }
}

// MARK: - Slash commands (slash-commands.tsx) — app_settings.slash_commands

struct IntelSlashCommand: Identifiable {
    var id: String
    var name: String
    var description: String
    var prompt: String
    var raw: [String: Any]
    init(_ d: [String: Any]) {
        raw = d
        id = d["id"] as? String ?? ""
        name = d["name"] as? String ?? ""
        description = d["description"] as? String ?? ""
        prompt = d["prompt"] as? String ?? ""
    }
}

enum IntelSlash {
    static func load() -> [IntelSlashCommand] {
        ((IntelData.settingJSON("slash_commands") ?? [:])["commands"] as? [[String: Any]] ?? []).map(IntelSlashCommand.init)
    }
    static func save(_ list: [IntelSlashCommand]) {
        IntelData.setSettingJSON("slash_commands", ["commands": list.map(\.raw)])
    }
}

struct IntelSlashSection: View {
    @State private var commands: [IntelSlashCommand]?
    @State private var editing: IntelSlashCommand?
    @State private var creating = false
    @State private var error: String?

    var body: some View {
        let sorted = (commands ?? []).sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "Slash commands", description: "Reusable prompt snippets you trigger by typing /name in the composer — picking one expands it into the message before it's sent. Stored locally on this device, they appear alongside your skills in the composer's slash menu.")
            Button { editing = nil; creating = true } label: { IntelLabel(icon: "plus", text: "New command") }
                .buttonStyle(IntelButtonStyle()).padding(.top, 24).testID("slash-new")
            if creating || editing != nil {
                IntelSlashEditor(command: editing, onCancel: { creating = false; editing = nil },
                                 onSaved: { creating = false; editing = nil; reload() }, onError: { error = $0 })
                    .id(editing?.id ?? "new")
                    .padding(.top, 16)
            }
            IntelCaption(text: commands == nil ? "Loading…" : sorted.isEmpty ? "No commands yet" : intelCount(sorted.count, "command", "commands"))
                .padding(.top, 24)
            if !sorted.isEmpty {
                IntelList {
                    ForEach(sorted) { c in
                        IntelSlashRow(command: c, onEdit: { creating = false; editing = c }, onDelete: remove)
                    }
                }
                .padding(.top, 12)
            }
            IntelError(text: error)
        }
        .onAppear(perform: reload)
    }

    private func reload() { commands = IntelSlash.load() }

    private func remove(_ id: String) {
        IntelSlash.save(IntelSlash.load().filter { $0.id != id })
        reload()
    }
}

private struct IntelSlashRow: View {
    let command: IntelSlashCommand
    let onEdit: () -> Void
    let onDelete: (String) -> Void
    @State private var confirming = false
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                IntelLine(text: "/\(command.name)", weight: .medium)
                if !command.description.isEmpty { IntelPara(text: command.description, lh: 16.5) }
                IntelPara(text: command.prompt, lh: 16.5, mono: true, color: Theme.mutedForeground.opacity(0.8), lineLimit: 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 2) {
                IntelIconButton(icon: "pencil", testID: "slash-edit-\(command.name)", action: onEdit)
                if confirming {
                    Button { onDelete(command.id) } label: { Text("Delete") }.buttonStyle(IntelButtonStyle(variant: .destructive))
                    Button { confirming = false } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle(variant: .ghost, muted: true))
                } else {
                    IntelIconButton(icon: "trash-2", destructiveHover: true, testID: "slash-delete-\(command.name)") { confirming = true }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }
}

private struct IntelSlashEditor: View {
    let command: IntelSlashCommand?
    let onCancel: () -> Void
    let onSaved: () -> Void
    let onError: (String) -> Void
    @State private var name = ""
    @State private var description = ""
    @State private var prompt = ""

    init(command: IntelSlashCommand?, onCancel: @escaping () -> Void, onSaved: @escaping () -> Void, onError: @escaping (String) -> Void) {
        self.command = command
        self.onCancel = onCancel
        self.onSaved = onSaved
        self.onError = onError
        _name = State(initialValue: command?.name ?? "")
        _description = State(initialValue: command?.description ?? "")
        _prompt = State(initialValue: command?.prompt ?? "")
    }

    var body: some View {
        let valid = !name.trimmingCharacters(in: .whitespaces).isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 8) {
            IntelLine(text: command == nil ? "New slash command" : "Edit slash command", size: 12, lh: 16.2, weight: .medium, color: Theme.mutedForeground)
            HStack(spacing: 6) {
                Text("/").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                IntelInput(placeholder: "name, e.g. summarize", text: $name, horizontal: 0, borderless: true, autofocus: true)
            }
            .padding(.leading, 11)
            .frame(height: 38)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            IntelInput(placeholder: "What does it do? (one line, optional)", text: $description)
            IntelTextArea(placeholder: "The prompt this expands to. Write it as you'd type the message.", text: $prompt, rows: 5)
            HStack(spacing: 8) {
                Button { save() } label: { Text("Save") }.buttonStyle(IntelButtonStyle(variant: .primary)).disabled(!valid)
                Button { onCancel() } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle()).testID("slash-cancel")
            }
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }

    private func save() {
        var n = name.trimmingCharacters(in: .whitespaces)
        while n.hasPrefix("/") { n.removeFirst() }
        n = String(n.trimmingCharacters(in: .whitespaces).prefix(64))
        guard let first = n.first, first.isASCII, first.isLetter || first.isNumber,
              n.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }) else {
            onError(n.isEmpty ? "a command needs a name" : "use letters, numbers, dashes or underscores only"); return
        }
        var list = IntelSlash.load()
        let idx = command.flatMap { c in list.firstIndex { $0.id == c.id } } ?? list.firstIndex { $0.name.lowercased() == n.lowercased() }
        if list.enumerated().contains(where: { $0.offset != idx && $0.element.name.lowercased() == n.lowercased() }) {
            onError("a command named /\(n) already exists"); return
        }
        let now = IntelData.nowMs()
        if let i = idx {
            list[i].raw["name"] = n
            list[i].raw["description"] = description.trimmingCharacters(in: .whitespaces)
            list[i].raw["prompt"] = prompt
            list[i].raw["updatedAt"] = now
        } else {
            list.append(IntelSlashCommand(["id": IntelData.uuid(), "name": n, "description": description.trimmingCharacters(in: .whitespaces),
                                           "prompt": prompt, "createdAt": now, "updatedAt": now]))
        }
        IntelSlash.save(list)
        onSaved()
    }
}
