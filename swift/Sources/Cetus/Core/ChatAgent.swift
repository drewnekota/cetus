import Foundation

// Agent-turn integration that the Tauri host layers around the pi runtime,
// wired to cetus-agentd's host ops (agentd/src/pi.rs `host_op`):
//  - auto titles (commands/prompt.rs title_source + spawn_auto_title, titling.rs)
//  - host-tunnel tools the UI owns: create/list/update_automation
//    (automation_tool.rs) and the visible-browser request (agent.rs)
//  - Settings → Skills / MCP / Plugins / Computer & Browser edits re-export the
//    global skills dir + mcp.json, as skills.rs / mcp.rs do on every change
//  - a deleted conversation drops its frozen agent dir (remove_conv_agent)

extension AgentHost {
    func title(_ conv: String, message: String) { send(["op": "title", "id": .string(conv), "message": .string(message)]) }
    func exportConfig() { send(["op": "exportConfig"]) }
    func forgetConv(_ conv: String) { send(["op": "forgetConv", "conv": .string(conv)]) }
    func hostReply(_ requestId: String, _ reply: JSON) { send(["op": "hostReply", "requestId": .string(requestId), "reply": reply]) }
}

enum ChatTitling {
    /// Conversation id → the placeholder painted while the AI title is in flight.
    nonisolated(unsafe) static var pending: [String: String] = [:]

    private static func stripContextFence(_ msg: String) -> Substring {
        let open = "<context source=\"cetus-", close = "</context>"
        guard msg.hasPrefix(open), let r = msg.range(of: close) else { return Substring(msg) }
        var rest = msg[r.upperBound...]
        while let f = rest.first, f == "\n" || f == "\r" { rest = rest.dropFirst() }
        return rest
    }

    /// commands/prompt.rs `title_source`: the human prose of a prompt, or the
    /// attached file names when there is none.
    static func source(_ message: String) -> String {
        let msg = stripContextFence(message)
        let open = "<cetus-attachments>", close = "</cetus-attachments>"
        guard let o = msg.range(of: open) else { return msg.trimmingCharacters(in: .whitespacesAndNewlines) }
        let prose = msg[..<o.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        if !prose.isEmpty { return prose }
        let tail = msg[o.upperBound...]
        let block = tail.range(of: close).map { tail[..<$0.lowerBound] } ?? tail
        return block.split(separator: "\n", omittingEmptySubsequences: false).compactMap { line -> String? in
            let t = line.trimmingCharacters(in: .whitespaces)
            guard t.hasPrefix("- "), let arrow = t.range(of: " → ") else { return nil }
            let name = t[t.index(t.startIndex, offsetBy: 2) ..< arrow.lowerBound].trimmingCharacters(in: .whitespaces)
            return name.isEmpty ? nil : name
        }.joined(separator: "、")
    }

    /// commands.rs `derive_title`: first line, 60 characters.
    static func derive(_ prompt: String) -> String {
        var first = prompt.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        if first.hasSuffix("\r") { first.removeLast() }
        first = first.trimmingCharacters(in: .whitespaces)
        return first.count > 60 ? String(first.prefix(60)) + "…" : first
    }
}

extension Controller {
    /// send_prompt's title contract: paint the mechanical placeholder now, and
    /// on the first prompt of an untitled conversation ask for an AI title.
    func titleOnSend(_ conv: Conversation, outgoing: String) {
        let wasUntitled = conv.title.trimmingCharacters(in: .whitespaces).isEmpty
        let src = ChatTitling.source(outgoing)
        let fallback = ChatTitling.derive(src)
        if wasUntitled { store.update(conv.id, [.title(fallback)]) }
        if wasUntitled && !src.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ChatTitling.pending[conv.id] = fallback
            host.title(conv.id, message: src)
        }
    }

