import AppKit
import Foundation
import SQLite3

// Meeting memory (meeting.rs + store/meetings.rs): settings, the meetings
// database, the agent-facing recall log, saved-audio dirs, helper resolution and
// the `cetus meeting` text formatting. Everything lives under the Swift data dir
// (`Env.dataDir`) — never the Tauri app's store.

// MARK: - Constants (meeting.rs)

enum MeetingConst {
    static let autoStartSecs: Double = 6
    static let autoStopSecs: Double = 30
    static let autoIdleStopSecs: Double = 5 * 60
    static let watchdogTickSecs: Double = 60
    static let maxSessionSecs: Double = 6 * 60 * 60
    static let summaryMinChars = 200
    static let summaryHeadChars = 16_000
    static let summaryTailChars = 8_000
    static let recallMaxBytes: UInt64 = 4_000_000
    static let recallKeepLines = 4000
    static let recallTextCap = 2000
    static let pruneIntervalSecs: Double = 3600
    static let hudCollapsed = CGSize(width: 220, height: 52)
    static let hudExpanded = CGSize(width: 440, height: 336)

    static let appBundles: Set<String> = [
        "us.zoom.xos", "com.microsoft.teams", "com.microsoft.teams2", "com.apple.FaceTime",
        "com.tinyspeck.slackmacgap", "com.larksuite.suite", "com.bytedance.feishu", "com.tencent.meeting",
        "com.tencent.voov", "com.alibaba.DingTalkMac", "com.cisco.webexmeetingsapp", "Cisco-Systems.Spark",
        "net.whatsapp.WhatsApp", "com.hnc.Discord", "org.telegram.desktop",
    ]
    static let browserBundles: Set<String> = [
        "com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
        "com.google.Chrome.beta", "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
        "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
        "company.thebrowser.Browser", "com.thebrowser.Browser",
    ]
    static let webDomains = [
        "meet.google.com", "teams.microsoft.com", "teams.live.com", "zoom.us", "webex.com", "meet.jit.si",
        "whereby.com", "around.co", "slack.com", "discord.com", "web.whatsapp.com", "web.telegram.org",
        "meeting.tencent.com", "voovmeeting.com", "meeting.dingtalk.com", "vc.feishu.cn", "larksuite.com",
    ]

    static let summarySystemPrompt = """
    You summarize a meeting transcript captured on the user's machine. The `mic` lines are the user speaking; the `system` lines are everyone else (heard through the speakers). The transcript is automatic speech recognition output — expect recognition errors and fix obvious ones silently.

    Respond with STRICT JSON only — no prose, no code fences:
    {"title":"...","summary":"..."}
    `title`: at most 8 words naming the meeting's actual subject.
    `summary`: concise markdown minutes — key points discussed, decisions made, and action items (with owners when stated). Use short bullet lists under bold mini-headers. Skip filler and small talk. Write BOTH fields in the language the meeting was held in.
    """
}

// MARK: - Settings (UserDefaults `settings.meeting`, MeetingSettings)

enum MeetingSettingsStore {
    static let key = "settings.meeting"

    static func load() -> CapMeetingSettings {
        var s = CapStored<CapMeetingSettings>(rawValue: UserDefaults.standard.string(forKey: key) ?? "{}")?.value ?? .init()
        // load_settings: migrate the short-lived Ctrl+Alt+M default back.
        if s.toggleHotkey == "Ctrl+Alt+M" { s.toggleHotkey = "Cmd+Shift+M" }
        return s
    }
}

// MARK: - Records

struct MeetingRecord: Identifiable, Equatable {
    var id: String
    var startedTs: Double
    var endedTs: Double?
    var title: String?
    var summary: String?
    var appName: String?
    var segmentCount: Int
}

struct MeetingSegmentRecord: Equatable, Hashable {
    var ts: Double
    var source: String
    var text: String
}

// MARK: - Paths

enum MeetingPaths {
    static var dataDir: URL { Env.dataDir }
    static var recallLog: URL { dataDir.appendingPathComponent("meeting-context/recall.jsonl") }
    static func audioDir(_ id: String) -> URL { dataDir.appendingPathComponent("meetings").appendingPathComponent(id) }

    static func removeAudioDir(_ id: String) {
        let dir = audioDir(id)
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue {
            try? FileManager.default.removeItem(at: dir)
        }
    }

    /// meeting_audio_dir: the saved-audio dir, or nil when nothing was kept.
    static func existingAudioDir(_ id: String) -> String? {
        if id.contains("/") || id.contains("\\") || id.contains(".") { return nil }
        var isDir: ObjCBool = false
        let dir = audioDir(id)
        return FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue ? dir.path : nil
    }
}

