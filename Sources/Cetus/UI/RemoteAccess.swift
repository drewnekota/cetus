import AppKit
import CoreImage
import CryptoKit
import Foundation
import Observation

// Port of src-tauri/src/remote.rs: the authenticated mobile companion served on
// localhost (127.0.0.1:17382) and published through Tailscale Serve. Only
// conversation operations are exposed; files, terminal, secrets and settings never
// enter this API. The web client (src-tauri/remote/*) is served verbatim.

/// `RemoteSettings` (get_remote_settings / set_remote_enabled / … return value).
struct RemoteSnapshot: Equatable {
    var enabled = false
    var keepAwake = false
    var port = 17382
    var accessUrl = ""
    var pairingUrl = ""
    var tailscaleReady = false
    var tailscaleMessage = ""
}

@Observable
@MainActor
final class RemoteModel {
    static let shared = RemoteModel()
    var snapshot: RemoteSnapshot?
    var busy = false
}

enum RemoteAccess {
    // MARK: Persistent settings (remote.enabled / remote.keep_awake / remote.access_token)

    private struct Config: Codable { var enabled = false; var keepAwake = false; var token = "" }
    nonisolated(unsafe) private static var config = loadConfig()
    private static let lock = NSLock()

    private static var configFile: URL { Env.dataDir.appendingPathComponent("remote.json") }

    private static func loadConfig() -> Config {
        var c = (try? Data(contentsOf: Env.dataDir.appendingPathComponent("remote.json"))).flatMap { try? JSONDecoder().decode(Config.self, from: $0) } ?? Config()
        if c.token.count < 32 { c.token = newToken() }
        return c
    }

