import Foundation

// diagnostics.rs `export_diagnostics`: a sanitized report for bug reports.
enum AppShellDiagnostics {
    static let runtimes = ["claude", "codex", "opencode", "grok", "kimi", "dsh"]

    static func export() -> String {
        var out = ""
        func push(_ s: String) { out += s + "\n" }
        let env = Env.shell
        push("== Cetus diagnostics ==")
        push("cetus \(CLIServer.version)")
        #if arch(arm64)
        push("macos aarch64")
        #else
        push("macos x86_64")
        #endif
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        push("generated \(f.string(from: Date()))")
        push("Review before sharing — paths below include your username.")

        push("\n== Environment ==")
        push("SHELL = \(env["SHELL"] ?? "(unset)")")
        push("PATH =")
        for dir in (env["PATH"] ?? "").split(separator: ":", omittingEmptySubsequences: false) { push("  \(dir)") }

        push("\n== Runtimes ==")
        for bin in runtimes {
            if let path = resolve(bin, env["PATH"] ?? "") { push("\(bin): \(path) — \(version(path))") } else { push("\(bin): not on PATH") }
        }

        push("\n== Codex auth/config ==")
        let home = URL(fileURLWithPath: Env.home)
        push("~/.codex/auth.json: \(FileManager.default.fileExists(atPath: home.appendingPathComponent(".codex/auth.json").path) ? "present" : "MISSING (run `codex login`)")")
        push("OPENAI_API_KEY in app env: \((env["OPENAI_API_KEY"] ?? "").trimmingCharacters(in: .whitespaces).isEmpty ? "unset" : "set")")
        if let text = try? String(contentsOf: home.appendingPathComponent(".codex/config.toml"), encoding: .utf8) {
            push("~/.codex/config.toml keys (values redacted):")
            for l in tomlSkeleton(text) { push("  \(l)") }
        } else {
            push("~/.codex/config.toml: absent")
        }

        push("\n== Recent log ==")
        if let (path, tail) = latestLog() {
            push("\(path) (last \(tail.count) lines)")
            for l in tail { push(l) }
        } else {
            push("no log file found")
        }
        return out
    }

    private static func resolve(_ bin: String, _ path: String) -> String? {
        path.split(separator: ":").map { "\($0)/\(bin)" }.first {
            var d: ObjCBool = false
            return FileManager.default.fileExists(atPath: $0, isDirectory: &d) && !d.boolValue
        }
    }

    private static func version(_ path: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = ["--version"]
        p.environment = Env.shell
        let o = Pipe()
        p.standardOutput = o
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return "failed to run: \(error.localizedDescription)" }
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return "--version timed out" }
        let text = String(decoding: o.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        if p.terminationStatus != 0 { return "--version exited exit status: \(p.terminationStatus)" }
        return text.split(separator: "\n").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    }

    static func tomlSkeleton(_ text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("[") { return t }
            let key = t.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            return !key.isEmpty && !key.hasPrefix("#") && t.contains("=") ? "\(key) = …" : nil
        }
    }

    private static func latestLog() -> (String, [String])? {
        let dir = Env.dataDir.appendingPathComponent("logs")
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        guard let newest = files.max(by: {
            ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
                < ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }), let text = try? String(contentsOf: newest, encoding: .utf8) else { return nil }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        return (newest.path, Array(lines.suffix(120)))
    }
}
