import Foundation
import SQLite3

/// Conversations and transcripts in the same shape as Cetus's `pi-desktop.db`
/// (`conversations` + `cli_messages`), but in this app's own database so the
/// apps never write each other's files.

enum RunState: String, Codable { case idle, running, aborted, interrupted }

struct Conversation: Identifiable, Equatable, Hashable {
    var id: String
    var title: String
    /// Resume token of the current runtime (claude session id / codex thread id).
    var sessionFile: String
    var workspaceDir: String
    var backend: String
    var cliModel: String
    var cliEffort: String
    var runState: RunState
    var createdAt: Double
    var updatedAt: Double
    var pinnedAt: Double?
    var archivedAt: Double?
    var unread: Bool
    /// Set when an automation run created the chat (sidebar shows a clock).
    var sourceAutomationId: String? = nil
    /// Board review handoff: "pending" after the agent calls request_review,
    /// "approved" once the user approves it, else "none".
    var reviewState = "none"
}

enum Schedule: Codable, Equatable, Hashable {
    case once(at: Double)
    case interval(every: Int, unit: String)
    case daily(time: String, weekdays: [Int])
    case cron(expr: String)

    init(from decoder: Decoder) throws {
        let j = try JSON(from: decoder)
        switch j["kind"].string {
        // Cetus's JSON (atMs / everyMinutes / expr); the older Swift keys still decode.
        case "once": self = .once(at: j["atMs"].double ?? j["at"].double ?? nowMs())
        case "interval": self = j["everyMinutes"].int.map { Schedule.interval(minutes: $0) } ?? .interval(every: j["every"].int ?? 1, unit: j["unit"].string ?? "hours")
        case "cron": self = .cron(expr: j["expr"].string ?? "")
        default: self = .daily(time: j["time"].string ?? "09:00", weekdays: (j["weekdays"].array ?? []).compactMap(\.int))
        }
    }

    func encode(to encoder: Encoder) throws { try json.encode(to: encoder) }

    var json: JSON {
        switch self {
        case .once(let at): return ["kind": "once", "atMs": .number(at)]
        case .interval: return ["kind": "interval", "everyMinutes": .number(Double(everyMinutes))]
        case .cron(let expr): return ["kind": "cron", "expr": .string(expr)]
        case .daily(let time, let weekdays): return ["kind": "daily", "time": .string(time), "weekdays": .array(weekdays.map { .number(Double($0)) })]
        }
    }

    var kind: String {
        switch self { case .once: "once"; case .interval: "interval"; case .daily: "daily"; case .cron: "cron" }
    }
}

struct Automation: Identifiable, Equatable, Hashable {
    var id: String
    var name: String
    var prompt: String
    var backend: String
    var model: String
    var effort: String
    var workspaceDir: String
    var schedule: Schedule
    var enabled: Bool
    var lastRunAt: Double?
    var lastConversationId: String?
    var lastError: String?
    var createdAt: Double
    var updatedAt: Double
    /// Completed runs and the last run's outcome ("ok" | "error"), as Cetus stores them.
    var runCount = 0
    var lastStatus: String? = nil
    /// Epoch-ms of the next scheduled fire (nil when disabled / spent), as Cetus stores it.
    var nextRunAt: Double? = nil
}

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLValue {
    case text(String), int(Int64), real(Double), null

    init(_ s: String?) { self = s.map { .text($0) } ?? .null }
    init(_ d: Double?) { self = d.map { .int(Int64($0)) } ?? .null }
    init(_ b: Bool) { self = .int(b ? 1 : 0) }
}

typealias Row = [String: SQLValue]

extension Dictionary where Key == String, Value == SQLValue {
    func str(_ k: String) -> String {
        switch self[k] {
        case .text(let s): return s
        case .int(let i): return String(i)
        case .real(let d): return String(d)
        default: return ""
        }
    }
    func num(_ k: String) -> Double? {
        switch self[k] {
        case .int(let i): return Double(i)
        case .real(let d): return d
        case .text(let s): return Double(s)
        default: return nil
        }
    }
}

final class Store {
    private var db: OpaquePointer?
    let path: String

