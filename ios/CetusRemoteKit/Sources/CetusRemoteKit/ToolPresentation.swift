import Foundation

/// What a tool step shows, worked out the same way the desktop's tool card
/// does: its state, the one-line preview, and the body it expands to.
public struct ToolPresentation: Sendable {
    public enum Status: Sendable { case running, error, incomplete, settled }

    public struct SubagentStep: Sendable, Hashable {
        public var tool: String
        public var detail: String
        public var done: Bool
    }

    public struct Subagent: Sendable {
        public var type: String
        public var description: String
        public var steps: [SubagentStep]
    }

    public struct DiffLine: Sendable, Hashable {
        public enum Kind: Sendable { case add, del, same }
        public var kind: Kind
        public var text: String
    }

    public struct Edit: Sendable {
        public var path: String?
        /// One line diff per replacement.
        public var diffs: [[DiffLine]]
        public var adds: Int
        public var dels: Int
    }

    public enum ArgumentsKind: Sendable { case diff, command, args }

    public var name: String
    public var status: Status
    public var preview: String
    public var subagent: Subagent?
    public var edit: Edit?
    public var command: String?
    /// Nil for file tools: their path shows above the result instead.
    public var argumentsKind: ArgumentsKind?
    public var argumentsText: String
    public var hasResult: Bool
    public var filePath: String?
    /// "offset 40 · limit 80" for a read, the size for a write.
    public var fileMeta: String
    public var body: String
    /// Total size of an output the Mac kept only a preview of.
    public var truncatedBytes: Int?

    /// `active`: the turn this step belongs to is still running.
    public init(name: String, arguments: JSON, result: JSON?, active: Bool) {
        self.name = name
        let args = arguments.parsedArguments
        let details = result?["details"] ?? .null
        let partial = result?["partial"].bool == true
        let failed = result?["isError"].bool == true

        let sub = details["subagent"]
        let subStatus = sub["status"].string
        if sub.object != nil {
            subagent = Subagent(
                type: sub["type"].string ?? "agent",
                description: sub["description"].string ?? "",
                steps: (sub["steps"].array ?? []).compactMap { s in
                    s.object == nil ? nil : SubagentStep(
                        tool: s["tool"].string ?? "tool", detail: s["detail"].string ?? "", done: s["done"].bool == true)
                })
        }
        // A background agent can outlive its turn; a plain tool left without
        // a result was interrupted, not finished.
        if ((result == nil || partial) && active) || (sub.object != nil && (subStatus ?? "running") == "running") {
            status = .running
        } else if failed || subStatus == "failed" || subStatus == "error" {
            status = .error
        } else if result == nil || partial || ["cancelled", "canceled", "interrupted"].contains(subStatus ?? "") {
            status = .incomplete
        } else {
            status = .settled
        }

        let lower = name.trimmingCharacters(in: .whitespaces).lowercased()
        let isRead = lower == "read" || lower == "read_file"
        let isWrite = lower == "write" || lower == "write_file"
        var content: String?
        if isRead || isWrite {
            filePath = Self.path(args)
            var parts: [String] = []
            if let n = Self.number(args["offset"]) { parts.append("offset \(n)") }
            if let n = Self.number(args["limit"]) { parts.append("limit \(n)") }
            content = args["content"].string
            if let content { parts.append(Self.bytes(content.utf16.count)) }
            fileMeta = parts.joined(separator: " · ")
        } else {
            fileMeta = ""
        }

        edit = Self.edit(args)
        command = AssistantSegment.command(name, arguments: arguments)
        if let subagent {
            preview = [subagent.type, subagent.description].filter { !$0.isEmpty }.joined(separator: " — ")
        } else if let edit {
            preview = "\(edit.path ?? "edit") · +\(edit.adds) -\(edit.dels)"
        } else if let command {
            preview = "$ " + command.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        } else {
            preview = arguments.argumentPreview
        }

        argumentsKind = arguments.isNull || isRead || isWrite ? nil : edit != nil ? .diff : command != nil ? .command : .args
        argumentsText = command ?? arguments.prettyText

        hasResult = result != nil
        let resultText = Self.stripAnsi(result?.toolResultText ?? "")
        // A write's result is only a confirmation: show what was written.
        body = isWrite && !failed ? (content ?? "") : resultText
        let output = details["toolOutput"]
        truncatedBytes = output["truncated"].bool == true ? (output["totalBytes"].int ?? 0) : nil
    }