// MARK: - Database (meetings / meeting_segments, same schema as Cetus)

final class MeetingDB: @unchecked Sendable {
    static let shared = MeetingDB()
    private var db: OpaquePointer?
    private let lock = NSLock()
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private init() {
        let dir = Env.dataDir
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        sqlite3_open(dir.appendingPathComponent("meetings.db").path, &db)
        sqlite3_busy_timeout(db, 3000)
        exec("PRAGMA journal_mode = WAL")
        exec("""
        CREATE TABLE IF NOT EXISTS meetings (
            id TEXT PRIMARY KEY,
            started_ts INTEGER NOT NULL,
            ended_ts INTEGER,
            title TEXT,
            summary TEXT,
            app_name TEXT,
            segment_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_meeting_started ON meetings (started_ts DESC);
        CREATE TABLE IF NOT EXISTS meeting_segments (
            id TEXT PRIMARY KEY,
            meeting_id TEXT NOT NULL,
            ts INTEGER NOT NULL,
            source TEXT NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mseg_meeting ON meeting_segments (meeting_id, ts);
        """)
    }

    private func exec(_ sql: String) { sqlite3_exec(db, sql, nil, nil, nil) }

    private enum Arg { case s(String?), i(Int64?) }

    @discardableResult
    private func run(_ sql: String, _ args: [Arg]) -> Int {
        lock.lock(); defer { lock.unlock() }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(st) }
        bind(st, args)
        _ = sqlite3_step(st)
        return Int(sqlite3_changes(db))
    }

    private func bind(_ st: OpaquePointer?, _ args: [Arg]) {
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case .s(let v): if let v { sqlite3_bind_text(st, idx, v, -1, transient) } else { sqlite3_bind_null(st, idx) }
            case .i(let v): if let v { sqlite3_bind_int64(st, idx, v) } else { sqlite3_bind_null(st, idx) }
            }
        }
    }

    private func query<T>(_ sql: String, _ args: [Arg], _ row: (OpaquePointer?) -> T) -> [T] {
        lock.lock(); defer { lock.unlock() }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(st) }
        bind(st, args)
        var out: [T] = []
        while sqlite3_step(st) == SQLITE_ROW { out.append(row(st)) }
        return out
    }

    private static func text(_ st: OpaquePointer?, _ i: Int32) -> String? {
        sqlite3_column_type(st, i) == SQLITE_NULL ? nil : sqlite3_column_text(st, i).map { String(cString: $0) }
    }

    private static func int(_ st: OpaquePointer?, _ i: Int32) -> Double? {
        sqlite3_column_type(st, i) == SQLITE_NULL ? nil : Double(sqlite3_column_int64(st, i))
    }

    func insertMeeting(id: String, startedTs: Double, appName: String?) -> Bool {
        run("INSERT INTO meetings (id, started_ts, app_name) VALUES (?1, ?2, ?3)", [.s(id), .i(Int64(startedTs)), .s(appName)]) == 1
    }

    func finishMeeting(id: String, endedTs: Double, segmentCount: Int) {
        run("UPDATE meetings SET ended_ts = ?2, segment_count = ?3 WHERE id = ?1", [.s(id), .i(Int64(endedTs)), .i(Int64(segmentCount))])
    }

    func setSummary(id: String, title: String, summary: String) {
        run("UPDATE meetings SET title = ?2, summary = ?3 WHERE id = ?1", [.s(id), .s(title), .s(summary)])
    }

    func insertSegment(meetingId: String, ts: Double, source: String, text: String) {
        run("INSERT INTO meeting_segments (id, meeting_id, ts, source, text) VALUES (?1, ?2, ?3, ?4, ?5)",
            [.s(UUID().uuidString.lowercased()), .s(meetingId), .i(Int64(ts)), .s(source), .s(text)])
    }

    func list(limit: Int) -> [MeetingRecord] {
        query("SELECT id, started_ts, ended_ts, title, summary, app_name, segment_count FROM meetings ORDER BY started_ts DESC LIMIT ?1",
              [.i(Int64(limit))]) { st in
            MeetingRecord(id: Self.text(st, 0) ?? "", startedTs: Self.int(st, 1) ?? 0, endedTs: Self.int(st, 2),
                          title: Self.text(st, 3), summary: Self.text(st, 4), appName: Self.text(st, 5),
                          segmentCount: Int(Self.int(st, 6) ?? 0))
        }
    }

    func segments(_ meetingId: String) -> [MeetingSegmentRecord] {
        query("SELECT ts, source, text FROM meeting_segments WHERE meeting_id = ?1 ORDER BY ts ASC", [.s(meetingId)]) { st in
            MeetingSegmentRecord(ts: Self.int(st, 0) ?? 0, source: Self.text(st, 1) ?? "mic", text: Self.text(st, 2) ?? "")
        }
    }

    func delete(_ id: String) {
        lock.lock()
        exec("BEGIN")
        lock.unlock()
        run("DELETE FROM meeting_segments WHERE meeting_id = ?1", [.s(id)])
        run("DELETE FROM meetings WHERE id = ?1", [.s(id)])
        lock.lock()
        exec("COMMIT")
        lock.unlock()
    }

    func idsStartedBefore(_ ts: Double) -> [String] {
        query("SELECT id FROM meetings WHERE started_ts < ?1", [.i(Int64(ts))]) { st in Self.text(st, 0) ?? "" }
    }

    func prune(before ts: Double) -> Int {
        run("DELETE FROM meeting_segments WHERE meeting_id IN (SELECT id FROM meetings WHERE started_ts < ?1)", [.i(Int64(ts))])
        let n = run("DELETE FROM meetings WHERE started_ts < ?1", [.i(Int64(ts))])
        if n > 0 {
            lock.lock()
            exec("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
            lock.unlock()
        }
        return n
    }

    /// monitor::prune — saved audio first (ids are gone after the SQL delete).
    static func prune(retentionDays: Int) {
        guard retentionDays > 0 else { return }
        let before = nowMs() - Double(retentionDays) * 86_400 * 1000
        for id in shared.idsStartedBefore(before) { MeetingPaths.removeAudioDir(id) }
        _ = shared.prune(before: before)
    }
}

