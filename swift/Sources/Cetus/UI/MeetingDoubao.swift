import Foundation
import zlib

// Volcano Engine (Doubao) real-time streaming ASR for meetings — a port of
// doubao.rs `stream_hands_free` (binary WebSocket protocol: 4-byte header +
// big-endian size + gzip'd payload). Each meeting stream (mic / system) runs
// one hands-free session: `single` results + `definite` utterances, live
// interims as captions, two-pass (`bigmodel_async`) first with a lossless
// replay fallback onto the plain endpoint.

enum MeetingDoubao {
    static let url = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel"
    static let urlAsync = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    static let defaultResource = "volc.seedasr.sauc.duration"
    /// Flipped off for the rest of the process when a two-pass attempt dies
    /// before producing any sentence (missing `bigmodel_async` entitlement).
    nonisolated(unsafe) static var twoPassOK = true

    private static let fullClient: UInt8 = 0b0001
    private static let audioOnly: UInt8 = 0b0010
    private static let errorType: UInt8 = 0b1111
    private static let flagLast: UInt8 = 0b0010
    private static let serJSON: UInt8 = 0b0001
    private static let gzipFlag: UInt8 = 0b0001

    // MARK: gzip

    static func gzip(_ data: Data) -> Data {
        var s = z_stream()
        guard deflateInit2_(&s, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 31, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return Data() }
        defer { deflateEnd(&s) }
        var out = Data()
        var input = data
        let chunk = 16_384
        var buf = [UInt8](repeating: 0, count: chunk)
        input.withUnsafeMutableBytes { (p: UnsafeMutableRawBufferPointer) in
            s.next_in = p.baseAddress?.assumingMemoryBound(to: Bytef.self)
            s.avail_in = uInt(p.count)
            repeat {
                buf.withUnsafeMutableBufferPointer { b in
                    s.next_out = b.baseAddress
                    s.avail_out = uInt(chunk)
                    _ = deflate(&s, Z_FINISH)
                    out.append(b.baseAddress!, count: chunk - Int(s.avail_out))
                }
            } while s.avail_out == 0
        }
        return out
    }

    static func gunzip(_ data: Data) -> Data? {
        var s = z_stream()
        guard inflateInit2_(&s, 47, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return nil }
        defer { inflateEnd(&s) }
        var out = Data()
        var input = data
        let chunk = 16_384
        var buf = [UInt8](repeating: 0, count: chunk)
        var status: Int32 = Z_OK
        input.withUnsafeMutableBytes { (p: UnsafeMutableRawBufferPointer) in
            s.next_in = p.baseAddress?.assumingMemoryBound(to: Bytef.self)
            s.avail_in = uInt(p.count)
            repeat {
                buf.withUnsafeMutableBufferPointer { b in
                    s.next_out = b.baseAddress
                    s.avail_out = uInt(chunk)
                    status = inflate(&s, Z_NO_FLUSH)
                    out.append(b.baseAddress!, count: chunk - Int(s.avail_out))
                }
            } while status == Z_OK && (s.avail_out == 0 || s.avail_in > 0)
        }
        return status == Z_STREAM_END || status == Z_OK ? out : nil
    }

    // MARK: frames

    static func frame(_ type: UInt8, _ flags: UInt8, _ ser: UInt8, _ payload: Data) -> Data {
        let gz = gzip(payload)
        var out = Data([0x11, (type << 4) | flags, (ser << 4) | gzipFlag, 0x00])
        var size = UInt32(gz.count).bigEndian
        out.append(Data(bytes: &size, count: 4))
        out.append(gz)
        return out
    }

    static func fullClientRequest(hotwords: [String], twoPass: Bool) -> Data {
        var req: [String: Any] = [
            "model_name": "bigmodel", "enable_itn": true, "enable_punc": true,
            "result_type": "single", "show_utterances": true, "end_window_size": 800, "enable_ddc": true,
        ]
        if twoPass { req["enable_nonstream"] = true }
        if !hotwords.isEmpty {
            let inner: [String: Any] = ["hotwords": hotwords.map { ["word": $0] }]
            if let d = try? JSONSerialization.data(withJSONObject: inner), let s = String(data: d, encoding: .utf8) {
                req["corpus"] = ["context": s]
            }
        }
        let cfg: [String: Any] = [
            "user": ["uid": "cetus"],
            "audio": ["format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1],
            "request": req,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: cfg)) ?? Data()
        return frame(fullClient, 0, serJSON, data)
    }

    static func audioRequest(_ pcm: Data, last: Bool) -> Data { frame(audioOnly, last ? flagLast : 0, 0, pcm) }

    struct Parsed {
        var error: String?
        var sentences: [String] = []
        var interim: String?
        var last = false
    }

