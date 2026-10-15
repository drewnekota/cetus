import Foundation

/// Port of Cetus's `chat-state.ts`: folds pi streaming events into rendered
/// messages. Assistant blocks are indexed by pi's `contentIndex`; tool
/// execution events only carry a `toolCallId`, so a side table maps it to
/// (message, block).

struct ToolResult: Equatable {
    var content: [JSON]
    var details: JSON
    var isError: Bool

    var text: String {
        content.compactMap { $0["type"].string == "text" ? $0["text"].string : nil }.joined(separator: "\n")
    }
}

enum BlockKind: String, Equatable { case text, thinking, toolUse, image, file, custom }

struct Block: Equatable {
    var kind: BlockKind
    var text = ""
    var streaming = false
    var phase: String?
    /// Mention labels declared by the prompt's `<cetus-mentions>` block.
    var mentions: [String] = []
    // tool_use
    var toolId = ""
    var name = ""
    var args: JSON = .null
    var result: ToolResult?
    // image (base64 payload) / file
    var data: String?
    var mimeType = ""
    var path = ""
    var sizeBytes = 0
    // custom
    var customType = ""
    var details: JSON = .null

    static func text(_ t: String, streaming: Bool = false) -> Block { Block(kind: .text, text: t, streaming: streaming) }
    static func thinking(_ t: String, streaming: Bool = false) -> Block { Block(kind: .thinking, text: t, streaming: streaming) }
    static func custom(_ type: String, _ text: String, details: JSON = .null) -> Block {
        Block(kind: .custom, text: text, customType: type, details: details)
    }
}

enum Role: String, Equatable { case user, assistant, custom, tool, system }

struct RenderedMessage: Equatable, Identifiable {
    var key: String
    var role: Role
    var blocks: [Block]
    /// Epoch milliseconds.
    var createdAt: Double
    var raw: JSON? = nil
    var id: String { key }

    var plainText: String {
        blocks.compactMap { $0.kind == .text ? $0.text : nil }.joined(separator: "\n")
    }
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func genKey(_ prefix: String) -> String {
    "\(prefix)-\(String(Int(nowMs()), radix: 36))-\(String(UInt32.random(in: 0 ... UInt32.max), radix: 36))"
}

enum ChatAction {
    case reset([JSON]?)
    case userSent(text: String, images: [(data: String, mimeType: String, name: String)], files: [(name: String, path: String, mimeType: String, size: Int)])
    case piEvent(JSON)
    case setError(String?)
    case endStream(keepPartial: Bool)
    case bashStart(key: String, command: String, cwd: String?)
    case bashDone(key: String, result: JSON)
    case runtimeSwitch(from: String, to: String)
}

struct ChatState: Equatable {
    var messages: [RenderedMessage] = []
    var activeAssistantIdx: Int?
    var toolIndex: [String: (messageIdx: Int, blockIdx: Int)] = [:]
    var isStreaming = false
    var isCompacting = false
    var compactionReason: String?
    var awaitingAssistant = false
    var error: String?
    var aborted = false

    static func == (a: ChatState, b: ChatState) -> Bool {
        a.messages == b.messages && a.isStreaming == b.isStreaming && a.awaitingAssistant == b.awaitingAssistant
            && a.error == b.error && a.isCompacting == b.isCompacting && a.aborted == b.aborted
    }