// MARK: - Recall log (summary.rs append_recall)

enum MeetingRecall {
    private static let lock = NSLock()

    static func append(ts: Double, kind: String, source: String, app: String?, title: String?, text: String) {
        lock.lock(); defer { lock.unlock() }
        let path = MeetingPaths.recallLog
        try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        var t = text.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
        if t.count > MeetingConst.recallTextCap { t = String(t.prefix(MeetingConst.recallTextCap)) }
        let iso = ISO8601DateFormatter.string(from: Date(timeIntervalSince1970: ts / 1000), timeZone: .current,
                                              formatOptions: [.withInternetDateTime, .withFractionalSeconds])
        let obj: [String: Any] = ["ts": Int64(ts), "iso": iso, "kind": kind, "source": source,
                                  "app": app ?? "", "title": title ?? "", "text": t]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]),
              let line = String(data: data, encoding: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: path.path) { FileManager.default.createFile(atPath: path.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: path) {
            h.seekToEndOfFile()
            h.write(Data((line + "\n").utf8))
            try? h.close()
        }
        if let size = (try? FileManager.default.attributesOfItem(atPath: path.path))?[.size] as? UInt64, size > MeetingConst.recallMaxBytes,
           let content = try? String(contentsOf: path, encoding: .utf8) {
            let lines = content.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.isEmpty }
            let kept = lines.suffix(MeetingConst.recallKeepLines).joined(separator: "\n")
            try? (kept + "\n").write(to: path, atomically: true, encoding: .utf8)
        }
    }
}

// MARK: - Helper resolution (lazy swiftc compile, mirrors meeting.rs / voice.rs)

enum MeetingHelper {
    static let version = "cetus-meeting-helper-v9"
    private static let lock = NSLock()
    nonisolated(unsafe) private static var resolved: String??
    nonisolated(unsafe) private static var shim: String??

    static let plist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>CFBundleIdentifier</key>
      <string>dev.cetus.app.meeting-helper</string>
      <key>CFBundleName</key>
      <string>cetus-meeting-helper</string>
      <key>NSMicrophoneUsageDescription</key>
      <string>cetus listens during meetings to transcribe them into searchable notes.</string>
      <key>NSSpeechRecognitionUsageDescription</key>
      <string>cetus transcribes meetings on-device so you can recall what was said.</string>
      <key>NSAudioCaptureUsageDescription</key>
      <string>cetus transcribes the other meeting participants from your system audio.</string>
    </dict>
    </plist>

