// cetus meeting (ambient audio) helper.
//
// A small on-device companion compiled lazily by the Rust meeting module with
// `swiftc` (see src/meeting.rs), same pattern as the speech + screen helpers.
// Subcommands:
//
//   cetus-meeting-helper permcheck
//       -> {"mic":"authorized","speech":"undetermined"}   (no prompts)
//   cetus-meeting-helper monitor
//       -> watches which OTHER processes are capturing the microphone via the
//          CoreAudio process-object API (macOS 14+). Emits one JSONL line per
//          state change:
//            {"mic":{"active":true,"pids":[812],"apps":["us.zoom.xos"]}}
//          cetus's own helpers are filtered out by bundle-id prefix so a running
//          meeting recorder never counts as "someone is on a call".
//          Exits on stdin EOF.
//   cetus-meeting-helper record [--no-system] [localeIdentifier]
//       -> captures the microphone (AVAudioEngine) and — on macOS 14.2+ — the
//          system audio output (CoreAudio process tap mixed down into a private
//          aggregate device), runs one streaming SFSpeechRecognizer per stream,
//          and emits transcript segments as JSONL:
//            {"ready":true}
//            {"warn":"system_audio_unavailable"}            (pre-14.2 etc.)
//            {"segment":{"source":"mic","ts":1718000000000,"text":"..."}}
//            {"segment":{"source":"system","ts":...,"text":"..."}}
//            {"done":true}                                  then exit
//          Stops + finalizes as soon as ANYTHING (a newline, or EOF) arrives on
//          stdin — same convention as the speech helper.
//
// Only TEXT ever leaves this process. No audio is written to disk, ever —
// that's the product stance (Granola-style): transcripts, not recordings.
//
// Recognition is forced on-device when the locale supports it. Each stream's
// recognition request is rotated on speech pauses (and on a hard interval) so
// segments land continuously during long meetings instead of as one giant
// final blob.
//
// Build flags (cascaded by the Rust side when an older SDK rejects symbols):
//   -D NO_TAP           drop the system-audio process tap (needs 14.2 SDK)
//   -D NO_PROC_MONITOR  drop the process-object monitor (needs 14.0 SDK)

import Foundation
import AVFoundation
import Speech
import CoreAudio
import AudioToolbox

// Serialize one JSON object per line on stdout, flushing so the Rust reader
// sees events in real time. Hopped through the main queue by callers that
// aren't already on it.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          var s = String(data: data, encoding: .utf8) else { return }
    s += "\n"
    FileHandle.standardOutput.write(s.data(using: .utf8)!)
}

func eprint(_ s: String) {
    if let data = (s + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "unknown"
    }
}

func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "undetermined"
    @unknown default: return "unknown"
    }
}

func requestAuthorizations() {
    let group = DispatchGroup()
    group.enter()
    SFSpeechRecognizer.requestAuthorization { _ in group.leave() }
    group.enter()
    AVCaptureDevice.requestAccess(for: .audio) { _ in group.leave() }
    group.wait()
}

// ---- CoreAudio property helpers --------------------------------------------

func propAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
}

/// Read a fixed-size plain-old-data property value; false on any error.
func getProp<T>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T) -> Bool {
    var addr = propAddress(selector)
    var size = UInt32(MemoryLayout<T>.size)
    return withUnsafeMutablePointer(to: &value) { ptr in
        AudioObjectGetPropertyData(objectID, &addr, 0, nil, &size, ptr) == noErr
    }
}

/// Read a CFString property (returned +1 retained by CoreAudio); "" on error.
func getStringProp(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = propAddress(selector)
    var ref: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let ok = withUnsafeMutablePointer(to: &ref) { ptr in
        AudioObjectGetPropertyData(objectID, &addr, 0, nil, &size, ptr) == noErr
    }
    guard ok, let r = ref else { return "" }
    return r.takeRetainedValue() as String
}

// ---- mic-in-use monitor (process objects, macOS 14+) ------------------------

#if !NO_PROC_MONITOR
@available(macOS 14.0, *)
func listInputProcesses() -> [(pid: Int32, bundle: String)] {
    var addr = propAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0
    else { return [] }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &objects) == noErr
    else { return [] }

    var out: [(Int32, String)] = []
    for obj in objects {
        var running: UInt32 = 0
        guard getProp(obj, kAudioProcessPropertyIsRunningInput, &running), running != 0 else {
            continue
        }
        var pid: pid_t = -1
        _ = getProp(obj, kAudioProcessPropertyPID, &pid)
        out.append((Int32(pid), getStringProp(obj, kAudioProcessPropertyBundleID)))
    }
    return out
}
#endif

