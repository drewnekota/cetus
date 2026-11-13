import Foundation

public enum ChatBlock: Hashable, Sendable, Identifiable {
    case text(id: Int, text: String, streaming: Bool)
    case thinking(id: Int, text: String, streaming: Bool)
    /// `name` is empty until the model finishes writing the call. `result`
    /// is `{content, details, isError}`; a tool that is still reporting
    /// progress carries `partial: true` in it.
    case tool(id: Int, callId: String, name: String, arguments: JSON, result: JSON?)
    /// Image bytes as sent (JPEG/PNG), nil when the Mac didn't include them.
    case image(id: Int, data: Data?)

    public var id: Int {
        switch self {
        case .text(let id, _, _), .thinking(let id, _, _), .tool(let id, _, _, _, _), .image(let id, _): id
        }
    }
}

public struct ChatMessage: Identifiable, Hashable, Sendable {
    public enum Role: Sendable { case user, assistant }
    public var id: Int
    public var role: Role
    public var blocks: [ChatBlock]
}

/// Messages + live state of one conversation, built from the history snapshot
/// and kept current by the desktop's streamed `pi_event`s — the same reducer
/// the legacy web client ran, typed.
public struct ChatTimeline: Sendable {
    public private(set) var messages: [ChatMessage] = []
    public private(set) var controls: [ControlRequest] = []
    public var running = false
    /// The Mac sent only the tail of a longer history.
    public private(set) var truncated = false
    /// When the open turn began, for the elapsed-time line.
    public private(set) var turnStartedAt: Date?
    /// Stream events numbered up to this are already part of the snapshot.
    public private(set) var liveSeq = 0
    /// Text blocks a runtime marked as the final answer: never folded.
    public private(set) var finalAnswers: Set<Int> = []
    /// Why the Mac is compacting the context right now, nil when it isn't.
    public private(set) var compacting: String?
    /// A failure the stream reported; the screen takes it with `takeError`.
    private var failure: String?
    private var aborted = false
    private var nextId = 0

    public init() {}

    public enum Effect { case none, refetch }

    public init(snapshot: JSON) {
        controls = (snapshot["pendingControls"].array ?? []).map(ControlRequest.init)
        running = snapshot["conversation"]["runState"].string == "running"
        var results: [String: JSON] = [:]
        let raw = snapshot["messages"].array ?? []
        truncated = (snapshot["totalMessages"].int ?? 0) > raw.count
        for m in raw where m["role"].string == "toolResult" {
            if let id = m["toolCallId"].string { results[id] = m }
        }
        var lastUserAt: Date?
        for m in raw {
            guard m["display"].bool != false else { continue }
            let role: ChatMessage.Role
            switch m["role"].string {
            case "user": role = .user
            case "assistant": role = .assistant
            default: continue
            }
            var blocks: [ChatBlock] = []
            for b in Self.contentBlocks(m) {
                if let block = block(from: b, results: results, isUser: role == .user) { blocks.append(block) }
            }
            if blocks.isEmpty { continue }
            messages.append(ChatMessage(id: newId(), role: role, blocks: blocks))
            if role == .user { lastUserAt = m["timestamp"].number.map { Date(timeIntervalSince1970: $0 / 1000) } }
        }
        if running { turnStartedAt = lastUserAt ?? Date() }
        // The open turn: a CLI runtime's history holds none of it until the
        // turn ends, so the Mac sends its stream events to replay.
        for e in snapshot["liveEvents"].array ?? [] { _ = apply(e) }
        liveSeq = snapshot["liveSeq"].int ?? 0
    }

    private mutating func newId() -> Int {
        nextId += 1
        return nextId
    }

    private static func contentBlocks(_ m: JSON) -> [JSON] {
        if let s = m["content"].string { return [["type": "text", "text": .string(s)]] }
        return m["content"].array ?? []
    }

    private mutating func block(from b: JSON, results: [String: JSON], isUser: Bool) -> ChatBlock? {
        switch b["type"].string {
        case "text":
            var text = b["text"].string ?? ""
            if isUser { text = Self.stripContextFence(text) }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let id = newId()
            if b["phase"].string == "final_answer" { finalAnswers.insert(id) }
            return .text(id: id, text: text, streaming: false)
        case "thinking":
            let t = b["thinking"].string ?? b["text"].string ?? ""
            return t.isEmpty ? nil : .thinking(id: newId(), text: t, streaming: false)
        case "toolCall", "tool_use":
            let callId = b["id"].string ?? ""
            let args = !b["arguments"].isNull ? b["arguments"] : (!b["args"].isNull ? b["args"] : b["input"])
            return .tool(id: newId(), callId: callId, name: b["name"].string ?? "tool", arguments: args, result: results[callId])
        case "image":
            let data = (b["data"].string ?? b["source"]["data"].string).flatMap { Data(base64Encoded: $0) }
            return .image(id: newId(), data: data)
        default:
            return nil
        }
    }

