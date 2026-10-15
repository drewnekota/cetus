import Foundation

// Remote SSH workspaces (cetus-bridge/src/remote.rs). A workspace dir of the form
// `ssh://[user@]host[:port]/abs/path` or `[user@]host:/abs/path` runs remotely:
// the pi runtime via agentd (PiRpc::spawn already ships pi over ssh), and Bash
// mode (`!cmd`) through `ssh … sh -lc` (bash.rs run_remote_bash).

struct RemoteWorkspace: Equatable {
    var target: String
    var port: Int?
    var path: String

    /// RemoteWorkspace::display.
    var display: String { port.map { "ssh://\(target):\($0)\(path)" } ?? "\(target):\(path)" }

    var sshArgs: [String] { (port.map { ["-p", String($0)] } ?? []) + [target] }

    /// parse_remote_workspace.
    static func parse(_ raw: String) -> RemoteWorkspace? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let b = Array(s.utf8)
        // A Windows drive path looks like scp's host:path — treat it as local.
        if b.count >= 2, b[1] == UInt8(ascii: ":"), (b[0] >= 65 && b[0] <= 90) || (b[0] >= 97 && b[0] <= 122) { return nil }
        if s.hasPrefix("ssh://") {
            let rest = String(s.dropFirst(6))
            guard let slash = rest.firstIndex(of: "/") else { return nil }
            let authority = String(rest[..<slash]), path = String(rest[slash...])
            guard !authority.isEmpty, path.count > 1 else { return nil }
            var target = authority, port: Int?
            if let c = authority.lastIndex(of: ":") {
                let host = String(authority[..<c]), p = String(authority[authority.index(after: c)...])
                if !host.isEmpty, !p.isEmpty, let n = UInt16(p) { target = host; port = Int(n) }
            }
            guard !target.isEmpty else { return nil }
            return RemoteWorkspace(target: target, port: port, path: path)
        }
        guard let colon = s.firstIndex(of: ":") else { return nil }
        let target = String(s[..<colon]), path = String(s[s.index(after: colon)...])
        if s.hasPrefix("/") || target.contains("/") || target.isEmpty || path.isEmpty { return nil }
        return RemoteWorkspace(target: target, port: nil, path: path)
    }

    /// shell_word: bare when safe, else single-quoted.
    static func shellWord(_ s: String) -> String {
        let safe = Set("@%_+=:,./~-")
        if !s.isEmpty, s.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || safe.contains($0) }) { return s }
        return "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    /// remote_command_args.
    func commandArgs(_ script: String) -> [String] { sshArgs + ["sh -lc \(Self.shellWord(script))"] }

    /// The ssh invocation for a Bash-mode command (run_remote_bash).
    func bashArgs(_ command: String) -> [String] {
        let p = Self.shellWord(path)
        return commandArgs("mkdir -p \(p) && cd \(p) && exec \"${SHELL:-/bin/sh}\" -lc \(Self.shellWord(command))")
    }

    /// Point a Bash-mode `Process` at the workspace: local login shell in the dir,
    /// or ssh for a remote workspace. Returns the cwd to report.
    static func configureBash(_ p: Process, command: String, cwd: String, shell: String) -> String {
        if let r = parse(cwd) {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            p.arguments = r.bashArgs(command)
            return r.display
        }
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-lc", command]
        p.currentDirectoryURL = URL(fileURLWithPath: cwd)
        return cwd
    }
}
