import Foundation
import SQLite3

// Screen-context storage (store/screenshots.rs + store/ambient.rs): the
// screenshot+OCR stream and the AX-text stream, each a plain table plus a
// trigger-free FTS5 index, in this app's own `screen-context.db` (never
// Cetus's capture store).

/// One captured frame (`Screenshot`). `filePath` is "" once tiered retention
/// dropped the pixels; the OCR text row lives on.
struct ScreenFrame: Identifiable, Equatable, Hashable {
    var id: String
    var ts: Double
    var appName: String?
    var windowTitle: String?
    var filePath: String
    var thumbPath: String?
    var phash: Int64?
    var bytes: Int64
    var ocrText: String?
    var trigger: String?
}

/// One AX observation (`AxContextEntry`).
struct AmbientEntry: Identifiable, Equatable, Hashable {
    var id: String
    var ts: Double
    var appName: String?
    var bundleId: String?
    var windowTitle: String?
    var url: String?
    var pageTitle: String?
    var text: String
    var textHash: Int64?
}

final class ScreenStore: @unchecked Sendable {
    static let shared = ScreenStore(dataDir: Env.dataDir)

    let dataDir: URL
    private var db: OpaquePointer?
    private let lock = NSLock()

    /// Bumped on every write so open views can refresh.
    nonisolated(unsafe) static var onChange: (() -> Void)?

