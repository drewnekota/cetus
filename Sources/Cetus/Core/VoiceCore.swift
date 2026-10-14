import Compression
import Foundation

// Global voice dictation — shared building blocks: settings, session ownership,
// HUD event bus, logging, and the Volcano Engine (Doubao) streaming ASR client.
// Faithful port of src-tauri/src/{quick.rs (voice settings), voice_session.rs,
// doubao.rs}.

// MARK: - Logging

enum VoiceLog {
    static let debugEnabled = Env.process["CETUS_VOICE_DEBUG"] != nil
    static func info(_ s: @autoclosure () -> String) { FileHandle.standardError.write(Data("[voice] \(s())\n".utf8)) }
    static func debug(_ s: @autoclosure () -> String) { if debugEnabled { info(s()) } }

    /// Single-line, length-capped rendering of a transcript for logs.
    static func preview(_ s: String) -> String {
        let one = s.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ⏎ ")
        return one.count > 160 ? String(one.prefix(160)) + "…" : one
    }
}

// MARK: - Settings (QuickSettings voice fields, read from the Settings UI store)

/// The voice fields of `QuickSettings`, normalized exactly like `quick::load_settings`
/// (insert mode is always "type", cleanup always on, no boosting table).
struct VoiceSettings {
    var launcherEnabled = true
    var gesturePlain = "both_cmd"
    var gestureShot = "off"
    var gestureReply = "double_opt"
    var voiceEnabled = false
    var voiceGesture = "right_option"
    var voiceHandsfreeShortcut = false
    var voiceAsrEngine = "doubao"
    var voiceContextBiasing = true
    var voiceHotwords = ""
    var voiceStartSound = true

    static func load() -> VoiceSettings {
        let raw = UserDefaults.standard.string(forKey: "settings.quick") ?? "{}"
        let q = CapStored<CapQuickSettings>(rawValue: raw)?.value ?? CapQuickSettings()
        var s = VoiceSettings()
        s.launcherEnabled = q.enabled
        s.gesturePlain = q.gesturePlain
        s.gestureShot = q.gestureShot
        s.gestureReply = q.gestureReply
        s.voiceEnabled = q.voiceEnabled
        s.voiceGesture = q.voiceGesture
        s.voiceHandsfreeShortcut = q.voiceHandsfreeShortcut
        s.voiceAsrEngine = q.voiceAsrEngine
        s.voiceContextBiasing = q.voiceContextBiasing
        s.voiceHotwords = q.voiceHotwords
        s.voiceStartSound = q.voiceStartSound
        s.normalizeReplyGesture()
        return s
    }

    /// quick::normalize_reply_gesture
    mutating func normalizeReplyGesture() {
        if gestureReply == "off" || (gestureReply != gesturePlain && gestureReply != gestureShot) { return }
        gestureReply = ["double_opt", "double_cmd", "both_opt", "both_cmd"].first { $0 != gesturePlain && $0 != gestureShot } ?? "off"
    }

    /// quick::gesture_actions → (both_cmd, both_opt, double_cmd, double_opt); 0 = none.
    var gestureActions: (UInt8, UInt8, UInt8, UInt8) {
        var a: [String: UInt8] = [:]
        for (g, act) in [(gesturePlain, UInt8(1)), (gestureShot, 2), (gestureReply, 3)] { a[g] = act }
        return (a["both_cmd"] ?? 0, a["both_opt"] ?? 0, a["double_cmd"] ?? 0, a["double_opt"] ?? 0)
    }

    var gestureCode: UInt8 { VoiceSettings.gestureCode(voiceGesture) }

    static let rightCmd: UInt8 = 0, rightOption: UInt8 = 1, fn: UInt8 = 2, capsLock: UInt8 = 3
    static func gestureCode(_ g: String) -> UInt8 {
        switch g {
        case "right_option": rightOption
        case "fn": fn
        case "caps_lock": capsLock
        default: rightCmd
        }
    }

    var engineIsDoubao: Bool { voiceAsrEngine != "apple" }
}

// MARK: - Secrets (same sources Tauri reads)

enum VoiceSecrets {
    /// Tauri's provider blob (dev-secrets.json) first, then the provider env var.
    static func get(_ provider: String) -> String? {
        if let v = IntelData.secrets()[provider], !v.isEmpty { return v }
        let env = provider == "doubao" ? "DOUBAO_API_KEY" : provider == "volc_ark" ? "ARK_API_KEY" : ""
        if !env.isEmpty, let v = Env.shell[env] ?? Env.process[env], !v.isEmpty { return v }
        return nil
    }
    static func has(_ provider: String) -> Bool { get(provider) != nil }
}