    /// The utility model's answer: replace the placeholder unless the user
    /// renamed the conversation meanwhile. Failures keep the placeholder.
    func applyGeneratedTitle(_ m: JSON) {
        guard let id = m["id"].string, let fallback = ChatTitling.pending.removeValue(forKey: id),
              let title = m["title"].string, !title.isEmpty, let conv = store.get(id)
        else { return }
        guard conv.title == fallback || conv.title.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        store.update(id, [.title(title)])
        reload()
    }

    /// A deleted conversation's frozen skills + mcp.json go with it.
    func forgetConversationAgent(_ id: String) { host.forgetConv(id) }

    // MARK: Host-tunnel requests the UI answers

    func handleHostRequest(_ m: JSON) {
        guard let requestId = m["requestId"].string else { return }
        let reply: JSON
        switch m["kind"].string {
        case "automation": reply = ChatAutomationTool.handle(self, m["params"])
        case "browser": reply = ["ok": false, "error": "The visible Browser is not available in this Cetus client."]
        default: reply = ["ok": false, "error": "unknown host request"]
        }
        host.hostReply(requestId, reply)
    }

    /// The agent changed skills or MCP servers through its tools.
    func hostSettingsChanged(_ m: JSON) {
        ChatAgentSync.shared.noteExternalChange()
        NotificationCenter.default.post(name: .cetusAgentSettingsChanged, object: m["what"].string)
    }

    func startAgentSync() { ChatAgentSync.shared.start(host) }
}

extension Notification.Name {
    static let cetusAgentSettingsChanged = Notification.Name("cetus.agentSettingsChanged")
}

