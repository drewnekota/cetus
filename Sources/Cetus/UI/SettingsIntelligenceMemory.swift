import SwiftUI

// MARK: - Memory (memory.tsx) — <app data>/memory.json

struct IntelMemoryEntry: Identifiable, Equatable {
    var id: String
    var content: String
    var category: String?
    var source: String
    var enabled: Bool
    var createdAt: Double
    var updatedAt: Double

    init(_ d: [String: Any]) {
        id = d["id"] as? String ?? ""
        content = d["content"] as? String ?? ""
        let c = (d["category"] as? String)?.trimmingCharacters(in: .whitespaces)
        category = (c?.isEmpty ?? true) ? nil : c
        source = d["source"] as? String ?? "user"
        enabled = d["enabled"] as? Bool ?? true
        createdAt = (d["createdAt"] as? NSNumber)?.doubleValue ?? 0
        updatedAt = (d["updatedAt"] as? NSNumber)?.doubleValue ?? 0
    }

    var json: [String: Any] {
        var d: [String: Any] = ["id": id, "content": content, "source": source, "enabled": enabled,
                                "createdAt": Int64(createdAt), "updatedAt": Int64(updatedAt)]
        d["category"] = category ?? NSNull()
        return d
    }
}

enum IntelMemoryStore {
    static var url: URL { IntelData.file("memory.json") }

    static func read() -> (enabled: Bool, entries: [IntelMemoryEntry]) {
        let root = IntelData.readJSON(url) as? [String: Any] ?? [:]
        let entries = (root["entries"] as? [[String: Any]] ?? []).map(IntelMemoryEntry.init).filter { !$0.id.isEmpty && !$0.content.isEmpty }
        return (root["enabled"] as? Bool ?? true, entries)
    }

    static func write(enabled: Bool, entries: [IntelMemoryEntry]) {
        IntelData.writeJSON(url, ["version": 1, "enabled": enabled, "entries": entries.map(\.json)])
    }

    static func mutate(_ f: (inout Bool, inout [IntelMemoryEntry]) -> Void) {
        var (en, list) = read()
        f(&en, &list)
        write(enabled: en, entries: list)
    }
}

struct IntelMemorySection: View {
    @State private var loaded = false
    @State private var enabled = true
    @State private var entries: [IntelMemoryEntry] = []
    @State private var draft = ""
    @State private var draftCategory = ""
    @State private var confirmingClear = false

    var body: some View {
        let sorted = entries.sorted { $0.updatedAt > $1.updatedAt }
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "Memory", description: "Durable notes about you — your preferences, ongoing projects, and decisions — that the agent carries across conversations. The agent adds to these as it learns; you can add, edit, mute, or delete any of them here.")
            IntelToggleRow(label: "Enable memory", description: "When on, enabled notes below are injected into the agent's context every turn. Turn off to pause memory without losing your notes.",
                           isOn: enabled, testID: "memory-enabled") { v in
                enabled = v
                IntelMemoryStore.mutate { e, _ in e = v }
            }
            .padding(.top, 24)

            addCard
                .compositingGroup().opacity(enabled ? 1 : 0.6)
                .padding(.top, 16)

