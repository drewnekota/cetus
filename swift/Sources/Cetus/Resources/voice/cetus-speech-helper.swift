// cetus speech (dictation) helper.
//
// A tiny on-device companion compiled lazily by the Rust voice module with
// `swiftc` (see src/voice.rs). It exposes three subcommands:
//
//   cetus-speech-helper permcheck
//       -> {"mic":"authorized","speech":"undetermined"}   (no prompts)
//   cetus-speech-helper request
//       -> requests Microphone + Speech Recognition access (shows the system
//          prompts when undetermined), then prints the resulting statuses.
//   cetus-speech-helper listen [--wav PATH] [localeIdentifier]
//       -> streams JSONL on stdout while capturing the microphone:
//            {"ready":true}                  once audio is live
//            {"partial":"the running text"}  on each recognition update
//            {"final":"the final text"}      once, right before exit
//          Stops + finalizes as soon as ANYTHING (a newline, or EOF) arrives on
//          stdin — that's how the Rust side asks it to wrap up.
//          When --wav PATH is given, the captured mic audio is ALSO written as a
//          16 kHz mono 16-bit PCM WAV to PATH, fully flushed BEFORE the `final`
//          line, so the Rust side can upload it for cloud re-transcription
//          (MiMo-V2.5-ASR) while still getting the on-device transcript as a
//          fallback. Apple recognition is unchanged either way.
//
// Recognition uses Apple's Speech framework (SFSpeechRecognizer) forced to
// on-device when the locale supports it, so the Apple transcript never leaves
// the machine — same privacy posture as the Vision OCR helper. The optional WAV
// is the ONLY thing that leaves the device, and only when the caller asks for
// it (i.e. the user picked the MiMo cloud engine).

import Foundation
import AVFoundation
import Speech

// Serialize one JSON object per line on stdout, flushing so the Rust reader
// sees partials in real time.
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

// Wrap raw little-endian 16-bit PCM samples in a canonical 44-byte WAV header.
// Used to persist the captured mic audio for cloud transcription.
func makeWav(_ pcm: Data, sampleRate: Int, channels: Int) -> Data {
    let bitsPerSample = 16
    let byteRate = sampleRate * channels * bitsPerSample / 8
    let blockAlign = channels * bitsPerSample / 8
    let dataLen = pcm.count
    func u32(_ v: UInt32) -> Data { var x = v.littleEndian; return Data(bytes: &x, count: 4) }
    func u16(_ v: UInt16) -> Data { var x = v.littleEndian; return Data(bytes: &x, count: 2) }
    var out = Data()
    out.append("RIFF".data(using: .ascii)!)
    out.append(u32(UInt32(36 + dataLen)))
    out.append("WAVE".data(using: .ascii)!)
    out.append("fmt ".data(using: .ascii)!)
    out.append(u32(16))                       // PCM fmt chunk size
    out.append(u16(1))                        // audio format = PCM
    out.append(u16(UInt16(channels)))
    out.append(u32(UInt32(sampleRate)))
    out.append(u32(UInt32(byteRate)))
    out.append(u16(UInt16(blockAlign)))
    out.append(u16(UInt16(bitsPerSample)))
    out.append("data".data(using: .ascii)!)
    out.append(u32(UInt32(dataLen)))
    out.append(pcm)
    return out
}

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

// Request both authorizations (no-ops when already decided) and block until the
// user has answered both prompts.
func requestAuthorizations() {
    let group = DispatchGroup()
    group.enter()
    SFSpeechRecognizer.requestAuthorization { _ in group.leave() }
    group.enter()
    AVCaptureDevice.requestAccess(for: .audio) { _ in group.leave() }
    group.wait()
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    eprint("usage: cetus-speech-helper <permcheck|request|listen> [locale]")
    exit(2)
}

