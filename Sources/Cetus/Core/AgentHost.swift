import AppKit
import Foundation
import UserNotifications

/// Client for `cetus-agentd`, the stdio host around Cetus's `cetus-bridge`.
/// One process for the whole app; it owns every runtime (Claude Code, Codex,
/// ACP agents) and streams their PiEvents back as JSON lines.
final class AgentHost {
    private var process: Process?
    private var stdin: FileHandle?
    private var buffer = Data()
    var onMessage: ((JSON) -> Void)?

    static func binaryPath() -> String? {
        var candidates: [String] = []
        if let env = Env.process["CETUS_AGENTD"] { candidates.append(env) }
        if let res = Bundle.main.resourceURL?.appendingPathComponent("cetus-agentd").path { candidates.append(res) }
        let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        candidates.append(exeDir.appendingPathComponent("cetus-agentd").path)
        candidates.append("\(Env.home)/Developer/gpuix-fork/apps/cetus/agentd/target/release/cetus-agentd")
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func start() {
        guard let path = Self.binaryPath() else {
            NSLog("cetus-agentd not found")
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        // agentd keeps Swift-owned state (meeting recall log, per-chat snapshots) in our data dir.
        p.environment = Env.shell.merging(["CETUS_SWIFT_DATA": Env.dataDir.path]) { _, new in new }
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.standardError
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(chunk) }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.onMessage?(["type": "host_exited"])
            }
        }
        do { try p.run() } catch {
            NSLog("failed to start agentd: \(error)")
            return
        }
        process = p
        stdin = inPipe.fileHandleForWriting
    }

    private func consume(_ chunk: Data) {
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex ..< nl]
            buffer.removeSubrange(buffer.startIndex ... nl)
            if line.isEmpty { continue }
            if let msg = JSON.parse(Data(line)) { onMessage?(msg) }
        }
    }

    func send(_ request: JSON) {
        if process?.isRunning != true { start() }
        guard let stdin else { return }
        var data = Data(request.compact.utf8)
        data.append(0x0A)
        try? stdin.write(contentsOf: data)
    }

    func turn(_ request: JSON) {
        var r = request
        r["op"] = "turn"
        send(r)
    }

    func abort(_ conv: String) { send(["op": "abort", "conv": .string(conv)]) }
    func control(_ conv: String, requestId: JSON, response: JSON) {
        send(["op": "control", "conv": .string(conv), "requestId": requestId, "response": response])
    }
    func close(_ conv: String) { send(["op": "close", "conv": .string(conv)]) }
    /// What the CLI runs with no override, plus its live model catalog (get_cli_defaults).
    func cliDefaults(_ backend: String) { send(["op": "cliDefaults", "backend": .string(backend)]) }

    func dispose() {
        try? stdin?.close()
        process?.terminate()
    }
}

/// macOS notifications for finished turns and pending input. "Mute while
/// focused" skips them while Cetus is the frontmost app.
enum Notifier {
    static var disabled: Bool { Env.process["CETUS_NO_NOTIFY"] != nil }
    private static var authorized = false

    static func prepare() {
        guard !disabled, Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { ok, _ in authorized = ok }
    }

    static func post(title: String, body: String, muteWhenFocused: Bool) {
        if disabled { return }
        if muteWhenFocused && (NSApplication.shared.isActive) { return }
        if Bundle.main.bundleIdentifier != nil && authorized {
            let content = UNMutableNotificationContent()
            content.title = "Cetus"
            content.subtitle = title
            content.body = body
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            return
        }
        let script = "display notification \(quote(body)) with title \"Cetus\" subtitle \(quote(title))"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", script]
        try? p.run()
    }

    private static func quote(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }
}
