import AppKit
import SQLite3

/// Remote-control commands for the screen-context area (`sc.sh NAME "screen …"`):
///   screen open [query]      open Screen history (optionally seeded)
///   screen capture           capture + OCR one frame now (ignores the toggle; test only)
///   screen ambient           record one AX observation of the frontmost app now
///   screen stats             frame / ambient counts
///   screen summary           the ambient fence the composer would inject
///   screen clear             delete every frame + ambient row of THIS instance (and files)
///   screen import <db> [n]   copy the newest n rows from another Cetus db read-only (pixels not copied)
@MainActor
enum ScreenControl {
    static func handler(_ cmd: String) -> ((AppState, String) async -> String)? {
        guard cmd == "screen" else { return nil }
        return { app, arg in await run(app, arg) }
    }

    private static func run(_ app: AppState, _ arg: String) async -> String {
        let parts = arg.split(separator: " ", maxSplits: 1).map(String.init)
        let sub = parts.first ?? "", rest = parts.count > 1 ? parts[1] : ""
        let store = ScreenStore.shared
        switch sub {
        case "open":
            ScreenHistoryModel.shared.show(app, query: rest)
            return "ok"
        case "capture":
            let f = ScreenAX.frontmost()
            let title = f.map { ScreenAX.windowTitle($0.pid) ?? "" } ?? ""
            let h = await ScreenCapture.captureOnce(ScreenCapture.settings, app: f?.app ?? "", bundle: f?.bundle ?? "", title: title, trigger: "interval", prevHash: nil)
            guard h != nil, let shot = store.recentScreenshots(limit: 1).first else { return "no frame" }
            return "\(shot.id) \(shot.filePath) ocr=\(shot.ocrText?.count ?? 0)"
        case "ambient":
            guard let f = ScreenAX.frontmost() else { return "no frontmost" }
            let text = ScreenAX.visibleText(f.pid, maxChars: AmbientCollector.maxTextChars) ?? ""
            let (url, page) = ScreenAX.browserURL(f.bundle) ?? ("", "")
            let title = ScreenAX.windowTitle(f.pid) ?? ""
            store.insertAxContext(AmbientEntry(id: UUID().uuidString.lowercased(), ts: nowMs(), appName: f.app, bundleId: f.bundle,
                                               windowTitle: title.nonEmptyScreen, url: url.nonEmptyScreen, pageTitle: page.nonEmptyScreen, text: text, textHash: nil))
            return "\(f.app) title=\(title) chars=\(text.count)"
        case "stats":
            return "frames=\(store.screenshotsCount()) ambient=\(store.axContextCount()) capture=\(ScreenCapture.settings.enabled) running=\(ScreenCapture.running)"
        case "summary":
            return (AmbientCollector.recentSummary() ?? "nil").replacingOccurrences(of: "\n", with: "⏎")
        case "clear":
            let ids = store.recentScreenshots(limit: 100_000).map(\.id)
            for p in store.deleteScreenshots(ids: ids) { try? FileManager.default.removeItem(atPath: p) }
            store.clearAxContext()
            try? FileManager.default.removeItem(at: store.recallLog)
            return "deleted \(ids.count)"
        case "import":
            var path = rest.trimmingCharacters(in: .whitespaces), limit = 200
            if let r = path.range(of: " ", options: .backwards), let n = Int(path[r.upperBound...]) { limit = n; path = String(path[..<r.lowerBound]) }
            guard !path.isEmpty else { return "bad args" }
            return importRows(path, limit: limit)
        default:
            return "unknown screen command"
        }
    }

    /// Read-only copy of rows for side-by-side layout checks. Pixels are never
    /// copied: file paths point nowhere, so tiles show the empty image box like
    /// the shadow (which can't load the files either).
    private static func importRows(_ path: String, limit: Int) -> String {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return "open failed" }
        defer { sqlite3_close(db) }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT id, ts, app_name, window_title, ocr_text, trigger FROM screenshots ORDER BY ts DESC LIMIT \(limit)", -1, &st, nil) == SQLITE_OK else { return "query failed: " + String(cString: sqlite3_errmsg(db)) }
        defer { sqlite3_finalize(st) }
        func s(_ i: Int32) -> String? { sqlite3_column_type(st, i) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(st, i)) }
        var n = 0
        while sqlite3_step(st) == SQLITE_ROW {
            ScreenStore.shared.insertScreenshot(ScreenFrame(id: s(0) ?? UUID().uuidString, ts: Double(sqlite3_column_int64(st, 1)), appName: s(2), windowTitle: s(3),
                                                            filePath: "/nonexistent/\(n).jpg", thumbPath: nil, phash: nil, bytes: 0, ocrText: s(4), trigger: s(5)))
            n += 1
        }
        return "imported \(n)"
    }
}
