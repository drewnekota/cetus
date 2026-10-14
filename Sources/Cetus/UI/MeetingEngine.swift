import AppKit
import Carbon.HIToolbox
import Foundation
import NaturalLanguage
import Observation

// The meeting runtime (meeting.rs): the single in-flight capture session
// (start/stop/reader/watchdog), the auto-detect monitor loop, the post-meeting
// summary, live captions for the HUD + Settings, lifecycle notifications, and
// the global toggle hotkey. Capture itself is Cetus's own helper binary
// (`cetus-meeting-helper record|monitor`), spawned exactly like the Tauri app.

struct MeetingStatus: Equatable {
    var recording = false
    var startedTs: Double?
    var auto = false
    var appHint: String?
    var segments = 0
    var engine = "idle"
    var meetingId: String?
}

/// One live-caption line (`meeting-caption` event).
struct MeetingCaption {
    var meetingId: String
    var source: String
    var kind: String
    var ts: Double
    var text: String
}

@MainActor
@Observable
final class MeetingEngine {
    static let shared = MeetingEngine()

    private(set) var status = MeetingStatus()
    /// Bumped on every lifecycle event (started / stopped / saved).
    private(set) var eventSeq = 0
    /// Bumped on every caption; `lastCaption` is the newest one.
    private(set) var captionSeq = 0
    @ObservationIgnored private(set) var lastCaption: MeetingCaption?
    @ObservationIgnored var captionListeners: [UUID: (MeetingCaption) -> Void] = [:]

    @ObservationIgnored private weak var app: AppState?
    @ObservationIgnored private var session: Session?
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var autoSuppressed = false
    @ObservationIgnored private var booted = false
    @ObservationIgnored private var awakeToken: NSObjectProtocol?

    final class Session {
        let id: String
        let startedTs: Double
        let auto: Bool
        let appHint: String?
        let engine: String
        let process: Process
        var stdin: FileHandle?
        let pid: Int32
        let grouped: Bool
        var segments = 0
        var lastActivity: Double
        init(id: String, startedTs: Double, auto: Bool, appHint: String?, engine: String, process: Process, stdin: FileHandle, grouped: Bool) {
            self.id = id; self.startedTs = startedTs; self.auto = auto; self.appHint = appHint; self.engine = engine
            self.process = process; self.stdin = stdin; pid = process.processIdentifier; self.grouped = grouped
            lastActivity = startedTs
        }
    }

    // MARK: Boot / shutdown