    private static func saveConfig() {
        try? FileManager.default.createDirectory(at: Env.dataDir, withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(config) { try? d.write(to: configFile, options: .atomic) }
    }

    private static func setToken(_ t: String) { lock.lock(); config.token = t; lock.unlock() }

    static var token: String { lock.lock(); defer { lock.unlock() }; return config.token }
    static var keepAwakePref: Bool { config.keepAwake }

    /// 64 hex chars from two v4 UUIDs (`new_token`).
    static func newToken() -> String {
        (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
    }

    /// 17382 in a real install; comparison instances use their own port so they
    /// never collide with the user's running Cetus.
    static var port: Int {
        if let p = Env.process["CETUS_REMOTE_PORT"].flatMap(Int.init) { return p }
        return Env.process["CETUS_CONTROL"] != nil ? 18382 : 17382
    }

    nonisolated(unsafe) private static weak var controller: Controller?

    @MainActor
    static func initialize(_ c: Controller) {
        controller = c
        if config.enabled { startServer() }
        Task { await refresh() }
    }

    // MARK: Commands (the Settings section calls these)

    @MainActor
    static func refresh() async {
        RemoteModel.shared.snapshot = await snapshot()
    }

    @MainActor
    static func setEnabled(_ on: Bool) async {
        RemoteModel.shared.busy = true
        defer { RemoteModel.shared.busy = false }
        config.enabled = on
        saveConfig()
        if on {
            startServer()
            let configured = await Task.detached { configureTailscale() }.value
            var s = await snapshot()
            if case .failure(let e) = configured {
                s.tailscaleReady = false
                s.tailscaleMessage = "Tailscale Serve needs attention: \(e.message)"
            }
            RemoteModel.shared.snapshot = s
        } else {
            stopServer()
            RemoteModel.shared.snapshot = await snapshot()
        }
    }

    @MainActor
    static func setKeepAwake(_ on: Bool) async {
        RemoteModel.shared.busy = true
        defer { RemoteModel.shared.busy = false }
        config.keepAwake = on
        saveConfig()
        Awake.setRemotePref(on)
        RemoteModel.shared.snapshot = await snapshot()
    }

    /// rotate_remote_access: a fresh token; existing phones are rejected at once.
    @MainActor
    static func rotate() async {
        RemoteModel.shared.busy = true
        defer { RemoteModel.shared.busy = false }
        setToken(newToken())
        saveConfig()
        RemoteModel.shared.snapshot = await snapshot()
    }

    static func snapshot() async -> RemoteSnapshot {
        let (url, ready, message) = await Task.detached { tailscaleURL() }.value
        return RemoteSnapshot(enabled: config.enabled, keepAwake: config.keepAwake, port: port, accessUrl: url,
                              pairingUrl: "\(url)/pair?token=\(token)", tailscaleReady: ready, tailscaleMessage: message)
    }

    // MARK: Tailscale

    struct Failure: Error { let message: String }

    private static func run(_ bin: String, _ args: [String]) -> (status: Int32, out: Data, err: Data)? {
        let p = Process()
        if bin.hasPrefix("/") { p.executableURL = URL(fileURLWithPath: bin) } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        }
        p.arguments = bin.hasPrefix("/") ? args : [bin] + args
        p.environment = Env.shell
        let o = Pipe(), e = Pipe()
        p.standardOutput = o
        p.standardError = e
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let out = o.fileHandleForReading.readDataToEndOfFile()
        let err = e.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        // `env` exits 127 when the program isn't on PATH: that's "could not spawn".
        if !bin.hasPrefix("/") && p.terminationStatus == 127 { return nil }
        return (p.terminationStatus, out, err)
    }

    private static func tailscaleBinary() -> String {
        ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
            .first { run($0, ["version"]) != nil } ?? "tailscale"
    }

    private static func configureTailscale() -> Result<Void, Failure> {
        // A comparison instance must never rewrite the user's Tailscale Serve config.
        if Env.process["CETUS_CONTROL"] != nil || Env.process["CETUS_REMOTE_NO_SERVE"] != nil { return .success(()) }
        guard let r = run(tailscaleBinary(), ["serve", "--bg", "--yes", "http://127.0.0.1:\(port)"]) else {
            return .failure(Failure(message: "No such file or directory (os error 2)"))
        }
        if r.status == 0 { return .success(()) }
        return .failure(Failure(message: String(decoding: r.err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    private static func tailscaleURL() -> (String, Bool, String) {
        let local = "http://127.0.0.1:\(port)"
        guard let r = run(tailscaleBinary(), ["status", "--json"]) else { return (local, false, "Tailscale CLI not found") }
        if r.status != 0 { return (local, false, "Tailscale is not connected") }
        var dns = JSON.parse(r.out)?["Self"]["DNSName"].string ?? ""
        while dns.hasSuffix(".") { dns.removeLast() }
        if dns.isEmpty { return (local, false, "MagicDNS name unavailable") }
        return ("https://\(dns)", true, "Available only inside your tailnet")
    }

    // MARK: Event fan-out (app-event → WebSocket) + pending control requests

    nonisolated(unsafe) private static var pendingControls: [String: [JSON]] = [:]
    nonisolated(unsafe) private static var sockets: [Int32] = []
    private static let socketLock = NSLock()

    /// Mirror an agent-host message as the Tauri `app-event` payload the web client reads.
    static func broadcast(_ m: JSON) {
        guard let conv = m["conv"].string else { return }
        let payload: JSON
        switch m["type"].string {
        case "event":
            let e = m["event"]
            switch e["type"].string {
            case "cli_control_request": pendingControls[conv, default: []].append(e)
            case "agent_end": pendingControls[conv] = nil
            case "cli_control_resolved": pendingControls[conv]?.removeAll { $0["requestId"] == e["requestId"] }
            default: break
            }
            payload = ["type": "pi_event", "conversationId": .string(conv), "event": e]
        case "error": payload = ["type": "pi_error", "conversationId": .string(conv), "message": m["message"]]
        case "exited": payload = ["type": "pi_exited", "conversationId": .string(conv), "code": m["code"]]
        default: return
        }
        socketLock.lock()
        let targets = sockets
        socketLock.unlock()
        guard !targets.isEmpty else { return }
        let frame = wsFrame(Data(SerdeJSON.compact(payload).utf8))
        DispatchQueue.global().async {
            for fd in targets { _ = frame.withUnsafeBytes { write(fd, $0.baseAddress, frame.count) } }
        }
    }

    // MARK: HTTP server (127.0.0.1 only)

    nonisolated(unsafe) private static var listenFd: Int32 = -1

    @MainActor
    static func startServer() {
        guard listenFd < 0 else { return }
        Awake.setRemoteActive(true)
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port).bigEndian)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard ok == 0, listen(fd, 32) == 0 else {
            NSLog("Cetus Remote could not bind 127.0.0.1:\(port)")
            close(fd)
            return
        }
        listenFd = fd
        NSLog("Cetus Remote listening on http://127.0.0.1:\(port)")
        Thread.detachNewThread {
            while true {
                let conn = accept(fd, nil, nil)
                if conn < 0 { if errno == EINTR { continue }; break }
                var on: Int32 = 1
                setsockopt(conn, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                Thread.detachNewThread { handle(conn) }
            }
        }
    }

    @MainActor
    static func stopServer() {
        if listenFd >= 0 { Darwin.shutdown(listenFd, SHUT_RDWR); close(listenFd); listenFd = -1 }
        socketLock.lock()
        for s in sockets { Darwin.shutdown(s, SHUT_RDWR) }
        sockets = []
        socketLock.unlock()
        Awake.setRemoteActive(false)
    }

    @MainActor
    static func shutdownAll() { stopServer() }
    @MainActor
    static func shutdown() { stopServer() }

    struct Request {
        var method: String
        var path: String
        var query: [String: String]
        var headers: [String: String]
        var body: Data
    }

    struct Response {
        var status: Int
        var headers: [(String, String)] = []
        var body = Data()

        static func json(_ status: Int, _ j: JSON) -> Response {
            Response(status: status, headers: [("content-type", "application/json")], body: Data(SerdeJSON.compact(j).utf8))
        }
        static func text(_ status: Int, _ s: String, type: String = "text/plain; charset=utf-8") -> Response {
            Response(status: status, headers: [("content-type", type)], body: Data(s.utf8))
        }
        static func empty(_ status: Int) -> Response { Response(status: status) }
    }

    private static let reasons = [200: "OK", 202: "Accepted", 204: "No Content", 303: "See Other", 400: "Bad Request", 401: "Unauthorized",
                                  404: "Not Found", 405: "Method Not Allowed", 415: "Unsupported Media Type", 422: "Unprocessable Entity", 500: "Internal Server Error"]

    private static func readRequest(_ fd: Int32) -> Request? {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 65536)
        var headerEnd: Range<Data.Index>?
        while headerEnd == nil {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { return nil }
            data.append(contentsOf: buf[0 ..< n])
            headerEnd = data.range(of: Data("\r\n\r\n".utf8))
            if data.count > 1 << 20 && headerEnd == nil { return nil }
        }
        guard let end = headerEnd else { return nil }
        let head = String(decoding: data[data.startIndex ..< end.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let parts = lines.removeFirst().split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for l in lines {
            guard let c = l.firstIndex(of: ":") else { continue }
            let k = l[..<c].trimmingCharacters(in: .whitespaces).lowercased()
            let v = l[l.index(after: c)...].trimmingCharacters(in: .whitespaces)
            headers[k] = headers[k].map { "\($0); \(v)" } ?? v
        }
        var body = Data(data[end.upperBound...])
        let length = Int(headers["content-length"] ?? "0") ?? 0
        if length > 64 << 20 { return nil }
        while body.count < length {
            let n = read(fd, &buf, min(buf.count, length - body.count))
            if n <= 0 { break }
            body.append(contentsOf: buf[0 ..< n])
        }
        let target = String(parts[1])
        let (path, q) = target.firstIndex(of: "?").map { (String(target[..<$0]), String(target[target.index(after: $0)...])) } ?? (target, "")
        var query: [String: String] = [:]
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String($0) }
            if let k = kv.first { query[k] = kv.count > 1 ? kv[1] : "" }
        }
        return Request(method: String(parts[0]), path: path, query: query, headers: headers, body: body)
    }

    private static func send(_ fd: Int32, _ r: Response) {
        var head = "HTTP/1.1 \(r.status) \(reasons[r.status] ?? "Status")\r\n"
        for (k, v) in r.headers { head += "\(k): \(v)\r\n" }
        head += "content-length: \(r.body.count)\r\nconnection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(r.body)
        var off = 0
        while off < out.count {
            let n = out.withUnsafeBytes { write(fd, $0.baseAddress! + off, out.count - off) }
            if n <= 0 { break }
            off += n
        }
    }

    private static func handle(_ fd: Int32) {
        guard let req = readRequest(fd) else { close(fd); return }
        if req.path == "/api/events" && req.method == "GET" {
            events(fd, req)
            return
        }
        send(fd, route(req))
        close(fd)
    }

    // MARK: Auth

    private static func cookieAuthorized(_ req: Request) -> Bool {
        let expected = "cetus_remote=\(token)"
        return (req.headers["cookie"] ?? "").split(separator: ";").contains { $0.trimmingCharacters(in: .whitespaces) == expected }
    }

    private static func authorized(_ req: Request) -> Bool {
        cookieAuthorized(req) && req.headers["x-cetus-remote"] == "1"
    }

    private static let unauthorized = Response.json(401, ["error": "Pair this phone from Cetus Settings first."])

    private static func resource(_ name: String) -> Data {
        Theme.resource("shell/remote/\(name)").flatMap { try? Data(contentsOf: $0) } ?? Data()
    }

    // MARK: Routes

    private static func route(_ req: Request) -> Response {
        let segs = req.path.split(separator: "/").map(String.init)
        switch (req.method, req.path) {
        case ("GET", "/"): return Response(status: 200, headers: [("content-type", "text/html; charset=utf-8")], body: resource("index.html"))
        case ("GET", "/app.css"):
            var d = resource("cetus-tokens.css")
            d.append(Data("\n".utf8))
            d.append(resource("app.css"))
            return Response(status: 200, headers: [("content-type", "text/css; charset=utf-8")], body: d)
        case ("GET", "/app.js"): return Response(status: 200, headers: [("content-type", "text/javascript; charset=utf-8")], body: resource("app.js"))
        case ("GET", "/manifest.webmanifest"): return Response(status: 200, headers: [("content-type", "application/manifest+json")], body: resource("manifest.webmanifest"))
        case ("GET", "/remote-icon.svg"): return Response(status: 200, headers: [("content-type", "image/svg+xml")], body: resource("icon.svg"))
        case ("GET", "/pair"):
            let t = token
            guard req.query["token"] == t else { return .text(401, "Invalid or expired pairing link") }
            return Response(status: 303, headers: [("location", "/"), ("set-cookie", "cetus_remote=\(t); Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000")])
        default: break
        }
        guard segs.first == "api" else { return .empty(404) }
        guard authorized(req) else {
            return segs.count >= 2 && ["status", "conversations"].contains(segs[1]) ? unauthorized : .empty(404)
        }
        func body() -> JSON? { req.body.isEmpty ? nil : JSON.parse(req.body) }
        let result: Result<Response, Failure> = DispatchQueue.main.sync {
            MainActor.assumeIsolated { () -> Result<Response, Failure> in
                guard let c = controller else { return .failure(Failure(message: "app is not ready")) }
                switch (req.method, Array(segs.dropFirst())) {
                case ("GET", ["status"]): return .success(.json(200, ["ok": true, "version": 1]))
                case ("GET", ["conversations"]):
                    let include = req.query["archived"] == "true"
                    let rows = include ? (c.store.list() + c.store.archived()).sorted { $0.updatedAt > $1.updatedAt } : c.store.list()
                    return .success(.json(200, .array(rows.map(CLIServer.conversationJSON))))
                case ("POST", ["conversations"]):
                    guard let b = body() else { return .success(.text(400, "Failed to parse the request body as JSON")) }
                    return newConversation(c, b)
                case ("GET", let p) where p.count == 2 && p[0] == "conversations":
                    guard let conv = c.store.get(p[1]) else { return .failure(Failure(message: "conversation not found")) }
                    return .success(.json(200, ["conversation": CLIServer.conversationJSON(conv), "messages": .array(c.store.messages(conv.id)),
                                                "pendingControls": .array(pendingControls[conv.id] ?? [])]))
                case ("PATCH", let p) where p.count == 2 && p[0] == "conversations":
                    guard let b = body() else { return .success(.text(400, "Failed to parse the request body as JSON")) }
                    return patch(c, p[1], b)
                case ("POST", let p) where p.count == 3 && p[0] == "conversations" && p[2] == "messages":
                    guard let b = body(), let message = b["message"].string else { return .success(.text(422, "Failed to deserialize the JSON body into the target type: missing field `message`")) }
                    return sendMessage(c, p[1], message, b["images"].array ?? [])
                case ("POST", let p) where p.count == 3 && p[0] == "conversations" && p[2] == "abort":
                    guard c.store.get(p[1]) != nil else { return .failure(Failure(message: "conversation not found")) }
                    c.abort(p[1])
                    return .success(.empty(204))
                case ("POST", let p) where p.count == 3 && p[0] == "conversations" && p[2] == "control":
                    guard let b = body() else { return .success(.text(400, "Failed to parse the request body as JSON")) }
                    let rid = b["requestId"]
                    c.respondToControl(p[1], request: ["requestId": rid], response: b["response"])
                    pendingControls[p[1]]?.removeAll { $0["requestId"] == rid }
                    return .success(.empty(204))
                default:
                    return .success(.empty(404))
                }
            }
        }
        switch result {
        case .success(let r): return r
        case .failure(let e): return .json(400, ["error": .string(e.message)])
        }
    }

    @MainActor
    private static func isRemoteWorkspace(_ d: String) -> Bool {
        d.hasPrefix("ssh://") || d.range(of: #"^[^/:\s]+@?[^/:\s]+:"#, options: .regularExpression) != nil
    }

    @MainActor
    private static func newConversation(_ c: Controller, _ b: JSON) -> Result<Response, Failure> {
        let ws = b["workspaceDir"].string ?? Env.defaultWorkspace
        if !isRemoteWorkspace(ws) {
            do { try FileManager.default.createDirectory(atPath: ws, withIntermediateDirectories: true) } catch { return .failure(Failure(message: error.localizedDescription)) }
        }
        let conv = c.store.create(title: "", workspaceDir: ws, backend: b["backend"].string ?? "pi", model: "", effort: "")
        c.reload()
        return .success(.json(200, CLIServer.conversationJSON(c.store.get(conv.id) ?? conv)))
    }

    @MainActor
    private static func patch(_ c: Controller, _ id: String, _ b: JSON) -> Result<Response, Failure> {
        guard let conv = c.store.get(id) else { return .failure(Failure(message: "conversation not found")) }
        if let t = b["title"].string { c.rename(id, t) }
        if let backend = b["backend"].string, backend != conv.backend { c.store.update(id, [.backend(backend), .sessionFile("")]) }
        if !b["cliModel"].isNull || !b["cliEffort"].isNull {
            c.store.update(id, [.model(b["cliModel"].string ?? ""), .effort(b["cliEffort"].string ?? "")])
        }
        if let r = b["reviewState"].string { c.store.update(id, [.reviewState(r)]) }
        if let a = b["archived"].bool { if a { c.archive(id) } else { c.restore(id) } }
        c.reload()
        guard let updated = c.store.get(id) else { return .failure(Failure(message: "conversation not found")) }
        return .success(.json(200, CLIServer.conversationJSON(updated)))
    }

    @MainActor
    private static func sendMessage(_ c: Controller, _ id: String, _ message: String, _ images: [JSON]) -> Result<Response, Failure> {
        guard let conv = c.store.get(id) else { return .failure(Failure(message: "conversation not found")) }
        var attachments: [Attachment] = []
        let dir = Env.dataDir.appendingPathComponent("remote-uploads")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for img in images {
            guard let b64 = img["data"].string, let data = Data(base64Encoded: b64) else { continue }
            let mime = img["mimeType"].string ?? "image/png"
            let ext = mime.split(separator: "/").last.map(String.init).map { $0 == "jpeg" ? "jpg" : $0 } ?? "png"
            let url = dir.appendingPathComponent("\(UUID().uuidString.lowercased()).\(ext)")
            guard (try? data.write(to: url)) != nil, case .success(let a) = Attachment.make(url.path) else { continue }
            attachments.append(a)
        }
        if conv.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { c.store.update(id, [.title(Titling.derive(message))]) }
        c.send(SendOptions(conversationId: id, text: message, backend: conv.backend, model: conv.cliModel, effort: conv.cliEffort,
                           workspaceDir: conv.workspaceDir, attachments: attachments))
        return .success(.empty(202))
    }

    // MARK: WebSocket (/api/events)

    private static func events(_ fd: Int32, _ req: Request) {
        guard cookieAuthorized(req), let key = req.headers["sec-websocket-key"] else {
            send(fd, .empty(401))
            close(fd)
            return
        }
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        let head = "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-accept: \(accept)\r\n\r\n"
        _ = head.withCString { write(fd, $0, strlen($0)) }
        socketLock.lock(); sockets.append(fd); socketLock.unlock()
        // Read (and discard) client frames until close; answer pings.
        var buf = [UInt8](repeating: 0, count: 4096)
        var pending = [UInt8]()
        loop: while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            pending += buf[0 ..< n]
            while pending.count >= 2 {
                let opcode = pending[0] & 0x0F
                var len = Int(pending[1] & 0x7F)
                var off = 2
                if len == 126 { guard pending.count >= 4 else { break }; len = Int(pending[2]) << 8 | Int(pending[3]); off = 4 }
                else if len == 127 { guard pending.count >= 10 else { break }; len = (2 ..< 10).reduce(0) { $0 << 8 | Int(pending[$1]) }; off = 10 }
                let masked = pending[1] & 0x80 != 0
                let total = off + (masked ? 4 : 0) + len
                guard pending.count >= total else { break }
                if opcode == 0x8 { break loop }
                if opcode == 0x9 {
                    var payload = Array(pending[(off + (masked ? 4 : 0)) ..< total])
                    if masked { let m = Array(pending[off ..< off + 4]); for i in payload.indices { payload[i] ^= m[i % 4] } }
                    var f = Data([0x8A])
                    f.append(UInt8(min(payload.count, 125)))
                    f.append(contentsOf: payload.prefix(125))
                    _ = f.withUnsafeBytes { write(fd, $0.baseAddress, f.count) }
                }
                pending.removeFirst(total)
            }
        }
        socketLock.lock(); sockets.removeAll { $0 == fd }; socketLock.unlock()
        close(fd)
    }

    static func wsFrame(_ payload: Data) -> Data {
        var f = Data([0x81])
        if payload.count < 126 { f.append(UInt8(payload.count)) }
        else if payload.count < 65536 { f.append(126); f.append(UInt8(payload.count >> 8)); f.append(UInt8(payload.count & 0xFF)) }
        else { f.append(127); for i in (0 ..< 8).reversed() { f.append(UInt8((payload.count >> (i * 8)) & 0xFF)) } }
        f.append(payload)
        return f
    }

    // MARK: QR

    /// The pairing QR as a module matrix (EC level M, as the `qrcode` crate's default).
    static func qrModules(_ text: String) -> [[Bool]]? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let img = f.outputImage else { return nil }
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(img, from: img.extent) else { return nil }
        let w = cg.width, h = cg.height
        var px = [UInt8](repeating: 0, count: w * h)
        guard let gctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return nil }
        gctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var rows = (0 ..< h).map { y in (0 ..< w).map { x in px[y * w + x] < 128 } }
        // Strip CoreImage's own quiet zone; the view adds the standard 4 modules.
        while let r = rows.first, !r.contains(true) { rows.removeFirst() }
        while let r = rows.last, !r.contains(true) { rows.removeLast() }
        let left = rows.map { $0.firstIndex(of: true) ?? Int.max }.min() ?? 0
        let right = rows.map { $0.lastIndex(of: true) ?? 0 }.max() ?? 0
        return rows.map { Array($0[left ... right]) }
    }
}