func runMonitor() {
#if NO_PROC_MONITOR
    emit(["warn": "monitor_unavailable"])
    exit(0)
#else
    guard #available(macOS 14.0, *) else {
        emit(["warn": "monitor_unavailable"])
        exit(0)
    }
    var lastKey = "\u{0}" // never matches, so the initial state always emits
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    // Poll every 4s, not 2s: this enumeration of every CoreAudio process runs
    // 24/7 while auto-detect is on, so the wakeup cost is pure background tax.
    // Detection still lands well inside the 6s auto-start debounce on the Rust
    // side (AUTO_START_SECS), so halving the wakeups costs no meaningful latency.
    timer.schedule(deadline: .now(), repeating: .seconds(4))
    timer.setEventHandler {
        // Only count *identifiable* apps as "mic in use":
        //  - empty bundle id → an unbundled daemon/helper (including cetus's own
        //    voice/speech/recorder helpers, which report "" when run unbundled in
        //    dev and so slip past the dev.cetus.app prefix filter below). These
        //    are not meetings; counting them auto-started sessions out of nowhere
        //    (e.g. while merely playing audio), so drop them.
        //  - our own recorder captures the mic during a session; without the
        //    prefix filter a running session would look like an ever-active call
        //    and auto-stop could never fire.
        // Apple's speech/Siri/dictation daemons keep a mic input stream open for
        // system features (dictation, "Hey Siri", Live Captions) and also back
        // SFSpeechRecognizer — i.e. our OWN transcription drives CoreSpeech, so
        // counting it would both false-trigger at idle (observed: a session
        // auto-starting just from system speech being warm) and wedge auto-stop.
        // None of these is ever a meeting; a real call shows the conferencing
        // app's own bundle id (us.zoom.xos, com.google.Chrome, …).
        let ignoredBundles: Set<String> = [
            "com.apple.CoreSpeech",
            "com.apple.SpeechRecognitionCore",
            "com.apple.assistantd",
            "com.apple.Siri",
            "com.apple.siri.embeddedspeech",
        ]
        let procs = listInputProcesses().filter {
            !$0.bundle.isEmpty
                && !$0.bundle.hasPrefix("dev.cetus.app")
                && !ignoredBundles.contains($0.bundle)
                && $0.pid != getpid()
        }
        let pids = procs.map { $0.pid }.sorted()
        let key = pids.map(String.init).joined(separator: ",")
        if key != lastKey {
            lastKey = key
            let apps = Array(Set(procs.map { $0.bundle }.filter { !$0.isEmpty })).sorted()
            emit(["mic": ["active": !procs.isEmpty, "pids": pids, "apps": apps]])
        }
    }
    timer.resume()
    // Host closes our stdin (or writes anything) to shut the monitor down.
    DispatchQueue.global(qos: .utility).async {
        _ = FileHandle.standardInput.availableData
        exit(0)
    }
    RunLoop.main.run()
#endif
}

// ---- streaming transcriber ---------------------------------------------------

/// One continuously-running speech recognizer over one audio stream ("mic" or
/// "system"). Rotates its recognition request on speech pauses so transcript
/// segments are emitted live during long meetings. All state is confined to the
/// main queue; `append` is the only audio-thread entry point.
final class StreamTranscriber {
    let source: String
    let recognizer: SFSpeechRecognizer
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var gen = 0
    private var lastPartial = ""
    private var partialChangedAt = Date()
    private var requestStartedAt = Date()
    private var firstSpeechTs: Int64?
    private var consecutiveFailures = 0
    private(set) var stopped = false

    /// Rotate (finalize the running text into a segment) after this long
    /// without the partial changing — i.e. a speech pause.
    private let pauseSecs: TimeInterval = 1.6
    /// Hard rotation interval so one request never grows unbounded.
    private let maxRequestSecs: TimeInterval = 60

    init?(source: String, locale: Locale) {
        self.source = source
        guard let r = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(),
              r.isAvailable
        else { return nil }
        self.recognizer = r
    }

