import Foundation

/// What the pairing QR (`cetus://pair#<base64url JSON>`) carries.
public struct PairingOffer: Codable, Hashable, Sendable {
    public var v: Int
    /// Relay room id.
    public var sid: String
    /// The Mac's static X25519 public key, base64.
    public var pk: String
    /// Relay base URL, e.g. wss://relay.cetus.run
    public var relay: String
    /// Optional direct socket (Tailscale), e.g. wss://mac.tailnet.ts.net/v1/direct
    public var direct: String?
    /// One-time pairing secret.
    public var ps: String
    public var name: String?

    public static func parse(_ text: String) -> PairingOffer? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hash = trimmed.firstIndex(of: "#") else { return nil }
        let head = trimmed[..<hash].lowercased()
        guard head.hasPrefix("cetus://pair") else { return nil }
        var b64 = String(trimmed[trimmed.index(after: hash)...])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let offer = try? JSONDecoder().decode(PairingOffer.self, from: data),
              offer.v == 1, offer.sid.count == 32, Data(base64Encoded: offer.pk)?.count == 32
        else { return nil }
        return offer
    }
}

/// A Mac this phone has paired with. Everything needed to reconnect.
public struct PairedHost: Codable, Hashable, Identifiable, Sendable {
    public var id: String { sid }
    public var sid: String
    public var publicKey: String
    public var relay: String
    public var direct: String?
    public var macName: String
    public var deviceToken: String
    public var pairedAt: Date

    public init(offer: PairingOffer, macName: String, deviceToken: String) {
        sid = offer.sid
        publicKey = offer.pk
        relay = offer.relay
        direct = offer.direct
        self.macName = macName
        self.deviceToken = deviceToken
        pairedAt = Date()
    }
}

public enum RemoteError: LocalizedError, Equatable, Sendable {
    case macOffline
    case unpaired
    case handshakeFailed
    case closed
    case timeout
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .macOffline: "Your Mac is offline, or Remote Access is turned off in Cetus."
        case .unpaired: "This iPhone is no longer paired. Scan the QR code in Cetus Settings again."
        case .handshakeFailed: "Couldn't verify your Mac. Scan the QR code again."
        case .closed: "Connection closed."
        case .timeout: "Couldn't reach your Mac."
        case .server(let m): m
        }
    }
}

public struct HelloResult: Sendable {
    public var deviceToken: String?
    public var macName: String
}