/// automation_tool.rs: create / list / update scheduled automations from a turn.
enum ChatAutomationTool {
    private static func str(_ p: JSON, _ k: String) -> String? {
        guard let s = p[k].string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    static func handle(_ c: Controller, _ p: JSON) -> JSON {
        switch p["op"].string ?? "" {
        case "list":
            return ["ok": true, "automations": .array(c.store.automations().map(summarize))]
        case "create": return create(c, p)
        case "update": return update(c, p)
        case let other: return ["ok": false, "error": .string("unknown op '\(other)'")]
        }
    }

    private static func create(_ c: Controller, _ p: JSON) -> JSON {
        guard let name = str(p, "name") else { return ["ok": false, "error": "missing 'name'"] }
        guard let prompt = str(p, "prompt") else { return ["ok": false, "error": "missing 'prompt'"] }
        let schedule: Schedule
        switch buildSchedule(p) {
        case .success(let s): schedule = s
        case .failure(let e): return ["ok": false, "error": .string(e.message)]
        }
        if let e = schedule.validationError() { return ["ok": false, "error": .string("invalid schedule: \(e)")] }
        let enabled = p["enabled"].bool ?? true
        let (model, effort) = buildModel(p)
        let input = AutomationInput(name: name, prompt: prompt, workspaceDir: str(p, "workspaceDir") ?? Env.defaultWorkspace,
                                    backend: "pi", model: model, effort: effort, schedule: schedule, enabled: enabled)
        switch AutomationScheduler.create(c, input) {
        case .failure(let e): return ["ok": false, "error": .string(e.message)]
        case .success(let a):
            let note = enabled
                ? "Saved and ENABLED — it will run on its schedule. Tell the user it's active; they can review or pause it in Automations (⌘3)."
                : "Saved as a DISABLED draft — it won't run until enabled. Tell the user where to find it (Automations, ⌘3)."
            return ["ok": true, "automation": summarize(a), "note": .string(note)]
        }
    }

    private static func update(_ c: Controller, _ p: JSON) -> JSON {
        guard let id = str(p, "id") else { return ["ok": false, "error": "missing 'id'"] }
        guard let existing = c.store.automations().first(where: { $0.id == id }) else { return ["ok": false, "error": "automation not found"] }
        var schedule = existing.schedule
        if !p["scheduleKind"].isNull {
            switch buildSchedule(p) {
            case .success(let s): schedule = s
            case .failure(let e): return ["ok": false, "error": .string(e.message)]
            }
        }
        if let e = schedule.validationError() { return ["ok": false, "error": .string("invalid schedule: \(e)")] }
        var model = existing.model, effort = existing.effort
        if !p["model"].isNull || !p["reasoning"].isNull { (model, effort) = buildModel(p) }
        let input = AutomationInput(name: str(p, "name") ?? existing.name, prompt: str(p, "prompt") ?? existing.prompt,
                                    workspaceDir: str(p, "workspaceDir") ?? existing.workspaceDir,
                                    backend: existing.backend, model: model, effort: effort, schedule: schedule,
                                    enabled: p["enabled"].bool ?? existing.enabled)
        switch AutomationScheduler.update(c, id: id, input) {
        case .failure(let e): return ["ok": false, "error": .string(e.message)]
        case .success(let a): return ["ok": true, "automation": summarize(a)]
        }
    }

    private static func summarize(_ a: Automation) -> JSON {
        ["id": .string(a.id), "name": .string(a.name), "prompt": .string(a.prompt), "schedule": .string(describe(a.schedule)),
         "enabled": .bool(a.enabled), "workspaceDir": .string(a.workspaceDir), "nextRunAt": a.nextRunAt.map { .number($0) } ?? .null]
    }

    private static func describe(_ s: Schedule) -> String {
        switch s {
        case .once(let at): return "once at epoch-ms \(Int64(at))"
        case .interval: return "every \(s.everyMinutes) min"
        case .daily(let time, let weekdays):
            return weekdays.isEmpty ? "daily at \(time)" : "at \(time) on weekdays [\(weekdays.map(String.init).joined(separator: ", "))] (0=Sun)"
        case .cron(let expr): return "cron '\(expr)'"
        }
    }

    /// build_model: ModelChoice — `model` "flash"|"pro"|"<provider>/<id>", `reasoning` a pi level (legacy aliases accepted).
    private static func buildModel(_ p: JSON) -> (String, String) {
        var model = "flash", effort = "high"
        if let m = p["model"].string?.trimmingCharacters(in: .whitespaces), !m.isEmpty {
            if m == "flash" || m == "pro" { model = "flash" }
            else if let slash = m.firstIndex(of: "/"), slash != m.startIndex, m.index(after: slash) != m.endIndex { model = m }
        }
        if let r = p["reasoning"].string {
            let aliases = ["non_think": "off", "none": "off", "think_high": "high", "think_max": "max"]
            let level = aliases[r] ?? r
            if Runtimes.piReasoningAxis.contains(level) { effort = level }
        }
        return (model, effort)
    }

    private static func buildSchedule(_ p: JSON) -> Result<Schedule, AutomationFailure> {
        guard let kind = p["scheduleKind"].string else { return .failure(.init("missing 'scheduleKind' (one of: daily, interval, cron, once)")) }
        switch kind {
        case "daily":
            guard let time = str(p, "time") else { return .failure(.init("'daily' needs 'time' as HH:MM (24h, local)")) }
            return .success(.daily(time: time, weekdays: (p["weekdays"].array ?? []).compactMap { $0.int.flatMap { $0 >= 0 ? $0 : nil } }))
        case "interval":
            guard let every = p["everyMinutes"].int else { return .failure(.init("'interval' needs 'everyMinutes' (integer ≥ 1)")) }
            if every < 1 { return .success(.interval(every: every, unit: "minutes")) }
            return .success(.interval(minutes: every))
        case "cron":
            guard let expr = str(p, "cron") else { return .failure(.init("'cron' needs 'cron' as a standard 5-field expression")) }
            return .success(.cron(expr: expr))
        case "once":
            if let ms = p["atMs"].double { return .success(.once(at: ms.rounded(.towardZero))) }
            guard let at = str(p, "at") else { return .failure(.init("'once' needs 'at' (local 'YYYY-MM-DD HH:MM') or 'atMs' (epoch-ms)")) }
            for fmt in ["yyyy-MM-dd HH:mm", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss"] {
                let f = DateFormatter()
                f.locale = Locale(identifier: "en_US_POSIX")
                f.timeZone = .current
                f.dateFormat = fmt
                f.isLenient = false
                if let d = f.date(from: at) { return .success(.once(at: (d.timeIntervalSince1970 * 1000).rounded())) }
            }
            return .failure(.init("could not parse 'at' = '\(at)'; use 'YYYY-MM-DD HH:MM'"))
        default:
            return .failure(.init("unknown scheduleKind '\(kind)'"))
        }
    }
}

/// Settings → Skills / MCP / Plugins / Computer & Browser write the shared
/// `app_settings` store; the Tauri host re-exports the global active-skills dir
/// and mcp.json after each such write (skills::resync_active_dir,
/// mcp::export_config). Watch those keys and ask agentd to re-export when one
/// changes, whoever wrote it. Conversations keep their own frozen copies.
final class ChatAgentSync {
    static let shared = ChatAgentSync()
    private static let keys = ["skills", "discovery", "mcp_connectors", "plugins", "agent_control"]
    private weak var host: AgentHost?
    /// The shared db is large and another app may hold its lock (2s busy timeout):
    /// poll it off the main thread, and only query when the db or its WAL changed.
    private let queue = DispatchQueue(label: "cetus.agent-sync", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var last: [String: String]?
    private var stamp: [Date?] = []

    func start(_ host: AgentHost) {
        self.host = host
        guard timer == nil else { return }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(500))
        t.setEventHandler { [weak self] in self?.poll() }
        timer = t
        queue.async {
            self.stamp = Self.fileStamp()
            self.last = self.snapshot()
            t.resume()
        }
    }