    func start() {
        startRequest()
    }

    /// Audio-thread entry: feed one PCM buffer to the live request.
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let req = request
        lock.unlock()
        req?.append(buffer)
    }

    /// Main-queue timer entry (~2×/s): rotate on pause or on the hard interval.
    func tick() {
        guard !stopped else { return }
        let now = Date()
        if !lastPartial.isEmpty && now.timeIntervalSince(partialChangedAt) > pauseSecs {
            rotate()
        } else if now.timeIntervalSince(requestStartedAt) > maxRequestSecs {
            rotate()
        }
    }

    /// Emit whatever has been recognized so far as a segment (if non-empty) and
    /// start a fresh request. Also the error-recovery path.
    private func rotate() {
        let text = lastPartial.trimmingCharacters(in: .whitespacesAndNewlines)
        let ts = firstSpeechTs ?? nowMs()
        let oldTask = task
        lastPartial = ""
        firstSpeechTs = nil
        gen += 1 // orphan any in-flight callbacks from the old task
        oldTask?.cancel()
        if !text.isEmpty {
            consecutiveFailures = 0
            emit(["segment": ["source": source, "ts": ts, "text": text]])
        }
        startRequest()
    }

    private func startRequest() {
        guard !stopped else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition {
            req.requiresOnDeviceRecognition = true
        }
        if #available(macOS 13.0, *) {
            req.addsPunctuation = true
        }
        lock.lock()
        request = req
        lock.unlock()
        requestStartedAt = Date()
        gen += 1
        let g = gen
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, g == self.gen, !self.stopped else { return }
                if let result {
                    let t = result.bestTranscription.formattedString
                    if t != self.lastPartial {
                        self.lastPartial = t
                        self.partialChangedAt = Date()
                        if self.firstSpeechTs == nil { self.firstSpeechTs = nowMs() }
                    }
                    if result.isFinal {
                        self.rotate()
                        return
                    }
                }
                if error != nil {
                    // Recognizers error transiently (and report completion via
                    // error after cancel); salvage the partial and restart. Give
                    // up on a stream only after several barren failures in a row.
                    self.consecutiveFailures += 1
                    if self.consecutiveFailures > 6 && self.lastPartial.isEmpty {
                        self.stopped = true
                        emit(["warn": "asr_failed_\(self.source)"])
                        return
                    }
                    self.rotate()
                }
            }
        }
    }

    /// Engine-restart entry (main queue): the buffer format is about to change
    /// under the live request, which it can't absorb — flush it and start fresh.
    func forceRotate() {
        guard !stopped else { return }
        rotate()
    }

    /// Final flush at session end: emit the in-flight partial (if any) and stop.
    func finish() {
        guard !stopped else { return }
        stopped = true
        let text = lastPartial.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            emit(["segment": ["source": source, "ts": firstSpeechTs ?? nowMs(), "text": text]])
        }
        gen += 1
        task?.cancel()
        lock.lock()
        request = nil
        lock.unlock()
    }
}

/// Deep-copy a HAL-owned buffer list into a standalone AVAudioPCMBuffer. The
/// IOProc's memory is only valid during the callback, while the recognizer may
/// hold onto appended buffers — so copying is mandatory, not paranoia.
func copyPCMBuffer(_ abl: UnsafePointer<AudioBufferList>, format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let ablPtr = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: abl))
    guard let first = ablPtr.first, first.mDataByteSize > 0 else { return nil }
    let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
    guard bytesPerFrame > 0 else { return nil }
    let frames = AVAudioFrameCount(first.mDataByteSize / bytesPerFrame)
    guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
        return nil
    }
    out.frameLength = frames
    let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
    for (i, src) in ablPtr.enumerated() where i < dst.count {
        if let from = src.mData, let to = dst[i].mData {
            let n = min(src.mDataByteSize, dst[i].mDataByteSize)
            memcpy(to, from, Int(n))
            dst[i].mDataByteSize = n
        }
    }
    return out
}

// ---- system-audio tap (macOS 14.2+) -----------------------------------------