switch args[1] {
case "permcheck":
    emit(["mic": micStatus(), "speech": speechStatus()])

case "request":
    requestAuthorizations()
    emit(["mic": micStatus(), "speech": speechStatus()])

case "listen":
    // First-run convenience: surface the prompts here too so the very first
    // dictation works even if the user never opened Settings.
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

    // Parse the rest: an optional `--wav PATH` (capture a WAV for cloud ASR) and
    // an optional bare locale identifier.
    var wavPath: String? = nil
    var localeId: String? = nil
    var i = 2
    while i < args.count {
        if args[i] == "--wav", i + 1 < args.count {
            wavPath = args[i + 1]
            i += 2
        } else {
            localeId = args[i]
            i += 1
        }
    }

    let locale = localeId.map { Locale(identifier: $0) } ?? Locale.current
    guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer() else {
        emit(["error": "no speech recognizer for this locale"])
        exit(1)
    }
    guard recognizer.isAvailable else {
        emit(["error": "speech recognizer unavailable"])
        exit(1)
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition {
        request.requiresOnDeviceRecognition = true
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)

    // Optional WAV capture for cloud ASR (MiMo): downsample the mic to 16 kHz
    // mono 16-bit PCM on the fly and accumulate it. Built only when --wav was
    // passed, so the on-device-only path keeps zero extra work.
    let recordFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)
    var wavConverter: AVAudioConverter? = nil
    if wavPath != nil, let rf = recordFormat {
        wavConverter = AVAudioConverter(from: format, to: rf)
    }
    let wavLock = NSLock()
    var wavData = Data()

    // Live mic amplitude (0…1), updated on the audio thread and sampled by a
    // timer for the waveform indicator. The webview can't see the audio stream,
    // so we surface the level here.
    var currentLevel: Float = 0
    // Whether the session ever contained actual speech. Cloud Whisper
    // hallucinates on silence (it'll "transcribe" a near-silent clip into
    // "Thank you." / "字幕 by …"), so we count audio buffers whose energy clears
    // a speech floor; if too few do, finish() skips the WAV and the cloud upload
    // is never made. ~5 buffers ≈ 100 ms of real voice clears it.
    let speechFloor: Float = 0.10
    let speechFramesNeeded = 5
    var loudFrames = 0
    var sawSpeech = false
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
        // Feed the same buffer to the WAV recorder (resample → 16k mono int16).
        if let conv = wavConverter, let rf = recordFormat {
            let ratio = rf.sampleRate / format.sampleRate
            let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
            if let outBuf = AVAudioPCMBuffer(pcmFormat: rf, frameCapacity: cap) {
                var fed = false
                conv.convert(to: outBuf, error: nil) { _, st in
                    if fed { st.pointee = .noDataNow; return nil }
                    fed = true
                    st.pointee = .haveData
                    return buffer
                }
                if outBuf.frameLength > 0, let ich = outBuf.int16ChannelData {
                    let bytes = Int(outBuf.frameLength) * MemoryLayout<Int16>.size
                    let chunk = Data(bytes: ich[0], count: bytes)
                    wavLock.lock(); wavData.append(chunk); wavLock.unlock()
                }
            }
        }
        guard let ch = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let n = Int(buffer.frameLength)
        let p = ch[0]
        var sum: Float = 0
        var i = 0
        while i < n {
            let s = p[i]
            sum += s * s
            i += 1
        }
        let rms = (sum / Float(n)).squareRoot()
        // Speech RMS is small; apply gain + clamp, then light smoothing so the
        // bars glide instead of strobing.
        let scaled = min(1.0, rms * 18.0)
        currentLevel = currentLevel * 0.6 + scaled * 0.4
        // Speech-presence gate: enough buffers above the floor → real voice.
        if scaled > speechFloor {
            loudFrames += 1
            if loudFrames >= speechFramesNeeded { sawSpeech = true }
        }
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        emit(["error": "audio engine failed: \(error.localizedDescription)"])
        exit(1)
    }
    emit(["ready": true])

    // Push the amplitude ~20×/s on the main queue, decoupled from the audio
    // thread so writing to stdout never glitches capture.
    let levelTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    levelTimer.schedule(deadline: .now() + .milliseconds(50), repeating: .milliseconds(50))
    levelTimer.setEventHandler {
        emit(["level": Double(currentLevel)])
    }
    levelTimer.resume()

    var lastText = ""
    var finished = false
    // All finalization funnels through the main queue so the recognition
    // callback, the stdin watcher, and the safety timeout can't race.
    func finish(_ text: String) {
        DispatchQueue.main.async {
            if finished { return }
            finished = true
            input.removeTap(onBus: 0)
            engine.stop()
            // Flush the captured audio to disk BEFORE announcing the final text,
            // so the Rust side reads a complete WAV the moment it sees `final`.
            // Skip the write entirely when no speech was detected: a silent clip
            // would otherwise be uploaded and Whisper would hallucinate text for
            // it. With no WAV on disk, the Rust cloud path falls back to the
            // (empty) Apple transcript and nothing is inserted.
            if let path = wavPath, sawSpeech {
                wavLock.lock()
                let pcm = wavData
                wavLock.unlock()
                if !pcm.isEmpty {
                    let wav = makeWav(pcm, sampleRate: 16000, channels: 1)
                    try? wav.write(to: URL(fileURLWithPath: path))
                }
            }
            // On a silent session, force the final text empty too — even Apple's
            // recognizer occasionally emits a stray token from room noise.
            emit(["final": sawSpeech ? text : ""])
            exit(0)
        }
    }

    let task = recognizer.recognitionTask(with: request) { result, error in
        if let result = result {
            lastText = result.bestTranscription.formattedString
            if result.isFinal {
                finish(lastText)
            } else {
                emit(["partial": lastText])
            }
        }
        // After endAudio the recognizer reports completion via `error`; treat it
        // as "finalize with whatever we have" rather than an actual failure.
        if error != nil {
            finish(lastText)
        }
    }
    _ = task // keep the task alive for the run loop's lifetime

    // Any byte (a newline) or EOF on stdin means "stop and finalize".
    DispatchQueue.global(qos: .userInitiated).async {
        _ = FileHandle.standardInput.availableData
        request.endAudio()
        // If the recognizer never delivers a final result, fall back to the
        // last partial after a short grace period.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            finish(lastText)
        }
    }

    RunLoop.main.run()

