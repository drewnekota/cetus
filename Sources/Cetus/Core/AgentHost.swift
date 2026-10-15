import AppKit
import Foundation
import UserNotifications

/// Client for `cetus-agentd`, the stdio host around Cetus's `cetus-bridge`.
/// One process for the whole app; it owns every runtime (Claude Code, Codex,
/// ACP agents) and streams their PiEvents back as JSON lines.
final class AgentHost {
    private var process: Process?
    private var stdin: FileHandle?
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
        // Lines are split and parsed on the pipe's reader thread; main gets whole
        // messages in batches (see Outbox), so a burst of streamed tokens is one UI update.
        let reader = LineReader()
        let outbox = Outbox { [weak self] batch in
            guard let self else { return }
            for m in batch { self.onMessage?(m) }
        }
        outPipe.fileHandleForReading.readabilityHandler = { h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil; return }
            outbox.post(reader.feed(chunk))
        }
        // Through the outbox too: it must not overtake messages still waiting there.
        p.terminationHandler = { _ in outbox.post([["type": "host_exited"]]) }
        do { try p.run() } catch {
            NSLog("failed to start agentd: \(error)")
            return
        }
        process = p
        stdin = inPipe.fileHandleForWriting
    }

    /// Hands messages to main at most every 25ms: agentd writes a line per streamed
    /// token, and each delivery re-renders the transcript.
    private final class Outbox: @unchecked Sendable {
        private let lock = NSLock()
        private var pending: [JSON] = []
        private var scheduled = false
        private let deliver: ([JSON]) -> Void
        init(_ deliver: @escaping ([JSON]) -> Void) { self.deliver = deliver }

        func post(_ messages: [JSON]) {
            guard !messages.isEmpty else { return }
            lock.lock()
            pending += messages
            let schedule = !scheduled
            scheduled = true
            lock.unlock()
            guard schedule else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) {
                self.lock.lock()
                let batch = self.pending
                self.pending = []
                self.scheduled = false
                self.lock.unlock()
                self.deliver(batch)
            }
        }
    }

    /// Newline-delimited JSON from one agentd process. Only the new chunk is
    /// scanned for newlines, so a multi-MB line (turn_done with images) arriving
    /// in many chunks isn't rescanned from its start each time.
    private final class LineReader {
        private var buffer = Data()

        func feed(_ chunk: Data) -> [JSON] {
            let from = buffer.count
            buffer.append(chunk)
            var out: [JSON] = []
            var lineStart = 0
            buffer.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else { return }
                var i = from
                while i < raw.count, let hit = memchr(base + i, 0x0A, raw.count - i) {
                    let nl = base.distance(to: UnsafeRawPointer(hit))
                    if nl > lineStart, let msg = JSON.parse(Data(bytes: base + lineStart, count: nl - lineStart)) { out.append(msg) }
                    lineStart = nl + 1
                    i = nl + 1
                }
            }
            if lineStart > 0 { buffer = Data(buffer[(buffer.startIndex + lineStart)...]) }
            return out
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
