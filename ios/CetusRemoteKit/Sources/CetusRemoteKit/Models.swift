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
    /// Model and reasoning effort picked for this chat. "" = no override, the
    /// runtime's own default runs (see `RuntimeTuning`).
    public var model: String
    public var effort: String

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
        // The built-in runtime keeps its choice in `model`, the CLI runtimes
        // in `cliModel` / `cliEffort`.
        if backend == Runtime.pi.rawValue {
            model = j["model"]["model"].string ?? ""
            effort = j["model"]["reasoning"].string ?? ""
        } else {
            model = j["cliModel"].string ?? ""
            effort = j["cliEffort"].string ?? ""
        }
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

/// The models and reasoning efforts one runtime offers, as reported by the
/// Mac (`runtimes.tuning`). Empty for runtimes that can't be tuned.
public struct RuntimeTuning: Hashable, Sendable {
    public struct Option: Identifiable, Hashable, Sendable {
        public var id: String
        public var label: String
    }

    public struct Model: Identifiable, Hashable, Sendable {
        public var id: String
        public var label: String
        /// Effort ids this model accepts; nil = every effort of the runtime.
        public var efforts: [String]?
    }

    public var models: [Model]
    public var efforts: [Option]
    /// What runs when a chat carries no override.
    public var defaultModel: String?
    public var defaultEffort: String?

    public init(_ j: JSON) {
        models = (j["models"].array ?? []).compactMap { m in
            guard let id = m["id"].string else { return nil }
            return Model(id: id, label: m["label"].string ?? id, efforts: m["efforts"].array?.compactMap(\.string))
        }
        efforts = (j["efforts"].array ?? []).compactMap { e in
            e["id"].string.map { Option(id: $0, label: e["label"].string ?? $0) }
        }
        defaultModel = j["model"].string
        defaultEffort = j["effort"].string
    }

    public var isEmpty: Bool { models.isEmpty && efforts.isEmpty }

    /// The model a chat's stored pick stands for: the pick itself when the
    /// Mac lists it, else the runtime's default.
    public func model(for picked: String) -> Model? {
        models.first { $0.id == picked } ?? (picked.isEmpty ? models.first { $0.id == defaultModel } : nil)
    }

    /// The efforts on offer for a stored model pick.
    public func efforts(forModel picked: String) -> [Option] {
        guard let allowed = model(for: picked)?.efforts else { return efforts }
        return efforts.filter { allowed.contains($0.id) }
    }

    /// The effort that runs for a stored pick. A level the model doesn't take
    /// moves to the nearest one it does, upward first, as the Mac does.
    public func effort(for picked: String, model: String) -> Option? {
        let offered = efforts(forModel: model)
        let wanted = picked.isEmpty ? defaultEffort : picked
        guard let wanted, let at = efforts.firstIndex(where: { $0.id == wanted }) else { return nil }
        let walk = Array(efforts[at...]) + efforts[..<at].reversed()
        return walk.first { offered.contains($0) }
    }

    /// "Fable · High" for a stored pick. An unlisted model shows its raw id;
    /// nil when nothing is known about either part.
    public func summary(model: String, effort: String) -> String? {
        let m = self.model(for: model)?.label ?? (model.isEmpty ? nil : model)
        let e = self.effort(for: effort, model: model)?.label
        let parts = [m, e].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