    /// Start the monitor loop and register the toggle hotkey. Idempotent.
    func boot(_ app: AppState) {
        self.app = app
        guard !booted else { return }
        booted = true
        Task { await monitorLoop() }
        syncHotkey()
        NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in MeetingEngine.shared.syncHotkey() }
        }
    }

    /// Synchronous exit hook: never leave a capture helper holding the mic.
    func shutdown() {
        if let s = session { Self.kill(s) }
        if let m = monitor { m.process.terminate(); try? m.stdin.close() }
        MeetingHotkey.unregister()
    }

    nonisolated private static func kill(_ s: Session) {
        if s.pid > 0 { Darwin.kill(s.grouped ? -s.pid : s.pid, SIGKILL) }
    }

    // MARK: Start / stop

    func start(auto: Bool, appHint: String?) async throws {
        if session != nil || starting { throw MeetingError.message("a meeting is already being recorded") }
        starting = true
        defer { starting = false }
        guard let (program, lead) = await Task.detached(operation: { MeetingHelper.command() }).value else {
            throw MeetingError.message("meeting helper unavailable (swiftc missing?)")
        }
        let settings = MeetingSettingsStore.load()
        let doubaoKey = IntelData.secrets()["doubao"] ?? ""
        let cloud = settings.asrEngine != "local" && !doubaoKey.isEmpty
        var args = lead + ["record"]
        if !settings.systemAudio { args.append("--no-system") }
        if cloud { args.append("--cloud") }
        args.append("--no-aec")
        let id = UUID().uuidString.lowercased()
        if settings.saveAudio { args += ["--save-dir", MeetingPaths.audioDir(id).path] }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: program)
        p.arguments = args
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { throw MeetingError.message("failed to start meeting capture: \(error)") }
        let grouped = (program as NSString).lastPathComponent.contains("spawn-disclaim")

        let startedTs = nowMs()
        let s = Session(id: id, startedTs: startedTs, auto: auto, appHint: appHint, engine: cloud ? "cloud" : "local",
                        process: p, stdin: inPipe.fileHandleForWriting, grouped: grouped)
        guard MeetingDB.shared.insertMeeting(id: id, startedTs: startedTs, appName: appHint) else {
            Self.kill(s)
            p.waitUntilExit()
            MeetingPaths.removeAudioDir(id)
            throw MeetingError.message("failed to save the meeting")
        }
        session = s
        publish()
        awakeBegin()
        emitEvent("started", id: id, appHint: appHint, title: nil)
        MeetingHUD.shared.show()
        startWatchdog(id)
        startReader(s, stdout: outPipe.fileHandleForReading, cloud: cloud, key: doubaoKey)
    }

    /// Ask the live session to finalize; false when nothing was recording.
    @discardableResult
    func stop(suppressAuto: Bool) async -> Bool {
        guard let s = session else { return false }
        let stdin = s.stdin
        s.stdin = nil
        if suppressAuto { autoSuppressed = true }
        if let stdin {
            try? stdin.write(contentsOf: Data("\n".utf8))
            try? stdin.close()
        }
        for i in 0..<80 {
            if session == nil || session?.id != s.id { return true }
            if i == 60 { Self.kill(s) }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        return true
    }

    func toggleFromHotkey() {
        Task {
            if await stop(suppressAuto: true) { return }
            try? await start(auto: false, appHint: nil)
        }
    }

    private func publish() {
        if let s = session {
            status = MeetingStatus(recording: true, startedTs: s.startedTs, auto: s.auto, appHint: s.appHint, segments: s.segments, engine: s.engine, meetingId: s.id)
        } else {
            status = MeetingStatus()
        }
    }

    private func startWatchdog(_ id: String) {
        Task {
            while true {
                try? await Task.sleep(nanoseconds: UInt64(MeetingConst.watchdogTickSecs * 1e9))
                guard let s = session, s.id == id else { return }
                let now = nowMs()
                let overMax = now - s.startedTs >= MeetingConst.maxSessionSecs * 1000
                let idle = s.auto && now - s.lastActivity >= MeetingConst.autoIdleStopSecs * 1000
                if overMax || idle {
                    await stop(suppressAuto: true)
                    return
                }
            }
        }
    }

    // MARK: Reader

    private func startReader(_ s: Session, stdout: FileHandle, cloud: Bool, key: String) {
        let id = s.id, appHint = s.appHint
        let hotwords = cloud ? MeetingBiasing.hotwords() : []
        Thread.detachNewThread {
            var mic: MeetingASRStream?
            var system: MeetingASRStream?
            var spawned = false
            var buf = Data()
            func handle(_ line: Data) {
                guard let v = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
                if let pcm = v["pcm"] as? [String: Any] {
                    let source = pcm["source"] as? String ?? "mic"
                    guard let b64 = pcm["data"] as? String, let bytes = Data(base64Encoded: b64) else { return }
                    if cloud && !spawned {
                        spawned = true
                        mic = Self.cloudStream(id: id, source: "mic", key: key, hotwords: hotwords, appHint: appHint)
                        system = Self.cloudStream(id: id, source: "system", key: key, hotwords: hotwords, appHint: appHint)
                    }
                    (source == "system" ? system : mic)?.input.send(bytes)
                } else if let src = v["pcm_end"] as? String {
                    (src == "system" ? system : mic)?.input.close()
                } else if let p = v["partial"] as? [String: Any] {
                    let src = p["source"] as? String ?? "mic"
                    let ts = (p["ts"] as? NSNumber)?.doubleValue ?? nowMs()
                    let text = p["text"] as? String ?? ""
                    DispatchQueue.main.async { MeetingEngine.shared.caption(id: id, source: src, kind: "partial", ts: ts, text: text) }
                } else if let seg = v["segment"] as? [String: Any] {
                    let src = seg["source"] as? String ?? "mic"
                    let ts = (seg["ts"] as? NSNumber)?.doubleValue ?? nowMs()
                    let text = (seg["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    DispatchQueue.main.async { MeetingEngine.shared.segment(id: id, source: src, ts: ts, text: text, appHint: appHint) }
                }
            }
            while true {
                let chunk = stdout.availableData
                if chunk.isEmpty { break }
                buf.append(chunk)
                while let nl = buf.firstIndex(of: 0x0A) {
                    let line = buf[buf.startIndex..<nl]
                    buf.removeSubrange(buf.startIndex...nl)
                    if !line.isEmpty { handle(Data(line)) }
                }
            }
            let streams = [mic, system].compactMap { $0 }
            Task.detached {
                for st in streams { await st.finish() }
                s.process.waitUntilExit()
                await MeetingEngine.shared.finalize(id: id, appHint: appHint)
            }
        }
    }

    nonisolated private static func cloudStream(id: String, source: String, key: String, hotwords: [String], appHint: String?) -> MeetingASRStream {
        MeetingASRStream(key: key, resource: MeetingDoubao.defaultResource, hotwords: hotwords, onPartial: { text in
            DispatchQueue.main.async { MeetingEngine.shared.caption(id: id, source: source, kind: "partial", ts: nowMs(), text: text) }
        }, onSentence: { text in
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return }
            let ts = nowMs()
            DispatchQueue.main.async { MeetingEngine.shared.segment(id: id, source: source, ts: ts, text: t, appHint: appHint) }
        })
    }

    private func segment(id: String, source: String, ts: Double, text: String, appHint: String?) {
        caption(id: id, source: source, kind: "final", ts: ts, text: text)
        MeetingDB.shared.insertSegment(meetingId: id, ts: ts, source: source, text: text)
        MeetingRecall.append(ts: ts, kind: "segment", source: source, app: appHint, title: nil, text: text)
        if let s = session, s.id == id {
            s.segments += 1
            publish()
        }
    }

    /// emit_caption: feeds the idle watchdog and the live-caption consumers.
    private func caption(id: String, source: String, kind: String, ts: Double, text: String) {
        if let s = session, s.id == id { s.lastActivity = nowMs() }
        let c = MeetingCaption(meetingId: id, source: source, kind: kind, ts: ts, text: text)
        lastCaption = c
        captionSeq += 1
        for l in captionListeners.values { l(c) }
    }

    private func finalize(id: String, appHint: String?) async {
        let count = session?.id == id ? session?.segments ?? 0 : 0
        if session?.id == id {
            session = nil
            publish()
        }
        MeetingHUD.shared.hide()
        awakeEnd()
        emitEvent("stopped", id: id, appHint: appHint, title: nil)
        MeetingDB.shared.finishMeeting(id: id, endedTs: nowMs(), segmentCount: count)
        if count == 0 {
            MeetingDB.shared.delete(id)
            MeetingPaths.removeAudioDir(id)
            return
        }
        if MeetingSettingsStore.load().summarize {
            do { try await summarize(id: id, appHint: appHint) } catch { emitEvent("saved", id: id, appHint: appHint, title: nil) }
        } else {
            emitEvent("saved", id: id, appHint: appHint, title: nil)
        }
    }

    // MARK: Summary (summary.rs)

    private func summarize(id: String, appHint: String?) async throws {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        var transcript = ""
        for s in MeetingDB.shared.segments(id) {
            transcript += "[\(f.string(from: Date(timeIntervalSince1970: s.ts / 1000)))] (\(s.source)) \(s.text)\n"
        }
        let total = transcript.count
        if total < MeetingConst.summaryMinChars {
            emitEvent("saved", id: id, appHint: appHint, title: nil)
            return
        }
        if total > MeetingConst.summaryHeadChars + MeetingConst.summaryTailChars {
            transcript = String(transcript.prefix(MeetingConst.summaryHeadChars)) + "\n[… transcript truncated …]\n" + String(transcript.suffix(MeetingConst.summaryTailChars))
        }
        guard let target = MeetingUtilityTarget.resolve() else { throw MeetingError.message("no LLM endpoint configured; skipping meeting summary") }
        let body: [String: Any] = [
            "model": target.model,
            "messages": [["role": "system", "content": MeetingConst.summarySystemPrompt], ["role": "user", "content": transcript]],
            "stream": false, "temperature": 0.3, "max_tokens": 2048, "response_format": ["type": "json_object"],
        ]
        guard let url = URL(string: target.url) else { throw MeetingError.message("bad summary url") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 90
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        if !target.apiKey.isEmpty { req.setValue("Bearer \(target.apiKey)", forHTTPHeaderField: "authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw MeetingError.message("meeting summary failed: \((resp as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        guard let v = (try JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let content = (((v["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"] as? String) else {
            throw MeetingError.message("summary response missing content")
        }
        var c = content.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in ["```json", "```"] { while c.hasPrefix(p) { c.removeFirst(p.count) } }
        while c.hasSuffix("```") { c.removeLast(3) }
        c = c.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = (try JSONSerialization.jsonObject(with: Data(c.utf8))) as? [String: Any] else { throw MeetingError.message("summary not JSON") }
        let title = ((parsed["title"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = ((parsed["summary"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if summary.isEmpty {
            emitEvent("saved", id: id, appHint: appHint, title: nil)
            return
        }
        MeetingDB.shared.setSummary(id: id, title: title, summary: summary)
        MeetingRecall.append(ts: nowMs(), kind: "summary", source: "summary", app: appHint, title: title, text: summary)
        emitEvent("saved", id: id, appHint: appHint, title: title.isEmpty ? nil : title)
    }

    // MARK: Events / notifications

    private func emitEvent(_ kind: String, id: String, appHint: String?, title: String?) {
        eventSeq += 1
        // "stopped" is a UI-resync signal only — no notification.
        guard kind != "stopped", let app else { return }
        let n = app.prefs.notifications
        guard n.enabled, UserDefaults.standard.object(forKey: "settings.notifyMeeting") as? Bool ?? true else { return }
        let started = kind == "started"
        Notifier.post(title: started ? "Transcribing meeting" : "Meeting notes ready",
                      body: (!started ? title : nil) ?? (started ? "Cetus is transcribing this meeting on-device." : "Transcript saved and searchable."),
                      muteWhenFocused: n.muteWhenFocused)
    }

    private func awakeBegin() {
        guard UserDefaults.standard.object(forKey: "settings.keepAwakeWhileWorking") as? Bool ?? true, awakeToken == nil else { return }
        awakeToken = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled], reason: "Cetus is recording a meeting")
    }

    private func awakeEnd() {
        if let t = awakeToken { ProcessInfo.processInfo.endActivity(t) }
        awakeToken = nil
    }

    // MARK: Settings-facing operations

    func list(limit: Int = 50) -> [MeetingRecord] { MeetingDB.shared.list(limit: min(limit, 200)) }
    func transcript(_ id: String) -> [MeetingSegmentRecord] { MeetingDB.shared.segments(id) }
    func delete(_ id: String) {
        MeetingDB.shared.delete(id)
        MeetingPaths.removeAudioDir(id)
    }

    // MARK: Auto-detect monitor (monitor.rs)

    private final class Monitor {
        let process: Process
        let stdin: FileHandle
        var exited = false
        var warned = false
        init(process: Process, stdin: FileHandle) { self.process = process; self.stdin = stdin }
    }

    @ObservationIgnored private var monitor: Monitor?
    @ObservationIgnored private var rawMicActive = false
    @ObservationIgnored private var rawMicApps: [String] = []

    private func stopMonitor() async {
        guard let m = monitor else { return }
        monitor = nil
        try? m.stdin.close()
        let p = m.process
        await Task.detached { p.waitUntilExit() }.value
    }

    private func monitorLoop() async {
        var micActive = false
        var trusted: String?
        var activeSince: Date?
        var inactiveSince: Date?
        var lastPrune = Date()
        var helperBroken = false
        while true {
            let settings = MeetingSettingsStore.load()
            if Date().timeIntervalSince(lastPrune) >= MeetingConst.pruneIntervalSecs {
                let days = settings.retentionDays
                await Task.detached { MeetingDB.prune(retentionDays: days) }.value
                lastPrune = Date()
            }
            if !(settings.enabled && settings.autoDetect) || helperBroken {
                await stopMonitor()
                micActive = false; rawMicActive = false; rawMicApps = []
                trusted = nil; activeSince = nil; inactiveSince = nil
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                continue
            }
            if monitor == nil {
                guard let (program, lead) = await Task.detached(operation: { MeetingHelper.command() }).value else {
                    helperBroken = true
                    continue
                }
                let p = Process()
                p.executableURL = URL(fileURLWithPath: program)
                p.arguments = lead + ["monitor"]
                let inPipe = Pipe(), outPipe = Pipe()
                p.standardInput = inPipe
                p.standardOutput = outPipe
                p.standardError = FileHandle.nullDevice
                do { try p.run() } catch { helperBroken = true; continue }
                let m = Monitor(process: p, stdin: inPipe.fileHandleForWriting)
                monitor = m
                let out = outPipe.fileHandleForReading
                Thread.detachNewThread {
                    var buf = Data()
                    while true {
                        let chunk = out.availableData
                        if chunk.isEmpty { break }
                        buf.append(chunk)
                        while let nl = buf.firstIndex(of: 0x0A) {
                            let line = Data(buf[buf.startIndex..<nl])
                            buf.removeSubrange(buf.startIndex...nl)
                            guard let v = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
                            DispatchQueue.main.async { MeetingEngine.shared.monitorLine(v, m) }
                        }
                    }
                    DispatchQueue.main.async { m.exited = true }
                }
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if let m = monitor {
                if m.warned { helperBroken = true; continue }
                if m.exited {
                    await stopMonitor()
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }

            // Raw microphone occupancy → trusted meeting occupancy.
            if !rawMicActive {
                trusted = nil
            } else if !(trusted.map { rawMicApps.contains($0) } ?? false) {
                let apps = rawMicApps
                trusted = await Task.detached { MeetingDetect.trustedApp(apps) }.value
            }
            let nowActive = trusted != nil
            if nowActive != micActive {
                micActive = nowActive
                if micActive { activeSince = Date(); inactiveSince = nil } else { inactiveSince = Date(); activeSince = nil }
            }
            if !micActive { autoSuppressed = false }
            switch session?.auto {
            case nil where micActive && !autoSuppressed && (activeSince.map { Date().timeIntervalSince($0) >= MeetingConst.autoStartSecs } ?? false):
                do { try await start(auto: true, appHint: trusted) } catch { activeSince = Date() }
            case true? where !micActive && (inactiveSince.map { Date().timeIntervalSince($0) >= MeetingConst.autoStopSecs } ?? false):
                await stop(suppressAuto: false)
                inactiveSince = nil
            default: break
            }
        }
    }

    private func monitorLine(_ v: [String: Any], _ m: Monitor) {
        guard monitor === m else { return }
        if let mic = v["mic"] as? [String: Any] {
            let own = session?.pid
            let pids = ((mic["pids"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.int32Value }.filter { $0 != own }
            rawMicActive = !pids.isEmpty
            rawMicApps = (mic["apps"] as? [Any])?.compactMap { $0 as? String } ?? []
        } else if v["warn"] != nil {
            m.warned = true
        }
    }

    // MARK: Hotkey

    @ObservationIgnored private var registeredHotkey: String?

    func syncHotkey() {
        let s = MeetingSettingsStore.load()
        let want = s.enabled ? s.toggleHotkey.trimmingCharacters(in: .whitespaces) : ""
        guard want != (registeredHotkey ?? "") else { return }
        registeredHotkey = want
        MeetingHotkey.unregister()
        if !want.isEmpty { MeetingHotkey.register(want) { MeetingEngine.shared.toggleFromHotkey() } }
    }
}

// MARK: - Global toggle hotkey (Carbon, "Cmd+Shift+M" accelerator format)

enum MeetingHotkey {
    nonisolated(unsafe) private static var ref: EventHotKeyRef?
    nonisolated(unsafe) private static var handler: EventHandlerRef?
    nonisolated(unsafe) private static var action: (@MainActor () -> Void)?
    private static let signature: OSType = 0x4D_45_45_54 // 'MEET'

    static func register(_ accelerator: String, _ action: @escaping @MainActor () -> Void) {
        guard let (code, mods) = parse(accelerator) else { return }
        self.action = action
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
                var hk = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
                guard hk.signature == MeetingHotkey.signature else { return OSStatus(eventNotHandledErr) }
                DispatchQueue.main.async { MainActor.assumeIsolated { MeetingHotkey.action?() } }
                return noErr
            }, 1, &spec, nil, &handler)
        }
        var r: EventHotKeyRef?
        if RegisterEventHotKey(code, mods, EventHotKeyID(signature: signature, id: 1), GetApplicationEventTarget(), 0, &r) == noErr { ref = r }
    }

    static func unregister() {
        if let r = ref { UnregisterEventHotKey(r) }
        ref = nil
    }

    static func parse(_ s: String) -> (UInt32, UInt32)? {
        var mods: UInt32 = 0
        var key: UInt32?
        for raw in s.split(separator: "+") {
            let t = raw.trimmingCharacters(in: .whitespaces).lowercased()
            switch t {
            case "cmd", "command", "super", "meta", "cmdorctrl", "commandorcontrol", "cmdorcontrol", "commandorctrl": mods |= UInt32(cmdKey)
            case "shift": mods |= UInt32(shiftKey)
            case "alt", "option": mods |= UInt32(optionKey)
            case "ctrl", "control": mods |= UInt32(controlKey)
            default: key = keyCode(t)
            }
        }
        guard let key else { return nil }
        return (key, mods)
    }

    private static func keyCode(_ k: String) -> UInt32? {
        let letters: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
            "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
            "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
            "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
            "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "space": kVK_Space, "enter": kVK_Return, "return": kVK_Return, "tab": kVK_Tab, "escape": kVK_Escape, "esc": kVK_Escape,
            "backspace": kVK_Delete, "delete": kVK_ForwardDelete, "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow,
            "right": kVK_RightArrow, "arrowup": kVK_UpArrow, "arrowdown": kVK_DownArrow, "arrowleft": kVK_LeftArrow, "arrowright": kVK_RightArrow,
            "minus": kVK_ANSI_Minus, "-": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "=": kVK_ANSI_Equal, "comma": kVK_ANSI_Comma, ",": kVK_ANSI_Comma,
            "period": kVK_ANSI_Period, ".": kVK_ANSI_Period, "slash": kVK_ANSI_Slash, "/": kVK_ANSI_Slash, "semicolon": kVK_ANSI_Semicolon,
            ";": kVK_ANSI_Semicolon, "quote": kVK_ANSI_Quote, "'": kVK_ANSI_Quote, "backquote": kVK_ANSI_Grave, "`": kVK_ANSI_Grave,
            "bracketleft": kVK_ANSI_LeftBracket, "[": kVK_ANSI_LeftBracket, "bracketright": kVK_ANSI_RightBracket, "]": kVK_ANSI_RightBracket,
            "backslash": kVK_ANSI_Backslash, "\\": kVK_ANSI_Backslash, "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
            "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8,
            "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12, "f13": kVK_F13, "f14": kVK_F14, "f15": kVK_F15,
            "f16": kVK_F16, "f17": kVK_F17, "f18": kVK_F18, "f19": kVK_F19, "f20": kVK_F20,
        ]
        var name = k
        if name.hasPrefix("key"), name.count == 4 { name.removeFirst(3) }
        if name.hasPrefix("digit"), name.count == 6 { name.removeFirst(5) }
        return letters[name].map { UInt32($0) }
    }
}

// MARK: - Recognition biasing for cloud ASR (biasing::hotwords)

enum MeetingBiasing {
    private static let maxHotwords = 24
    private static let stopwords: Set<String> = [
        "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one", "our", "out", "day", "get", "has",
        "him", "his", "how", "man", "new", "now", "old", "see", "two", "way", "who", "boy", "did", "its", "let", "put", "say", "she",
        "too", "use", "that", "this", "with", "have", "from", "they", "will", "would", "there", "their", "what", "about", "which",
        "when", "make", "like", "time", "just", "know", "take", "into", "your", "some", "could", "them", "than", "then", "look",
        "only", "come", "over", "also", "back", "after", "want", "because", "good", "much", "where", "very", "well", "should",
        "okay", "yeah", "gonna", "really", "thing", "things", "something", "anything", "everything",
    ]

    /// Manual list + correction-confirmed + learned + memory terms — only when
    /// context biasing is on (quick settings), like meeting/transcription.rs.
    static func hotwords() -> [String] {
        let quick = CapStored<CapQuickSettings>(rawValue: UserDefaults.standard.string(forKey: "settings.quick") ?? "{}")?.value ?? .init()
        guard quick.voiceContextBiasing else { return [] }
        var out: [String] = []
        var seen = Set<String>()
        func add(_ raw: String) {
            guard out.count < maxHotwords else { return }
            let w = (raw.split(separator: "|", omittingEmptySubsequences: false).first.map(String.init) ?? raw).trimmingCharacters(in: .whitespaces)
            guard (2...10).contains(w.count), seen.insert(w.lowercased()).inserted else { return }
            out.append(w)
        }
        for line in quick.voiceHotwords.split(separator: "\n", omittingEmptySubsequences: false) { add(String(line)) }
        let dir = Env.dataDir
        if let c = IntelData.readJSON(dir.appendingPathComponent("corrections.json")) as? [String: Any], let pairs = c["pairs"] as? [[String: Any]] {
            var cseen = Set<String>()
            for p in pairs.sorted(by: { (($0["last_ms"] as? NSNumber)?.doubleValue ?? 0) > (($1["last_ms"] as? NSNumber)?.doubleValue ?? 0) }) {
                if let r = p["right"] as? String, cseen.insert(r.lowercased()).inserted { add(r) }
            }
        }
        if let l = IntelData.readJSON(dir.appendingPathComponent("learned_hotwords.json")) as? [String: Any], let terms = l["terms"] as? [String: [String: Any]] {
            let ranked = terms.values.compactMap { t -> (String, Int)? in
                guard let w = t["word"] as? String, let n = (t["count"] as? NSNumber)?.intValue, n >= 2 else { return nil }
                return (w, n)
            }.sorted { $0.1 > $1.1 }
            for (w, _) in ranked { add(w) }
        }
        if let m = IntelData.readJSON(IntelData.file("memory.json")) as? [String: Any], (m["enabled"] as? Bool) ?? false,
           let entries = m["entries"] as? [[String: Any]] {
            for e in entries where (e["enabled"] as? Bool) ?? true {
                for w in distinctive((e["content"] as? String) ?? "") { add(w) }
            }
        }
        return out
    }

    private static func distinctive(_ text: String) -> [String] {
        var tokens: [String] = []
        var seen = Set<String>()
        for raw in text.split(whereSeparator: { !($0.isASCII && ($0.isLetter || $0.isNumber)) }) where tokens.count < 64 {
            let w = String(raw)
            guard (2...10).contains(w.count), w.contains(where: { $0.isLetter }), !stopwords.contains(w.lowercased()), seen.insert(w.lowercased()).inserted else { continue }
            tokens.append(w)
        }
        guard text.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }) else { return tokens }
        let tagger = NLTagger(tagSchemes: [.nameType])
        tagger.string = text
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: [.omitWhitespace, .omitPunctuation, .joinNames]) { tag, r in
            guard tokens.count < 64 else { return false }
            guard let tag, [.personalName, .placeName, .organizationName].contains(tag) else { return true }
            let w = String(text[r]).trimmingCharacters(in: .whitespaces)
            if (2...10).contains(w.count), w.unicodeScalars.contains(where: { (0x4E00...0x9FFF).contains($0.value) }), seen.insert(w).inserted { tokens.append(w) }
            return true
        }
        return tokens
    }
}
