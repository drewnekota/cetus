import AppKit
import CoreGraphics

// Global push-to-talk / hands-free dictation — port of the voice parts of
// src-tauri/src/hotkey.rs (listen-only CGEventTap, PTT monitor, serialized
// worker, finish_ptt) and caps_remap.rs.

// MARK: - Caps Lock → F18 remap (caps_remap.rs)

enum VoiceCapsRemap {
    static let remappedKeycode: Int64 = 79
    private static let applied = VoiceBox(false)
    private static let mapJSON = #"{"UserKeyMapping":[{"HIDKeyboardModifierMappingSrc":0x700000039,"HIDKeyboardModifierMappingDst":0x70000006D}]}"#
    private static let clearJSON = #"{"UserKeyMapping":[]}"#

    static func setActive(_ active: Bool) {
        if active {
            voiceRun("/usr/bin/hidutil", ["property", "--set", mapJSON])
            applied.value = true
        } else if applied.value {
            applied.value = false
            voiceRun("/usr/bin/hidutil", ["property", "--set", clearJSON])
        }
    }

    static func restore() { setActive(false) }
}

// MARK: - Runtime

enum VoiceCmd: Equatable { case startPtt, stopPttInsert, cancelPtt, toggleHandsFree, stopAll }

final class VoiceRuntime: @unchecked Sendable {
    static let shared = VoiceRuntime()

    // Tap thresholds (hotkey.rs).
    static let pttHoldThreshold: TimeInterval = 0.25
    static let voiceDoubleGap: TimeInterval = 0.3

    // CGEventFlags masks.
    static let lcmd: UInt64 = 0x08, rcmd: UInt64 = 0x10, ralt: UInt64 = 0x40
    static let mShift: UInt64 = 1 << 17, mCtrl: UInt64 = 1 << 18, mAlt: UInt64 = 1 << 19, mCmd: UInt64 = 1 << 20, mFn: UInt64 = 1 << 23
    static let mAll = mShift | mCtrl | mAlt | mCmd | mFn

    static let sessionNone: UInt8 = 0, sessionPtt: UInt8 = 1, sessionHandsFree: UInt8 = 2

    // Shared signals (tap → monitor → worker).
    let inputRevision = VoiceBox<UInt64>(0)
    let cancelRevision = VoiceBox<UInt64>(0)
    let pttHeld = VoiceBox(false)
    let pttDirty = VoiceBox(false)
    let hfGen = VoiceBox<UInt32>(0)
    let sessionKind = VoiceBox(sessionNone)
    let settings = VoiceBox(VoiceSettings())

    // Tap-local tap/double-tap tracker (VoiceTap).
    private var pressAt: Date?
    private var lastTap: Date?
    private var tapDirty = false

    private var started = false
    private var tap: CFMachPort?
    private var tapRunLoop: CFRunLoop?
    private var tapThread: Thread?
    private let queueLock = NSLock()
    private var queue: [VoiceCmd] = []
    private var stopFlag = VoiceBox(false)
    private var lastCapsActive: Bool?
    private var trustTimer: Timer?

    /// Whether this process should own the global voice trigger. Remote-controlled
    /// parity instances opt in explicitly (CETUS_VOICE=1) so test runs never leave
    /// a hot trigger behind.
    static var allowed: Bool { Env.process["CETUS_CONTROL"] == nil || Env.process["CETUS_VOICE"] == "1" }

