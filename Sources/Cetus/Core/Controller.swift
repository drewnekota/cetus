import AppKit
import Foundation
import Observation

/// The app's agent backend, in-process: conversations in SQLite, runtimes in
/// `cetus-agentd`, and per-conversation `ChatState` folded by the reducer.
///
/// Mirrors the Tauri host's turn flow (cli_backend/turns.rs): persist the user
/// row first, replay the transcript as a handoff preamble when there is no
/// resume token, keep the resume token only when content streamed, and drop it
/// when the runtime rejected it.

struct Attachment: Identifiable, Equatable, Hashable {
    var path: String
    var name: String
    var mimeType: String
    var size: Int
    var id: String { path }
    var isImage: Bool { mimeType.hasPrefix("image/") }

    static let maxBytes = 25 * 1024 * 1024
    static let imageTypes = ["png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"]

    /// An attachment for `path`, or a reason it can't be attached.
    static func make(_ path: String) -> Result<Attachment, AttachError> {
        let url = URL(fileURLWithPath: path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { return .failure(.init("\(url.lastPathComponent) could not be read")) }
        if isDir.boolValue { return .failure(.init("\(url.lastPathComponent) is a folder")) }
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        if size > maxBytes { return .failure(.init("\(url.lastPathComponent) is larger than 25 MB")) }
        let mime = imageTypes[url.pathExtension.lowercased()] ?? "application/octet-stream"
        return .success(Attachment(path: path, name: url.lastPathComponent, mimeType: mime, size: size))
    }
}

struct AttachError: Error { let message: String; init(_ m: String) { message = m } }

struct Queued: Identifiable, Equatable {
    var id = UUID().uuidString
    var text: String
    var attachments: [Attachment]
    var mentions: [MentionRef]
}

struct ContextUsage: Equatable { var used: Double; var window: Double }

/// One conversation's live state: the reduced transcript plus the side
/// channels Cetus keeps per conversation.
@Observable
final class ChatModel {
    let id: String
    /// Changes on every streamed delta: only the transcript should read it.
    /// Chrome around it (composer, footer, header) reads the flags below,
    /// which change only when their value does.
    var state = ChatState() {
        didSet {
            revision &+= 1
            if streaming != state.isStreaming { streaming = state.isStreaming }
            if compacting != state.isCompacting { compacting = state.isCompacting }
            // Mid-turn only the tail can gain one; a full walk when idle (reset, turn end).
            let scan = state.isStreaming ? state.messages.suffix(2) : state.messages[...]
            let found = scan.contains { m in m.blocks.contains { b in b.kind == .toolUse && b.result.map { !ArtifactDetails.from($0.details).isEmpty } == true } }
            let artifacts = state.isStreaming ? hasArtifacts || found : found
            if hasArtifacts != artifacts { hasArtifacts = artifacts }
        }
    }
    /// Bumped on every state change (not observed): memo key for derived layouts.
    @ObservationIgnored private(set) var revision = 0
    private(set) var streaming = false
    private(set) var compacting = false
    private(set) var hasArtifacts = false
    var controls: [JSON] = []
    var commands: [SlashCommand] = []
    var context: ContextUsage?
    var background: [JSON] = []
    /// Wall clock (ms) of the running turn's start; nil when idle.
    var startedAt: Double?
    /// Duration of the last finished turn, for "Worked for Xs".
    var lastDurationMs: Double?
    var queue: [Queued] = []

    init(id: String) { self.id = id }

    var isStreaming: Bool { streaming }
}

struct SendOptions {
    var conversationId: String?
    var text: String
    var backend: String
    var model: String
    var effort: String
    var workspaceDir: String
    var attachments: [Attachment] = []
    var mentions: [MentionRef] = []
    var title: String?
    var sourceAutomationId: String?
}

@Observable
final class Controller {
    @ObservationIgnored let store: Store
    @ObservationIgnored let prefStore: PrefStore
    @ObservationIgnored let host = AgentHost()
    @ObservationIgnored private var chats: [String: ChatModel] = [:]
    @ObservationIgnored private var steering = Set<String>()
    @ObservationIgnored private var scheduler: Timer?
    /// The conversation on screen: finishing it doesn't mark it unread.
    @ObservationIgnored private var visible: String?