// MARK: - Session (voice_session.rs)

final class VoiceSession: @unchecked Sendable {
    private static let lock = NSLock()
    private static var nextId: UInt64 = 1
    let id: UInt64
    private let lock = NSLock()
    private var _live = true
    private var _failed = false
    private let started = Date()

    init() {
        VoiceSession.lock.lock()
        id = VoiceSession.nextId
        VoiceSession.nextId += 1
        VoiceSession.lock.unlock()
    }

    var isLive: Bool { lock.lock(); defer { lock.unlock() }; return _live }
    func cancel() { lock.lock(); _live = false; lock.unlock() }
    func fail() { lock.lock(); _failed = true; lock.unlock() }
    var failed: Bool { lock.lock(); defer { lock.unlock() }; return _failed }
    func mark(_ stage: String) {
        VoiceLog.info("voice timing session_id=\(id) stage=\(stage) elapsed_ms=\(Int(Date().timeIntervalSince(started) * 1000))")
    }
}

/// voice_session::CLEANUP_BUDGET — one deadline covers context + all model attempts.
let voiceCleanupBudget: Double = 2.0

/// Run `op` with a deadline; nil on timeout or when the caller is cancelled.
/// Returns at the deadline even if `op` ignores cancellation (it is cancelled
/// and left to wind down on its own).
func voiceWithTimeout<T: Sendable>(_ seconds: Double, _ op: @escaping @Sendable () async -> T) async -> T? {
    let first = VoiceOneShot<T?>()
    let work = Task { first.send(await op()) }
    let timer = Task {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
        first.send(nil)
    }
    let r = await withTaskCancellationHandler { await first.wait() } onCancel: { first.send(nil) }
    work.cancel()
    timer.cancel()
    return r ?? nil
}

// MARK: - HUD event bus

enum VoiceEvent {
    case reset, ready, level(Double), partial(String), final(String), transcribing, error(String)
    case notice(code: String, text: String?)
    case dictionaryAdded([String])
}

enum VoiceEvents {
    /// Deliver an event to the HUD (main thread). `sessionId` follows the
    /// voice-* payload contract: stale sessions are ignored by the HUD.
    static func emit(_ e: VoiceEvent, session: UInt64? = nil) {
        DispatchQueue.main.async { VoiceHUD.shared.handle(e, sessionId: session) }
    }
}

/// voice.rs SessionEmitter: drops events once the session is no longer live and
/// marks it failed on an error.
struct VoiceEmitter: Sendable {
    let session: VoiceSession
    let headless: Bool
    func emit(_ e: VoiceEvent) {
        guard session.isLive else { return }
        if case .error = e { session.fail() }
        if headless { return }
        VoiceEvents.emit(e, session: session.id)
    }
}

// MARK: - One-shot value

final class VoiceOneShot<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T?
    private var waiters: [CheckedContinuation<T?, Never>] = []
    private var closed = false

    func send(_ v: T) {
        lock.lock()
        if value != nil || closed { lock.unlock(); return }
        value = v
        let w = waiters; waiters = []
        lock.unlock()
        w.forEach { $0.resume(returning: v) }
    }

    func close() {
        lock.lock()
        closed = true
        let w = waiters; waiters = []
        lock.unlock()
        w.forEach { $0.resume(returning: nil) }
    }

    func wait() async -> T? {
        await withCheckedContinuation { c in
            lock.lock()
            if let v = value { lock.unlock(); c.resume(returning: v); return }
            if closed { lock.unlock(); c.resume(returning: nil); return }
            waiters.append(c)
            lock.unlock()
        }
    }
}

final class VoiceBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T {
        get { lock.lock(); defer { lock.unlock() }; return v }
        set { lock.lock(); v = newValue; lock.unlock() }
    }
}

// MARK: - gzip (Compression raw DEFLATE + RFC 1952 framing)

enum VoiceGzip {
    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    static func crc32(_ d: Data) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for b in d { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFF_FFFF
    }