    /// Composer-injected `<context source="cetus-…">…</context>` preambles
    /// are for the model, not for reading back on a phone.
    static func stripContextFence(_ s: String) -> String {
        guard s.hasPrefix("<context source=\"cetus-"), let end = s.range(of: "</context>") else { return s }
        return String(s[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Optimistic echo of what the phone just sent.
    public mutating func appendUser(_ text: String, images: [Data]) {
        var blocks: [ChatBlock] = images.map { .image(id: newId(), data: $0) }
        if !text.isEmpty { blocks.append(.text(id: newId(), text: text, streaming: false)) }
        messages.append(ChatMessage(id: newId(), role: .user, blocks: blocks))
        // A steered follow-up joins the run in progress: its clock keeps going.
        if !running || turnStartedAt == nil { turnStartedAt = Date() }
        running = true
    }

    /// The failure reported since the last call, if any.
    public mutating func takeError() -> String? {
        defer { failure = nil }
        return failure
    }

    public mutating func removeControl(_ key: String) {
        controls.removeAll { $0.requestKey == key }
    }

    /// Applies one `pi_event` payload (the inner `event`).
    public mutating func apply(_ e: JSON) -> Effect {
        switch e["type"].string {
        case "agent_start":
            if !running || turnStartedAt == nil { turnStartedAt = Date() }
            running = true
            aborted = false
        case "compaction_start":
            compacting = e["reason"].string.flatMap { $0.isEmpty ? nil : $0 } ?? "context"
        case "compaction_end":
            compacting = nil
            if e["aborted"].bool == true { failure = "Context compaction failed. The conversation is unchanged." }
        case "agent_end":
            // A retrying run (auto-retry, compaction, queued follow-up) goes
            // on by itself; `agent_settled` ends it.
            if e["willRetry"].bool == true { break }
            settle()
            return .refetch
        case "agent_settled":
            guard running else { break }
            settle()
            return .refetch
        case "cli_control_request":
            let c = ControlRequest(e)
            if !controls.contains(where: { $0.requestKey == c.requestKey }) { controls.append(c) }
        case "cli_control_resolved":
            removeControl(e["requestId"].compactText)
        case "message_start":
            switch e["message"]["role"].string {
            case "assistant":
                messages.append(ChatMessage(id: newId(), role: .assistant, blocks: []))
            case "user":
                // A steered follow-up or a prompt the Mac started by itself.
                // What the phone sent is already on screen as the last row.
                if messages.last?.role == .user { break }
                var blocks: [ChatBlock] = []
                for b in Self.contentBlocks(e["message"]) {
                    if let block = block(from: b, results: [:], isUser: true) { blocks.append(block) }
                }
                if !blocks.isEmpty { messages.append(ChatMessage(id: newId(), role: .user, blocks: blocks)) }
            default:
                break
            }
        case "message_end":
            stopStreams(last: 1)
        case "message_update":
            let inner = e["assistantMessageEvent"]
            // The user's own Stop arrives as an error event.
            if inner["type"].string == "error", inner["reason"].string == "aborted" { aborted = true }
            delta(inner)
        case "tool_execution_update":
            let partial = e["partialResult"]
            attach(
                result: ["content": partial["content"], "details": partial["details"], "partial": true],
                to: e["toolCallId"].string ?? "")
        case "tool_execution_end":
            let result = e["result"]
            attach(
                result: ["content": result["content"], "details": result["details"], "isError": e["isError"]],
                to: e["toolCallId"].string ?? "")
        default:
            break
        }
        return .none
    }

    private mutating func settle() {
        // A turn that ends with thinking only, or nothing, produced no
        // answer: say so instead of stopping on a blank reply.
        var sawAssistant = false
        var hasContent = false
        for m in messages.reversed() {
            if m.role == .user { break }
            sawAssistant = true
            hasContent = m.blocks.contains { b in
                switch b {
                case .text(_, let t, _): !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                case .tool, .image: true
                case .thinking: false
                }
            }
            if hasContent { break }
        }
        if running, sawAssistant, !hasContent, !aborted {
            failure = "The model returned an empty response — no answer was produced. Tap Retry to try again."
        }
        compacting = nil
        running = false
        turnStartedAt = nil
        controls.removeAll()
        stopStreams(last: .max)
    }

    /// Clears the streaming flags of the trailing assistant messages.
    private mutating func stopStreams(last count: Int) {
        var left = count
        for mi in messages.indices.reversed() {
            guard messages[mi].role == .assistant, left > 0 else { break }
            left -= 1
            messages[mi].blocks = messages[mi].blocks.map { b in
                switch b {
                case .text(let id, let t, true): .text(id: id, text: t, streaming: false)
                case .thinking(let id, let t, true): .thinking(id: id, text: t, streaming: false)
                default: b
                }
            }
        }
    }

    private mutating func lastAssistantIndex() -> Int {
        if let i = messages.lastIndex(where: { $0.role == .assistant }), i == messages.count - 1 { return i }
        messages.append(ChatMessage(id: newId(), role: .assistant, blocks: []))
        return messages.count - 1
    }

    private mutating func delta(_ d: JSON) {
        guard let type = d["type"].string else { return }
        let mi = lastAssistantIndex()
        let i = d["contentIndex"].int ?? 0
        var blocks = messages[mi].blocks
        while blocks.count <= i { blocks.append(.text(id: newId(), text: "", streaming: false)) }
        let id = blocks[i].id
        if d["phase"].string == "final_answer" { finalAnswers.insert(id) }
        switch type {
        case "text_start":
            blocks[i] = .text(id: id, text: "", streaming: true)
        case "text_delta":
            if case .text(_, let t, _) = blocks[i] {
                blocks[i] = .text(id: id, text: t + (d["delta"].string ?? ""), streaming: true)
            } else {
                blocks[i] = .text(id: id, text: d["delta"].string ?? "", streaming: true)
            }
        case "text_end":
            blocks[i] = .text(id: id, text: d["content"].string ?? blocks[i].plainText, streaming: false)
        case "thinking_start":
            blocks[i] = .thinking(id: id, text: "", streaming: true)
        case "thinking_delta":
            if case .thinking(_, let t, _) = blocks[i] {
                blocks[i] = .thinking(id: id, text: t + (d["delta"].string ?? ""), streaming: true)
            } else {
                blocks[i] = .thinking(id: id, text: d["delta"].string ?? "", streaming: true)
            }
        case "thinking_end":
            blocks[i] = .thinking(id: id, text: d["content"].string ?? blocks[i].plainText, streaming: false)
        case "toolcall_start":
            // The id and name land on toolcall_end; hold the row meanwhile.
            blocks[i] = .tool(id: id, callId: "", name: "", arguments: .null, result: nil)
        case "toolcall_end":
            let call = d["toolCall"]
            blocks[i] = .tool(
                id: id,
                callId: call["id"].string ?? "",
                name: call["name"].string ?? "tool",
                arguments: !call["arguments"].isNull ? call["arguments"] : call["args"],
                result: nil
            )
        default:
            return
        }
        messages[mi].blocks = blocks
    }

    private mutating func attach(result: JSON, to callId: String) {
        for mi in messages.indices.reversed() {
            if let bi = messages[mi].blocks.firstIndex(where: {
                if case .tool(_, let c, _, _, _) = $0 { return c == callId }
                return false
            }) {
                if case .tool(let id, let c, let name, let args, _) = messages[mi].blocks[bi] {
                    messages[mi].blocks[bi] = .tool(id: id, callId: c, name: name, arguments: args, result: result)
                }
                return
            }
        }
    }
}

extension ChatBlock {
    var plainText: String {
        switch self {
        case .text(_, let t, _), .thinking(_, let t, _): t
        default: ""
        }
    }
}

extension JSON {
    /// Text of a tool result (`{content: string | [{text}]}` or anything).
    public var toolResultText: String {
        let c = self["content"]
        if let s = c.string { return s }
        if let a = c.array {
            return a.map { $0["type"].string == "text" || $0["type"].isNull ? ($0["text"].string ?? "") : "[\($0["type"].string ?? "")]" }
                .joined(separator: "\n")
        }
        return ""
    }

    /// One-line preview of tool arguments: the field that says what the
    /// call did, flattened (the desktop's `summarizeArgs`).
    public var argumentPreview: String {
        func flat(_ s: String) -> String {
            s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        }
        let value = parsedArguments
        if let s = value.string { return flat(s) }
        guard let obj = value.object else { return value.isNull ? "" : flat(value.compactText) }
        for key in ["command", "cmd", "path", "file", "file_path", "query", "url", "pattern", "name"] {
            if let s = obj[key]?.string, !flat(s).isEmpty { return flat(s) }
        }
        for key in obj.keys.sorted() {
            if let s = obj[key]?.string, !flat(s).isEmpty { return flat(s) }
        }
        return ""
    }

    /// Tool arguments as an object even when a runtime sent them as a JSON
    /// string.
    public var parsedArguments: JSON {
        if let s = string, let data = s.data(using: .utf8), let parsed = try? JSON.parse(data),
           parsed.object != nil { return parsed }
        return self
    }
}