    var conversations: [Conversation] = []
    var archived: [Conversation] = []
    var automations: [Automation] = []
    var rateLimits: [String: JSON] = [:]
    /// Per runtime: the CLI's configured model/effort and live catalog (nil until loaded).
    var cliDefaults: [String: CliDefaults] = [:]
    @ObservationIgnored private var cliDefaultsRequested: Set<String> = []
    @ObservationIgnored private var previewCache: [String: (Double, String?)] = [:]
    var prefs: Prefs
    /// Bumped whenever a conversation's running/unread status changes, so the sidebar refreshes.
    var revision = 0

    init(dataDir: URL = Env.dataDir) {
        store = Store(dataDir: dataDir)
        prefStore = PrefStore(dataDir: dataDir)
        prefs = prefStore.value
        prefStore.onChange = { [weak self] in
            guard let self else { return }
            self.prefs = self.prefStore.value
        }
        host.onMessage = { [weak self] m in self?.onHost(m) }
        host.start()
        startAgentSync()
        reload()
    }

    func reload() {
        conversations = store.list()
        archived = store.archived()
        automations = store.automations()
        revision += 1
    }

    func setPrefs(_ mutate: (inout Prefs) -> Void) { prefStore.set(mutate) }

    func chat(_ id: String) -> ChatModel {
        if let c = chats[id] { return c }
        let c = ChatModel(id: id)
        c.state.reduce(.reset(store.messages(id)))
        chats[id] = c
        return c
    }

    /// The chat model when already loaded; never reads the transcript from disk.
    func chatIfLoaded(_ id: String) -> ChatModel? { chats[id] }

    func conversation(_ id: String?) -> Conversation? {
        guard let id else { return nil }
        // Archived chats too, before the db: bodies call this on every keystroke.
        return conversations.first { $0.id == id } ?? archived.first { $0.id == id } ?? store.get(id)
    }

    func setVisible(_ id: String?) {
        visible = id
        if let id, store.get(id)?.unread == true {
            store.update(id, [.unread(false)])
            reload()
        }
    }

    // MARK: - Turns

    /// Start a turn, or queue it behind the running one. Returns the conversation id.
    @discardableResult
    func send(_ o: SendOptions) -> String {
        let text = o.text.trimmingCharacters(in: .whitespacesAndNewlines)
        var conv = o.conversationId.flatMap { store.get($0) }
        if conv == nil {
            // Untitled until the first send paints a placeholder + asks for an AI title (titleOnSend).
            conv = store.create(title: o.title ?? "", workspaceDir: o.workspaceDir, backend: o.backend, model: o.model, effort: o.effort, sourceAutomationId: o.sourceAutomationId)
        } else if let c = conv, c.backend != o.backend || c.cliModel != o.model || c.cliEffort != o.effort {
            // A runtime switch loses the old runtime's session; the transcript is
            // replayed instead. A model/effort switch only respawns the process.
            let switched = c.backend != o.backend
            if switched {
                let from = Runtimes.byId(c.backend).label, to = Runtimes.byId(o.backend).label
                store.append(c.id, ["role": "custom", "customType": "runtime_switch", "content": [["type": "text", "text": .string("\(from) → \(to)")]], "details": ["from": .string(from), "to": .string(to)]])
                chat(c.id).state.reduce(.runtimeSwitch(from: from, to: to))
                chat(c.id).commands = []
                chat(c.id).context = nil
            }
            var fields: [Store.Field] = [.backend(o.backend), .model(o.model), .effort(o.effort)]
            if switched { fields.append(.sessionFile("")) }
            store.update(c.id, fields)
            conv = store.get(c.id)
        }
        guard let conv else { return "" }
        if conv.archivedAt != nil { store.update(conv.id, [.archivedAt(nil)]) }
        let model = chat(conv.id)
        if model.isStreaming {
            model.queue.append(Queued(text: text, attachments: o.attachments, mentions: o.mentions))
            reload()
            return conv.id
        }
        startTurn(conv, text: text, attachments: o.attachments, mentions: o.mentions)
        return conv.id
    }