    mutating func reduce(_ action: ChatAction) {
        switch action {
        case .reset(let history):
            self = ChatState()
            guard let history else { return }
            var rendered = history.map { m -> RenderedMessage in
                var r = Self.inflate(m)
                r.raw = m
                return r
            }
            rendered = Self.attachToolResults(rendered)
            rendered = Self.stripVisionEcho(rendered)
            messages = Self.stripAttachmentEcho(rendered)

        case .userSent(let text, let images, let files):
            var blocks: [Block] = []
            for img in images {
                blocks.append(Block(kind: .image, data: img.data, mimeType: img.mimeType, path: img.name))
            }
            for f in files {
                blocks.append(Block(kind: .file, text: f.name, mimeType: f.mimeType, path: f.path, sizeBytes: f.size))
            }
            if !text.isEmpty { blocks += Self.userPromptBlocks(text) }
            messages.append(RenderedMessage(key: genKey("user"), role: .user, blocks: blocks, createdAt: nowMs()))
            awaitingAssistant = true

        case .setError(let message):
            error = message
            awaitingAssistant = false

        case .endStream(let keepPartial):
            if !isStreaming && activeAssistantIdx == nil { return }
            if let idx = activeAssistantIdx, messages.indices.contains(idx) {
                if keepPartial {
                    for i in messages[idx].blocks.indices { messages[idx].blocks[i].streaming = false }
                } else {
                    removeMessage(at: idx)
                }
            }
            stopTurnStreams()
            isStreaming = false
            awaitingAssistant = false
            activeAssistantIdx = nil
            aborted = true

        case .bashStart(let key, let command, let cwd):
            messages.append(RenderedMessage(
                key: key, role: .custom,
                blocks: [.custom("bash_exec", command, details: ["status": "running", "cwd": JSON(cwd)])],
                createdAt: nowMs()))

        case .bashDone(let key, let result):
            guard let idx = messages.firstIndex(where: { $0.key == key }) else { return }
            for i in messages[idx].blocks.indices where messages[idx].blocks[i].customType == "bash_exec" {
                messages[idx].blocks[i].details = ["status": "done", "result": result]
            }

        case .runtimeSwitch(let from, let to):
            messages.append(RenderedMessage(
                key: genKey("runtime-switch"), role: .custom,
                blocks: [.custom("runtime_switch", "\(from) → \(to)", details: ["from": .string(from), "to": .string(to)])],
                createdAt: nowMs()))

        case .piEvent(let event):
            reducePiEvent(event)
        }
    }

    // MARK: - History inflation

    static func inflate(_ msg: JSON) -> RenderedMessage {
        var blocks: [Block] = []
        let role = msg["role"].string ?? "assistant"
        let content: [JSON]
        if let a = msg["content"].array { content = a }
        else if let s = msg["content"].string { content = [["type": "text", "text": .string(s)]] }
        else { content = [] }
        for c in content {
            switch c["type"].string {
            case "text":
                let text = c["text"].stringValue
                if role == "custom", let ct = msg["customType"].string {
                    blocks.append(.custom(ct, text, details: msg["details"]))
                } else if role == "user" {
                    blocks += userPromptBlocks(text)
                } else {
                    var b = Block.text(text)
                    b.phase = c["phase"].string
                    blocks.append(b)
                }
            case "thinking":
                blocks.append(.thinking(c["thinking"].stringValue))
            case "toolCall":
                blocks.append(Block(kind: .toolUse, toolId: c["id"].stringValue, name: c["name"].stringValue, args: c["arguments"]))
            case "image":
                blocks.append(Block(kind: .image, data: c["data"].string, mimeType: c["mimeType"].stringValue))
            default: break
            }
        }
        let r: Role
        switch role {
        case "toolResult", "tool": r = .tool
        case "user": r = .user
        case "custom": r = .custom
        case "system": r = .system
        default: r = .assistant
        }
        return RenderedMessage(
            key: msg["id"].string ?? genKey("hist"), role: r, blocks: blocks,
            createdAt: msg["timestamp"].double ?? nowMs())
    }

    static func attachToolResults(_ messages: [RenderedMessage]) -> [RenderedMessage] {
        var out = messages
        var location: [String: (Int, Int)] = [:]
        for (mi, m) in out.enumerated() where m.role == .assistant {
            for (bi, b) in m.blocks.enumerated() where b.kind == .toolUse { location[b.toolId] = (mi, bi) }
        }
        for m in out where m.role == .tool {
            guard let raw = m.raw, let id = raw["toolCallId"].string, let (mi, bi) = location[id] else { continue }
            let inner: [JSON]
            if let a = raw["content"].array { inner = a }
            else if let s = raw["content"].string { inner = [["type": "text", "text": .string(s)]] }
            else { inner = [] }
            out[mi].blocks[bi].result = ToolResult(content: inner, details: raw["details"], isError: raw["isError"].truthy)
        }
        return out.filter { $0.role != .tool }
    }

    static func stripVisionEcho(_ messages: [RenderedMessage]) -> [RenderedMessage] {
        var out = messages
        for i in out.indices {
            guard out[i].role == .custom,
                  let desc = out[i].blocks.first(where: { $0.customType == "vision_describe" })?.text.trimmingCharacters(in: .whitespacesAndNewlines),
                  !desc.isEmpty,
                  let j = out[(i + 1)...].firstIndex(where: { $0.role == .user })
            else { continue }
            out[j].blocks = out[j].blocks.compactMap { b in
                guard b.kind == .text else { return b }
                // chat-state.ts stripSuffix: trimEnd only, and a code-unit suffix match
                // (Swift's hasSuffix would also match canonically-equivalent text).
                var t = Array(b.text.utf16)
                while let last = t.last, let u = UnicodeScalar(last), CharacterSet.whitespacesAndNewlines.contains(u) { t.removeLast() }
                let d = Array(desc.utf16)
                guard t.count >= d.count, Array(t.suffix(d.count)) == d else { return b }
                var headUnits = Array(t.dropLast(d.count))
                while let last = headUnits.last, let u = UnicodeScalar(last), CharacterSet.whitespacesAndNewlines.contains(u) { headUnits.removeLast() }
                let head = String(decoding: headUnits, as: UTF16.self)
                if head.isEmpty { return nil }
                var c = b
                c.text = head
                return c
            }
        }
        return out
    }

