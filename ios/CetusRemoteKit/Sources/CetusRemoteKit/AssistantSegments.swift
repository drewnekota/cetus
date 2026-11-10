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
                segments: Self.segments(run.flatMap(\.blocks), live: active),
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
    static func segments(_ all: [ChatBlock], live: Bool) -> [AssistantSegment] {
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
            if case .text = b { foldText = hasProcess && (live ? i < lastProcess : i < boundary) } else { foldText = false }
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
        case .thinking, .tool: true
        default: false
        }
    }

    /// Survives the refetch after a turn ends (tool call ids are stable;
    /// block ids are renumbered).
    var foldKey: String {
        if case .tool(_, let callId, _, _, _) = self, !callId.isEmpty { return "t\(callId)" }
        return "b\(id)"
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
            case .tool(_, _, let name, _, _):
                if isCommand(name) { commands += 1 } else { tools += 1 }
            default: break
            }
        }
        func n(_ c: Int, _ one: String) -> String { "\(c) \(one)\(c == 1 ? "" : "s")" }
        if commands > 0 && tools > 0 { return "Ran \(n(commands, "command")) and used \(n(tools, "other tool"))" }
        if commands > 0 { return "Ran \(n(commands, "command"))" }
        if tools > 0 { return "Used \(n(tools, "tool"))" }
        return thinking ? "Thought" : "Progress updates"
    }

    public static func isCommand(_ tool: String) -> Bool {
        tool.range(of: "bash|shell|exec_command|command", options: [.regularExpression, .caseInsensitive]) != nil
    }

    public var hasTool: Bool {
        guard case .activity(_, let steps, _) = self else { return false }
        return steps.contains { if case .tool = $0 { return true } else { return false } }
    }
}