            HStack(spacing: 16) {
                IntelCaption(text: !loaded ? "Loading…" : sorted.isEmpty ? "No memories yet" : intelCount(sorted.count, "memory", "memories"))
                Spacer(minLength: 0)
                if !sorted.isEmpty {
                    if confirmingClear {
                        HStack(spacing: 8) {
                            IntelLine(text: "Delete all?", size: 12, lh: 16.2, color: Theme.mutedForeground)
                            Button { clearAll() } label: { Text("Confirm") }.buttonStyle(IntelButtonStyle(variant: .destructive)).testID("memory-clear-confirm")
                            Button { confirmingClear = false } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle()).testID("memory-clear-cancel")
                        }
                    } else {
                        Button { confirmingClear = true } label: { IntelLabel(icon: "trash-2", text: "Clear all") }
                            .buttonStyle(IntelButtonStyle(destructiveText: true)).testID("memory-clear")
                    }
                }
            }
            .frame(minHeight: 32)
            .padding(.top, 24)

            if !sorted.isEmpty {
                IntelList {
                    ForEach(sorted) { m in
                        IntelMemoryRow(entry: m, onSave: save, onToggle: toggle, onDelete: remove)
                    }
                }
                .padding(.top, 12)
            }
        }
        .onAppear(perform: load)
    }

    private var addCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            IntelLine(text: "Add a memory", size: 12, lh: 16.2, weight: .medium, color: Theme.mutedForeground)
            IntelTextArea(placeholder: "e.g. Prefers pnpm over npm, and concise commit messages.", text: $draft, rows: 2, onCommand: add)
            HStack(spacing: 8) {
                IntelInput(placeholder: "Category (optional)", text: $draftCategory, height: 32)
                Button { add() } label: { IntelLabel(icon: "plus", text: "Add") }
                    .buttonStyle(IntelButtonStyle(variant: .primary))
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .testID("memory-add")
            }
        }
        .padding(13)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }

    private func load() {
        let s = IntelMemoryStore.read()
        enabled = s.enabled
        entries = s.entries
        loaded = true
    }

    private func add() {
        let c = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return }
        let cat = draftCategory.trimmingCharacters(in: .whitespaces)
        let now = Double(IntelData.nowMs())
        var e = IntelMemoryEntry(["id": IntelData.uuid(), "content": String(c.prefix(2000)), "source": "user", "enabled": true])
        e.category = cat.isEmpty ? nil : cat
        e.createdAt = now
        e.updatedAt = now
        IntelMemoryStore.mutate { _, list in list.append(e) }
        draft = ""
        draftCategory = ""
        load()
    }

    private func save(_ id: String, _ content: String, _ category: String) {
        IntelMemoryStore.mutate { _, list in
            guard let i = list.firstIndex(where: { $0.id == id }) else { return }
            list[i].content = content
            list[i].category = category.isEmpty ? nil : category
            list[i].updatedAt = Double(IntelData.nowMs())
        }
        load()
    }

    private func toggle(_ id: String, _ on: Bool) {
        if let i = entries.firstIndex(where: { $0.id == id }) { entries[i].enabled = on }
        IntelMemoryStore.mutate { _, list in
            if let i = list.firstIndex(where: { $0.id == id }) { list[i].enabled = on }
        }
    }

    private func remove(_ id: String) {
        entries.removeAll { $0.id == id }
        IntelMemoryStore.mutate { _, list in list.removeAll { $0.id == id } }
    }

    private func clearAll() {
        IntelMemoryStore.mutate { _, list in list = [] }
        entries = []
        confirmingClear = false
    }
}

private struct IntelMemoryRow: View {
    let entry: IntelMemoryEntry
    let onSave: (String, String, String) -> Void
    let onToggle: (String, Bool) -> Void
    let onDelete: (String) -> Void
    @State private var editing = false
    @State private var content = ""
    @State private var category = ""

    var body: some View {
        if editing {
            VStack(alignment: .leading, spacing: 8) {
                IntelTextArea(placeholder: "", text: $content, rows: 2, autofocus: true, onCommand: save, onEscape: cancel)
                HStack(spacing: 8) {
                    IntelInput(placeholder: "Category (optional)", text: $category, height: 32)
                    Button { save() } label: { Text("Save") }.buttonStyle(IntelButtonStyle(variant: .primary))
                        .disabled(content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button { cancel() } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle())
                }
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.3)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        } else {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    IntelPara(text: entry.content, size: 14, lh: 19.25, color: Theme.foreground)
                    HStack(spacing: 8) {
                        if entry.source == "agent" {
                            IntelTag(text: "Agent", fill: IntelColor.skill.opacity(0.1), color: IntelColor.skill)
                        } else {
                            IntelTag(text: "You")
                        }
                        if let c = entry.category { IntelTag(text: c, weight: .regular) }
                        IntelLine(text: "Edited \(IntelData.localeDate(entry.updatedAt))", size: 12, lh: 16.2, color: Theme.mutedForeground)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 2) {
                    IntelSwitch(isOn: entry.enabled, testID: "memory-toggle-\(entry.id)") { onToggle(entry.id, $0) }
                    IntelIconButton(icon: "pencil", testID: "memory-edit-\(entry.id)") {
                        content = entry.content
                        category = entry.category ?? ""
                        editing = true
                    }
                    IntelIconButton(icon: "trash-2", destructiveHover: true, testID: "memory-delete-\(entry.id)") { onDelete(entry.id) }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .compositingGroup()
            .opacity(entry.enabled ? 1 : 0.5)
        }
    }

    private func save() {
        let c = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !c.isEmpty else { return }
        onSave(entry.id, c, category.trimmingCharacters(in: .whitespaces))
        editing = false
    }

    private func cancel() { editing = false }
}