    static func parse(_ d: Data) throws -> Parsed {
        let b = [UInt8](d)
        guard b.count >= 4 else { throw MeetingError.message("doubao: short frame (\(b.count) bytes)") }
        let type = b[1] >> 4, flags = b[1] & 0x0F, compression = b[2] & 0x0F
        var off = 4
        if flags == 0b0001 || flags == 0b0011 { off += 4 }
        func u32(_ o: Int) throws -> Int {
            guard o + 4 <= b.count else { throw MeetingError.message("doubao: truncated frame") }
            return Int(UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3]))
        }
        if type == errorType {
            let code = try u32(off); off += 4
            let size = try u32(off); off += 4
            let end = min(off + size, b.count)
            return Parsed(error: "\(code): \(String(decoding: b[min(off, end)..<end], as: UTF8.self))", last: true)
        }
        let size = try u32(off); off += 4
        let end = min(off + size, b.count)
        var payload = Data(b[min(off, end)..<end])
        if compression == gzipFlag {
            guard let g = gunzip(payload) else { throw MeetingError.message("doubao: gunzip failed") }
            payload = g
        }
        var p = Parsed()
        let v = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any]
        if let utts = (v?["result"] as? [String: Any])?["utterances"] as? [[String: Any]] {
            for u in utts {
                guard let t = (u["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { continue }
                if (u["definite"] as? Bool) == true { p.sentences.append(t) } else { p.interim = t }
            }
        }
        p.last = flags == flagLast || flags == 0b0011
        return p
    }
}

/// A PCM channel: the meeting reader thread pushes 16 kHz mono s16le chunks,
/// the ASR session consumes them; `close()` is end-of-audio.
final class MeetingPCMChannel: @unchecked Sendable {
    let stream: AsyncStream<Data>
    private let cont: AsyncStream<Data>.Continuation
    init() {
        var c: AsyncStream<Data>.Continuation!
        stream = AsyncStream(bufferingPolicy: .unbounded) { c = $0 }
        cont = c
    }
    func send(_ d: Data) { cont.yield(d) }
    func close() { cont.finish() }
}

/// One hands-free recognition stream (doubao.rs `stream_hands_free`).
final class MeetingASRStream: @unchecked Sendable {
    let input = MeetingPCMChannel()
    private var task: Task<Void, Never>?
    private let lock = NSLock()
    private var sentenceSeen = false

    init(key: String, resource: String, hotwords: [String], onPartial: @escaping @Sendable (String) -> Void, onSentence: @escaping @Sendable (String) -> Void) {
        task = Task.detached { [self] in
            do {
                try await self.handsFree(key: key, resource: resource, hotwords: hotwords, onPartial: onPartial, onSentence: onSentence)
            } catch {
                FileHandle.standardError.write(Data("meeting: cloud ASR failed: \(error)\n".utf8))
            }
        }
    }

    /// Close the audio and wait (bounded, 15s) for the session to finalize.
    func finish() async {
        input.close()
        guard let task else { return }
        let done = await withTaskGroup(of: Bool.self) { g -> Bool in
            g.addTask { await task.value; return true }
            g.addTask { try? await Task.sleep(nanoseconds: 15_000_000_000); return false }
            let r = await g.next() ?? false
            g.cancelAll()
            return r
        }
        if !done { task.cancel() }
    }

    private var firstSentence: Bool {
        get { lock.lock(); defer { lock.unlock() }; return sentenceSeen }
        set { lock.lock(); sentenceSeen = newValue; lock.unlock() }
    }

    private func handsFree(key: String, resource: String, hotwords: [String], onPartial: @escaping @Sendable (String) -> Void, onSentence: @escaping @Sendable (String) -> Void) async throws {
        if !MeetingDoubao.twoPassOK {
            try await Self.session(url: MeetingDoubao.url, key: key, resource: resource, hotwords: hotwords, twoPass: false,
                                   input: input.stream, onPartial: onPartial, onSentence: onSentence)
            return
        }
        // Tee into a bounded replay buffer until the first sentence lands.
        let pump = MeetingPump(source: input.stream, firstSentence: { [weak self] in self?.firstSentence ?? true })
        let first = MeetingPCMChannel()
        await pump.start(target: first)
        let wrapped: @Sendable (String) -> Void = { [weak self] s in
            self?.firstSentence = true
            onSentence(s)
        }
        do {
            try await Self.session(url: MeetingDoubao.urlAsync, key: key, resource: resource, hotwords: hotwords, twoPass: true,
                                   input: first.stream, onPartial: onPartial, onSentence: wrapped)
            await pump.stop()
            return
        } catch {
            if firstSentence {
                await pump.stop()
                throw error
            }
            MeetingDoubao.twoPassOK = false
            let second = MeetingPCMChannel()
            guard await pump.swap(to: second) else { throw error }
            defer { Task { await pump.stop() } }
            try await Self.session(url: MeetingDoubao.url, key: key, resource: resource, hotwords: hotwords, twoPass: false,
                                   input: second.stream, onPartial: onPartial, onSentence: wrapped)
        }
    }