case "stream":
    // Doubao (real-time cloud) path: capture the mic and stream 16 kHz mono
    // 16-bit PCM chunks as base64 JSONL ({"pcm":"…"} ~10×/s, {"pcm_end":true} on
    // stop) for the Rust side to forward to the cloud over WebSocket. No SFSpeech
    // — the cloud does the recognizing — so this needs ONLY Microphone access.
    //
    // `--standby`: pre-warmed mode. The process is spawned ahead of time (paying
    // fork/exec + dyld + runtime init off the critical path) and blocks on stdin
    // until the host writes "go\n" — only then does it touch the mic. EOF or
    // anything else on stdin quietly exits, so an abandoned warm helper never
    // holds the microphone.
    //
    // The gate consumes EXACTLY one line, one raw read(2) byte at a time: a
    // buffered/availableData read could swallow a stop "\n" that landed in the
    // pipe right behind "go\n" (minimum-length holds release within ms of the
    // start), and a swallowed stop leaves the mic hot forever with the
    // dictation slot wedged. Byte-wise reads leave later bytes in the pipe for
    // the stop watcher.
    if args.contains("--standby") {
        var line = [UInt8]()
        var byte: UInt8 = 0
        while true {
            let n = read(0, &byte, 1)
            if n <= 0 { exit(0) } // EOF / error → abandoned warm helper
            if byte == 0x0A { break } // first newline ends the gate line
            line.append(byte)
            if line.count > 16 { exit(0) } // garbage — never a valid "go"
        }
        guard String(bytes: line, encoding: .utf8)?.contains("go") == true else {
            exit(0)
        }
    }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let g = DispatchGroup()
        g.enter()
        AVCaptureDevice.requestAccess(for: .audio) { _ in g.leave() }
        g.wait()
    }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
        emit(["error": "microphone not authorized"])
        exit(3)
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard
        let recordFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
        let conv = AVAudioConverter(from: format, to: recordFormat)
    else {
        emit(["error": "audio converter unavailable"])
        exit(1)
    }

    // Accumulate converted PCM on the audio thread (cheap); flush + emit off it
    // on a timer so stdout writes never glitch capture.
    let pcmLock = NSLock()
    var pcmBuffer = Data()
    var currentLevel: Float = 0
    // Speech-presence gate, same constants as the `listen` path: enough buffers
    // above the floor → real voice. Reported once at stop ({"speech":bool}) so
    // the host can discard noise-only sessions (an accidental hold would
    // otherwise stream room noise to the cloud and type whatever token it
    // hallucinates).
    let speechFloor: Float = 0.10
    let speechFramesNeeded = 5
    var loudFrames = 0
    var sawSpeech = false
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        let ratio = recordFormat.sampleRate / format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        if let outBuf = AVAudioPCMBuffer(pcmFormat: recordFormat, frameCapacity: cap) {
            var fed = false
            conv.convert(to: outBuf, error: nil) { _, st in
                if fed { st.pointee = .noDataNow; return nil }
                fed = true
                st.pointee = .haveData
                return buffer
            }
            if outBuf.frameLength > 0, let ich = outBuf.int16ChannelData {
                let bytes = Int(outBuf.frameLength) * MemoryLayout<Int16>.size
                let chunk = Data(bytes: ich[0], count: bytes)
                pcmLock.lock(); pcmBuffer.append(chunk); pcmLock.unlock()
            }
        }
        guard let chf = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let n = Int(buffer.frameLength)
        let p = chf[0]
        var sum: Float = 0
        var i = 0
        while i < n {
            let s = p[i]
            sum += s * s
            i += 1
        }
        let rms = (sum / Float(n)).squareRoot()
        let scaled = min(1.0, rms * 18.0)
        currentLevel = currentLevel * 0.6 + scaled * 0.4
        if scaled > speechFloor {
            loudFrames += 1
            if loudFrames >= speechFramesNeeded { sawSpeech = true }
        }
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        emit(["error": "audio engine failed: \(error.localizedDescription)"])
        exit(1)
    }
    emit(["ready": true])

    var streamFinished = false
    func flushPcm() {
        pcmLock.lock()
        let chunk = pcmBuffer
        pcmBuffer = Data()
        pcmLock.unlock()
        if !chunk.isEmpty {
            emit(["pcm": chunk.base64EncodedString()])
        }
    }
    // ~10×/s: emit a ~100 ms PCM chunk + the waveform level.
    let streamTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
    streamTimer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
    streamTimer.setEventHandler {
        if streamFinished { return }
        flushPcm()
        emit(["level": Double(currentLevel)])
    }
    streamTimer.resume()

    // Any byte (a newline) or EOF on stdin → stop. Keep capturing a short tail
    // first: users release the key as the last syllable leaves their mouth, and
    // an immediate stop clips final consonants (the classic push-to-talk failure
    // mode top dictation apps engineer around).
    DispatchQueue.global(qos: .userInitiated).async {
        _ = FileHandle.standardInput.availableData
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(200)) {
            if streamFinished { return }
            streamFinished = true
            input.removeTap(onBus: 0)
            engine.stop()
            flushPcm()
            emit(["speech": sawSpeech])
            emit(["pcm_end": true])
            exit(0)
        }
    }

    RunLoop.main.run()

default:
    eprint("unknown subcommand: \(args[1])")
    exit(2)
}