    init(dataDir: URL) {
        self.dataDir = dataDir
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let path = dataDir.appendingPathComponent("screen-context.db").path
        if sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
            NSLog("screen-context: cannot open \(path)")
            db = nil
            return
        }
        exec("""
        PRAGMA journal_mode=WAL;
        PRAGMA auto_vacuum=INCREMENTAL;
        CREATE TABLE IF NOT EXISTS screenshots (
            id TEXT PRIMARY KEY, ts INTEGER NOT NULL, app_name TEXT, window_title TEXT,
            file_path TEXT NOT NULL, phash INTEGER, bytes INTEGER NOT NULL DEFAULT 0, ocr_text TEXT,
            thumb_path TEXT, trigger TEXT);
        CREATE INDEX IF NOT EXISTS idx_shot_ts ON screenshots (ts DESC);
        CREATE INDEX IF NOT EXISTS idx_shot_app ON screenshots (app_name);
        CREATE VIRTUAL TABLE IF NOT EXISTS screenshots_fts USING fts5(id UNINDEXED, ocr_text);
        CREATE TABLE IF NOT EXISTS ax_context (
            id TEXT PRIMARY KEY, ts INTEGER NOT NULL, app_name TEXT, bundle_id TEXT, window_title TEXT,
            url TEXT, page_title TEXT, text TEXT NOT NULL DEFAULT '', text_hash INTEGER);
        CREATE INDEX IF NOT EXISTS idx_axctx_ts ON ax_context (ts DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS ax_context_fts USING fts5(id UNINDEXED, text);
        """)
    }

    var screenshotsDir: URL { dataDir.appendingPathComponent("screenshots", isDirectory: true) }
    var recallLog: URL { dataDir.appendingPathComponent("screen-context/recall.jsonl") }

    // MARK: - SQLite plumbing

    private enum V { case s(String?), i(Int64?) }
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    @discardableResult
    private func exec(_ sql: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }

    @discardableResult
    private func run(_ sql: String, _ args: [V] = []) -> Int {
        lock.lock(); defer { lock.unlock() }
        return runLocked(sql, args)
    }

    private func runLocked(_ sql: String, _ args: [V]) -> Int {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(st) }
        bind(st, args)
        sqlite3_step(st)
        return Int(sqlite3_changes(db))
    }

    private func bind(_ st: OpaquePointer?, _ args: [V]) {
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case .s(let v): if let v { sqlite3_bind_text(st, idx, v, -1, Self.transient) } else { sqlite3_bind_null(st, idx) }
            case .i(let v): if let v { sqlite3_bind_int64(st, idx, v) } else { sqlite3_bind_null(st, idx) }
            }
        }
    }

    private func query<T>(_ sql: String, _ args: [V], _ row: (OpaquePointer?) -> T) -> [T] {
        lock.lock(); defer { lock.unlock() }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(st) }
        bind(st, args)
        var out: [T] = []
        while sqlite3_step(st) == SQLITE_ROW { out.append(row(st)) }
        return out
    }

    private func transaction(_ body: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        sqlite3_exec(db, "BEGIN", nil, nil, nil)
        body()
        sqlite3_exec(db, "COMMIT", nil, nil, nil)
    }

    private static func str(_ st: OpaquePointer?, _ i: Int32) -> String? {
        guard sqlite3_column_type(st, i) != SQLITE_NULL, let c = sqlite3_column_text(st, i) else { return nil }
        return String(cString: c)
    }

    private static func int(_ st: OpaquePointer?, _ i: Int32) -> Int64? {
        sqlite3_column_type(st, i) == SQLITE_NULL ? nil : sqlite3_column_int64(st, i)
    }

    /// `fts_match_expr`: every whitespace token quoted, implicit AND.
    static func matchExpr(_ q: String) -> String {
        q.split(whereSeparator: \.isWhitespace).map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: " ")
    }

    private func changed() { DispatchQueue.main.async { ScreenStore.onChange?() } }

    // MARK: - Screenshots

    private static let shotCols = "id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path, trigger"

    private static func frame(_ st: OpaquePointer?) -> ScreenFrame {
        ScreenFrame(id: str(st, 0) ?? "", ts: Double(int(st, 1) ?? 0), appName: str(st, 2), windowTitle: str(st, 3),
                    filePath: str(st, 4) ?? "", thumbPath: str(st, 8), phash: int(st, 5), bytes: int(st, 6) ?? 0,
                    ocrText: str(st, 7), trigger: str(st, 9))
    }

    func insertScreenshot(_ s: ScreenFrame) {
        // OCR text goes in through setScreenshotOCR, which also indexes it.
        let ocr = s.ocrText.flatMap { $0.isEmpty ? nil : $0 }
        run("INSERT INTO screenshots (id, ts, app_name, window_title, file_path, phash, bytes, ocr_text, thumb_path, trigger) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            [.s(s.id), .i(Int64(s.ts)), .s(s.appName), .s(s.windowTitle), .s(s.filePath), .i(s.phash), .i(s.bytes), .s(ocr == nil ? s.ocrText : nil), .s(s.thumbPath), .s(s.trigger)])
        if let ocr { setScreenshotOCR(s.id, ocr) }
        changed()
    }

    func setScreenshotOCR(_ id: String, _ text: String) {
        transaction {
            // `id` is UNINDEXED in the fts table, so this delete scans the whole index:
            // only frames that already had OCR text (and so an fts row) need it.
            var st: OpaquePointer?
            var had = true
            if sqlite3_prepare_v2(db, "SELECT ocr_text IS NOT NULL AND ocr_text != '' FROM screenshots WHERE id = ?1", -1, &st, nil) == SQLITE_OK {
                bind(st, [.s(id)])
                had = sqlite3_step(st) == SQLITE_ROW && sqlite3_column_int(st, 0) != 0
                sqlite3_finalize(st)
            }
            _ = runLocked("UPDATE screenshots SET ocr_text = ?1 WHERE id = ?2", [.s(text), .s(id)])
            if had { _ = runLocked("DELETE FROM screenshots_fts WHERE id = ?1", [.s(id)]) }
            _ = runLocked("INSERT INTO screenshots_fts (id, ocr_text) VALUES (?1, ?2)", [.s(id), .s(text)])
        }
        changed()
    }

    func recentScreenshots(limit: Int, before: Double? = nil) -> [ScreenFrame] {
        query("SELECT \(Self.shotCols) FROM screenshots WHERE ts < ?2 ORDER BY ts DESC LIMIT ?1",
              [.i(Int64(limit)), .i(before.map { Int64($0) } ?? Int64.max)], Self.frame)
    }

    func searchScreenshots(_ q: String, since: Double = 0, limit: Int, before: Double? = nil) -> [ScreenFrame] {
        let m = Self.matchExpr(q)
        if m.isEmpty { return recentScreenshots(limit: limit, before: before).filter { $0.ts >= since } }
        let cols = Self.shotCols.split(separator: ",").map { "s." + $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
        return query("SELECT \(cols) FROM screenshots s JOIN screenshots_fts ON screenshots_fts.id = s.id WHERE screenshots_fts MATCH ?1 AND s.ts >= ?2 AND s.ts < ?4 ORDER BY s.ts DESC LIMIT ?3",
                     [.s(m), .i(Int64(since)), .i(Int64(limit)), .i(before.map { Int64($0) } ?? Int64.max)], Self.frame)
    }

    func screenshotsCount() -> Int {
        query("SELECT COUNT(*) FROM screenshots", []) { Int(sqlite3_column_int64($0, 0)) }.first ?? 0
    }

    /// Delete frames older than `before`; returns full + thumb paths to unlink.
    func pruneScreenshots(before: Double) -> [String] {
        let paths = query("SELECT file_path, thumb_path FROM screenshots WHERE ts < ?1", [.i(Int64(before))]) { st in
            [Self.str(st, 0), Self.str(st, 1)].compactMap { $0 }.filter { !$0.isEmpty }
        }.flatMap { $0 }
        var n = 0
        transaction {
            _ = runLocked("DELETE FROM screenshots_fts WHERE id IN (SELECT id FROM screenshots WHERE ts < ?1)", [.i(Int64(before))])
            n = runLocked("DELETE FROM screenshots WHERE ts < ?1", [.i(Int64(before))])
        }
        if n > 0 {
            exec("INSERT INTO screenshots_fts(screenshots_fts) VALUES('optimize'); PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
            changed()
        }
        return paths
    }

    /// Tiered retention phase 1: drop only the pixels, keep the text row.
    func pruneScreenshotFrames(before: Double) -> [String] {
        let paths = query("SELECT file_path, thumb_path FROM screenshots WHERE ts < ?1 AND (file_path != '' OR thumb_path IS NOT NULL)", [.i(Int64(before))]) { st in
            [Self.str(st, 0), Self.str(st, 1)].compactMap { $0 }.filter { !$0.isEmpty }
        }.flatMap { $0 }
        if !paths.isEmpty {
            run("UPDATE screenshots SET file_path = '', thumb_path = NULL, bytes = 0 WHERE ts < ?1 AND (file_path != '' OR thumb_path IS NOT NULL)", [.i(Int64(before))])
            changed()
        }
        return paths
    }

    /// Delete specific frames (test cleanup); returns their file paths.
    func deleteScreenshots(ids: [String]) -> [String] {
        var paths: [String] = []
        for id in ids {
            paths += query("SELECT file_path, thumb_path FROM screenshots WHERE id = ?1", [.s(id)]) { st in
                [Self.str(st, 0), Self.str(st, 1)].compactMap { $0 }.filter { !$0.isEmpty }
            }.flatMap { $0 }
            transaction {
                _ = runLocked("DELETE FROM screenshots_fts WHERE id = ?1", [.s(id)])
                _ = runLocked("DELETE FROM screenshots WHERE id = ?1", [.s(id)])
            }
        }
        changed()
        return paths
    }

    // MARK: - AX context

    private static let axCols = "id, ts, app_name, bundle_id, window_title, url, page_title, text, text_hash"

    private static func entry(_ st: OpaquePointer?) -> AmbientEntry {
        AmbientEntry(id: str(st, 0) ?? "", ts: Double(int(st, 1) ?? 0), appName: str(st, 2), bundleId: str(st, 3), windowTitle: str(st, 4),
                     url: str(st, 5), pageTitle: str(st, 6), text: str(st, 7) ?? "", textHash: int(st, 8))
    }

    func insertAxContext(_ e: AmbientEntry) {
        let fts = "\(e.windowTitle ?? "") \(e.pageTitle ?? "") \(e.url ?? "") \(e.text)".trimmingCharacters(in: .whitespacesAndNewlines)
        transaction {
            _ = runLocked("INSERT INTO ax_context (id, ts, app_name, bundle_id, window_title, url, page_title, text, text_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                          [.s(e.id), .i(Int64(e.ts)), .s(e.appName), .s(e.bundleId), .s(e.windowTitle), .s(e.url), .s(e.pageTitle), .s(e.text), .i(e.textHash)])
            _ = runLocked("INSERT INTO ax_context_fts (id, text) VALUES (?1, ?2)", [.s(e.id), .s(fts)])
        }
        changed()
    }

    func recentAxContext(limit: Int, before: Double? = nil) -> [AmbientEntry] {
        query("SELECT \(Self.axCols) FROM ax_context WHERE ts < ?2 ORDER BY ts DESC LIMIT ?1",
              [.i(Int64(limit)), .i(before.map { Int64($0) } ?? Int64.max)], Self.entry)
    }

    /// Entries at or after `since`, oldest first, bounded to the newest `limit`.
    func axContextSince(_ since: Double, limit: Int) -> [AmbientEntry] {
        query("SELECT \(Self.axCols) FROM (SELECT * FROM ax_context WHERE ts >= ?1 ORDER BY ts DESC LIMIT ?2) ORDER BY ts ASC",
              [.i(Int64(since)), .i(Int64(limit))], Self.entry)
    }

    func searchAxContext(_ q: String, since: Double = 0, limit: Int, before: Double? = nil) -> [AmbientEntry] {
        let m = Self.matchExpr(q)
        if m.isEmpty { return recentAxContext(limit: limit, before: before).filter { $0.ts >= since } }
        let cols = Self.axCols.split(separator: ",").map { "c." + $0.trimmingCharacters(in: .whitespaces) }.joined(separator: ", ")
        return query("SELECT \(cols) FROM ax_context c JOIN ax_context_fts ON ax_context_fts.id = c.id WHERE ax_context_fts MATCH ?1 AND c.ts >= ?2 AND c.ts < ?4 ORDER BY c.ts DESC LIMIT ?3",
                     [.s(m), .i(Int64(since)), .i(Int64(limit)), .i(before.map { Int64($0) } ?? Int64.max)], Self.entry)
    }

    func axContextCount() -> Int {
        query("SELECT COUNT(*) FROM ax_context", []) { Int(sqlite3_column_int64($0, 0)) }.first ?? 0
    }

    func pruneAxContext(before: Double) -> Int {
        var n = 0
        transaction {
            _ = runLocked("DELETE FROM ax_context_fts WHERE id IN (SELECT id FROM ax_context WHERE ts < ?1)", [.i(Int64(before))])
            n = runLocked("DELETE FROM ax_context WHERE ts < ?1", [.i(Int64(before))])
        }
        if n > 0 {
            exec("INSERT INTO ax_context_fts(ax_context_fts) VALUES('optimize'); PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
            changed()
        }
        return n
    }

    /// "Delete all history".
    func clearAxContext() {
        transaction {
            _ = runLocked("DELETE FROM ax_context_fts", [])
            _ = runLocked("DELETE FROM ax_context", [])
        }
        exec("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
        changed()
    }
}
