import AppKit
import Foundation

// Littlebird-like resident ambient context (ambient.rs): a rolling, text-only
// memory of the frontmost app read over the accessibility API — window title,
// visible text, browser URL. Off by default; per-app exclusion before any
// read; content-hash dedupe; retention pruning. Settings in UserDefaults
// `settings.ambient` (CapAmbientSettings).

enum AmbientCollector {
    static let maxTextChars = 8000
    static let slowRefreshSecs = 30.0
    static let idleSkipSecs = 120.0

    /// The collector's effective state (see ScreenCapture.loopsAllowed).
    static var enabledNow: Bool { ScreenCapture.loopsForced || (ScreenCapture.loopsAllowed && settings.enabled) }

    static var settings: CapAmbientSettings {
        CapStored<CapAmbientSettings>(rawValue: UserDefaults.standard.string(forKey: "settings.ambient") ?? "{}")?.value ?? .init()
    }

    nonisolated(unsafe) private static var started = false

    static func start() {
        guard !started else { return }
        started = true
        Task.detached(priority: .utility) { await loop() }
    }

    private struct TickState {
        var bundle = "", title = "", url = "", pageTitle = ""
        var hash: Int?
    }

    private static func loop() async {
        var state = TickState()
        var lastFullRead: Date?
        var lastPrune = Date()
        let own = getpid()
        while true {
            var s = settings
            if !ScreenCapture.loopsAllowed { s.enabled = false }
            if ScreenCapture.loopsForced { s.enabled = true }
            // Retention runs whether or not collection is on.
            if Date().timeIntervalSince(lastPrune) >= 3600 {
                if s.retentionDays > 0 { _ = ScreenStore.shared.pruneAxContext(before: nowMs() - Double(s.retentionDays) * 86_400_000) }
                lastPrune = Date()
            }
            if !s.enabled {
                state = TickState()
                lastFullRead = nil
                try? await Task.sleep(for: .seconds(3))
                continue
            }
            let refreshDue = lastFullRead.map { Date().timeIntervalSince($0) >= slowRefreshSecs } ?? true
            if let f = ScreenAX.frontmost(), f.pid != own, !ScreenAX.isExcluded(s.excludedApps, app: f.app, bundle: f.bundle) {
                let title = ScreenAX.windowTitle(f.pid) ?? ""
                let changed = f.bundle != state.bundle || title != state.title
                let idle = ScreenAX.secondsSinceLastInput() >= idleSkipSecs
                var text: String?
                var url = "", pageTitle = ""
                if (changed || refreshDue) && !idle {
                    ScreenAX.wake(f.pid)
                    text = ScreenAX.visibleText(f.pid, maxChars: maxTextChars) ?? ""
                    if changed, let (u, t) = ScreenAX.browserURL(f.bundle) { url = u; pageTitle = t }
                }
                if changed { state.url = ""; state.pageTitle = "" }
                state.bundle = f.bundle
                state.title = title
                if !url.isEmpty { state.url = url; state.pageTitle = pageTitle }
                if let text {
                    lastFullRead = Date()
                    let u = url.isEmpty ? state.url : url
                    let pt = pageTitle.isEmpty ? state.pageTitle : pageTitle
                    var h = Hasher()
                    h.combine(f.bundle); h.combine(title); h.combine(u); h.combine(text)
                    let hash = h.finalize()
                    if state.hash != hash {
                        state.hash = hash
                        ScreenStore.shared.insertAxContext(AmbientEntry(
                            id: UUID().uuidString.lowercased(), ts: nowMs(), appName: f.app.isEmpty ? nil : f.app,
                            bundleId: f.bundle.isEmpty ? nil : f.bundle, windowTitle: title.isEmpty ? nil : title,
                            url: u.isEmpty ? nil : u, pageTitle: pt.isEmpty ? nil : pt, text: text, textHash: Int64(hash)))
                    }
                }
            }
            try? await Task.sleep(for: .seconds(Double(max(1, s.intervalSeconds))))
        }
    }

    // MARK: - Recent-activity summary (chat injection)

    /// `ambient::recent_summary`: last 5 minutes, same-window runs merged, plus
    /// an excerpt of what is on screen now. nil when off or empty.
    static func recentSummary() -> String? {
        guard enabledNow else { return nil }
        let entries = ScreenStore.shared.axContextSince(nowMs() - 5 * 60_000, limit: 40)
        guard !entries.isEmpty else { return nil }
        var merged: [AmbientEntry] = []
        for e in entries {
            if let m = merged.last, m.bundleId == e.bundleId, m.windowTitle == e.windowTitle, m.url == e.url {
                merged[merged.count - 1] = e
            } else {
                merged.append(e)
            }
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        var lines = ["Recent activity (last 5 min, newest last):"]
        for e in merged {
            var line = "- \(f.string(from: Date(timeIntervalSince1970: e.ts / 1000))) \(e.appName ?? "?")"
            if let t = (e.pageTitle?.isEmpty == false ? e.pageTitle : e.windowTitle) { line += " — \(t)" }
            if let u = e.url, !u.isEmpty { line += " (\(u))" }
            lines.append(line)
        }
        if let latest = merged.last, !latest.text.isEmpty {
            lines.append("Currently on screen:")
            lines.append(String(latest.text.prefix(900)).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        var out = lines.joined(separator: "\n")
        if out.count > 1600 { out = String(out.prefix(1600)) }
        return out
    }

    /// `composeWithAmbient`: lead the prompt with the ambient fence (skipped
    /// when the text already leads with a context fence).
    static func compose(_ text: String, summary: String?) -> String {
        guard let s = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return text }
        if text.hasPrefix("<context ") { return text }
        return "<context source=\"cetus-ambient\">\n\(s)\n</context>\n\n\(text)"
    }

    /// The composer's radar toggle (`cetus.ambient-inject`).
    static var injectOn: Bool {
        get { UserDefaults.standard.bool(forKey: "settings.ambient.inject") }
        set { UserDefaults.standard.set(newValue, forKey: "settings.ambient.inject") }
    }
}

extension AmbientCollector {
    /// composer.tsx: lead with the ambient fence when the radar chip is on and
    /// the collector is enabled; best-effort (no summary → bare prompt).
    static func composeForSend(_ text: String) -> String {
        guard injectOn, enabledNow, !text.isEmpty else { return text }
        return compose(text, summary: recentSummary())
    }
}