    init(dataDir: URL) {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        path = dataDir.appendingPathComponent("cetus.db").path
        sqlite3_open(path, &db)
        exec("PRAGMA journal_mode = WAL")
        // WAL stays consistent with NORMAL; FULL fsynced on every autocommit write.
        exec("PRAGMA synchronous = NORMAL")
        exec("""
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          session_file TEXT NOT NULL DEFAULT '',
          workspace_dir TEXT NOT NULL DEFAULT '',
          backend TEXT NOT NULL DEFAULT 'claude-code',
          cli_model TEXT NOT NULL DEFAULT '',
          cli_effort TEXT NOT NULL DEFAULT '',
          run_state TEXT NOT NULL DEFAULT 'idle',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          pinned_at INTEGER,
          unread INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS cli_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          message_json TEXT NOT NULL,
          resume_before TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cli_messages_conv ON cli_messages(conversation_id, id);
        CREATE TABLE IF NOT EXISTS automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          backend TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          effort TEXT NOT NULL DEFAULT '',
          workspace_dir TEXT NOT NULL DEFAULT '',
          schedule_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          last_conversation_id TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        """)
        let columns = Set(query("PRAGMA table_info(conversations)").map { $0.str("name") })
        if !columns.contains("pinned_at") { exec("ALTER TABLE conversations ADD COLUMN pinned_at INTEGER") }
        if !columns.contains("source_automation_id") { exec("ALTER TABLE conversations ADD COLUMN source_automation_id TEXT") }
        if !columns.contains("unread") { exec("ALTER TABLE conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0") }
        if !columns.contains("review_state") { exec("ALTER TABLE conversations ADD COLUMN review_state TEXT NOT NULL DEFAULT 'none'") }
        let autoColumns = Set(query("PRAGMA table_info(automations)").map { $0.str("name") })
        if !autoColumns.contains("run_count") { exec("ALTER TABLE automations ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0") }
        if !autoColumns.contains("last_status") { exec("ALTER TABLE automations ADD COLUMN last_status TEXT") }
        if !autoColumns.contains("next_run_at") { exec("ALTER TABLE automations ADD COLUMN next_run_at INTEGER") }
        // Anything still running belonged to a process that died mid-turn.
        exec("UPDATE conversations SET run_state = 'interrupted' WHERE run_state = 'running'")
    }

    deinit { sqlite3_close(db) }

    // MARK: - SQL plumbing