    private static func run(_ input: Data, _ op: compression_stream_operation) -> Data? {
        var stream = compression_stream(dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!, dst_size: 0,
                                        src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!, src_size: 0, state: nil)
        guard compression_stream_init(&stream, op, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else { return nil }
        defer { compression_stream_destroy(&stream) }
        let cap = 64 * 1024
        let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
        defer { buf.deallocate() }
        var out = Data()
        return input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Data? in
            let base = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer<UInt8>(bitPattern: 1)!
            stream.src_ptr = base
            stream.src_size = input.count
            while true {
                stream.dst_ptr = buf
                stream.dst_size = cap
                let st = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                out.append(buf, count: cap - stream.dst_size)
                switch st {
                case COMPRESSION_STATUS_OK: continue
                case COMPRESSION_STATUS_END: return out
                default: return nil
                }
            }
        }
    }

    static func compress(_ d: Data) -> Data {
        var out = Data([0x1F, 0x8B, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03])
        out.append(run(d, COMPRESSION_STREAM_ENCODE) ?? Data())
        var crc = crc32(d).littleEndian, size = UInt32(truncatingIfNeeded: d.count).littleEndian
        out.append(Data(bytes: &crc, count: 4))
        out.append(Data(bytes: &size, count: 4))
        return out
    }

    static func decompress(_ d: Data) -> Data? {
        let b = [UInt8](d)
        guard b.count >= 18, b[0] == 0x1F, b[1] == 0x8B, b[2] == 8 else { return nil }
        let flags = b[3]
        var i = 10
        if flags & 0x04 != 0 { guard i + 2 <= b.count else { return nil }; i += 2 + Int(b[i]) | (Int(b[i + 1]) << 8) }
        if flags & 0x08 != 0 { while i < b.count, b[i] != 0 { i += 1 }; i += 1 }
        if flags & 0x10 != 0 { while i < b.count, b[i] != 0 { i += 1 }; i += 1 }
        if flags & 0x02 != 0 { i += 2 }
        guard i < b.count - 8 else { return nil }
        return run(Data(b[i..<(b.count - 8)]), COMPRESSION_STREAM_DECODE)
    }
}

// MARK: - Doubao streaming ASR (doubao.rs)

/// Recognition biasing fed into the request's `corpus` field.
struct VoiceCorpus: Sendable {
    var hotwords: [String] = []
    var context: String?
    var recent: String?
    var boostingTableId: String?

    var isEmpty: Bool {
        func blank(_ s: String?) -> Bool { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return hotwords.isEmpty && blank(context) && blank(recent) && blank(boostingTableId)
    }
}

struct VoiceASRError: Error, CustomStringConvertible {
    let description: String
    init(_ s: String) { description = s }
}

enum Doubao {
    static let url = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
    static let urlAsync = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    static let defaultResourceId = "volc.seedasr.sauc.duration"

    // message types / flags / serialization
    private static let fullClient: UInt8 = 0b0001, audioOnly: UInt8 = 0b0010, errorType: UInt8 = 0b1111
    private static let flagNone: UInt8 = 0, flagLast: UInt8 = 0b0010
    private static let serJSON: UInt8 = 0b0001, serRaw: UInt8 = 0, gzipComp: UInt8 = 0b0001

    /// Whether the two-pass endpoint is believed usable (flips off for the process).
    static let twoPassOK = VoiceBox(true)

    private static func frame(_ type: UInt8, _ flags: UInt8, _ ser: UInt8, _ payload: Data) -> Data {
        let gz = VoiceGzip.compress(payload)
        var out = Data([0x11, (type << 4) | flags, (ser << 4) | gzipComp, 0x00])
        var n = UInt32(gz.count).bigEndian
        out.append(Data(bytes: &n, count: 4))
        out.append(gz)
        return out
    }

    /// Serialize like serde_json::Value::to_string — compact, keys sorted.
    private static func json(_ obj: Any) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(data: d, encoding: .utf8) ?? "{}"
    }

