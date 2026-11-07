import Foundation

public struct Conversation: Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String
    public var workspaceDir: String
    public var backend: String
    public var updatedAt: Date
    public var archived: Bool
    public var pinned: Bool
    public var unread: Bool
    public var runState: String

    public init?(_ j: JSON) {
        guard let id = j["id"].string else { return nil }
        self.id = id
        title = j["title"].string ?? ""
        workspaceDir = j["workspaceDir"].string ?? ""
        backend = j["backend"].string ?? "pi"
        updatedAt = Date(timeIntervalSince1970: (j["updatedAt"].number ?? 0) / 1000)
        archived = !j["archivedAt"].isNull
        pinned = !j["pinnedAt"].isNull
        unread = !j["unreadAt"].isNull
        runState = j["runState"].string ?? "idle"
    }

    public var displayTitle: String { title.isEmpty ? "Untitled" : title }

    /// Last path component of the workspace, "Chat" for the default one.
    public var workspaceName: String {
        let last = (workspaceDir as NSString).lastPathComponent
        return last.isEmpty ? "Chat" : last
    }
}

public enum Runtime: String, CaseIterable, Identifiable, Sendable {
    case pi
    case claudeCode = "claude-code"
    case codex
    case opencode
    case grok
    case kimi
    case dsh

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .pi: "Cetus"
        case .claudeCode: "Claude Code"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        case .grok: "Grok Build"
        case .kimi: "Kimi CLI"
        case .dsh: "DeepSeek Harness"
        }
    }

    public static func label(for id: String) -> String {
        Runtime(rawValue: id)?.label ?? id
    }
}

/// A user-facing approval / question a CLI runtime is waiting on.
public struct ControlRequest: Identifiable, Hashable, Sendable {
    public var id: String { requestKey }
    public var raw: JSON
    public var requestKey: String { raw["requestId"].compactText }
    public var toolName: String { raw["toolName"].string ?? "" }
    public var source: String? { raw["source"].string }
    public var requestKind: String? { raw["requestKind"].string }
    public var input: JSON { raw["input"] }

    public init(_ raw: JSON) { self.raw = raw }

    /// Questions asked by AskUserQuestion (claude) / request_user_input (codex).
    public var isQuestion: Bool {
        toolName == "AskUserQuestion" || requestKind == "request_user_input"
    }

    public var questions: [Question] {
        (input["questions"].array ?? []).map { q in
            Question(
                id: q["id"].string ?? q["question"].string ?? UUID().uuidString,
                text: q["question"].string ?? q["header"].string ?? "",
                options: (q["options"].array ?? []).compactMap { $0["label"].string ?? $0.string }
            )
        }
    }

    public struct Question: Hashable, Sendable {
        public var id: String
        public var text: String
        public var options: [String]
    }

    /// The response object each runtime expects (mirrors the desktop and the
    /// legacy web client). `answers` maps question id → answer.
    public func response(allow: Bool, answers: [String: String] = [:]) -> JSON {
        if source == "codex" {
            if requestKind == "request_user_input" && allow {
                var out: [String: JSON] = [:]
                for q in questions { out[q.id] = ["answers": [.string(answers[q.id] ?? "")]] }
                return ["answers": .object(out)]
            }
            return allow
                ? ["action": "accept", "content": [:], "_meta": nil]
                : ["action": "decline", "content": nil, "_meta": nil]
        }
        if toolName == "AskUserQuestion" && allow {
            var updated = input.object ?? [:]
            var out: [String: JSON] = [:]
            for q in questions { out[q.text] = .string(answers[q.id] ?? "") }
            updated["answers"] = .object(out)
            return ["behavior": "allow", "updatedInput": .object(updated)]
        }
        return allow
            ? ["behavior": "allow", "updatedInput": input]
            : ["behavior": "deny", "message": "Denied from Cetus on iPhone"]
    }
}
