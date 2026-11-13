import Foundation

/// One row of the chat screen: a user message, or a whole assistant turn
/// (every consecutive assistant message merged, the way the desktop does).
public enum TimelineItem: Identifiable, Sendable {
    case user(ChatMessage)
    case assistant(AssistantTurn)

    public var id: Int {
        switch self {
        case .user(let m): m.id
        case .assistant(let t): t.id
        }
    }
}

public struct AssistantTurn: Identifiable, Sendable {
    /// Id of the turn's first message.
    public var id: Int
    public var segments: [AssistantSegment]
    /// The turn the agent is still working on.
    public var active: Bool
}

public enum AssistantSegment: Identifiable, Sendable {
    /// Thinking, tool calls and narration between them, folded into one line.
    case activity(key: String, steps: [ChatBlock], trailing: Bool)
    case answer(ChatBlock)

    public var id: String {
        switch self {
        case .activity(let key, _, _): key
        case .answer(let b): "b\(b.id)"
        }
    }
}

extension ChatTimeline {
    /// Messages grouped into turns, with process steps folded. The last
    /// assistant turn is `active` while the agent runs.
    public func items(running: Bool) -> [TimelineItem] {
        var out: [TimelineItem] = []
        var run: [ChatMessage] = []
        func flush(active: Bool) {
            guard let first = run.first else { return }
            out.append(.assistant(AssistantTurn(
                id: first.id,
                segments: Self.segments(run.flatMap(\.blocks), live: active, finalAnswers: finalAnswers),
                active: active
            )))
            run = []
        }
        for m in messages {
            if m.role == .user {
                flush(active: false)
                out.append(.user(m))
            } else {
                run.append(m)
            }
        }
        flush(active: running)
        return out
    }

    /// Same policy as the desktop's `buildAssistantSegments`: thinking and
    /// tool calls always fold; narration folds when more work follows it
    /// (settled: everything before the last text run). Every run starts
    /// collapsed.
    static func segments(_ all: [ChatBlock], live: Bool, finalAnswers: Set<Int> = []) -> [AssistantSegment] {
        let flat = all.filter { b in
            switch b {
            // Empty blocks (including the placeholders streaming deltas pad
            // with) render nothing but would still take a row of spacing.
            case .text(_, let t, _): !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case .thinking(_, let t, let streaming): streaming || !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            default: true
            }
        }
        var boundary = -1
        var hasProcess = false
        var lastProcess = -1
        for (i, b) in flat.enumerated() {
            if b.isProcess {
                hasProcess = true
                lastProcess = i
            }
            if case .text(_, let t, _) = b, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { boundary = i }
        }
        while boundary > 0, case .text = flat[boundary - 1] { boundary -= 1 }
        if boundary < 0 { boundary = max(0, flat.count - 1) }

        var out: [AssistantSegment] = []
        var steps: [ChatBlock] = []
        func close() {
            guard let first = steps.first else { return }
            out.append(.activity(key: first.foldKey, steps: steps, trailing: false))
            steps = []
        }
        for (i, b) in flat.enumerated() {
            let foldText: Bool
            if case .text = b {
                foldText = !finalAnswers.contains(b.id) && hasProcess && (live ? i < lastProcess : i < boundary)
            } else {
                foldText = false
            }
            if b.isProcess || foldText {
                steps.append(b)
            } else {
                close()
                out.append(.answer(b))
            }
        }
        if let first = steps.first {
            out.append(.activity(key: first.foldKey, steps: steps, trailing: true))
        }
        return out
    }
}

extension ChatBlock {
    var isProcess: Bool {
        switch self {
        case .thinking: true
        // Files handed to the user stay in view; folding never moves the
        // steps around them.
        case .tool: !isThreadCard && artifacts.isEmpty
        default: false
        }
    }

    /// A coordinator's successful thread_start / thread_send stays in view
    /// instead of folding into the steps.
    var isThreadCard: Bool {
        guard case .tool(_, _, let name, _, let result?) = self else { return false }
        return (name == "thread_start" || name == "thread_send") && result["isError"].bool != true
            && result["partial"].bool != true
    }

    /// Survives the refetch after a turn ends (tool call ids are stable;
    /// block ids are renumbered).
    var foldKey: String {
        if case .tool(_, let callId, _, _, _) = self, !callId.isEmpty { return "t\(callId)" }
        return "b\(id)"
    }
}