#if !NO_TAP
/// Tap the system-wide audio output (everything the user hears: the meeting
/// app's remote participants, a shared video, …) and stream it into `sink`.
/// Returns a teardown closure, or nil (after emitting a warn) when the tap
/// can't be built — pre-14.2, denied TCC, exotic devices — in which case the
/// session is mic-only.
///
/// IMPORTANT: everything 14.2-only is resolved dynamically (NSClassFromString,
/// dlsym, ObjC selectors). The obvious static spelling —
/// `CATapDescription(stereoGlobalTapButExcludeProcesses:)` behind
/// `#available` — leaves a non-weak Swift-overlay symbol in the binary and
/// dyld ABORTS AT LAUNCH on macOS 14.0/14.1, killing even `permcheck`.
func startSystemTap(sink: StreamTranscriber) -> (() -> Void)? {
    typealias TapFn = @convention(c) (AnyObject, UnsafeMutablePointer<AudioObjectID>) -> OSStatus
    typealias DestroyFn = @convention(c) (AudioObjectID) -> OSStatus
    let dl = dlopen(nil, RTLD_NOW)
    guard let createSym = dlsym(dl, "AudioHardwareCreateProcessTap"),
          let destroySym = dlsym(dl, "AudioHardwareDestroyProcessTap"),
          let cls = NSClassFromString("CATapDescription") as? NSObject.Type
    else {
        emit(["warn": "system_audio_unavailable"])
        return nil
    }
    let createTap = unsafeBitCast(createSym, to: TapFn.self)
    let destroyTap = unsafeBitCast(destroySym, to: DestroyFn.self)

    // [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[]]:
    // a stereo mixdown of every process's output (we exclude nothing — cetus's
    // helpers produce no output audio anyway).
    let initSel = NSSelectorFromString("initStereoGlobalTapButExcludeProcesses:")
    guard let alloc = (cls as AnyObject).perform(NSSelectorFromString("alloc"))?
        .takeUnretainedValue(),
          alloc.responds(to: initSel),
          let desc = alloc.perform(initSel, with: [] as NSArray)?.takeUnretainedValue()
    else {
        emit(["warn": "system_audio_unavailable"])
        return nil
    }

    var tapID = AudioObjectID(kAudioObjectUnknown)
    guard createTap(desc, &tapID) == noErr, tapID != kAudioObjectUnknown else {
        emit(["warn": "system_audio_denied"])
        return nil
    }
    var aggregateID = AudioObjectID(kAudioObjectUnknown)
    var ioProcID: AudioDeviceIOProcID?
    func teardown() {
        if let proc = ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            _ = destroyTap(tapID)
        }
    }

    // The tap's mixed-down stream format (typically 32-bit float stereo at the
    // output device's sample rate).
    var asbd = AudioStreamBasicDescription()
    var addr = propAddress(kAudioTapPropertyFormat)
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd) == noErr,
          let format = AVAudioFormat(streamDescription: &asbd),
          let tapUUID = (desc.value(forKey: "UUID") as? UUID)?.uuidString
    else {
        emit(["warn": "system_audio_format"])
        teardown()
        return nil
    }

    // A private aggregate device whose only input is the tap; we read it with a
    // plain IOProc. Auto-start keeps the tap fed even before AudioDeviceStart.
    let aggDesc: [String: Any] = [
        kAudioAggregateDeviceNameKey: "cetus-meeting-tap",
        kAudioAggregateDeviceUIDKey: "dev.cetus.app.meeting.tap." + UUID().uuidString,
        kAudioAggregateDeviceIsPrivateKey: true,
        kAudioAggregateDeviceTapAutoStartKey: true,
        kAudioAggregateDeviceTapListKey: [
            [
                kAudioSubTapUIDKey: tapUUID,
                kAudioSubTapDriftCompensationKey: true,
            ]
        ],
    ]
    var status = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggregateID)
    guard status == noErr, aggregateID != kAudioObjectUnknown else {
        emit(["warn": "system_audio_aggregate"])
        teardown()
        return nil
    }

    status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
        _, inInputData, _, _, _ in
        if let buf = copyPCMBuffer(inInputData, format: format) {
            sink.append(buf)
        }
    }
    guard status == noErr, let proc = ioProcID else {
        emit(["warn": "system_audio_ioproc"])
        teardown()
        return nil
    }
    guard AudioDeviceStart(aggregateID, proc) == noErr else {
        emit(["warn": "system_audio_start"])
        teardown()
        return nil
    }
    return teardown
}
#endif

// ---- record ------------------------------------------------------------------