    func exec(_ sql: String) {
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    /// One commit for a batch of writes (a finished turn's messages).
    func transaction(_ body: () -> Void) {
        exec("BEGIN")
        body()
        exec("COMMIT")
    }

    @discardableResult
    func run(_ sql: String, _ args: [SQLValue] = []) -> Int32 {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return -1 }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, args)
        return sqlite3_step(stmt)
    }

    func query(_ sql: String, _ args: [SQLValue] = []) -> [Row] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bind(stmt, args)
        var rows: [Row] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var row: Row = [:]
            for i in 0 ..< sqlite3_column_count(stmt) {
                let name = String(cString: sqlite3_column_name(stmt, i))
                switch sqlite3_column_type(stmt, i) {
                case SQLITE_INTEGER: row[name] = .int(sqlite3_column_int64(stmt, i))
                case SQLITE_FLOAT: row[name] = .real(sqlite3_column_double(stmt, i))
                case SQLITE_TEXT: row[name] = .text(String(cString: sqlite3_column_text(stmt, i)))
                default: row[name] = .null
                }
            }
            rows.append(row)
        }
        return rows
    }

    private func bind(_ stmt: OpaquePointer?, _ args: [SQLValue]) {
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case .text(let s): sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT)
            case .int(let n): sqlite3_bind_int64(stmt, idx, n)
            case .real(let d): sqlite3_bind_double(stmt, idx, d)
            case .null: sqlite3_bind_null(stmt, idx)
            }
        }
    }

    // MARK: - Conversations

    private func conversation(_ r: Row) -> Conversation {
        Conversation(
            id: r.str("id"), title: r.str("title"), sessionFile: r.str("session_file"),
            workspaceDir: r.str("workspace_dir"), backend: r.str("backend").isEmpty ? "claude-code" : r.str("backend"),
            cliModel: r.str("cli_model"), cliEffort: r.str("cli_effort"),
            runState: RunState(rawValue: r.str("run_state")) ?? .idle,
            createdAt: r.num("created_at") ?? 0, updatedAt: r.num("updated_at") ?? 0,
            pinnedAt: r.num("pinned_at"), archivedAt: r.num("archived_at"), unread: (r.num("unread") ?? 0) == 1,
            sourceAutomationId: r.str("source_automation_id").isEmpty ? nil : r.str("source_automation_id"),
            reviewState: r.str("review_state").isEmpty ? "none" : r.str("review_state"))
    }

    func list() -> [Conversation] {
        query("SELECT * FROM conversations WHERE archived_at IS NULL ORDER BY updated_at DESC").map(conversation)
    }

    func archived() -> [Conversation] {
        query("SELECT * FROM conversations WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").map(conversation)
    }

    func get(_ id: String) -> Conversation? {
        query("SELECT * FROM conversations WHERE id = ?", [.text(id)]).first.map(conversation)
    }

    func create(title: String, workspaceDir: String, backend: String, model: String, effort: String, sourceAutomationId: String? = nil) -> Conversation {
        let now = Int64(nowMs())
        let id = UUID().uuidString.lowercased()
        run("INSERT INTO conversations (id, title, workspace_dir, backend, cli_model, cli_effort, created_at, updated_at, source_automation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [.text(id), .text(title), .text(workspaceDir), .text(backend), .text(model), .text(effort), .int(now), .int(now), sourceAutomationId.map { .text($0) } ?? .null])
        return get(id)!
    }

    enum Field {
        case title(String), sessionFile(String), workspaceDir(String), backend(String), model(String), effort(String)
        case runState(RunState), updatedAt(Double), pinnedAt(Double?), archivedAt(Double?), unread(Bool), reviewState(String)

        var column: (String, SQLValue) {
            switch self {
            case .title(let v): ("title", .text(v))
            case .sessionFile(let v): ("session_file", .text(v))
            case .workspaceDir(let v): ("workspace_dir", .text(v))
            case .backend(let v): ("backend", .text(v))
            case .model(let v): ("cli_model", .text(v))
            case .effort(let v): ("cli_effort", .text(v))
            case .runState(let v): ("run_state", .text(v.rawValue))
            case .updatedAt(let v): ("updated_at", .int(Int64(v)))
            case .pinnedAt(let v): ("pinned_at", SQLValue(v))
            case .archivedAt(let v): ("archived_at", SQLValue(v))
            case .unread(let v): ("unread", SQLValue(v))
            case .reviewState(let v): ("review_state", .text(v))
            }
        }
    }

    func update(_ id: String, _ fields: [Field]) {
        guard !fields.isEmpty else { return }
        let cols = fields.map(\.column)
        run("UPDATE conversations SET \(cols.map { "\($0.0) = ?" }.joined(separator: ", ")) WHERE id = ?", cols.map(\.1) + [.text(id)])
    }

    func delete(_ id: String) {
        run("DELETE FROM cli_messages WHERE conversation_id = ?", [.text(id)])
        run("DELETE FROM conversations WHERE id = ?", [.text(id)])
    }

    func messages(_ id: String) -> [JSON] {
        query("SELECT message_json, created_at FROM cli_messages WHERE conversation_id = ? ORDER BY id", [.text(id)]).compactMap { r in
            guard var m = JSON.parse(r.str("message_json")) else { return nil }
            m["timestamp"] = JSON(r.num("created_at"))
            return m
        }
    }

    func append(_ id: String, _ message: JSON, resumeBefore: String? = nil) {
        let now = nowMs()
        run("INSERT INTO cli_messages (conversation_id, message_json, resume_before, created_at) VALUES (?, ?, ?, ?)",
            [.text(id), .text(message.compact), SQLValue(resumeBefore), .int(Int64(now))])
        update(id, [.updatedAt(now)])
    }

    /// Copy rows up to and including `throughIndex` into another conversation.
    func copyMessages(from: String, to: String, throughIndex: Int) {
        let rows = query("SELECT message_json, created_at FROM cli_messages WHERE conversation_id = ? ORDER BY id", [.text(from)])
        for r in rows.prefix(max(0, throughIndex + 1)) {
            run("INSERT INTO cli_messages (conversation_id, message_json, resume_before, created_at) VALUES (?, ?, NULL, ?)",
                [.text(to), .text(r.str("message_json")), .int(Int64(r.num("created_at") ?? nowMs()))])
        }
    }

    /// Conversations whose title or transcript contains `text`, newest first.
    func search(_ text: String, limit: Int = 30) -> [(Conversation, String)] {
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_")
        let like = SQLValue.text("%\(escaped)%")
        let rows = query("""
        SELECT c.*, (
          SELECT m.message_json FROM cli_messages m
          WHERE m.conversation_id = c.id AND m.message_json LIKE ? ESCAPE '\\'
          ORDER BY m.id DESC LIMIT 1
        ) AS hit
        FROM conversations c
        WHERE c.title LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM cli_messages m WHERE m.conversation_id = c.id AND m.message_json LIKE ? ESCAPE '\\'
        )
        ORDER BY c.updated_at DESC LIMIT ?
        """, [like, like, like, .int(Int64(limit))])
        return rows.map { r in (conversation(r), Self.snippet(r.str("hit"), text)) }
    }

    private static func snippet(_ json: String, _ q: String) -> String {
        guard let m = JSON.parse(json) else { return "" }
        let text = (m["content"].array ?? []).compactMap { $0["type"].string == "text" ? $0["text"].string : nil }.joined(separator: " ")
        guard let r = text.range(of: q, options: .caseInsensitive) else { return "" }
        let start = text.index(r.lowerBound, offsetBy: -40, limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(r.upperBound, offsetBy: 60, limitedBy: text.endIndex) ?? text.endIndex
        let body = text[start ..< end].split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return (start > text.startIndex ? "…" : "") + body
    }

    // MARK: - Automations

    func automations() -> [Automation] {
        query("SELECT * FROM automations ORDER BY created_at DESC").map { r in
            Automation(
                id: r.str("id"), name: r.str("name"), prompt: r.str("prompt"), backend: r.str("backend"),
                model: r.str("model"), effort: r.str("effort"), workspaceDir: r.str("workspace_dir"),
                schedule: (try? JSONDecoder().decode(Schedule.self, from: Data(r.str("schedule_json").utf8))) ?? .daily(time: "09:00", weekdays: []),
                enabled: (r.num("enabled") ?? 1) == 1, lastRunAt: r.num("last_run_at"),
                lastConversationId: r["last_conversation_id"].flatMap { if case .text(let s) = $0 { s } else { nil } },
                lastError: r["last_error"].flatMap { if case .text(let s) = $0 { s } else { nil } },
                createdAt: r.num("created_at") ?? 0, updatedAt: r.num("updated_at") ?? 0,
                runCount: Int(r.num("run_count") ?? 0),
                lastStatus: r["last_status"].flatMap { if case .text(let s) = $0 { s } else { nil } },
                nextRunAt: r.num("next_run_at"))
        }
    }

    func saveAutomation(_ a: Automation) {
        let now = Int64(nowMs())
        run("""
        INSERT INTO automations (id, name, prompt, backend, model, effort, workspace_dir, schedule_json, enabled,
          last_run_at, last_conversation_id, last_error, created_at, updated_at, run_count, last_status, next_run_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, backend = excluded.backend,
          model = excluded.model, effort = excluded.effort, workspace_dir = excluded.workspace_dir,
          schedule_json = excluded.schedule_json, enabled = excluded.enabled, last_run_at = excluded.last_run_at,
          last_conversation_id = excluded.last_conversation_id, last_error = excluded.last_error,
          updated_at = excluded.updated_at, run_count = excluded.run_count, last_status = excluded.last_status,
          next_run_at = excluded.next_run_at
        """, [.text(a.id), .text(a.name), .text(a.prompt), .text(a.backend), .text(a.model), .text(a.effort),
              .text(a.workspaceDir), .text(a.schedule.json.compact), SQLValue(a.enabled), SQLValue(a.lastRunAt),
              SQLValue(a.lastConversationId), SQLValue(a.lastError), .int(a.createdAt > 0 ? Int64(a.createdAt) : now), .int(now),
              .int(Int64(a.runCount)), SQLValue(a.lastStatus), SQLValue(a.nextRunAt)])
    }

    func deleteAutomation(_ id: String) {
        run("DELETE FROM automations WHERE id = ?", [.text(id)])
    }
}

extension Store {
    /// The last assistant text of a conversation, whitespace-collapsed and cut
    /// to 220 characters (computeLastReplyPreview), for board cards.
    func lastReplyPreview(_ id: String) -> String? {
        // The reply is almost always among the last rows: read those before the whole transcript.
        let tail = query("SELECT message_json FROM cli_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 24", [.text(id)])
            .compactMap { JSON.parse($0.str("message_json")) }
        if let hit = Self.preview(in: tail) { return hit }
        return tail.count < 24 ? nil : Self.preview(in: Array(messages(id).reversed()))
    }

    private static func preview(in newestFirst: [JSON]) -> String? {
        for m in newestFirst where m["role"].string == "assistant" {
            for b in (m["content"].array ?? []).reversed() where b["type"].string == "text" {
                let t = b["text"].stringValue
                guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                let collapsed = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                return String(collapsed.prefix(220))
            }
        }
        return nil
    }
}