/// A file an agent handed to the user (the `send_artifact` result).
public struct Artifact: Sendable, Hashable, Identifiable {
    public var kind: String
    public var path: String
    public var name: String
    public var caption: String?
    public var sizeBytes: Int
    public var id: String { path }

    init?(_ d: JSON) {
        guard d["kind"].string == "artifact", let path = d["path"].string else { return nil }
        self.path = path
        kind = d["artifactKind"].string ?? "other"
        name = d["name"].string ?? (path as NSString).lastPathComponent
        caption = d["caption"].string.flatMap { $0.isEmpty ? nil : $0 }
        sizeBytes = d["sizeBytes"].int ?? 0
    }

    /// One artifact, a collection, or either nested under `artifacts`.
    static func list(_ details: JSON) -> [Artifact] {
        if let one = Artifact(details) { return [one] }
        guard details.object != nil else { return [] }
        if details["kind"].string == "artifact_collection", let all = details["artifacts"].array {
            return all.compactMap(Artifact.init)
        }
        if let all = details["artifacts"].array { return all.flatMap(list) }
        return details["artifacts"].isNull ? [] : list(details["artifacts"])
    }

    /// "Image", "PDF", or the file's extension.
    public var kindLabel: String {
        switch kind {
        case "image": return "Image"
        case "video": return "Video"
        case "audio": return "Audio"
        case "pdf": return "PDF"
        case "markdown": return "Markdown"
        case "html": return "HTML"
        case "text": return "Text"
        default:
            let ext = (name as NSString).pathExtension
            return ext.isEmpty ? "File" : ext.uppercased()
        }
    }
}

/// The thread a coordinator's thread_start / thread_send touched.
public struct ThreadCard: Sendable, Hashable {
    public var isStart: Bool
    public var id: String
    public var title: String
    /// A runtime id as the phone knows it ("pi" for the built-in one).
    public var runtime: String
    public var message: String
}

extension ChatBlock {
    public var artifacts: [Artifact] {
        guard case .tool(_, _, _, _, let result?) = self else { return [] }
        return Artifact.list(result["details"])
    }

    public var threadCard: ThreadCard? {
        guard isThreadCard, case .tool(_, _, let name, let arguments, let result?) = self,
              let data = result.toolResultText.data(using: .utf8), let reply = try? JSON.parse(data),
              reply["ok"].bool == true, let id = reply["thread_id"].string else { return nil }
        let args = arguments.parsedArguments
        func pick(_ values: JSON...) -> String { values.compactMap(\.string).first { !$0.isEmpty } ?? "" }
        let runtime = reply["runtime"].string ?? ""
        return ThreadCard(
            isStart: name == "thread_start", id: id, title: pick(reply["title"], args["title"]),
            runtime: runtime == "cetus" ? "pi" : runtime, message: pick(args["message"], args["task"]))
    }
}

extension AssistantSegment {
    /// "Ran 3 commands and used 2 other tools", as on the desktop.
    public static func summary(_ steps: [ChatBlock]) -> String {
        var commands = 0
        var tools = 0
        var thinking = false
        for s in steps {
            switch s {
            case .thinking: thinking = true
            case .tool(_, _, let name, let args, _):
                if isCommand(name, arguments: args) { commands += 1 } else { tools += 1 }
            default: break
            }
        }
        func n(_ c: Int, _ one: String) -> String { "\(c) \(one)\(c == 1 ? "" : "s")" }
        if commands > 0 && tools > 0 { return "Ran \(n(commands, "command")) and used \(n(tools, "other tool"))" }
        if commands > 0 { return "Ran \(n(commands, "command"))" }
        if tools > 0 { return "Used \(n(tools, "tool"))" }
        return thinking ? "Thought" : "Progress updates"
    }

    /// A shell-command step: named like one, or carrying a command to run.
    public static func isCommand(_ tool: String, arguments: JSON = .null) -> Bool {
        tool.range(of: "bash|shell|exec_command|command", options: [.regularExpression, .caseInsensitive]) != nil
            || command(tool, arguments: arguments) != nil
    }

    /// The shell command of a bash-style call, nil for other tools.
    public static func command(_ tool: String, arguments: JSON) -> String? {
        let value = arguments.parsedArguments
        for key in ["command", "cmd"] {
            if let s = value[key].string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return s }
        }
        if let s = value.string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           tool.range(of: "bash", options: .caseInsensitive) != nil { return s }
        return nil
    }

    public var hasTool: Bool {
        guard case .activity(_, let steps, _) = self else { return false }
        return steps.contains { if case .tool = $0 { return true } else { return false } }
    }
}