    /// Idempotent; call once at launch (main thread).
    func start() {
        if Env.process["CETUS_CONTROL"] != nil && !started { VoiceControl.install() }
        guard !started, VoiceRuntime.allowed else { return }
        started = true
        settings.value = VoiceSettings.load()
        NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.applySettings()
        }
        applySettings()
        Thread.detachNewThread { [weak self] in self?.monitorLoop() }
        Task.detached { [weak self] in await self?.workerLoop() }
        Task.detached { await VoiceDictation.shared.prewarm() }
    }

    /// App quit: drop any session, the tap, the warm helper and the Caps remap.
    func shutdown() {
        stopFlag.value = true
        removeTap()
        VoiceCapsRemap.restore()
        let sem = DispatchSemaphore(value: 0)
        Task.detached {
            await VoiceDictation.shared.cancel()
            await VoiceDictation.shared.dropWarm()
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 1)
    }

    /// Re-read settings: tap lifetime follows `voiceEnabled`, Caps remap follows the gesture.
    func applySettings() {
        let s = VoiceSettings.load()
        let old = settings.value
        settings.value = s
        if s.voiceGesture != old.voiceGesture { resetTapState() }
        let caps = s.voiceEnabled && s.gestureCode == VoiceSettings.capsLock
        if caps != lastCapsActive {
            lastCapsActive = caps
            DispatchQueue.global().async { VoiceCapsRemap.setActive(caps) }
        }
        if s.voiceEnabled && s.launcherEnabled { ensureTap() } else { removeTap() }
        if s.voiceEnabled && !old.voiceEnabled { Task.detached { await VoiceDictation.shared.prewarm() } }
        if !s.voiceEnabled && old.voiceEnabled { Task.detached { await VoiceDictation.shared.dropWarm() } }
    }

    private func resetTapState() {
        pressAt = nil; lastTap = nil; tapDirty = false
        pttHeld.value = false; pttDirty.value = false
    }

    // MARK: Event tap

    private func ensureTap() {
        guard tap == nil, tapThread == nil else { return }
        guard AXIsProcessTrusted() else {
            // wait_for_trust: poll until Accessibility is granted.
            if trustTimer == nil {
                trustTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
                    guard let self else { t.invalidate(); return }
                    let s = self.settings.value
                    if !(s.voiceEnabled && s.launcherEnabled) { t.invalidate(); self.trustTimer = nil; return }
                    if AXIsProcessTrusted() { t.invalidate(); self.trustTimer = nil; self.ensureTap() }
                }
            }
            return
        }
        let thread = Thread { [weak self] in self?.runTap() }
        thread.name = "cetus-voice-tap"
        tapThread = thread
        thread.start()
    }

    private func removeTap() {
        trustTimer?.invalidate(); trustTimer = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let rl = tapRunLoop { CFRunLoopStop(rl) }
        tap = nil; tapRunLoop = nil; tapThread = nil
        resetTapState()
    }

    var tapActive: Bool { tap != nil }

    private func runTap() {
        let types: [CGEventType] = [.flagsChanged, .keyDown, .keyUp, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let cb: CGEventTapCallBack = { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            Unmanaged<VoiceRuntime>.fromOpaque(info).takeUnretainedValue().handle(type, event)
            return Unmanaged.passUnretained(event)
        }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                           eventsOfInterest: mask, callback: cb, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            VoiceLog.info("voice: event tap creation failed")
            DispatchQueue.main.async { self.tapThread = nil }
            return
        }
        let src = CFMachPortCreateRunLoopSource(nil, port, 0)
        let rl = CFRunLoopGetCurrent()
        CFRunLoopAddSource(rl, src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        DispatchQueue.main.sync {
            self.tap = port
            self.tapRunLoop = rl
        }
        VoiceLog.info("voice: push-to-talk listener active")
        CFRunLoopRun()
        VoiceLog.info("voice: push-to-talk listener stopped")
    }

    private func cleanHeld(_ bits: UInt64, _ gesture: UInt8) -> Bool {
        let m = bits & VoiceRuntime.mAll
        switch gesture {
        case VoiceSettings.rightCmd: return m == VoiceRuntime.mCmd && bits & VoiceRuntime.rcmd != 0
        case VoiceSettings.rightOption: return m == VoiceRuntime.mAlt && bits & VoiceRuntime.ralt != 0
        case VoiceSettings.fn: return m == VoiceRuntime.mFn
        default: return false
        }
    }

    private func handsfreeAllowed(_ s: VoiceSettings) -> Bool {
        guard s.voiceHandsfreeShortcut else { return false }
        let (_, _, dcmd, dopt) = s.gestureActions
        switch s.gestureCode {
        case VoiceSettings.rightCmd: return dcmd == 0
        case VoiceSettings.rightOption: return dopt == 0
        default: return true
        }
    }

    /// One rising/falling edge of the trigger; returns the previous held state.
    @discardableResult
    private func triggerEdge(_ held: Bool, handsfree: Bool) -> Bool {
        let was = pttHeld.value
        pttHeld.value = held
        if held && !was {
            pressAt = Date()
            tapDirty = false
            pttDirty.value = false
        } else if !held && was {
            let brief = pressAt.map { Date().timeIntervalSince($0) < VoiceRuntime.pttHoldThreshold } ?? false
            pressAt = nil
            if handsfree && brief && !tapDirty {
                let now = Date()
                if let prev = lastTap, now.timeIntervalSince(prev) < VoiceRuntime.voiceDoubleGap {
                    lastTap = nil
                    hfGen.value &+= 1
                } else {
                    lastTap = now
                }
            } else {
                lastTap = nil
            }
            tapDirty = false
        }
        return was
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        let s = settings.value
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            let bits = CGEventSource.flagsState(.combinedSessionState).rawValue
            let held = s.voiceEnabled && cleanHeld(bits, s.gestureCode)
            pttHeld.value = held
            pttDirty.value = false
            pressAt = held ? Date() : nil
            lastTap = nil
            tapDirty = false
            VoiceLog.info("voice: event tap was disabled by the OS; re-armed and resynced")
            return
        }
        if type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown {
            inputRevision.value &+= 1
            return
        }
        let keycode = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .keyDown {
            if keycode != VoiceCapsRemap.remappedKeycode { inputRevision.value &+= 1 }
            if keycode == 53 { cancelRevision.value &+= 1 }
        }
        guard s.launcherEnabled else { return }
        if type == .keyDown { VoiceCorrections.noteUserInput() }
        if type == .keyDown || type == .keyUp {
            if s.voiceEnabled && s.gestureCode == VoiceSettings.capsLock && keycode == VoiceCapsRemap.remappedKeycode {
                triggerEdge(type == .keyDown, handsfree: handsfreeAllowed(s))
                return
            }
            if type == .keyUp { return }
            if s.voiceEnabled {
                if pttHeld.value { pttDirty.value = true }
                tapDirty = true
                lastTap = nil
            }
            return
        }
        // FlagsChanged
        let bits = event.flags.rawValue
        if s.voiceEnabled {
            if s.gestureCode == VoiceSettings.capsLock {
                if bits & VoiceRuntime.mAll != 0 && lastTap != nil { lastTap = nil }
            } else {
                let held = cleanHeld(bits, s.gestureCode)
                let was = triggerEdge(held, handsfree: handsfreeAllowed(s))
                if !held && !was && bits & VoiceRuntime.mAll != 0 && lastTap != nil { lastTap = nil }
            }
        } else {
            pttHeld.value = false
        }
    }

    // MARK: Monitor (run_voice_monitor)

    private func send(_ c: VoiceCmd) {
        queueLock.lock(); queue.append(c); queueLock.unlock()
    }

    private func pop() -> VoiceCmd? {
        queueLock.lock(); defer { queueLock.unlock() }
        return queue.isEmpty ? nil : queue.removeFirst()
    }

    private func monitorLoop() {
        var cancelRev = cancelRevision.value
        var pressStart: Date?
        var engaged = false
        var lastGen = hfGen.value
        var fast = true
        var disabledIdle = false
        while !stopFlag.value {
            usleep(fast ? 15_000 : 200_000)
            let enabled = settings.value.voiceEnabled
            fast = enabled
            if !enabled {
                if !disabledIdle {
                    if engaged { send(.cancelPtt); engaged = false }
                    send(.stopAll)
                    pressStart = nil
                    lastGen = hfGen.value
                    disabledIdle = true
                }
                continue
            }
            disabledIdle = false
            let c = cancelRevision.value
            if c != cancelRev {
                cancelRev = c
                send(.cancelPtt)
                if engaged { pttDirty.value = true }
            }
            let g = hfGen.value
            var pending = g &- lastGen
            while pending > 0 { send(.toggleHandsFree); pending -= 1 }
            lastGen = g
            let kind = sessionKind.value, held = pttHeld.value, dirty = pttDirty.value
            if engaged {
                if !held {
                    send(.stopPttInsert); engaged = false; pressStart = nil
                } else if dirty {
                    send(.cancelPtt); engaged = false; pressStart = nil
                }
            } else if kind == VoiceRuntime.sessionNone && held && !dirty {
                if let t = pressStart {
                    if Date().timeIntervalSince(t) >= VoiceRuntime.pttHoldThreshold {
                        send(.startPtt); engaged = true; pressStart = nil
                    }
                } else {
                    pressStart = Date()
                }
            } else {
                pressStart = nil
            }
        }
    }

    // MARK: Worker (run_voice_worker)

    private func nextCmd() async -> VoiceCmd? {
        while !stopFlag.value {
            if let c = pop() { return c }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return nil
    }

    /// Exposed for the control harness: run a command through the same worker.
    func inject(_ c: VoiceCmd) { send(c) }

    private func workerLoop() async {
        var kind = VoiceRuntime.sessionNone
        var context: (VoiceSession, Task<VoiceTarget?, Never>)?
        var pending: VoiceCmd?
        while true {
            let cmd: VoiceCmd
            if let p = pending { cmd = p; pending = nil } else {
                guard let c = await nextCmd() else { break }
                cmd = c
            }
            switch cmd {
            case .startPtt where kind == VoiceRuntime.sessionNone:
                let session = VoiceSession()
                session.mark("trigger")
                let revision = inputRevision.value
                let identity = VoiceAX.frontmostIdentity()
                let target = Task.detached { () -> VoiceTarget? in
                    guard let id = identity else { return nil }
                    VoiceAX.wakeApp(id.2)
                    return VoiceTarget.capture(id, revision: revision)
                }
                do {
                    try await VoiceDictation.shared.start(target: "global", session: session)
                    await MainActor.run { VoiceHUD.shared.show(sessionId: session.id) }
                    context = (session, target)
                    kind = VoiceRuntime.sessionPtt
                } catch {
                    VoiceLog.info("voice start failed: \(error)")
                    await MainActor.run { VoiceHUD.shared.showNotice("failed", text: nil) }
                }
            case .stopPttInsert where kind == VoiceRuntime.sessionPtt:
                kind = VoiceRuntime.sessionNone
                sessionKind.value = kind
                if let (session, target) = context {
                    context = nil
                    session.mark("released")
                    let done = VoiceBox(false)
                    let finish = Task {
                        await self.finishPtt(session: session, target: target)
                        done.value = true
                    }
                    var interrupted: VoiceCmd??
                    while !done.value {
                        if let c = pop() {
                            if c == .stopPttInsert { continue }
                            interrupted = .some(c)
                            break
                        }
                        if stopFlag.value { interrupted = .some(nil); break }
                        try? await Task.sleep(nanoseconds: 5_000_000)
                    }
                    if interrupted != nil { finish.cancel(); _ = await finish.value }
                    await VoiceDictation.shared.cancel()
                    if let next = interrupted {
                        session.mark("cancelled")
                        await MainActor.run { VoiceHUD.shared.hide() }
                        guard let n = next else { break }
                        pending = n
                    }
                }
            case .cancelPtt, .stopAll:
                context = nil
                await VoiceDictation.shared.cancel()
                await MainActor.run { VoiceHUD.shared.hide() }
                kind = VoiceRuntime.sessionNone
            case .toggleHandsFree:
                if kind == VoiceRuntime.sessionNone {
                    do {
                        let id = try await VoiceDictation.shared.startHandsFree()
                        await MainActor.run { VoiceHUD.shared.show(sessionId: id) }
                        kind = VoiceRuntime.sessionHandsFree
                    } catch {
                        VoiceLog.info("hands-free start failed: \(error)")
                        await MainActor.run { VoiceHUD.shared.showNotice("failed", text: nil) }
                    }
                } else if kind == VoiceRuntime.sessionHandsFree {
                    await VoiceDictation.shared.stopHandsFree()
                    await VoiceDictation.shared.awaitSlotFree(3)
                    await VoiceDictation.shared.cancel()
                    await MainActor.run { VoiceHUD.shared.hide() }
                    kind = VoiceRuntime.sessionNone
                }
            default: break
            }
            sessionKind.value = kind
        }
        await VoiceDictation.shared.cancel()
    }

    // MARK: finish_ptt

    /// Stop the stream, AI-clean, apply corrections, then type into the focused
    /// app and watch the field to learn from edits. `insert: false` (control
    /// harness) returns the text instead of injecting keystrokes.
    @discardableResult
    func finishPtt(session: VoiceSession, target targetTask: Task<VoiceTarget?, Never>?, insert: Bool = true) async -> String? {
        let settings = VoiceSettings.load()
        await MainActor.run { VoiceHUD.shared.showTranscribing() }
        let raw: String
        do { raw = try await VoiceDictation.shared.stop() } catch {
            await MainActor.run { VoiceHUD.shared.showNotice("failed", text: nil) }
            return nil
        }
        session.mark("asr_stop_complete")
        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            await MainActor.run { VoiceHUD.shared.hide() }
            return ""
        }
        let target: VoiceTarget? = if let targetTask { await voiceWithTimeout(0.6) { await targetTask.value } ?? nil } else { nil }
        let appName = target?.app
        var text = raw
        var rawFallback = false
        session.mark("cleanup_started")
        let cleaned: String?? = await voiceWithTimeout(voiceCleanupBudget) { () -> String? in
            guard let key = VoiceSecrets.get("volc_ark") else { return nil }
            let corpus = await voiceWithTimeout(0.2) { () -> VoiceCorpus in
                var c = VoiceBiasing.buildCorpus(settings)
                if settings.voiceContextBiasing && c.context == nil, let screen = VoiceOCR.screenNow() {
                    let flat = screen.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                    c.context = VoiceFocusedText.tail(flat, 400)
                }
                return c
            } ?? VoiceCorpus()
            return try? await VoiceCleanup.cleanup(key: key, transcript: raw, context: corpus.context, terms: corpus.hotwords,
                                                   appName: appName, recent: corpus.recent)
        }
        if Task.isCancelled { return nil }
        if let c = cleaned ?? nil {
            text = c
            session.mark("cleanup_complete")
        } else {
            rawFallback = true
            session.mark("cleanup_raw_fallback")
        }
        if settings.voiceContextBiasing {
            let input = text
            if let corrected = await voiceWithTimeout(0.1, { VoiceCorrections.apply(input) }) { text = corrected }
        }
        text = VoiceText.normalizeZhEnSpacing(text)
        if Task.isCancelled { return nil }
        guard insert else {
            await MainActor.run { VoiceHUD.shared.hide() }
            return text
        }
        let revision = inputRevision.value
        let expected = target?.identity
        var valid = false
        if let target {
            valid = await voiceWithTimeout(0.6) { await Task.detached { target.stillFocused(revision) }.value } ?? false
        }
        session.mark("target_checked")
        let front = VoiceAX.frontmostIdentity().map { ($0.1, $0.2) }
        if !valid || revision != inputRevision.value || expected == nil || front == nil || expected! != front! {
            session.mark("target_changed")
            let t = text
            await MainActor.run { VoiceHUD.shared.showNotice("targetChanged", text: t) }
            return text
        }
        if Task.isCancelled { return nil }
        VoiceTextInput.insert(text)
        session.mark("insert_posted")
        if rawFallback {
            await MainActor.run { VoiceHUD.shared.showNotice("rawFallback", text: nil) }
        } else {
            await MainActor.run { VoiceHUD.shared.hide() }
        }
        let rec = text
        DispatchQueue.global().async { VoiceTranscripts.record(rec) }
        if settings.voiceContextBiasing {
            DispatchQueue.global().async { VoiceBiasing.harvest(rec) }
            VoiceCorrections.watchInsertion(rec)
        }
        return text
    }
}