    private func startTurn(_ conv: Conversation, text: String, attachments: [Attachment], mentions: [MentionRef]) {
        let images = attachments.filter(\.isImage)
        let files = attachments.filter { !$0.isImage }
        var transcripts: [String: String] = [:]
        for ref in mentions where ref.kind == .conversation {
            if let path = exportTranscript(ref.id) { transcripts[ref.label] = path }
        }
        // What the model reads; the reducer strips both blocks off the bubble.
        let outgoing = text + Mentions.build(mentions, transcripts: transcripts) + Attachments.build(files.map { ($0.name, $0.path) })
        titleOnSend(conv, outgoing: outgoing)
        var prompt = outgoing
        if conv.sessionFile.isEmpty, let preamble = Handoff.preamble(store.messages(conv.id)) {
            prompt = "\(preamble)\n\n\(outgoing)"
        }
        let payload: [(mime: String, data: String, path: String, name: String)] = images.compactMap { a in
            guard let d = try? Data(contentsOf: URL(fileURLWithPath: a.path)) else { return nil }
            return (a.mimeType, d.base64EncodedString(), a.path, a.name)
        }
        var content: [JSON] = [["type": "text", "text": .string(outgoing)]]
        for i in payload { content.append(["type": "image", "mimeType": .string(i.mime), "data": .string(i.data)]) }
        store.append(conv.id, ["role": "user", "content": .array(content)], resumeBefore: conv.sessionFile)
        store.update(conv.id, [.runState(.running)])
        let model = chat(conv.id)
        model.state.reduce(.userSent(
            text: text,
            images: payload.map { ($0.data, $0.mime, $0.name) },
            files: files.map { ($0.name, $0.path, $0.mimeType, $0.size) }))
        model.startedAt = nowMs()
        // CLI turns get the images as files too, their paths riding the prompt (save_turn_images).
        let imagePaths = conv.backend == "pi" ? payload.map(\.path) : cliImagePaths(conv, payload.map { ($0.mime, $0.data) })
        if conv.backend != "pi" { prompt += ChatSteer.imagePathRefs(imagePaths) }
        var request: JSON = [
            "conv": .string(conv.id),
            "backend": .string(conv.backend),
            "cwd": .string(conv.workspaceDir),
            "prompt": .string(prompt),
            "bypass": .bool(prefs.bypassApprovals),
            "images": .array(zip(payload, imagePaths.count == payload.count ? imagePaths : payload.map(\.path)).map { p, path in ["mimeType": .string(p.mime), "data": .string(p.data), "path": .string(path)] }),
        ]
        if !conv.cliModel.isEmpty { request["model"] = .string(conv.cliModel) }
        if !conv.cliEffort.isEmpty { request["effort"] = .string(conv.cliEffort) }
        if !conv.sessionFile.isEmpty { request["resume"] = .string(conv.sessionFile) }
        CLIServer.decorate(&request, backend: conv.backend, firstTurn: conv.sessionFile.isEmpty)
        host.turn(request)
        reload()
    }

    /// A conversation mention hands the model a Markdown export of that transcript.
    func exportTranscript(_ id: String) -> String? {
        guard let conv = store.get(id) else { return nil }
        var lines = ["# \(conv.title)", ""]
        for m in chat(id).state.messages {
            let text = m.blocks.compactMap { b -> String? in
                b.kind == .text ? b.text : b.kind == .toolUse ? "[tool: \(b.name)]" : nil
            }.filter { !$0.isEmpty }.joined(separator: "\n\n")
            if !text.isEmpty { lines += ["## \(m.role.rawValue)", "", text, ""] }
        }
        let dir = Env.dataDir.appendingPathComponent("exports")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("\(id).md")
        try? lines.joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }

    /// Load a runtime's CLI defaults once per launch (the probe takes a few seconds).
    func loadCliDefaults(_ backend: String) {
        guard Runtimes.tunable(backend), !cliDefaultsRequested.contains(backend) else { return }
        cliDefaultsRequested.insert(backend)
        host.cliDefaults(backend)
    }

    func abort(_ id: String) { host.abort(id) }