    /// The agent's own tool call already re-exported; just resync the baseline.
    func noteExternalChange() {
        queue.async {
            self.stamp = Self.fileStamp()
            self.last = self.snapshot()
        }
    }

    private func snapshot() -> [String: String] {
        var out: [String: String] = [:]
        for k in Self.keys { out[k] = IntelData.setting(k) ?? "" }
        return out
    }

    private static func fileStamp() -> [Date?] {
        let db = IntelData.file("pi-desktop.db").path
        return [db, db + "-wal"].map { (try? FileManager.default.attributesOfItem(atPath: $0))?[.modificationDate] as? Date }
    }

    private func poll() {
        let s = Self.fileStamp()
        guard s != stamp else { return }
        stamp = s
        let now = snapshot()
        defer { last = now }
        guard let last, last != now else { return }
        DispatchQueue.main.async { self.host?.exportConfig() }
    }
}

// MARK: - Steering and CLI image paths

extension AgentHost {
    func steer(_ request: JSON) {
        var r = request
        r["op"] = "steer"
        send(r)
    }
}

enum ChatSteer {
    /// backendSupportsSteer: pi steers via RPC, claude-code over stdin, codex with turn/steer.
    static func supports(_ backend: String) -> Bool { ["pi", "claude-code", "codex"].contains(backend) }

    /// In-flight steers per conversation: the queued item + its optimistic bubble key.
    nonisolated(unsafe) static var pending: [String: [(item: Queued, bubble: String?)]] = [:]

    /// cli_backend::save_turn_images: the CLIs read images as files, so each
    /// turn's images are materialized under `<data>/cli-attachments/<conv>`.
    static func saveTurnImages(_ conv: String, _ images: [(mime: String, data: String)]) -> [String] {
        guard !images.isEmpty else { return [] }
        let dir = Env.dataDir.appendingPathComponent("cli-attachments").appendingPathComponent(conv)
        guard (try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)) != nil else { return [] }
        return images.compactMap { img in
            let ext = ["image/png": "png", "image/gif": "gif", "image/webp": "webp"][img.mime] ?? "jpg"
            guard let bytes = Data(base64Encoded: img.data) else { return nil }
            let url = dir.appendingPathComponent("\(UUID().uuidString.lowercased()).\(ext)")
            return (try? bytes.write(to: url)) != nil ? url.path : nil
        }
    }