    static func fullClientRequest(handsFree: Bool, corpus: VoiceCorpus, twoPass: Bool) -> Data {
        var req: [String: Any] = ["model_name": "bigmodel", "enable_itn": true, "enable_punc": true]
        if handsFree {
            req["result_type"] = "single"
            req["show_utterances"] = true
            req["end_window_size"] = 800
            req["enable_ddc"] = true
            if twoPass { req["enable_nonstream"] = true }
        } else {
            req["result_type"] = "full"
            if twoPass { req["enable_nonstream"] = true }
        }
        if !corpus.isEmpty {
            var corpusObj: [String: Any] = [:]
            if let id = corpus.boostingTableId?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty {
                corpusObj["boosting_table_id"] = id
            }
            var inner: [String: Any] = [:]
            if !corpus.hotwords.isEmpty { inner["hotwords"] = corpus.hotwords.map { ["word": $0] } }
            var ctx: [[String: String]] = []
            if let p = corpus.recent?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty { ctx.append(["text": p]) }
            if let c = corpus.context?.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty { ctx.append(["text": c]) }
            if !ctx.isEmpty {
                inner["context_type"] = "dialog_ctx"
                inner["context_data"] = ctx
            }
            if !inner.isEmpty { corpusObj["context"] = json(inner) }
            req["corpus"] = corpusObj
        }
        let cfg: [String: Any] = [
            "user": ["uid": "cetus"],
            "audio": ["format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1],
            "request": req,
        ]
        let text = json(cfg)
        VoiceLog.debug("doubao: request config: \(text)")
        return frame(fullClient, flagNone, serJSON, Data(text.utf8))
    }

    static func audioRequest(_ pcm: Data, last: Bool) -> Data {
        frame(audioOnly, last ? flagLast : flagNone, serRaw, pcm)
    }

    struct Parsed {
        var error: String?
        var text: String?
        var sentences: [String] = []
        var interim: String?
        var last = false
    }

    static func parse(_ d: Data) throws -> Parsed {
        let b = [UInt8](d)
        guard b.count >= 4 else { throw VoiceASRError("doubao: short frame (\(b.count) bytes)") }
        let type = b[1] >> 4, flags = b[1] & 0x0F, comp = b[2] & 0x0F
        var off = 4
        if flags == 0b0001 || flags == 0b0011 { off += 4 }
        func u32(_ o: Int) throws -> Int {
            guard o + 4 <= b.count else { throw VoiceASRError("doubao: truncated frame") }
            return Int(UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3]))
        }
        if type == errorType {
            let code = try u32(off); off += 4
            let size = try u32(off); off += 4
            let end = min(off + size, b.count)
            let msg = String(decoding: b[min(off, end)..<end], as: UTF8.self)
            return Parsed(error: "\(code): \(msg)", last: true)
        }
        let size = try u32(off); off += 4
        let end = min(off + size, b.count)
        var payload = Data(b[min(off, end)..<end])
        if comp == gzipComp {
            guard let p = VoiceGzip.decompress(payload) else { throw VoiceASRError("doubao: gunzip failed") }
            payload = p
        }
        let v = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any]
        let result = v?["result"] as? [String: Any]
        var p = Parsed()
        p.text = result?["text"] as? String
        for u in (result?["utterances"] as? [[String: Any]]) ?? [] {
            let definite = u["definite"] as? Bool ?? false
            guard let t = (u["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { continue }
            if definite { p.sentences.append(t) } else { p.interim = t }
        }
        p.last = flags == flagLast || flags == 0b0011
        return p
    }

    /// An async channel of PCM chunks; `finish()` = end-of-audio.
    typealias PCM = AsyncStream<Data>

    /// Push-to-talk: two-pass attempt, teed replay on the plain endpoint, then
    /// salvage the longest partial.
    static func stream(key: String, resource: String, corpus: VoiceCorpus, pcm: PCM,
                       onPartial: @escaping @Sendable (String) -> Void, session: VoiceSession) async throws -> String {
        let twoPass = twoPassOK.value
        let buffer = VoiceBox<[Data]>([])
        let (rx1, tx1) = PCM.makeStream()
        let pump = Task {
            for await chunk in pcm {
                buffer.value.append(chunk)
                tx1.yield(chunk)
            }
            tx1.finish()
        }
        defer { pump.cancel() }
        let (text, err) = await run(url: twoPass ? urlAsync : url, key: key, resource: resource, corpus: corpus, pcm: rx1,
                                    handsFree: false, twoPass: twoPass, onPartial: onPartial, onSentence: { _ in }, session: session)
        guard let e = err else { return text }
        if twoPass && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            twoPassOK.value = false
            VoiceLog.info("doubao two-pass endpoint rejected; staying on plain streaming this run")
        }
        VoiceLog.info("doubao stream failed (\(e)); replaying audio on the plain endpoint")
        await pump.value
        let chunks = buffer.value
        if chunks.isEmpty {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw e }
            return text
        }
        let (rx2, tx2) = PCM.makeStream()
        let replay = Task {
            for c in chunks {
                if Task.isCancelled { break }
                tx2.yield(c)
                try? await Task.sleep(nanoseconds: 15_000_000)
            }
            tx2.finish()
        }
        defer { replay.cancel() }
        let (text2, err2) = await run(url: url, key: key, resource: resource, corpus: corpus, pcm: rx2,
                                      handsFree: false, twoPass: false, onPartial: onPartial, onSentence: { _ in }, session: session)
        guard let e2 = err2 else { return text2 }
        let best = text2.count >= text.count ? text2 : text
        if best.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw e2 }
        VoiceLog.info("doubao retry also failed (\(e2)); inserting last partial (\(best.count) chars)")
        return best
    }

    /// Hands-free: per-sentence delivery with a lossless early-failure fallback.
    static func streamHandsFree(key: String, resource: String, corpus: VoiceCorpus, pcm: PCM,
                                onPartial: @escaping @Sendable (String) -> Void,
                                onSentence: @escaping @Sendable (String) -> Void) async throws {
        if !twoPassOK.value {
            let (_, err) = await run(url: url, key: key, resource: resource, corpus: corpus, pcm: pcm, handsFree: true,
                                     twoPass: false, onPartial: onPartial, onSentence: onSentence, session: nil)
            if let err { throw err }
            return
        }
        let firstSentence = VoiceBox(false)
        let sentence: @Sendable (String) -> Void = { s in
            firstSentence.value = true
            onSentence(s)
        }
        let cap = 60 * 32000
        // The pump writes to whichever output is current; a swap replays the buffer first.
        final class Pump: @unchecked Sendable {
            let lock = NSLock()
            var out: AsyncStream<Data>.Continuation
            var buf: [Data] = []
            var bytes = 0
            var buffering = true
            var sourceDone = false
            init(_ out: AsyncStream<Data>.Continuation) { self.out = out }

            /// Tee one live chunk into the replay buffer; returns the current output.
            func take(_ chunk: Data, firstSentence: Bool, cap: Int) -> AsyncStream<Data>.Continuation {
                lock.lock(); defer { lock.unlock() }
                if buffering {
                    if firstSentence {
                        buffering = false
                        buf.removeAll()
                    } else if bytes + chunk.count <= cap {
                        bytes += chunk.count
                        buf.append(chunk)
                    } else {
                        VoiceLog.info("doubao hands-free: replay buffer cap hit with no sentence yet; fallback will be live-only")
                        buffering = false
                        buf.removeAll()
                    }
                }
                return out
            }

            func finishSource() -> AsyncStream<Data>.Continuation {
                lock.lock(); defer { lock.unlock() }
                sourceDone = true
                return out
            }

            /// Swap to a new live output; returns (buffered audio, source already done) or nil if nothing to replay.
            func swap(_ newOut: AsyncStream<Data>.Continuation) -> ([Data], Bool)? {
                lock.lock(); defer { lock.unlock() }
                if sourceDone && buf.isEmpty { return nil }
                let replay = buf
                buf.removeAll()
                buffering = false
                out = newOut
                return (replay, sourceDone)
            }
        }
        let (rx1, tx1) = PCM.makeStream()
        let state = Pump(tx1)
        let pump = Task {
            for await chunk in pcm {
                state.take(chunk, firstSentence: firstSentence.value, cap: cap).yield(chunk)
            }
            state.finishSource().finish()
        }
        defer { pump.cancel() }
        let (_, err) = await run(url: urlAsync, key: key, resource: resource, corpus: corpus, pcm: rx1, handsFree: true,
                                 twoPass: true, onPartial: onPartial, onSentence: sentence, session: nil)
        guard let e = err else { return }
        if firstSentence.value { throw e }
        twoPassOK.value = false
        VoiceLog.info("doubao hands-free two-pass failed before any sentence (\(e)); replaying on the plain endpoint")
        let (rx2, tx2) = PCM.makeStream()
        let (liveRx, liveTx) = PCM.makeStream()
        guard let (replay, done) = state.swap(liveTx) else { throw e }
        if done { liveTx.finish() }
        let feeder = Task {
            for c in replay {
                if Task.isCancelled { break }
                tx2.yield(c)
                try? await Task.sleep(nanoseconds: 15_000_000)
            }
            for await c in liveRx { tx2.yield(c) }
            tx2.finish()
        }
        defer { feeder.cancel() }
        let (_, err2) = await run(url: url, key: key, resource: resource, corpus: corpus, pcm: rx2, handsFree: true,
                                  twoPass: false, onPartial: onPartial, onSentence: sentence, session: nil)
        if let err2 { throw err2 }
    }

    /// Shared session driver: accumulated text + the terminal error, if any.
    static func run(url: String, key: String, resource: String, corpus: VoiceCorpus, pcm: PCM, handsFree: Bool, twoPass: Bool,
                    onPartial: @escaping @Sendable (String) -> Void, onSentence: @escaping @Sendable (String) -> Void,
                    session: VoiceSession?) async -> (String, Error?) {
        let started = Date()
        let acc = VoiceBox("")
        var err: Error?
        do {
            try await runSession(url: url, key: key, resource: resource, corpus: corpus, pcm: pcm, handsFree: handsFree,
                                 twoPass: twoPass, acc: acc, onPartial: onPartial, onSentence: onSentence, session: session)
        } catch {
            err = error
        }
        VoiceLog.debug("doubao: session ended in \(Int(Date().timeIntervalSince(started) * 1000))ms (two_pass=\(twoPass), \(acc.value.count) chars, err=\(err.map { "\($0)" } ?? "none"))")
        return (acc.value, err)
    }

    private static let urlSession = URLSession(configuration: .ephemeral)

    private static func runSession(url: String, key: String, resource: String, corpus: VoiceCorpus, pcm: PCM, handsFree: Bool,
                                   twoPass: Bool, acc: VoiceBox<String>, onPartial: @escaping @Sendable (String) -> Void,
                                   onSentence: @escaping @Sendable (String) -> Void, session: VoiceSession?) async throws {
        guard let u = URL(string: url) else { throw VoiceASRError("bad url") }
        var req = URLRequest(url: u)
        req.setValue(key, forHTTPHeaderField: "X-Api-Key")
        req.setValue(resource, forHTTPHeaderField: "X-Api-Resource-Id")
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Api-Request-Id")
        req.setValue("-1", forHTTPHeaderField: "X-Api-Sequence")
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Api-Connect-Id")
        let ws = urlSession.webSocketTask(with: req)
        ws.maximumMessageSize = 16 * 1024 * 1024
        ws.resume()
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        // Config frame doubles as the 5 s connect timeout (send completes once open).
        let cfg = fullClientRequest(handsFree: handsFree, corpus: corpus, twoPass: twoPass)
        let sent: Bool? = await voiceWithTimeout(5) {
            do { try await ws.send(.data(cfg)); return true } catch { return false }
        }
        guard sent == true else { throw VoiceASRError(sent == nil ? "doubao: connect timed out" : "doubao: websocket connect failed") }
        session?.mark("websocket_ready")
        VoiceLog.debug("doubao: websocket connected (url=\(url), resource_id=\(resource), hands_free=\(handsFree), two_pass=\(twoPass))")

        let sender = Task { () throws in
            var prev: Data?
            var total = 0
            var firstSent = false
            for await chunk in pcm {
                total += chunk.count
                if let p = prev {
                    try await ws.send(.data(audioRequest(p, last: false)))
                    if !firstSent { session?.mark("first_audio_sent"); firstSent = true }
                }
                prev = chunk
            }
            try await ws.send(.data(audioRequest(prev ?? Data(), last: true)))
            if !firstSent { session?.mark("first_audio_sent") }
            session?.mark("audio_end_sent")
            VoiceLog.debug("doubao: end-of-audio sent (\(total) bytes ≈ \(String(format: "%.1f", Double(total) / 32000))s)")
        }
        defer { sender.cancel() }

        var sawLast = false
        while !Task.isCancelled {
            let msg: URLSessionWebSocketTask.Message
            do { msg = try await ws.receive() } catch {
                if ws.closeCode != .invalid { break } // clean close → judged below
                throw error
            }
            guard case let .data(data) = msg else { continue }
            let p = try parse(data)
            if let e = p.error { throw VoiceASRError("doubao asr error: \(e)") }
            for s in p.sentences { onSentence(s) }
            if handsFree {
                if let t = p.interim { onPartial(t) } else if !p.sentences.isEmpty { onPartial("") }
            }
            if let t = p.text, !t.isEmpty {
                if !handsFree { onPartial(t) }
                acc.value = t
            }
            if p.last { sawLast = true; break }
        }
        _ = try? await sender.value
        if !sawLast { throw VoiceASRError("doubao session ended without a final frame") }
    }
}