    /// Bash mode (`!cmd`): run locally in the workspace and log a bash card.
    @discardableResult
    func runBash(_ o: SendOptions) -> String {
        let command = o.text
        let conv = o.conversationId.flatMap { store.get($0) }
            ?? store.create(title: Titling.derive("!\(command)"), workspaceDir: o.workspaceDir, backend: o.backend, model: o.model, effort: o.effort)
        let id = conv.id
        let key = "bash-\(String(Int(nowMs()), radix: 36))"
        let cwd = conv.workspaceDir.isEmpty ? o.workspaceDir : conv.workspaceDir
        chat(id).state.reduce(.bashStart(key: key, command: command, cwd: cwd))
        reload()
        let shell = Env.shell["SHELL"] ?? "/bin/zsh"
        DispatchQueue.global().async {
            let p = Process()
            let shownCwd = RemoteWorkspace.configureBash(p, command: command, cwd: cwd, shell: shell)
            p.environment = Env.shell
            let out = Pipe(), err = Pipe()
            p.standardOutput = out
            p.standardError = err
            p.standardInput = FileHandle.nullDevice
            var stdout = Data(), stderr = Data()
            let group = DispatchGroup()
            group.enter(); DispatchQueue.global().async { stdout = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
            group.enter(); DispatchQueue.global().async { stderr = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
            var timedOut = false
            do { try p.run() } catch {}
            let timer = DispatchWorkItem { timedOut = true; p.terminate() }
            DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: timer)
            p.waitUntilExit()
            timer.cancel()
            group.wait()
            let result: JSON = [
                "stdout": .string(String(String(decoding: stdout, as: UTF8.self).suffix(100_000))),
                "stderr": .string(String(String(decoding: stderr, as: UTF8.self).suffix(20_000))),
                "exitCode": .number(timedOut ? -1 : Double(p.terminationStatus)),
                "timedOut": .bool(timedOut),
                "cwd": .string(shownCwd),
            ]
            DispatchQueue.main.async {
                self.store.append(id, ["role": "custom", "customType": "bash_exec", "content": [["type": "text", "text": .string(command)]], "details": ["status": "done", "result": result]])
                self.chat(id).state.reduce(.bashDone(key: key, result: result))
                self.reload()
            }
        }
        return id
    }

    /// Send a queued message now: stop the running turn, then run it first.
    func steer(_ id: String, queuedId: String) {
        let model = chat(id)
        guard let item = model.queue.first(where: { $0.id == queuedId }) else { return }
        if model.isStreaming, let conv = store.get(id), ChatSteer.supports(conv.backend) {
            model.queue.removeAll { $0.id == queuedId }
            steerIntoRun(conv, item)
            return
        }
        model.queue = [item] + model.queue.filter { $0.id != queuedId }
        if model.isStreaming {
            steering.insert(id)
            host.abort(id)
        } else {
            drainQueue(id)
        }
    }

    @discardableResult
    func unqueue(_ id: String, queuedId: String) -> Queued? {
        let model = chat(id)
        let item = model.queue.first { $0.id == queuedId }
        model.queue.removeAll { $0.id == queuedId }
        return item
    }

    private func drainQueue(_ id: String) {
        let model = chat(id)
        guard let next = model.queue.first, let conv = store.get(id) else { return }
        model.queue.removeFirst()
        startTurn(conv, text: next.text, attachments: next.attachments, mentions: next.mentions)
    }

    /// Re-send the last user message (the inline error row's Retry).
    func retry(_ id: String) { retryLastTurn(id) }


    /// New conversation holding this one's transcript through user turn `turn`.
    func fork(_ id: String, turn: Int) -> String? {
        guard let conv = store.get(id) else { return nil }
        let copy = store.create(title: "\(conv.title) (fork)", workspaceDir: conv.workspaceDir, backend: conv.backend, model: conv.cliModel, effort: conv.cliEffort)
        let rows = store.messages(id)
        var users = -1
        var through = rows.count - 1
        for (i, r) in rows.enumerated() where r["role"].string == "user" {
            users += 1
            if users == turn + 1 { through = i - 1; break }
        }
        store.copyMessages(from: id, to: copy.id, throughIndex: through)
        reload()
        return copy.id
    }

    func rename(_ id: String, _ title: String) { store.update(id, [.title(title)]); reload() }
    func setPinned(_ id: String, _ pinned: Bool) { store.update(id, [.pinnedAt(pinned ? nowMs() : nil)]); reload() }
    func setUnread(_ id: String, _ unread: Bool) { store.update(id, [.unread(unread)]); reload() }

    func archive(_ id: String) {
        host.close(id)
        store.update(id, [.archivedAt(nowMs()), .pinnedAt(nil)])
        reload()
    }

    /// set_workspace: move a chat to another folder; its runtime was spawned
    /// with the old cwd, so drop it and let the next turn respawn there.
    func setWorkspace(_ id: String, _ dir: String) {
        if !dir.hasPrefix("ssh://"), dir.range(of: #"^[^/:\s]+@?[^/:\s]+:"#, options: .regularExpression) == nil {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }
        store.update(id, [.workspaceDir(dir), .updatedAt(nowMs())])
        host.close(id)
        reload()
    }

    func restore(_ id: String) { store.update(id, [.archivedAt(nil)]); reload() }

    func delete(_ id: String) {
        host.close(id)
        forgetConversationAgent(id)
        store.delete(id)
        chats.removeValue(forKey: id)
        reload()
    }

    /// Board "Approve": the pending review is accepted and the card drops to Done.
    func approveReview(_ id: String) {
        store.update(id, [.reviewState("approved")])
        reload()
    }

    /// Board card preview, cached per conversation and refreshed when it changes.
    func lastReply(_ c: Conversation) -> String? {
        if let hit = previewCache[c.id], hit.0 == c.updatedAt { return hit.1 }
        let p = store.lastReplyPreview(c.id)
        previewCache[c.id] = (c.updatedAt, p)
        return p
    }

    /// Clear a stopped or interrupted state (Kanban approve, banner dismiss).
    func markIdle(_ id: String) {
        store.update(id, [.runState(.idle), .unread(false)])
        chat(id).state.reduce(.setError(nil))
        reload()
    }

    /// Answer a control request and drop its card.
    func respondToControl(_ id: String, request: JSON, response: JSON) {
        host.control(id, requestId: request["requestId"], response: response)
        chat(id).controls.removeAll { $0["requestId"] == request["requestId"] }
    }

    // MARK: - Host events

    private func onHost(_ m: JSON) {
        AppShell.hostMessage(m)
        let conv = m["conv"].string
        switch m["type"].string {
        case "event":
            if let conv { onEvent(conv, m["event"]) }
        case "turn_done":
            settle(m)
        case "error":
            if let conv { chat(conv).state.reduce(.setError(m["message"].stringValue)) }
        case "exited":
            if let conv { chat(conv).background = [] }
        case "cli_defaults":
            let d = m["defaults"]
            let models = d["models"].array?.compactMap { e -> Option? in
                guard let id = e["id"].string else { return nil }
                return .init(id: id, label: e["label"].string ?? id)
            }
            cliDefaults[m["backend"].stringValue] = CliDefaults(model: d["model"].string, effort: d["effort"].string, models: models)
        case "title": applyGeneratedTitle(m)
        case "steered": steerResult(m)
        case "retry_ready": retryReady(m)
        case "host_request": handleHostRequest(m)
        case "settings_changed": hostSettingsChanged(m)
        case "host_exited":
            for (id, c) in chats where c.isStreaming {
                c.state.reduce(.setError("The agent host exited unexpectedly."))
                c.state.reduce(.endStream(keepPartial: true))
                store.update(id, [.runState(.interrupted)])
            }
            reload()
        default: break
        }
    }

    private func onEvent(_ id: String, _ event: JSON) {
        let model = chat(id)
        switch event["type"].string ?? "" {
        case "cli_rate_limit":
            if !event["info"].isNull { rateLimits[event["backend"].string ?? "claude-code"] = event["info"] }
        case "cli_context_usage":
            if let used = event["usedTokens"].double, let window = event["contextWindow"].double, window > 0 {
                model.context = ContextUsage(used: max(0, used), window: window)
            }
        case "cli_commands":
            model.commands = (event["commands"].array ?? []).map {
                SlashCommand(name: $0["name"].stringValue, description: $0["description"].stringValue, argumentHint: $0["argumentHint"].stringValue, kind: $0["kind"].string ?? "command")
            }
        case "cli_background_tasks":
            model.background = event["tasks"].array ?? []
        case "cli_control_request":
            model.controls.append(event)
        case "cli_control_resolved":
            model.controls.removeAll { $0["requestId"] == event["requestId"] }
        case "extension_ui_request":
            MainActor.assumeIsolated { ChatExtensionDialogs.observe(conv: id, event: event, controller: self) }
        default:
            if event["type"].string == "agent_end" { model.controls = [] }
            model.state.reduce(.piEvent(event))
        }
    }

    private func settle(_ done: JSON) {
        guard let id = done["conv"].string, let conv = store.get(id) else { return }
        store.transaction { for m in done["messages"].array ?? [] { store.append(id, m) } }
        let aborted = done["aborted"].truthy
        let streamed = done["streamed"].truthy
        var sessionFile = conv.sessionFile
        if done["resumeRejected"].truthy { sessionFile = "" }
        else if streamed, let r = done["resumeId"].string, !r.isEmpty { sessionFile = r }
        var fields: [Store.Field] = [.sessionFile(sessionFile), .runState(aborted ? .aborted : .idle), .updatedAt(nowMs())]
        // An agent that called request_review hands the task to the user (board "Needs review").
        let requestedReview = (done["messages"].array ?? []).contains { m in
            (m["content"].array ?? []).contains { b in b["type"].string == "toolCall" && b["name"].string == "request_review" }
        }
        if requestedReview { fields.append(.reviewState("pending")) }
        if visible != id && !aborted { fields.append(.unread(true)) }
        store.update(id, fields)
        let model = chat(id)
        let error = done["error"].string
        if let error, !streamed { model.state.reduce(.setError(error)) }
        if model.isStreaming { model.state.reduce(.endStream(keepPartial: true)) }
        if let started = model.startedAt { model.lastDurationMs = nowMs() - started }
        model.startedAt = nil
        model.controls = []
        let steered = steering.remove(id) != nil
        if !aborted || steered { drainQueue(id) }
        reload()
    }

    // MARK: - Automations

    // Cetus's automation_api / scheduler semantics live in AutomationScheduler.swift.
    func saveAutomation(_ a: Automation) {
        if let old = store.automations().first(where: { $0.id == a.id }), old.enabled != a.enabled {
            AutomationScheduler.setEnabled(self, id: a.id, a.enabled)
        } else {
            let input = AutomationInput(name: a.name, prompt: a.prompt, workspaceDir: a.workspaceDir, backend: a.backend, model: a.model, effort: a.effort, schedule: a.schedule, enabled: a.enabled)
            _ = store.automations().contains { $0.id == a.id } ? AutomationScheduler.update(self, id: a.id, input) : AutomationScheduler.create(self, input)
        }
    }
    func deleteAutomation(_ id: String) { AutomationScheduler.delete(self, id: id) }

    @discardableResult
    func runAutomation(_ id: String) -> String? { try? AutomationScheduler.runNow(self, id: id).get() }

    func startScheduler() { AutomationScheduler.start(self) }

    /// Kept for callers; the persisted `Automation.nextRunAt` is authoritative.
    static func nextRun(_ s: Schedule, lastRunAt: Double?, createdAt: Double) -> Double? { s.initialNextRun(nowMs()) }

    func dispose() {
        scheduler?.invalidate()
        prefStore.flush()
        host.dispose()
    }
}

struct CliDefaults: Equatable {
    var model: String?
    var effort: String?
    var models: [Option]?

    /// cliModelCatalog: the live list when the CLI reported one, else the static fallback.
    func catalog(_ r: Runtime) -> [Option] { r.id == "dsh" ? r.models : models ?? r.models }

    /// resolveDefaultEntry: exact id, then the alias family contained in a full id.
    static func resolveDefault(_ raw: String?, _ catalog: [Option]) -> Option? {
        guard let raw, !raw.isEmpty else { return nil }
        if let exact = catalog.first(where: { !$0.id.isEmpty && $0.id == raw }) { return exact }
        return catalog.first { m in
            let family = String(m.id.split(separator: "[").first ?? "")
            return !family.isEmpty && raw.contains(family)
        }
    }

    /// findCatalogModel: exact, then family match (a persisted alias vs. a live full id).
    static func find(_ selected: String, _ catalog: [Option]) -> Option? {
        if let exact = catalog.first(where: { $0.id == selected }) { return exact }
        guard !selected.isEmpty else { return nil }
        let family = String(selected.split(separator: "[").first ?? "").lowercased()
        let byFamily = catalog.first { m in
            let id = String(m.id.split(separator: "[").first ?? "").lowercased()
            return id.contains(family) || family.contains(m.label.lowercased())
        }
        return byFamily ?? findClaudeRelease(family, catalog)
    }

    /// resolveCliModel: a persisted id resolves only against the catalog (an
    /// unmatched id is what spawns, so it is shown raw); the CLI's default only
    /// when nothing is persisted.
    static func resolve(_ selected: String, _ catalog: [Option], _ defaults: CliDefaults?) -> Option? {
        selected.isEmpty ? resolveDefault(defaults?.model, catalog) : find(selected, catalog)
    }

    /// findClaudeRelease: a full Claude id the catalog lists only under a
    /// floating alias ("claude-fable-5-1[1m]" vs `fable` "Fable 5.1") — the row
    /// labelled with that tier and version, else the tier's bare alias row.
    private static func findClaudeRelease(_ family: String, _ catalog: [Option]) -> Option? {
        guard let m = family.firstMatch(of: /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-|$)/) else { return nil }
        let want = "\(m.1) \(m.3.map { "\(m.2).\($0)" } ?? String(m.2))"
        func label(_ o: Option) -> String {
            (o.label.components(separatedBy: " (").first ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        }
        return catalog.first { label($0) == want }
            ?? catalog.first { String($0.id.split(separator: "[").first ?? "").lowercased() == m.1 }
    }
}