    /// cli_backend::image_path_refs: where this turn's images landed on disk.
    static func imagePathRefs(_ paths: [String]) -> String {
        if paths.isEmpty { return "" }
        let lines = paths.map { "- \($0)" }.joined(separator: "\n")
        return "\n\n<cetus-attachments>\nThe attached images are also saved on disk. Use these paths whenever a tool needs the image as a file:\n\(lines)\n</cetus-attachments>"
    }
}

extension Controller {
    /// Deliver a queued follow-up into the running turn (steerQueued).
    func steerIntoRun(_ conv: Conversation, _ item: Queued) {
        let model = chat(conv.id)
        let images = item.attachments.filter(\.isImage)
        let files = item.attachments.filter { !$0.isImage }
        var transcripts: [String: String] = [:]
        for ref in item.mentions where ref.kind == .conversation {
            if let path = exportTranscript(ref.id) { transcripts[ref.label] = path }
        }
        let outgoing = item.text + Mentions.build(item.mentions, transcripts: transcripts) + Attachments.build(files.map { ($0.name, $0.path) })
        let payload: [(mime: String, data: String, path: String, name: String)] = images.compactMap { a in
            guard let d = try? Data(contentsOf: URL(fileURLWithPath: a.path)) else { return nil }
            return (a.mimeType, d.base64EncodedString(), a.path, a.name)
        }
        var prompt = outgoing
        var paths = payload.map(\.path)
        if conv.backend != "pi" {
            paths = ChatSteer.saveTurnImages(conv.id, payload.map { ($0.mime, $0.data) })
            prompt += ChatSteer.imagePathRefs(paths)
        }
        var content: [JSON] = [["type": "text", "text": .string(outgoing)]]
        for i in payload { content.append(["type": "image", "data": .string(i.data), "mimeType": .string(i.mime)]) }
        // pi emits the steered user message itself at its merge point (message_start
        // user); the CLI runtimes don't, so they get the bubble now.
        var bubble: String?
        if conv.backend != "pi" {
            model.state.reduce(.userSent(text: item.text, images: payload.map { ($0.data, $0.mime, $0.name) },
                                         files: files.map { ($0.name, $0.path, $0.mimeType, $0.size) }))
            bubble = model.state.messages.last?.key
        }
        ChatSteer.pending[conv.id, default: []].append((item, bubble))
        host.steer([
            "conv": .string(conv.id), "prompt": .string(prompt),
            "images": .array(zip(payload, paths.count == payload.count ? paths : payload.map(\.path)).map { p, path in
                ["mimeType": .string(p.mime), "data": .string(p.data), "path": .string(path)]
            }),
            "message": ["role": "user", "content": .array(content)],
        ])
        reload()
    }

    /// agentd's answer to a steer. A miss (the turn settled first) is sent as a
    /// normal next turn, like the host's redispatch-after-settle.
    func steerResult(_ m: JSON) {
        guard let id = m["conv"].string, var list = ChatSteer.pending[id], !list.isEmpty else { return }
        let (item, bubble) = list.removeFirst()
        ChatSteer.pending[id] = list.isEmpty ? nil : list
        guard !m["ok"].truthy, let conv = store.get(id) else { return }
        let model = chat(id)
        if let bubble, let i = model.state.messages.lastIndex(where: { $0.key == bubble }), i == model.state.messages.count - 1 {
            model.state.messages.remove(at: i)
        }
        send(SendOptions(conversationId: id, text: item.text, backend: conv.backend, model: conv.cliModel, effort: conv.cliEffort,
                         workspaceDir: conv.workspaceDir, attachments: item.attachments, mentions: item.mentions))
    }