    static func stripAttachmentEcho(_ messages: [RenderedMessage]) -> [RenderedMessage] {
        messages.map { m in
            guard m.role == .user else { return m }
            var c = m
            c.blocks = m.blocks.compactMap { b in
                guard b.kind == .text else { return b }
                let s = Attachments.strip(b.text)
                if s == b.text { return b }
                if s.isEmpty { return nil }
                var nb = b
                nb.text = s
                return nb
            }
            return c
        }
    }

    /// Strip the mention block (keeping its labels as pills) and split a
    /// leading context fence into its chip.
    static func userPromptBlocks(_ text: String) -> [Block] {
        let (prose, labels) = Mentions.extract(text)
        var blocks = QuickContext.userTextBlocks(prose)
        if !labels.isEmpty {
            for i in blocks.indices where blocks[i].kind == .text { blocks[i].mentions = labels }
        }
        return blocks
    }

    // MARK: - Streaming

    private mutating func removeMessage(at idx: Int) {
        messages.remove(at: idx)
        var next: [String: (messageIdx: Int, blockIdx: Int)] = [:]
        for (id, loc) in toolIndex where loc.messageIdx != idx {
            next[id] = (loc.messageIdx > idx ? loc.messageIdx - 1 : loc.messageIdx, loc.blockIdx)
        }
        toolIndex = next
    }

    private mutating func stopTurnStreams() {
        for i in messages.indices.reversed() {
            if messages[i].role == .user { break }
            for j in messages[i].blocks.indices where messages[i].blocks[j].streaming {
                messages[i].blocks[j].streaming = false
            }
        }
    }

