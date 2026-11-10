import Foundation

public enum ChatBlock: Hashable, Sendable, Identifiable {
    case text(id: Int, text: String, streaming: Bool)
    case thinking(id: Int, text: String, streaming: Bool)
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
        }
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
            return .text(id: newId(), text: text, streaming: false)
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
        running = true
    }

    public mutating func removeControl(_ key: String) {
        controls.removeAll { $0.requestKey == key }
    }

    /// Applies one `pi_event` payload (the inner `event`).
    public mutating func apply(_ e: JSON) -> Effect {
        switch e["type"].string {
        case "agent_start":
            running = true
        case "agent_end":
            running = false
            controls.removeAll()
            return .refetch
        case "cli_control_request":
            let c = ControlRequest(e)
            if !controls.contains(where: { $0.requestKey == c.requestKey }) { controls.append(c) }
        case "cli_control_resolved":
            removeControl(e["requestId"].compactText)
        case "message_start" where e["message"]["role"].string == "assistant":
            messages.append(ChatMessage(id: newId(), role: .assistant, blocks: []))
        case "message_update":
            delta(e["assistantMessageEvent"])
        case "tool_execution_end":
            attach(result: e["result"], to: e["toolCallId"].string ?? "")
        default:
            break
        }
        return .none
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
        while blocks.count <= i { blocks.append(.text(id: newId(), text: "", streaming: true)) }
        let id = blocks[i].id
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
        if let a = c.array { return a.compactMap { $0["text"].string }.joined(separator: "\n") }
        return isNull ? "" : prettyText
    }

    /// One-line preview of tool arguments.
    public var argumentPreview: String {
        for key in ["command", "path", "file_path", "pattern", "query", "url", "description"] {
            if let s = self[key].string { return s }
        }
        if let first = object?.values.first { return first.compactText }
        return ""
    }
}