    /// CLI turns: images as files on disk + their paths appended to the prompt.
    func cliImagePaths(_ conv: Conversation, _ payload: [(mime: String, data: String)]) -> [String] {
        ChatSteer.saveTurnImages(conv.id, payload)
    }
}

// MARK: - Retry (commands/prompt.rs retry_last_turn)

extension Store {
    /// last_cli_user_message: (row id, message, resume_before) of the newest user row.
    func lastUserRow(_ conv: String) -> (Int64, JSON, String?)? {
        guard let r = query("""
            SELECT id, message_json, resume_before FROM cli_messages
            WHERE conversation_id = ? AND json_extract(message_json, '$.role') = 'user'
            ORDER BY id DESC LIMIT 1
            """, [.text(conv)]).first,
            let id = r.num("id"), let msg = JSON.parse(r.str("message_json")) else { return nil }
        let resume: String? = { if case .text(let s) = r["resume_before"] { return s }; return nil }()
        return (Int64(id), msg, resume)
    }

    /// delete_cli_messages_from: drop transcript rows from `row` (inclusive) on.
    func deleteMessages(_ conv: String, fromRow row: Int64) {
        _ = run("DELETE FROM cli_messages WHERE conversation_id = ? AND id >= ?", [.text(conv), .int(row)])
    }
}

extension AgentHost {
    func retryPi(_ request: JSON) {
        var r = request
        r["op"] = "retryPi"
        send(r)
    }
}

enum ChatRetry {
    nonisolated(unsafe) static var pending: [String: Int64] = [:]

    /// cli_backend::message_text.
    static func text(_ message: JSON) -> String {
        if let s = message["content"].string { return s }
        return (message["content"].array ?? []).filter { $0["type"].string == "text" }.map { $0["text"].stringValue }.joined(separator: "\n")
    }
}

extension Controller {
    /// Roll back the last turn and resubmit it (the ChatGPT "regenerate"
    /// contract: a failed turn never persists into history). CLI runtimes drop
    /// the rows and rewind the resume token; pi forks its session.
    func retryLastTurn(_ id: String) {
        guard let conv = store.get(id), !chat(id).isStreaming, ChatRetry.pending[id] == nil else { return }
        guard let (row, message, resumeBefore) = store.lastUserRow(id) else {
            chat(id).state.reduce(.setError("nothing to retry: no user message to roll back to"))
            return
        }
        if conv.backend == "pi" {
            ChatRetry.pending[id] = row
            var req: JSON = ["conv": .string(id), "cwd": .string(conv.workspaceDir)]
            if !conv.sessionFile.isEmpty { req["resume"] = .string(conv.sessionFile) }
            host.retryPi(req)
            return
        }
        host.close(id)
        store.update(id, [.sessionFile(resumeBefore ?? "")])
        resubmit(id, fromRow: row, text: ChatRetry.text(message))
    }

    func retryReady(_ m: JSON) {
        guard let id = m["conv"].string, let row = ChatRetry.pending.removeValue(forKey: id) else { return }
        guard m["ok"].truthy else {
            chat(id).state.reduce(.setError(m["error"].string ?? "Retry failed"))
            return
        }
        let text = m["text"].string ?? store.lastUserRow(id).map { ChatRetry.text($0.1) } ?? ""
        resubmit(id, fromRow: row, text: text)
    }

    private func resubmit(_ id: String, fromRow row: Int64, text: String) {
        store.deleteMessages(id, fromRow: row)
        let model = chat(id)
        model.state.reduce(.reset(store.messages(id)))
        guard let conv = store.get(id), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { reload(); return }
        send(SendOptions(conversationId: id, text: text, backend: conv.backend, model: conv.cliModel, effort: conv.cliEffort, workspaceDir: conv.workspaceDir))
    }
}