    /// One WebSocket session (doubao.rs `run_session`, hands-free).
    static func session(url: String, key: String, resource: String, hotwords: [String], twoPass: Bool,
                        input: AsyncStream<Data>, onPartial: @escaping @Sendable (String) -> Void, onSentence: @escaping @Sendable (String) -> Void) async throws {
        var req = URLRequest(url: URL(string: url)!)
        req.setValue(key, forHTTPHeaderField: "X-Api-Key")
        req.setValue(resource, forHTTPHeaderField: "X-Api-Resource-Id")
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Api-Request-Id")
        req.setValue("-1", forHTTPHeaderField: "X-Api-Sequence")
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Api-Connect-Id")
        let ws = URLSession.shared.webSocketTask(with: req)
        ws.maximumMessageSize = 16 * 1024 * 1024
        ws.resume()
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        // Connect + config, bounded at 5s like the Rust connect timeout.
        try await withThrowingTaskGroup(of: Void.self) { g in
            g.addTask { try await ws.send(.data(MeetingDoubao.fullClientRequest(hotwords: hotwords, twoPass: twoPass))) }
            g.addTask { try await Task.sleep(nanoseconds: 5_000_000_000); throw MeetingError.message("doubao: connect timed out") }
            try await g.next()
            g.cancelAll()
        }
        let sender = Task.detached {
            var prev: Data?
            for await chunk in input {
                if let p = prev { try await ws.send(.data(MeetingDoubao.audioRequest(p, last: false))) }
                prev = chunk
            }
            try await ws.send(.data(MeetingDoubao.audioRequest(prev ?? Data(), last: true)))
        }
        defer { sender.cancel() }
        var sawLast = false
        while true {
            let msg: URLSessionWebSocketTask.Message
            do { msg = try await ws.receive() } catch {
                if ws.closeCode != .invalid { break }
                throw error
            }
            guard case .data(let data) = msg else { continue }
            let p = try MeetingDoubao.parse(data)
            if let e = p.error { throw MeetingError.message("doubao asr error: \(e)") }
            for s in p.sentences { onSentence(s) }
            if let t = p.interim { onPartial(t) } else if !p.sentences.isEmpty { onPartial("") }
            if p.last { sawLast = true; break }
        }
        _ = await sender.result
        if !sawLast { throw MeetingError.message("doubao session ended without a final frame") }
    }
}

/// The replay pump of `stream_hands_free`: forwards live audio to the current
/// attempt, teeing it into a ≤60s buffer until the first sentence lands so a
/// failed two-pass attempt can be replayed onto the plain endpoint.
actor MeetingPump {
    private let source: AsyncStream<Data>
    private let firstSentence: @Sendable () -> Bool
    private var out: MeetingPCMChannel?
    private var buffer: [Data] = []
    private var bufferBytes = 0
    private var buffering = true
    private var ended = false
    private var replaying = false
    private var pending: [Data] = []
    private var task: Task<Void, Never>?
    private static let cap = 60 * 32000

    init(source: AsyncStream<Data>, firstSentence: @escaping @Sendable () -> Bool) {
        self.source = source
        self.firstSentence = firstSentence
    }

    func start(target: MeetingPCMChannel) {
        out = target
        let source = source
        task = Task { [weak self] in
            for await chunk in source { await self?.forward(chunk) }
            await self?.end()
        }
    }

    private func forward(_ chunk: Data) {
        if replaying {
            pending.append(chunk)
            return
        }
        if buffering {
            if firstSentence() {
                buffering = false
                buffer.removeAll()
            } else if bufferBytes + chunk.count <= Self.cap {
                bufferBytes += chunk.count
                buffer.append(chunk)
            } else {
                buffering = false
                buffer.removeAll()
            }
        }
        out?.send(chunk)
    }

    private func end() {
        ended = true
        if !replaying { out?.close() }
    }

    /// Switch to a new attempt: replay the buffer (paced ~15ms/chunk), then live.
    /// False when the audio source already closed with nothing delivered.
    func swap(to next: MeetingPCMChannel) async -> Bool {
        if ended { return false }
        out = nil
        replaying = true
        let replay = buffer
        buffer.removeAll()
        buffering = false
        for c in replay {
            next.send(c)
            try? await Task.sleep(nanoseconds: 15_000_000)
        }
        for c in pending { next.send(c) }
        pending.removeAll()
        replaying = false
        out = next
        if ended { next.close() }
        return true
    }

    func stop() {
        task?.cancel()
        out?.close()
    }
}