func runRecord(noSystem: Bool, localeId: String?) {
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined
        || AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        requestAuthorizations()
    }
    guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
        emit(["error": "speech recognition not authorized"])
        exit(3)
    }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        emit(["error": "microphone not authorized"])
        exit(3)
    }

    let locale = localeId.map { Locale(identifier: $0) } ?? Locale.current
    guard let micT = StreamTranscriber(source: "mic", locale: locale) else {
        emit(["error": "no speech recognizer for this locale"])
        exit(1)
    }
    // The system stream gets its own recognizer so the two sides of a call
    // can't garble each other's hypotheses.
    let sysT = StreamTranscriber(source: "system", locale: locale)

    // Microphone: same AVAudioEngine tap as dictation, but feeding a rotating
    // long-form recognizer instead of a one-shot request.
    let engine = AVAudioEngine()
    let input = engine.inputNode
    var finished = false

    // Echo cancellation: without headphones the speakers replay the other
    // participants straight into the mic, so everything they say would land in
    // the transcript twice — once from the system tap, once attributed to the
    // user. Apple's voice-processing unit subtracts device playback from the
    // capture; with headphones on it is simply a no-op.
    var aecOn = true
    do {
        try input.setVoiceProcessingEnabled(true)
    } catch {
        aecOn = false
        emit(["warn": "aec_unavailable"])
    }

    micT.start()

    /// (Re)attach the mic tap and start the engine — also the recovery path
    /// when the input route changes mid-session.
    func attachMic() -> Bool {
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            micT.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            input.removeTap(onBus: 0)
            return false
        }
    }

    if !attachMic() {
        // The VP unit can leave exotic input devices in a 0 Hz state; retry raw.
        if aecOn {
            try? input.setVoiceProcessingEnabled(false)
            aecOn = false
            emit(["warn": "aec_unavailable"])
        }
        guard attachMic() else {
            emit(["error": "audio engine failed to start"])
            exit(1)
        }
    }

    // The engine halts itself when the input route changes (AirPods connect,
    // a USB mic unplugs, the user picks another default input). Flush the
    // in-flight request — the buffer format is about to change under it — and
    // bring the tap back up on the new device once the route settles.
    NotificationCenter.default.addObserver(
        forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { _ in
        if finished { return }
        input.removeTap(onBus: 0)
        micT.forceRotate()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(400)) {
            if finished { return }
            if !attachMic() {
                emit(["warn": "mic_restart_failed"])
            }
        }
    }

    // System audio (what the user hears — the other meeting participants).
    // startSystemTap self-gates by probing for the 14.2+ tap API at runtime.
    var tapTeardown: (() -> Void)? = nil
    if noSystem || sysT == nil {
        if !noSystem { emit(["warn": "system_audio_unavailable"]) }
    } else {
#if NO_TAP
        emit(["warn": "system_audio_unavailable"])
#else
        sysT!.start()
        tapTeardown = startSystemTap(sink: sysT!)
#endif
    }

    emit(["ready": true])

    let ticker = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    ticker.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
    ticker.setEventHandler {
        micT.tick()
        sysT?.tick()
    }
    ticker.resume()

    func finishAll() {
        DispatchQueue.main.async {
            if finished { return }
            finished = true
            input.removeTap(onBus: 0)
            engine.stop()
            tapTeardown?()
            micT.finish()
            sysT?.finish()
            emit(["done": true])
            exit(0)
        }
    }

    // Any byte (a newline) or EOF on stdin means "stop and finalize".
    DispatchQueue.global(qos: .userInitiated).async {
        _ = FileHandle.standardInput.availableData
        finishAll()
    }

    RunLoop.main.run()
}

// ---- main ---------------------------------------------------------------------

let args = CommandLine.arguments
guard args.count >= 2 else {
    eprint("usage: cetus-meeting-helper <permcheck|monitor|record> [--no-system] [locale]")
    exit(2)
}

switch args[1] {
case "permcheck":
    emit(["mic": micStatus(), "speech": speechStatus()])

case "monitor":
    runMonitor()

case "record":
    var noSystem = false
    var localeId: String? = nil
    for a in args.dropFirst(2) {
        if a == "--no-system" {
            noSystem = true
        } else {
            localeId = a
        }
    }
    runRecord(noSystem: noSystem, localeId: localeId)

default:
    eprint("unknown subcommand: \(args[1])")
    exit(2)
}