    private func hasVisibleContent(_ m: RenderedMessage) -> Bool {
        m.blocks.contains { b in
            (b.kind == .text && !b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                || b.kind == .toolUse || b.kind == .image || b.kind == .file || b.kind == .custom
        }
    }

    private mutating func settleRun() {
        var sawAssistant = false
        var hasContent = false
        for m in messages.reversed() {
            if hasContent { break }
            if m.role == .user { break }
            if m.role != .assistant { continue }
            sawAssistant = true
            hasContent = hasVisibleContent(m)
        }
        stopTurnStreams()
        isStreaming = false
        awaitingAssistant = false
        activeAssistantIdx = nil
        if sawAssistant && !hasContent && error == nil && !aborted {
            error = "The model returned an empty response — no answer was produced. Tap Retry to try again."
        }
    }

    private mutating func reducePiEvent(_ event: JSON) {
        switch event["type"].string ?? "" {
        case "agent_start":
            isStreaming = true
            awaitingAssistant = true
            error = nil
            aborted = false
        case "compaction_start":
            isCompacting = true
            compactionReason = event["reason"].string ?? "context"
            error = nil
        case "compaction_end":
            isCompacting = false
            compactionReason = nil
            if event["aborted"].truthy && error == nil { error = "Context compaction failed. The conversation is unchanged." }
        case "agent_end":
            if !event["willRetry"].truthy { settleRun() }
        case "agent_settled":
            if isStreaming { settleRun() }
        case "message_start":
            let msg = event["message"]
            switch msg["role"].string {
            case "custom":
                messages.append(Self.inflate(msg))
            case "user":
                if messages.last?.role == .user { return }
                messages.append(Self.inflate(msg))
                awaitingAssistant = true
            case "assistant":
                messages.append(RenderedMessage(key: genKey("asst"), role: .assistant, blocks: [], createdAt: nowMs()))
                activeAssistantIdx = messages.count - 1
                awaitingAssistant = false
            default: break
            }
        case "message_end":
            guard let idx = activeAssistantIdx, messages.indices.contains(idx) else { return }
            for i in messages[idx].blocks.indices { messages[idx].blocks[i].streaming = false }
        case "message_update":
            let am = event["assistantMessageEvent"]
            if am["type"].string == "error" && am["reason"].string == "aborted" {
                aborted = true
                return
            }
            reduceAssistantDelta(am)
        case "tool_execution_start", "tool_execution_update", "tool_execution_delta", "tool_execution_end":
            reduceToolExec(event)
        default: break
        }
    }

    private mutating func reduceAssistantDelta(_ e: JSON) {
        guard let mi = activeAssistantIdx, messages.indices.contains(mi) else { return }
        let ci = e["contentIndex"].int ?? 0
        func ensure(_ fill: Block) {
            while messages[mi].blocks.count <= ci { messages[mi].blocks.append(.text("")) }
            let cur = messages[mi].blocks[ci]
            if cur.kind != fill.kind && cur.kind == .text && cur.text.isEmpty { messages[mi].blocks[ci] = fill }
        }
        switch e["type"].string ?? "" {
        case "text_start":
            ensure(.text("", streaming: true))
            if let p = e["phase"].string, messages[mi].blocks[ci].kind == .text { messages[mi].blocks[ci].phase = p }
        case "text_delta":
            ensure(.text("", streaming: true))
            if messages[mi].blocks[ci].kind == .text {
                messages[mi].blocks[ci].text += e["delta"].stringValue
                messages[mi].blocks[ci].streaming = true
            }
        case "text_end":
            if messages[mi].blocks.indices.contains(ci), messages[mi].blocks[ci].kind == .text {
                messages[mi].blocks[ci].text = e["content"].stringValue
                messages[mi].blocks[ci].streaming = false
                if let p = e["phase"].string { messages[mi].blocks[ci].phase = p }
            }
        case "thinking_start":
            ensure(.thinking("", streaming: true))
        case "thinking_delta":
            ensure(.thinking("", streaming: true))
            if messages[mi].blocks[ci].kind == .thinking {
                messages[mi].blocks[ci].text += e["delta"].stringValue
                messages[mi].blocks[ci].streaming = true
            }
        case "thinking_end":
            if messages[mi].blocks.indices.contains(ci), messages[mi].blocks[ci].kind == .thinking {
                messages[mi].blocks[ci].text = e["content"].stringValue
                messages[mi].blocks[ci].streaming = false
            }
        case "toolcall_start":
            let block = Block(kind: .toolUse, streaming: true)
            ensure(block)
            messages[mi].blocks[ci] = block
        case "toolcall_end":
            let call = e["toolCall"]
            if messages[mi].blocks.indices.contains(ci), messages[mi].blocks[ci].kind == .toolUse {
                messages[mi].blocks[ci].toolId = call["id"].stringValue
                messages[mi].blocks[ci].name = call["name"].stringValue
                messages[mi].blocks[ci].args = call["arguments"]
                messages[mi].blocks[ci].streaming = true
            }
            toolIndex[call["id"].stringValue] = (mi, ci)
        default: break
        }
    }

    private static let previewChars = 64 * 1024
    private static let omission = "\n… output omitted …\n"

    private mutating func reduceToolExec(_ event: JSON) {
        guard let loc = toolIndex[event["toolCallId"].stringValue],
              messages.indices.contains(loc.messageIdx),
              messages[loc.messageIdx].blocks.indices.contains(loc.blockIdx),
              messages[loc.messageIdx].blocks[loc.blockIdx].kind == .toolUse
        else { return }
        var b = messages[loc.messageIdx].blocks[loc.blockIdx]
        switch event["type"].string ?? "" {
        case "tool_execution_start":
            b.streaming = true
        case "tool_execution_update":
            let p = event["partialResult"]
            b.result = ToolResult(content: p["content"].array ?? [], details: p["details"], isError: false)
            b.streaming = true
        case "tool_execution_delta":
            var text = (b.result?.text ?? "") + event["delta"].stringValue
            if text.count > Self.previewChars {
                let available = Self.previewChars - Self.omission.count
                let head = available / 2
                text = String(text.prefix(head)) + Self.omission + String(text.suffix(available - head))
            }
            var details = b.result?.details.object ?? [:]
            details["toolOutput"] = ["truncated": .bool(event["truncated"].truthy || text.contains(Self.omission)), "totalBytes": event["totalBytes"]]
            b.result = ToolResult(content: [["type": "text", "text": .string(text)]], details: .object(details), isError: false)
            b.streaming = true
        case "tool_execution_end":
            let r = event["result"]
            b.result = ToolResult(content: r["content"].array ?? [], details: r["details"], isError: event["isError"].truthy)
            b.streaming = false
        default: return
        }
        messages[loc.messageIdx].blocks[loc.blockIdx] = b
    }
}