/// One end-to-end encrypted session with a Mac (see remote_secure.rs for the
/// protocol). Connect, `hello`, then `request` + `events`.
public actor RemoteConnection {
    private static let chunk = 65_535 - 16 - 1
    private static let prologue = Data("cetus-remote-v1".utf8)

    private var task: URLSessionWebSocketTask?
    private var send: CipherState?
    private var receive: CipherState?
    private var partial = Data()
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<JSON, Error>] = [:]
    private var closedError: RemoteError?
    private let eventContinuation: AsyncStream<JSON>.Continuation
    public nonisolated let events: AsyncStream<JSON>
    private let session: URLSession

    public init() {
        var c: AsyncStream<JSON>.Continuation!
        events = AsyncStream(bufferingPolicy: .bufferingNewest(4096)) { c = $0 }
        eventContinuation = c
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        session = URLSession(configuration: config)
    }

    /// Opens the socket and runs the Noise handshake. Tries the relay first,
    /// then the direct (Tailscale) URL when the offer has one.
    public func connect(relay: String, direct: String?, sid: String, publicKey: String) async throws {
        guard let pk = Data(base64Encoded: publicKey), pk.count == 32 else { throw RemoteError.handshakeFailed }
        var urls: [URL] = []
        if let u = URL(string: "\(relay.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/v1/client?sid=\(sid)") {
            urls.append(u)
        }
        if let d = direct, let u = URL(string: d) { urls.append(u) }
        var last: Error = RemoteError.timeout
        for url in urls {
            do {
                try await open(url: url, publicKey: pk)
                return
            } catch let e as RemoteError where e == .handshakeFailed {
                throw e
            } catch {
                last = error
            }
        }
        throw last
    }

    private func open(url: URL, publicKey: Data) async throws {
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 1 << 20
        task.resume()
        self.task = task
        var noise = try NoiseNKInitiator(remoteStatic: publicKey, prologue: Self.prologue)
        do {
            let msg1 = try noise.writeMessage1()
            try await withTimeout(12) { try await task.send(.data(msg1)) }
            let reply = try await withTimeout(12) { try await task.receive() }
            guard case .data(let msg2) = reply else { throw RemoteError.handshakeFailed }
            do {
                (send, receive) = try noise.readMessage2(msg2)
            } catch {
                throw RemoteError.handshakeFailed
            }
        } catch {
            let code = task.closeCode.rawValue
            task.cancel(with: .goingAway, reason: nil)
            self.task = nil
            if code == 4404 { throw RemoteError.macOffline }
            throw error
        }
        Task { await self.readLoop() }
    }

    public func hello(deviceId: String, deviceName: String, token: String?, pairingSecret: String?) async throws -> HelloResult {
        var params: [String: JSON] = ["deviceId": .string(deviceId), "deviceName": .string(deviceName)]
        if let token { params["token"] = .string(token) }
        if let pairingSecret { params["pairingSecret"] = .string(pairingSecret) }
        do {
            let r = try await request("hello", .object(params))
            return HelloResult(deviceToken: r["deviceToken"].string, macName: r["macName"].string ?? "Mac")
        } catch RemoteError.server(let m) where m == "unpaired" {
            throw RemoteError.unpaired
        }
    }

    public func request(_ method: String, _ params: JSON = [:]) async throws -> JSON {
        if let closedError { throw closedError }
        let id = nextId
        nextId += 1
        let body: JSON = ["id": .number(Double(id)), "method": .string(method), "params": params]
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            do {
                try write(body)
            } catch {
                fail(id: id, error)
            }
        }
    }

    private func fail(id: Int, _ error: Error) {
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        finish(.closed)
    }

    /// Encrypts every chunk of a message in one go (no suspension point), then
    /// queues the frames; the socket sends queued frames in order, so chunks of
    /// two messages never interleave and nonces stay in step with the Mac.
    private func write(_ value: JSON) throws {
        guard let task, var cipher = send else { throw RemoteError.closed }
        let bytes = try value.data()
        var frames: [Data] = []
        var offset = 0
        repeat {
            let end = min(offset + Self.chunk, bytes.count)
            var plain = Data([end == bytes.count ? 1 : 0])
            plain.append(bytes[offset..<end])
            frames.append(try cipher.encrypt(ad: Data(), plaintext: plain))
            offset = end
        } while offset < bytes.count
        send = cipher
        for frame in frames {
            task.send(.data(frame)) { _ in }
        }
    }

    private func readLoop() async {
        while let task {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                finish(task.closeCode.rawValue == 4404 ? .macOffline : .closed)
                return
            }
            guard case .data(let frame) = message, var cipher = receive else { continue }
            guard let plain = try? cipher.decrypt(ad: Data(), ciphertext: frame), !plain.isEmpty else {
                finish(.closed)
                task.cancel(with: .protocolError, reason: nil)
                return
            }
            receive = cipher
            partial.append(plain.dropFirst())
            let flags = plain[plain.startIndex]
            guard flags & 1 == 1 else { continue }
            var whole = partial
            partial = Data()
            // Bit 1: raw DEFLATE (Apple's `.zlib` is RFC 1951 raw deflate).
            if flags & 2 != 0 {
                guard let inflated = try? (whole as NSData).decompressed(using: .zlib) as Data else { continue }
                whole = inflated
            }
            guard let msg = try? JSON.parse(whole) else { continue }
            if let event = msg.object?["event"] {
                eventContinuation.yield(event)
            } else if let id = msg["id"].int, let cont = pending.removeValue(forKey: id) {
                if let err = msg["error"].string {
                    cont.resume(throwing: RemoteError.server(err))
                } else {
                    cont.resume(returning: msg["result"])
                }
            }
        }
    }

    private func finish(_ error: RemoteError) {
        guard closedError == nil else { return }
        closedError = error
        task = nil
        for (_, c) in pending { c.resume(throwing: error) }
        pending.removeAll()
        eventContinuation.finish()
    }

    public var isClosed: Bool { closedError != nil }
    public var closeReason: RemoteError? { closedError }
}

func withTimeout<T: Sendable>(_ seconds: Double, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await body() }
        group.addTask {
            try await Task.sleep(for: .seconds(seconds))
            throw RemoteError.timeout
        }
        let first = try await group.next()!
        group.cancelAll()
        return first
    }
}
