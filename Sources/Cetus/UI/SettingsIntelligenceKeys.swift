import AppKit
import SwiftUI

// MARK: - API Keys (api-keys.tsx)

struct IntelApiKeysSection: View {
    static let providers: [(id: String, label: String, env: String)] = [
        ("deepseek", "DeepSeek", "DEEPSEEK_API_KEY"),
        ("exa", "Exa (web search)", "EXA_API_KEY"),
        ("tavily", "Tavily (web search)", "TAVILY_API_KEY"),
        ("doubao", "Doubao (voice)", "DOUBAO_API_KEY"),
        ("volc_ark", "Volcano Ark (rewrite)", "ARK_API_KEY"),
    ]

    @State private var masked: [String: String] = [:]
    @State private var editing: [String: String] = [:]
    @State private var copied: String?
    @State private var dsUrl = ""
    @State private var dsUrlSaved = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "API keys", description: "Keys are stored in your OS keychain. Saving restarts the pi subprocess so new keys take effect immediately.")
            VStack(alignment: .leading, spacing: 20) {
                ForEach(Self.providers, id: \.id) { p in row(p) }
                urlBlock
            }
            .padding(.top, 24)
        }
        .onAppear(perform: load)
    }

    private func load() {
        masked = IntelData.secrets().filter { k, _ in Self.providers.contains { $0.id == k } }.mapValues(IntelData.mask)
        let u = (IntelData.setting("deepseek_base_url") ?? "").trimmingCharacters(in: .whitespaces)
        let norm = u.hasSuffix("/") ? String(u.dropLast()) : u
        dsUrl = norm
        dsUrlSaved = norm
    }

    @ViewBuilder
    private func row(_ p: (id: String, label: String, env: String)) -> some View {
        let stored = masked[p.id] != nil
        let isEditing = editing[p.id] != nil
        let pending = Binding(get: { editing[p.id] ?? "" }, set: { editing[p.id] = $0 })
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(p.label).font(.system(size: 14, weight: .medium))
                    Text(p.env).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground)
                }
                .frame(height: 20.02)
                Spacer(minLength: 0)
                if stored && !isEditing {
                    IntelLine(text: "● stored", size: 12, lh: 16.2, color: Theme.success)
                } else if isEditing {
                    IntelLine(text: "● unsaved", size: 12, lh: 16.2, color: Theme.warning)
                }
            }
            HStack(alignment: .top, spacing: 8) {
                if stored && !isEditing {
                    Text(masked[p.id] ?? "•••").font(.system(size: 14, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: 36, maxHeight: 36, alignment: .leading)
                    Button { copy(p.id) } label: { IntelLabel(icon: copied == p.id ? "check" : "copy", text: copied == p.id ? "Copied" : "Copy") }
                        .buttonStyle(IntelButtonStyle()).testID("apikey-copy-\(p.id)")
                    Button { editing[p.id] = "" } label: { Text("Replace") }.buttonStyle(IntelButtonStyle()).testID("apikey-replace-\(p.id)")
                    Button { remove(p.id) } label: { Text("Remove") }.buttonStyle(IntelButtonStyle()).testID("apikey-remove-\(p.id)")
                } else {
                    IntelInput(placeholder: "sk-…", text: pending, mono: true, secure: stored, autofocus: isEditing, testID: "apikey-input-\(p.id)",
                               onSubmit: { save(p.id) }, onEscape: { editing[p.id] = nil })
                    if !pending.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button { save(p.id) } label: { Text("Save") }.buttonStyle(IntelButtonStyle(variant: .primary))
                    }
                    if stored {
                        Button { editing[p.id] = nil } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle()).testID("apikey-cancel-\(p.id)")
                    }
                }
            }
        }
    }

    private var urlBlock: some View {
        let dirty = dsUrl.trimmingCharacters(in: .whitespaces) != dsUrlSaved
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 0) {
                Text("DeepSeek API URL").font(.system(size: 14, weight: .medium)).frame(height: 20.02)
                Spacer(minLength: 0)
                if dirty { IntelLine(text: "● unsaved", size: 12, lh: 16.2, color: Theme.warning) }
            }
            HStack(alignment: .top, spacing: 8) {
                IntelInput(placeholder: "https://api.deepseek.com", text: $dsUrl, mono: true, testID: "deepseek-base-url", onSubmit: { if dirty { saveUrl() } })
                if dirty { Button { saveUrl() } label: { Text("Save") }.buttonStyle(IntelButtonStyle(variant: .primary)) }
            }
            IntelPara(text: "Optional. Routes all DeepSeek traffic — the agent plus titling and meeting minutes — through a custom OpenAI-compatible base URL (proxy or self-host). Blank uses the default api.deepseek.com.")
        }
        .padding(.top, 21)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    private func copy(_ id: String) {
        guard let key = IntelData.secrets()[id] else { return }
        System.copy(key)
        copied = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == id { copied = nil } }
    }

    private func save(_ id: String) {
        let v = (editing[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty else { return }
        var m = IntelData.secrets()
        m[id] = v
        IntelData.writeSecrets(m)
        editing[id] = nil
        load()
    }

    private func remove(_ id: String) {
        var m = IntelData.secrets()
        m.removeValue(forKey: id)
        IntelData.writeSecrets(m)
        editing[id] = nil
        load()
    }

    private func saveUrl() {
        let v = dsUrl.trimmingCharacters(in: .whitespaces)
        IntelData.setSetting("deepseek_base_url", v)
        dsUrl = v
        dsUrlSaved = v
    }
}

// MARK: - Models (models.tsx)

struct IntelCustomModel: Identifiable {
    var key = UUID()
    var id: String = ""
    var name: String = ""
    var vision = false
    var reasoning = false
    var thinkingLevels: [String: String] = [:]
    var thinkingFormat = ""
    var contextWindow = 0
    var maxTokens = 0
    var raw: [String: Any] = [:]

    init() {}
    init(_ d: [String: Any]) {
        raw = d
        id = d["id"] as? String ?? ""
        name = d["name"] as? String ?? ""
        vision = d["vision"] as? Bool ?? false
        reasoning = d["reasoning"] as? Bool ?? false
        thinkingLevels = d["thinkingLevels"] as? [String: String] ?? [:]
        thinkingFormat = d["thinkingFormat"] as? String ?? ""
        contextWindow = d["contextWindow"] as? Int ?? 0
        maxTokens = d["maxTokens"] as? Int ?? 0
    }

    var json: [String: Any] {
        var d = raw
        d["id"] = id.trimmingCharacters(in: .whitespaces)
        d["name"] = name.trimmingCharacters(in: .whitespaces)
        d["vision"] = vision
        d["reasoning"] = reasoning
        d["thinkingLevels"] = reasoning ? thinkingLevels : [:]
        d["thinkingFormat"] = thinkingFormat
        d["contextWindow"] = contextWindow
        d["maxTokens"] = maxTokens
        return d
    }
}

struct IntelProvider {
    var id = ""
    var name = ""
    var baseUrl = ""
    var models: [IntelCustomModel] = []
    var raw: [String: Any] = [:]
}

struct IntelModelsSection: View {
    static let levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    static let formats: [(String, String)] = [("", "reasoning_effort"), ("deepseek", "DeepSeek (thinking.type)"), ("openrouter", "OpenRouter (reasoning.effort)"), ("together", "Together")]

    @State private var providers: [IntelProvider] = []
    @State private var draft: IntelProvider?
    @State private var draftKey: String?
    @State private var editingHasKey = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "Models", description: "Add your own OpenAI-compatible model providers — a base URL, an API key, and model ids. Their models then appear in the chat model picker alongside the built-in tiers.")
            if let d = draft {
                editor(d)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if providers.isEmpty {
                        IntelPara(text: "No custom providers yet.", size: 14, lh: 20.02)
                    }
                    ForEach(providers, id: \.id) { p in providerRow(p) }
                }
                .padding(.top, 24)
                Button { startAdd() } label: { IntelLabel(icon: "plus", text: "Add provider") }
                    .buttonStyle(IntelButtonStyle()).padding(.top, 16).testID("models-add")
                IntelPara(text: "Background tasks (auto-titles, meeting notes) use DeepSeek when its key is set, otherwise your first custom provider.").padding(.top, 16)
            }
            IntelError(text: error)
        }
        .onAppear(perform: load)
    }

    private static func storedList() -> [[String: Any]] {
        guard let raw = IntelData.setting("custom_providers"), let d = raw.data(using: .utf8) else { return [] }
        return (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] ?? []
    }

    /// Persist to `app_settings.custom_providers` and re-export custom-models.json (custom_models::export_config).
    private static func storeList(_ list: [[String: Any]]) {
        IntelData.setSettingJSON("custom_providers", list)
        let exported: [[String: Any]] = list.map { p in
            let id = p["id"] as? String ?? ""
            let env = "CETUS_CUSTOM_KEY_" + String((id.hasPrefix("custom-") ? String(id.dropFirst(7)) : id).map { $0.isASCII && ($0.isLetter || $0.isNumber) ? Character($0.uppercased()) : "_" })
            return ["id": id, "name": p["name"] ?? "", "baseUrl": p["baseUrl"] ?? "", "keyEnv": env,
                    "models": (p["models"] as? [[String: Any]] ?? []).map { m -> [String: Any] in
                        var m = m
                        if (m["name"] as? String ?? "").isEmpty { m["name"] = m["id"] }
                        return m
                    }]
        }
        IntelData.writeJSON(IntelData.file("custom-models.json"), ["providers": exported])
    }

    private func load() {
        providers = Self.storedList().map { d in
            IntelProvider(id: d["id"] as? String ?? "", name: d["name"] as? String ?? "", baseUrl: d["baseUrl"] as? String ?? "",
                          models: (d["models"] as? [[String: Any]] ?? []).map(IntelCustomModel.init), raw: d)
        }
    }

    private func hasKey(_ id: String) -> Bool { IntelData.secrets()["custom:\(id)"] != nil }

    private func providerRow(_ p: IntelProvider) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    IntelLine(text: p.name, weight: .medium)
                    if !hasKey(p.id) {
                        IntelTag(text: "No key", fill: Theme.warning.opacity(0.1), color: Theme.warning, weight: .regular)
                    }
                }
                IntelLine(text: p.baseUrl, size: 12, lh: 16.2, mono: true, color: Theme.mutedForeground)
                IntelLine(text: p.models.map { $0.name.isEmpty ? $0.id : $0.name }.joined(separator: " · "), size: 12, lh: 16.2, color: Theme.mutedForeground)
            }
            Spacer(minLength: 0)
            Button { startEdit(p) } label: { Text("Edit") }.buttonStyle(IntelButtonStyle())
            Button { remove(p.id) } label: { Text("Remove") }.buttonStyle(IntelButtonStyle())
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
    }

    private func startAdd() {
        var m = IntelCustomModel()
        m.key = UUID()
        draft = IntelProvider(models: [m])
        draftKey = nil
        editingHasKey = false
        error = nil
    }

    private func startEdit(_ p: IntelProvider) {
        draft = p
        draftKey = nil
        editingHasKey = hasKey(p.id)
        error = nil
    }

    private func mintId(_ name: String) -> String {
        let slug = name.lowercased().map { $0.isASCII && ($0.isLetter || $0.isNumber) ? String($0) : "-" }.joined()
            .split(separator: "-").joined(separator: "-")
        let base = "custom-" + (slug.isEmpty ? "provider" : slug)
        if !providers.contains(where: { $0.id == base }) { return base }
        var n = 2
        while providers.contains(where: { $0.id == "\(base)-\(n)" }) { n += 1 }
        return "\(base)-\(n)"
    }

    private func save() {
        guard var d = draft else { return }
        let name = d.name.trimmingCharacters(in: .whitespaces)
        var url = d.baseUrl.trimmingCharacters(in: .whitespaces)
        while url.hasSuffix("/") { url.removeLast() }
        let models = d.models.filter { !$0.id.trimmingCharacters(in: .whitespaces).isEmpty }.map { m -> [String: Any] in
            var j = m.json
            if !m.reasoning { j["thinkingLevels"] = [String: String](); j["thinkingFormat"] = "" }
            else if m.thinkingLevels.isEmpty { j["thinkingLevels"] = ["off": "", "high": "", "max": ""] }
            return j
        }
        if name.isEmpty { error = "provider needs a name"; return }
        if url.isEmpty { error = "provider needs a base URL"; return }
        if models.isEmpty { error = "provider needs at least one model id"; return }
        var list = Self.storedList()
        if d.id.isEmpty { d.id = mintId(name) }
        var entry = d.raw
        entry["id"] = d.id
        entry["name"] = name
        entry["baseUrl"] = url
        entry["models"] = models
        if let i = list.firstIndex(where: { ($0["id"] as? String) == d.id }) { list[i] = entry } else { list.append(entry) }
        Self.storeList(list)
        if let k = draftKey {
            var s = IntelData.secrets()
            let t = k.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty { s.removeValue(forKey: "custom:\(d.id)") } else { s["custom:\(d.id)"] = t }
            IntelData.writeSecrets(s)
        }
        draft = nil
        error = nil
        load()
    }

    private func remove(_ id: String) {
        Self.storeList(Self.storedList().filter { ($0["id"] as? String) != id })
        var s = IntelData.secrets()
        if s.removeValue(forKey: "custom:\(id)") != nil { IntelData.writeSecrets(s) }
        load()
    }

    // Editor

    private func binding<T>(_ kp: WritableKeyPath<IntelProvider, T>) -> Binding<T> {
        Binding(get: { draft![keyPath: kp] }, set: { draft![keyPath: kp] = $0 })
    }

    private func modelBinding<T>(_ i: Int, _ kp: WritableKeyPath<IntelCustomModel, T>) -> Binding<T> {
        Binding(get: { draft!.models[i][keyPath: kp] }, set: { draft!.models[i][keyPath: kp] = $0 })
    }

    private func fieldLabel(_ s: String) -> some View { IntelLine(text: s, size: 14, lh: 14, weight: .medium) }

    @ViewBuilder
    private func editor(_ d: IntelProvider) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Name")
                IntelInput(placeholder: "OpenRouter, my vLLM box, …", text: binding(\.name), testID: "cm-name")
            }
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("Base URL")
                IntelInput(placeholder: "https://api.example.com/v1", text: binding(\.baseUrl), mono: true)
                IntelPara(text: "OpenAI-compatible endpoint, without /chat/completions.")
            }
            VStack(alignment: .leading, spacing: 6) {
                fieldLabel("API key")
                IntelInput(placeholder: editingHasKey && draftKey == nil ? "•••••••• (stored — type to replace)" : "sk-… (leave empty for local endpoints)",
                           text: Binding(get: { draftKey ?? "" }, set: { draftKey = $0 }), mono: true, secure: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                // An inline span in a 24px-line block: an 18px box with the text sitting low.
                IntelLine(text: "Models", weight: .medium).frame(height: 18).offset(y: 4)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(d.models.enumerated()), id: \.element.key) { i, m in modelCard(i, m) }
                }
                Button { draft?.models.append(IntelCustomModel()) } label: { IntelLabel(icon: "plus", text: "Add model") }
                    .buttonStyle(IntelButtonStyle(variant: .ghost))
                IntelPara(text: "Turn on Vision for models that accept images — attachments are sent directly to the model.")
                IntelPara(text: "Turn on Reasoning for models with an effort knob, then enable the levels your endpoint supports. Each level sends its own name by default — type a token to override (e.g. map cetus's levels onto an endpoint that only knows low/medium/high). Pick the effort format your vendor expects; disabled levels are clamped to the nearest enabled one.")
            }
            HStack(spacing: 8) {
                Button { save() } label: { Text("Save") }.buttonStyle(IntelButtonStyle(variant: .primary))
                Button { draft = nil } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle()).testID("cm-cancel")
            }
        }
        .padding(.top, 24)
    }

    @ViewBuilder
    private func modelCard(_ i: Int, _ m: IntelCustomModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                IntelInput(placeholder: "model id", text: modelBinding(i, \.id), mono: true)
                IntelInput(placeholder: "display name (optional)", text: modelBinding(i, \.name))
                IntelIconButton(icon: "trash-2", destructiveHover: true) { draft?.models.remove(at: i) }
            }
            HStack(spacing: 16) {
                HStack(spacing: 6) {
                    IntelSwitch(isOn: m.vision) { v in draft?.models[i].vision = v }
                    IntelLine(text: "Vision", size: 12, lh: 16.2, color: Theme.mutedForeground)
                }
                HStack(spacing: 6) {
                    IntelSwitch(isOn: m.reasoning) { v in
                        if v {
                            draft?.models[i].reasoning = true
                            if m.thinkingLevels.isEmpty { draft?.models[i].thinkingLevels = ["off": "", "high": "", "max": ""] }
                        } else { draft?.models[i].reasoning = false }
                    }
                    IntelLine(text: "Reasoning", size: 12, lh: 16.2, color: Theme.mutedForeground)
                }
                if m.reasoning {
                    HStack(spacing: 8) {
                        IntelLine(text: "Format", size: 12, lh: 16.2, color: Theme.mutedForeground)
                        IntelFormatSelect(id: "format-\(i)", value: m.thinkingFormat, formats: Self.formats) { draft?.models[i].thinkingFormat = $0 }
                    }
                }
            }
            if m.reasoning {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .leading), count: 3), alignment: .leading, spacing: 6) {
                    ForEach(Self.levels, id: \.self) { lvl in
                        let on = m.thinkingLevels[lvl] != nil
                        HStack(spacing: 6) {
                            IntelSwitch(isOn: on) { v in
                                if v { draft?.models[i].thinkingLevels[lvl] = m.thinkingLevels[lvl] ?? "" } else { draft?.models[i].thinkingLevels.removeValue(forKey: lvl) }
                            }
                            Text(lvl).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.mutedForeground).frame(width: 56, alignment: .leading)
                            if on && lvl != "off" {
                                IntelInput(placeholder: lvl, text: Binding(get: { draft?.models[i].thinkingLevels[lvl] ?? "" }, set: { draft?.models[i].thinkingLevels[lvl] = $0 }),
                                           mono: true, height: 24)
                            }
                        }
                    }
                }
            }
        }
        .padding(11)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
    }
}

/// models.tsx thinking-format Select: SelectTrigger size="sm" h-7 w-auto text-xs,
/// SelectContent rows text-sm with the check in the right gutter.
private struct IntelFormatSelect: View {
    let id: String
    let value: String
    let formats: [(String, String)]
    let set: (String) -> Void
    @Environment(AppState.self) private var app
    @State private var frame: CGRect = .zero
    var body: some View {
        Button {
            let items = formats.map { f in
                MenuItem(id: f.0.isEmpty ? "std" : f.0, title: f.1, checked: f.0 == value) { app.popup = nil; set(f.0) }
            }
            app.popup = PopupSpec(id: id, anchor: frame, style: .select,
                                  content: AnyView(MenuList(items: items, style: .select, minWidth: frame.width, textSize: 14)))
        } label: {
            HStack(spacing: 6) {
                Text(formats.first { $0.0 == value }?.1 ?? value).font(.system(size: 12)).foregroundStyle(Theme.foreground)
                IntelIcon(name: "chevron-down", size: 16, color: Theme.mutedForeground.opacity(0.5))
            }
            .padding(.horizontal, 11).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 8).fill(IntelColor.inputFill))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.input, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .readFrame($frame)
        .fixedSize()
    }
}
