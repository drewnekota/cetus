import Foundation

// Dictation lifecycle — port of src-tauri/src/voice.rs. The mic is captured by
// the same Swift speech helper Tauri uses (`cetus-speech-helper-v6`, spawned
// through the TCC-disclaim shim); it streams JSONL ({"pcm"}, {"level"},
// {"ready"}, {"speech"}, {"pcm_end"} / {"partial"}, {"final"}) which we parse
// and forward to Doubao (or read Apple's on-device result from).

// MARK: - Helper resolution (lazy compile, mirrors voice.rs `helper`)

enum VoiceHelper {
    static let plist = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>CFBundleIdentifier</key>
      <string>dev.cetus.app.speech-helper</string>
      <key>CFBundleName</key>
      <string>cetus-speech-helper</string>
      <key>NSMicrophoneUsageDescription</key>
      <string>cetus uses your microphone to transcribe speech to text for voice input.</string>
      <key>NSSpeechRecognitionUsageDescription</key>
      <string>cetus transcribes your speech on-device so you can dictate instead of type.</string>
    </dict>
    </plist>

    """

    private static let lock = NSLock()
    private static var helperResolved = false
    private static var helperPath: String?
    private static var shimResolved = false
    private static var shimPath: String?

    private static var binDir: URL { Env.dataDir.appendingPathComponent("bin") }
    /// The helper Tauri already compiled (and the user already granted mic access
    /// to). Executed in place, never modified.
    private static var tauriBin: URL { IntelData.appData.appendingPathComponent("bin") }

    static var path: String? {
        lock.lock(); defer { lock.unlock() }
        if !helperResolved { helperPath = resolveOrCompile(); helperResolved = true }
        return helperPath
    }

    static var shim: String? {
        lock.lock(); defer { lock.unlock() }
        if !shimResolved { shimPath = compileShim(); shimResolved = true }
        return shimPath
    }

    private static func resolveOrCompile() -> String? {
        if let p = Env.process["CETUS_SPEECH_HELPER"], FileManager.default.fileExists(atPath: p) { return p }
        let name = "cetus-speech-helper-v6"
        for dir in [binDir, tauriBin] {
            let p = dir.appendingPathComponent(name).path
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        guard let srcURL = Theme.resource("voice/cetus-speech-helper.swift"), let src = try? Data(contentsOf: srcURL) else { return nil }
        try? FileManager.default.createDirectory(at: binDir, withIntermediateDirectories: true)
        let srcPath = binDir.appendingPathComponent("cetus-speech-helper.swift")
        let plistPath = binDir.appendingPathComponent("cetus-speech-helper.plist")
        let bin = binDir.appendingPathComponent(name)
        guard (try? src.write(to: srcPath)) != nil, (try? plist.write(to: plistPath, atomically: true, encoding: .utf8)) != nil else { return nil }
        let r = voiceRun("/usr/bin/swiftc", ["-O", "-framework", "Speech", "-framework", "AVFoundation",
                                             "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                                             "-Xlinker", plistPath.path, "-o", bin.path, srcPath.path])
        if r == 0, FileManager.default.fileExists(atPath: bin.path) {
            VoiceLog.info("compiled speech helper at \(bin.path)")
            return bin.path
        }
        VoiceLog.info("swiftc failed to build speech helper; dictation disabled")
        return nil
    }

    private static func compileShim() -> String? {
        for dir in [binDir, tauriBin] {
            let p = dir.appendingPathComponent("cetus-spawn-disclaim").path
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        guard let srcURL = Theme.resource("voice/cetus-spawn-disclaim.c"), let src = try? Data(contentsOf: srcURL) else { return nil }
        try? FileManager.default.createDirectory(at: binDir, withIntermediateDirectories: true)
        let srcPath = binDir.appendingPathComponent("cetus-spawn-disclaim.c")
        let bin = binDir.appendingPathComponent("cetus-spawn-disclaim")
        guard (try? src.write(to: srcPath)) != nil else { return nil }
        if voiceRun("/usr/bin/cc", ["-O2", "-o", bin.path, srcPath.path]) == 0, FileManager.default.fileExists(atPath: bin.path) { return bin.path }
        VoiceLog.info("cc failed to build disclaim shim; falling back to direct spawn")
        return nil
    }

    /// (program, leading args, child is a process-group leader)
    static func command() throws -> (String, [String], Bool) {
        guard let bin = path else { throw VoiceASRError("speech helper unavailable (swiftc missing?)") }
        if let shim { return (shim, [bin], true) }
        return (bin, [], false)
    }

    /// `permcheck` / `request` → (mic, speech) authorization strings.
    static func permissions(request: Bool = false) -> (mic: String, speech: String) {
        guard let (prog, args, _) = try? command() else { return ("unknown", "unknown") }
        let out = voiceCapture(prog, args + [request ? "request" : "permcheck"])
        let v = (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any]
        return ((v?["mic"] as? String) ?? "unknown", (v?["speech"] as? String) ?? "unknown")
    }
}

@discardableResult
func voiceRun(_ exe: String, _ args: [String]) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

func voiceCapture(_ exe: String, _ args: [String], stdin: Data? = nil, env: [String: String]? = nil) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let env { p.environment = ProcessInfo.processInfo.environment.merging(env) { _, n in n } }
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    let inPipe = Pipe()
    p.standardInput = stdin == nil ? FileHandle.nullDevice : inPipe
    do { try p.run() } catch { return "" }
    if let stdin {
        inPipe.fileHandleForWriting.write(stdin)
        try? inPipe.fileHandleForWriting.close()
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: data, encoding: .utf8) ?? ""
}

// MARK: - A spawned helper process

final class VoiceHelperProcess: @unchecked Sendable {
    let process = Process()
    let groupLeader: Bool
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    let lines: AsyncStream<String>
    private let linesTx: AsyncStream<String>.Continuation
    private let lock = NSLock()
    private var killed = false

    init(subcommand: [String]) throws {
        let (prog, lead, leader) = try VoiceHelper.command()
        groupLeader = leader
        (lines, linesTx) = AsyncStream<String>.makeStream()
        process.executableURL = URL(fileURLWithPath: prog)
        process.arguments = lead + subcommand
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        let tx = linesTx
        let handle = stdoutPipe.fileHandleForReading
        do { try process.run() } catch { throw VoiceASRError("failed to start dictation: \(error.localizedDescription)") }
        Thread.detachNewThread {
            var buf = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                buf.append(chunk)
                while let nl = buf.firstIndex(of: 0x0A) {
                    let line = String(decoding: buf[buf.startIndex..<nl], as: UTF8.self)
                    buf.removeSubrange(buf.startIndex...nl)
                    tx.yield(line)
                }
            }
            if !buf.isEmpty { tx.yield(String(decoding: buf, as: UTF8.self)) }
            tx.finish()
        }
    }

    var isAlive: Bool { process.isRunning }

    func write(_ s: String) {
        lock.lock(); defer { lock.unlock() }
        guard !killed else { return }
        try? stdinPipe.fileHandleForWriting.write(contentsOf: Data(s.utf8))
    }

    /// Kill the child (and the disclaimed helper behind the shim's process group).
    func kill() {
        lock.lock()
        if killed { lock.unlock(); return }
        killed = true
        lock.unlock()
        let pid = process.processIdentifier
        if groupLeader, pid > 0 { Darwin.killpg(pid, SIGKILL) }
        if process.isRunning, pid > 0 { Darwin.kill(pid, SIGKILL) }
        try? stdinPipe.fileHandleForWriting.close()
    }
}

// MARK: - Dictation state (voice.rs DictationState)

/// The running capture: dropping/tearing it down kills the helper and every
/// task that belongs to it.
final class VoiceActive: @unchecked Sendable {
    let session: VoiceSession
    var tasks: [Task<Void, Never>] = []
    let helper: VoiceHelperProcess
    let final: VoiceOneShot<String>?
    let lastPartial: VoiceBox<String>

    init(session: VoiceSession, helper: VoiceHelperProcess, final: VoiceOneShot<String>?, lastPartial: VoiceBox<String>) {
        self.session = session
        self.helper = helper
        self.final = final
        self.lastPartial = lastPartial
    }

    func teardown() {
        session.cancel()
        tasks.forEach { $0.cancel() }
        helper.kill()
        final?.close()
    }
}

actor VoiceDictation {
    static let shared = VoiceDictation()
    private var active: VoiceActive?
    private var warm: VoiceHelperProcess?

    var isIdle: Bool { active == nil }

    private static func hasDoubao(_ s: VoiceSettings) -> Bool { s.engineIsDoubao && VoiceSecrets.has("doubao") }

    /// Park a `stream --standby` helper for the next Doubao dictation.
    func prewarm() async {
        let s = VoiceSettings.load()
        guard s.voiceEnabled, VoiceDictation.hasDoubao(s), Env.process["CETUS_SPEECH_HELPER"] == nil else { return }
        let compiled = await Task.detached { VoiceHelper.path != nil && { _ = VoiceHelper.shim; return true }() }.value
        guard compiled else { return }
        if let w = warm {
            if w.isAlive { return }
            warm = nil
        }
        warm = try? VoiceHelperProcess(subcommand: ["stream", "--standby"])
    }

    private func takeWarm() -> VoiceHelperProcess? {
        guard let w = warm else { return nil }
        warm = nil
        return w.isAlive ? w : nil
    }

    /// Kill a parked standby helper (voice disabled / app quit).
    func dropWarm() {
        warm?.kill()
        warm = nil
    }

    // MARK: Push-to-talk

    /// Start capturing the mic and streaming a transcript (voice.rs start_internal).
    func start(target: String, session: VoiceSession, headless: Bool = false) async throws {
        if active != nil { throw VoiceASRError("a dictation is already running") }
        let settings = VoiceSettings.load()
        let emitter = VoiceEmitter(session: session, headless: headless)

        if VoiceDictation.hasDoubao(settings), let key = VoiceSecrets.get("doubao") {
            let resource = Doubao.defaultResourceId
            let corpusTask = Task.detached { VoiceBiasing.buildCorpus(settings) }
            var helper: VoiceHelperProcess?
            if let w = takeWarm() {
                w.write("go\n")
                VoiceLog.debug("doubao asr: using pre-warmed helper")
                helper = w
            }
            let proc = try helper ?? VoiceHelperProcess(subcommand: ["stream"])
            let final = VoiceOneShot<String>()
            let (pcmRx, pcmTx) = Doubao.PCM.makeStream()
            let lastPartial = VoiceBox("")
            let speechSeen = VoiceBox(true)

            let streamTask = Task {
                let corpus = await voiceWithTimeout(0.3) { await corpusTask.value } ?? VoiceCorpus()
                session.mark("context_ready")
                VoiceLog.info("doubao asr (push-to-talk) starting: resource_id=\(resource), hotwords=\(corpus.hotwords.count), context=\(corpus.context != nil), recent=\(corpus.recent != nil), table=\(corpus.boostingTableId != nil)")
                let first = VoiceBox(true)
                var text: String
                do {
                    text = try await Doubao.stream(key: key, resource: resource, corpus: corpus, pcm: pcmRx, onPartial: { t in
                        guard session.isLive else { return }
                        if first.value { first.value = false; session.mark("first_result") }
                        lastPartial.value = t
                        emitter.emit(.partial(t))
                    }, session: session)
                } catch {
                    VoiceLog.info("doubao stream failed: \(error)")
                    emitter.emit(.error("Doubao recognition failed"))
                    text = ""
                }
                if !speechSeen.value && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.count <= 10 {
                    VoiceLog.info("doubao asr: no speech detected; discarding \(text.count) chars of noise transcript")
                    text = ""
                }
                VoiceLog.info("doubao asr (push-to-talk) final [\(target)]: \(text.count) chars: \(VoiceLog.preview(text))")
                guard session.isLive else { return }
                session.mark("asr_final")
                emitter.emit(.final(text))
                final.send(text)
            }

            let readerTask = Task {
                var firstPcm = true
                for await line in proc.lines {
                    if !session.isLive || Task.isCancelled { break }
                    guard let v = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
                    if let p = v["pcm"] as? String {
                        if let bytes = Data(base64Encoded: p) {
                            if firstPcm { session.mark("first_pcm"); firstPcm = false }
                            pcmTx.yield(bytes)
                        }
                    } else if let l = v["level"] as? Double {
                        emitter.emit(.level(l))
                    } else if v["ready"] != nil {
                        session.mark("capture_ready")
                        emitter.emit(.ready)
                    } else if let s = v["speech"] as? Bool {
                        speechSeen.value = s
                    } else if v["pcm_end"] != nil {
                        break
                    } else if let e = v["error"] as? String {
                        emitter.emit(.error(e))
                        break
                    }
                }
                pcmTx.finish()
            }

            let a = VoiceActive(session: session, helper: proc, final: final, lastPartial: lastPartial)
            a.tasks = [streamTask, readerTask]
            active = a
            Task { await self.prewarm() }
            return
        }

        // Apple on-device path (`listen`).
        if settings.engineIsDoubao {
            VoiceLog.info("doubao selected but no key set → falling back to Apple on-device asr")
        } else {
            VoiceLog.info("apple on-device asr (push-to-talk) starting")
        }
        let proc = try VoiceHelperProcess(subcommand: ["listen"])
        let final = VoiceOneShot<String>()
        let lastPartial = VoiceBox("")
        let readerTask = Task {
            var firstPartial = true, sawReady = false, sawTerminal = false
            for await line in proc.lines {
                if !session.isLive || Task.isCancelled { break }
                guard let v = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
                if let l = v["level"] as? Double {
                    emitter.emit(.level(l))
                } else if let p = v["partial"] as? String {
                    if firstPartial { session.mark("first_result"); firstPartial = false }
                    lastPartial.value = p
                    emitter.emit(.partial(p))
                } else if let f = v["final"] as? String {
                    sawTerminal = true
                    session.mark("asr_final")
                    VoiceLog.info("apple asr final [\(target)]: \(f.count) chars: \(VoiceLog.preview(f))")
                    final.send(f)
                    emitter.emit(.final(f))
                } else if v["ready"] != nil {
                    sawReady = true
                    session.mark("capture_ready")
                    emitter.emit(.ready)
                } else if let e = v["error"] as? String {
                    sawTerminal = true
                    emitter.emit(.error(e))
                }
            }
            final.send("")
            if !sawTerminal && !Task.isCancelled {
                emitter.emit(.error(sawReady ? "dictation ended unexpectedly"
                    : "couldn't start dictation — check Microphone & Speech Recognition access for cetus in System Settings › Privacy & Security"))
            }
        }
        let a = VoiceActive(session: session, helper: proc, final: final, lastPartial: lastPartial)
        a.tasks = [readerTask]
        active = a
    }

    /// Finalize (newline → helper stdin), wait ≤8 s for the final transcript, and
    /// return it — or the last partial on timeout. "" when nothing is running.
    func stop() async throws -> String {
        guard let a = active else { return "" }
        active = nil
        defer { a.teardown() }
        a.helper.write("\n")
        var text = ""
        if let f = a.final {
            if let r = await voiceWithTimeout(8, { await f.wait() }), let t = r {
                text = t
            } else {
                a.session.mark("asr_timeout")
                text = a.lastPartial.value
            }
        }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && a.session.failed {
            throw VoiceASRError("dictation failed")
        }
        return text
    }

    /// Abort immediately, discarding any transcript.
    func cancel() {
        active?.teardown()
        active = nil
    }

    /// Block until the slot is free (or `timeout` elapses).
    func awaitSlotFree(_ timeout: Double) async {
        let deadline = Date().addingTimeInterval(timeout)
        while active != nil && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    private func clearIfSession(_ id: UInt64) {
        if active?.session.id == id {
            active?.teardown()
            active = nil
        }
    }

    // MARK: Hands-free

    /// Continuous Doubao session inserting each VAD-complete sentence live.
    func startHandsFree() async throws -> UInt64 {
        guard let key = VoiceSecrets.get("doubao") else { throw VoiceASRError("hands-free requires the Doubao engine + key") }
        if active != nil { throw VoiceASRError("a dictation is already running") }
        let session = VoiceSession()
        let resource = Doubao.defaultResourceId
        let settings = VoiceSettings.load()
        let corpus = VoiceBiasing.buildCorpus(settings)
        VoiceLog.info("doubao asr (hands-free) starting: resource_id=\(resource), hotwords=\(corpus.hotwords.count), context=\(corpus.context != nil), recent=\(corpus.recent != nil), table=\(corpus.boostingTableId != nil)")
        let proc = try VoiceHelperProcess(subcommand: ["stream"])
        let (pcmRx, pcmTx) = Doubao.PCM.makeStream()
        let emitter = VoiceEmitter(session: session, headless: false)
        let prevEnd = VoiceBox<Character?>(nil)
        let streamTask = Task {
            let onSentence: @Sendable (String) -> Void = { sentence in
                guard session.isLive else { return }
                let s = VoiceText.normalizeZhEnSpacing(sentence.trimmingCharacters(in: .whitespacesAndNewlines))
                if s.isEmpty { return }
                VoiceLog.info("doubao asr (hands-free) sentence: \(VoiceLog.preview(s))")
                emitter.emit(.partial(s))
                var payload = ""
                if let first = s.unicodeScalars.first, first.isASCII, CharacterSet.alphanumerics.contains(first),
                   let prev = prevEnd.value, !prev.isASCII {
                    payload.append(" ")
                }
                payload += s
                if s.last?.isASCII == true { payload.append(" ") }
                prevEnd.value = payload.last
                VoiceTextInput.insert(payload)
                VoiceTranscripts.record(s)
            }
            do {
                try await Doubao.streamHandsFree(key: key, resource: resource, corpus: corpus, pcm: pcmRx, onPartial: { _ in }, onSentence: onSentence)
            } catch {
                VoiceLog.info("doubao hands-free stream failed: \(error)")
                emitter.emit(.error("Doubao recognition failed"))
            }
            emitter.emit(.final(""))
            await self.clearIfSession(session.id)
        }
        let readerTask = Task {
            for await line in proc.lines {
                if Task.isCancelled { break }
                guard let v = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
                if let p = v["pcm"] as? String {
                    if let bytes = Data(base64Encoded: p) { pcmTx.yield(bytes) }
                } else if let l = v["level"] as? Double {
                    emitter.emit(.level(l))
                } else if v["ready"] != nil {
                    emitter.emit(.ready)
                } else if v["pcm_end"] != nil {
                    break
                } else if let e = v["error"] as? String {
                    emitter.emit(.error(e))
                    break
                }
            }
            pcmTx.finish()
        }
        let a = VoiceActive(session: session, helper: proc, final: nil, lastPartial: VoiceBox(""))
        a.tasks = [streamTask, readerTask]
        active = a
        return session.id
    }

    /// Graceful hands-free stop: the helper flushes the trailing audio and exits.
    func stopHandsFree() {
        active?.helper.write("\n")
    }
}
