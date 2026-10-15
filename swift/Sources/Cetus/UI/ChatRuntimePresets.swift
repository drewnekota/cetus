import SwiftUI

/// Runtime presets in the composer's runtime picker and Tab cycle, after
/// Cetus's runtime-settings.ts (runtimeEntries / normalizeRuntimeEntryOrder)
/// and backend-picker.tsx (nextRuntimeTarget / applySwitchTarget). Presets are
/// stored by Settings › Runtimes (GRuntimePreset, "settings.runtimePresets").
enum ChatRuntimeEntries {
    enum Entry: Equatable {
        case runtime(String)
        case preset(GRuntimePreset)
        var id: String { switch self { case .runtime(let r): r; case .preset(let p): p.id } }
        var backend: String { switch self { case .runtime(let r): r; case .preset(let p): p.backend } }
    }

    /// Saved order, then missing runtimes, then missing presets; disabled runtimes (and their presets) drop out.
    static func entries(_ prefs: Prefs) -> [Entry] {
        let presets = GRuntimePreset.load()
        let known = Runtimes.all.map(\.id)
        var ids: [String] = []
        for id in prefs.runtimeOrder + known + presets.map(\.id) where (known.contains(id) || presets.contains { $0.id == id }) && !ids.contains(id) { ids.append(id) }
        return ids.compactMap { id -> Entry? in
            if let p = presets.first(where: { $0.id == id }) { return .preset(p) }
            return .runtime(id)
        }
        .filter { !prefs.disabledRuntimes.contains($0.backend) }
    }

    /// The preset row whose fixed tuning exactly matches the selection (the checkmark goes there).
    static func matchedPreset(_ prefs: Prefs, _ s: Selection) -> GRuntimePreset? {
        for case .preset(let p) in entries(prefs) where p.backend == s.runtime && p.model == s.model && p.effort == s.effort { return p }
        return nil
    }

    /// Apply a preset: its runtime plus fixed model/effort, never touching the runtime's sticky tuning.
    @MainActor static func apply(_ p: GRuntimePreset, app: AppState) {
        app.selection.runtime = p.backend
        app.selection.model = p.model
        app.selection.effort = p.effort
        app.controller.setPrefs { $0.runtime = p.backend; $0.model = p.model; $0.effort = p.effort }
    }

    /// Select a row: a preset applies its tuning; a runtime restores its sticky tuning.
    @MainActor static func select(_ e: Entry, app: AppState) {
        switch e {
        case .preset(let p): apply(p, app: app)
        case .runtime(let r): app.selectRuntime(r)
        }
    }

    /// nextRuntimeTarget: Tab walks the picker rows (runtimes and presets), wrapping.
    @MainActor static func cycle(_ delta: Int, app: AppState) {
        let rows = entries(app.prefs)
        guard !rows.isEmpty else { return }
        let s = app.selection
        let idx = rows.firstIndex { if case .preset(let p) = $0 { return p.backend == s.runtime && p.model == s.model && p.effort == s.effort }; return false }
            ?? rows.firstIndex { $0 == .runtime(s.runtime) } ?? 0
        select(rows[(idx + delta + rows.count) % rows.count], app: app)
    }
}