    private static func path(_ args: JSON) -> String? {
        for key in ["path", "file", "file_path", "filename"] {
            if let s = args[key].string?.trimmingCharacters(in: .whitespaces), !s.isEmpty { return s }
        }
        return nil
    }

    private static func number(_ v: JSON) -> Int? {
        if let n = v.number, n.isFinite { return Int(n) }
        if let s = v.string, let n = Double(s.trimmingCharacters(in: .whitespaces)), n.isFinite { return Int(n) }
        return nil
    }

    public static func bytes(_ n: Int) -> String {
        if n < 1024 { return "\(n) B" }
        if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
        return String(format: "%.1f MB", Double(n) / (1024 * 1024))
    }

    /// Terminal color codes mean nothing in a plain text box.
    static func stripAnsi(_ s: String) -> String {
        guard s.contains("\u{1B}") else { return s }
        return s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
    }

    /// The replacement pairs of an edit-style call: an `edits` list, or a
    /// bare `oldText` / `newText` pair.
    private static func edit(_ args: JSON) -> Edit? {
        guard args.object != nil else { return nil }
        var pairs: [(String, String)] = []
        func push(_ e: JSON) {
            let old = e["oldText"].string ?? ""
            let new = e["newText"].string ?? ""
            if !old.isEmpty || !new.isEmpty { pairs.append((old, new)) }
        }
        if let list = args["edits"].array {
            for e in list where e.object != nil { push(e) }
        } else if args["edits"].object != nil {
            push(args["edits"])
        } else if args["oldText"].string != nil || args["newText"].string != nil {
            push(args)
        }
        guard !pairs.isEmpty else { return nil }
        let diffs = pairs.map { diff($0.0, $0.1) }
        let all = diffs.joined()
        return Edit(
            path: path(args), diffs: diffs,
            adds: all.count { $0.kind == .add }, dels: all.count { $0.kind == .del })
    }

    private static let maxDiffLines = 800

    /// Line diff of two texts by longest common subsequence.
    static func diff(_ old: String, _ new: String) -> [DiffLine] {
        func lines(_ s: String) -> [String] { s.components(separatedBy: "\n") }
        if old.isEmpty { return lines(new).map { DiffLine(kind: .add, text: $0) } }
        if new.isEmpty { return lines(old).map { DiffLine(kind: .del, text: $0) } }
        let a = lines(old), b = lines(new)
        // Past this size the table gets too large: removals, then additions.
        if a.count > maxDiffLines || b.count > maxDiffLines {
            return a.map { DiffLine(kind: .del, text: $0) } + b.map { DiffLine(kind: .add, text: $0) }
        }
        let n = a.count, m = b.count
        var dp = [[Int32]](repeating: [Int32](repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
            }
        }
        var out: [DiffLine] = []
        var i = 0, j = 0
        while i < n, j < m {
            if a[i] == b[j] {
                out.append(DiffLine(kind: .same, text: a[i]))
                i += 1
                j += 1
            } else if dp[i + 1][j] >= dp[i][j + 1] {
                out.append(DiffLine(kind: .del, text: a[i]))
                i += 1
            } else {
                out.append(DiffLine(kind: .add, text: b[j]))
                j += 1
            }
        }
        while i < n { out.append(DiffLine(kind: .del, text: a[i])); i += 1 }
        while j < m { out.append(DiffLine(kind: .add, text: b[j])); j += 1 }
        return out
    }
}