    """

    private static var binDir: URL { Env.dataDir.appendingPathComponent("bin") }
    /// The Tauri install's bin dir — an identical prebuilt helper there is
    /// copied (same code signature, so any granted TCC access carries over).
    private static var tauriBinDir: URL { URL(fileURLWithPath: Env.home).appendingPathComponent("Library/Application Support/dev.cetus.app/bin") }

    /// (program, leading args) — through the disclaim shim when available.
    static func command() -> (String, [String])? {
        guard let bin = path() else { return nil }
        if let s = shimPath() { return (s, [bin]) }
        return (bin, [])
    }

    static func path() -> String? {
        lock.lock(); defer { lock.unlock() }
        if let r = resolved { return r }
        let r = resolveOrCompile()
        resolved = .some(r)
        return r
    }

    private static func resolveOrCompile() -> String? {
        let fm = FileManager.default
        if let p = Env.process["CETUS_MEETING_HELPER"], fm.fileExists(atPath: p) { return p }
        let bin = binDir.appendingPathComponent(version)
        if fm.fileExists(atPath: bin.path) { return bin.path }
        try? fm.createDirectory(at: binDir, withIntermediateDirectories: true)
        let prebuilt = tauriBinDir.appendingPathComponent(version)
        if fm.fileExists(atPath: prebuilt.path), (try? fm.copyItem(at: prebuilt, to: bin)) != nil { return bin.path }
        guard let srcURL = Theme.resource("meeting/cetus-meeting-helper.swift"), let src = try? String(contentsOf: srcURL, encoding: .utf8) else { return nil }
        let srcPath = binDir.appendingPathComponent("cetus-meeting-helper.swift")
        let plistPath = binDir.appendingPathComponent("cetus-meeting-helper.plist")
        try? src.write(to: srcPath, atomically: true, encoding: .utf8)
        try? plist.write(to: plistPath, atomically: true, encoding: .utf8)
        for flags in [[], ["-D", "NO_TAP"], ["-D", "NO_TAP", "-D", "NO_PROC_MONITOR"]] {
            let args = ["swiftc", "-O", "-framework", "Speech", "-framework", "AVFoundation", "-framework", "CoreAudio", "-framework", "AudioToolbox"]
                + flags + ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plistPath.path, "-o", bin.path, srcPath.path]
            if run(args) == 0, fm.fileExists(atPath: bin.path) { return bin.path }
        }
        return nil
    }

    static func shimPath() -> String? {
        lock.lock(); defer { lock.unlock() }
        if let s = shim { return s }
        let fm = FileManager.default
        let bin = binDir.appendingPathComponent("cetus-spawn-disclaim")
        var out: String?
        if fm.fileExists(atPath: bin.path) {
            out = bin.path
        } else {
            try? fm.createDirectory(at: binDir, withIntermediateDirectories: true)
            let prebuilt = tauriBinDir.appendingPathComponent("cetus-spawn-disclaim")
            if fm.fileExists(atPath: prebuilt.path), (try? fm.copyItem(at: prebuilt, to: bin)) != nil {
                out = bin.path
            } else if let srcURL = Theme.resource("meeting/cetus-spawn-disclaim.c") {
                let src = binDir.appendingPathComponent("cetus-spawn-disclaim.c")
                try? fm.removeItem(at: src)
                try? fm.copyItem(at: srcURL, to: src)
                if run(["cc", "-O2", "-o", bin.path, src.path]) == 0, fm.fileExists(atPath: bin.path) { out = bin.path }
            }
        }
        shim = .some(out)
        return out
    }

    private static func run(_ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
}

// MARK: - Utility LLM target (custom_models::utility_target)

struct MeetingUtilityTarget {
    var url: String
    var apiKey: String
    var model: String

    static func resolve() -> MeetingUtilityTarget? {
        let secrets = IntelData.secrets()
        if let key = secrets["deepseek"], !key.isEmpty {
            var base = (IntelData.setting("deepseek_base_url") ?? "").trimmingCharacters(in: .whitespaces)
            while base.hasSuffix("/") { base.removeLast() }
            if base.isEmpty { base = "https://api.deepseek.com" }
            return .init(url: base.hasSuffix("/chat/completions") ? base : base + "/chat/completions", apiKey: key, model: "deepseek-flash")
        }
        guard let raw = IntelData.setting("custom_providers"), let d = raw.data(using: .utf8),
              let list = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] else { return nil }
        for p in list {
            guard let models = p["models"] as? [[String: Any]], let first = models.first, let mid = first["id"] as? String else { continue }
            var base = (p["baseUrl"] as? String) ?? ""
            while base.hasSuffix("/") { base.removeLast() }
            let pid = (p["id"] as? String) ?? ""
            return .init(url: base.hasSuffix("/chat/completions") ? base : base + "/chat/completions",
                         apiKey: secrets["custom:\(pid)"] ?? "", model: mid)
        }
        return nil
    }
}

// MARK: - `cetus meeting` text (summary.rs cli_list / cli_transcript)

enum MeetingCLI {
    private static func fmt(_ ts: Double, _ format: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = format
        return f.string(from: Date(timeIntervalSince1970: ts / 1000))
    }

    static func list(limit: Int) -> String {
        let meetings = MeetingDB.shared.list(limit: min(max(limit, 1), 200))
        if meetings.isEmpty {
            return "No recorded meetings. Meeting capture may be off (Settings → Meetings), or nothing has been recorded yet."
        }
        var out = "Recorded meetings (newest first). `cetus meeting transcript <id|latest>` prints one in full.\n"
        for m in meetings {
            let end = m.endedTs.map { fmt($0, "HH:mm") } ?? "LIVE"
            out += "\n\(m.id)  \(fmt(m.startedTs, "yyyy-MM-dd HH:mm"))–\(end)  \(m.segmentCount) segments"
            if let a = m.appName { out += "  [\(a)]" }
            if let t = m.title { out += "  \(t)" }
        }
        return out
    }

    static func transcript(_ rawId: String) -> Result<String, MeetingError> {
        var id = rawId
        if id == "latest" {
            guard let first = MeetingDB.shared.list(limit: 1).first else { return .failure(.message("no recorded meetings")) }
            id = first.id
        }
        guard let m = MeetingDB.shared.list(limit: 200).first(where: { $0.id == id }) else {
            return .failure(.message("no meeting with id \"\(id)\" — run `cetus meeting list`"))
        }
        let segs = MeetingDB.shared.segments(id)
        var out = "Meeting \(m.id)\nStarted: \(fmt(m.startedTs, "yyyy-MM-dd HH:mm:ss"))"
        out += m.endedTs.map { "\nEnded: \(fmt($0, "yyyy-MM-dd HH:mm:ss"))" } ?? "\nEnded: (still recording)"
        if let a = m.appName { out += "\nApp: \(a)" }
        out += "\n"
        if let t = m.title, !t.isEmpty { out += "Title: \(t)\n" }
        if let s = m.summary, !s.isEmpty { out += "\n## Summary\n\(s)\n" }
        out += "\n## Transcript (`you` = the user's mic; `them` = everyone else, heard through system audio)\n"
        if segs.isEmpty { out += "(no transcript segments)\n" }
        for s in segs { out += "[\(fmt(s.ts, "HH:mm:ss"))] \(s.source == "mic" ? "you" : "them"): \(s.text)\n" }
        return .success(out)
    }
}

enum MeetingError: Error, CustomStringConvertible {
    case message(String)
    var description: String { if case .message(let m) = self { return m }; return "" }
}

// MARK: - Auto-detect helpers (monitor.rs)

enum MeetingDetect {
    static func urlHost(_ url: String) -> String? {
        let t = url.trimmingCharacters(in: .whitespaces)
        guard let r = t.range(of: "://") else { return nil }
        let rest = t[r.upperBound...]
        let authority = rest.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
        let hostPort = authority.split(separator: "@", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        var host = hostPort.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        while host.hasSuffix(".") { host.removeLast() }
        return host.isEmpty ? nil : host
    }

    static func isMeetingWebURL(_ url: String) -> Bool {
        guard let host = urlHost(url)?.lowercased() else { return false }
        return MeetingConst.webDomains.contains { d in host == d || host.hasSuffix("." + d) }
    }

    /// ax::fetch_browser_url — the active tab's URL via a bounded AppleScript.
    static func browserURL(_ bundle: String) -> String? {
        let chromium: Set<String> = MeetingConst.browserBundles.subtracting(["com.apple.Safari", "com.apple.SafariTechnologyPreview"])
        let src: String
        if bundle == "com.apple.Safari" || bundle == "com.apple.SafariTechnologyPreview" {
            src = "with timeout of 2 seconds\ntell application id \"\(bundle)\"\nset u to URL of front document\nset t to name of front document\nreturn {u, t}\nend tell\nend timeout"
        } else if chromium.contains(bundle) {
            src = "with timeout of 2 seconds\ntell application id \"\(bundle)\"\nset u to URL of active tab of front window\nset t to title of active tab of front window\nreturn {u, t}\nend tell\nend timeout"
        } else {
            return nil
        }
        var err: NSDictionary?
        guard let desc = NSAppleScript(source: src)?.executeAndReturnError(&err), err == nil else { return nil }
        if desc.numberOfItems >= 2 { return desc.atIndex(1)?.stringValue }
        return desc.stringValue
    }

    static func trustedApp(_ apps: [String]) -> String? {
        if let native = apps.first(where: { MeetingConst.appBundles.contains($0) }) { return native }
        for b in apps where MeetingConst.browserBundles.contains(b) {
            if let u = browserURL(b), isMeetingWebURL(u) { return b }
        }
        return nil
    }
}
