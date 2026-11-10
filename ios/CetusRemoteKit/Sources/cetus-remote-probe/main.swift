// Interop probe: drives a running Cetus through the same CetusRemoteKit code
// the iOS app uses.
//
//   cetus-remote-probe pair '<cetus://pair#…>'   pair and remember the host
//   cetus-remote-probe list                       list conversations
//   cetus-remote-probe get <id>                   history size + pending controls
//   cetus-remote-probe send <id> <text> [secs]    send, then print events
//   cetus-remote-probe usage                      provider usage
//   cetus-remote-probe big                        request a large reply (chunking)
//   cetus-remote-probe fold <snapshot.json>       print how the phone folds a history
//
// CETUS_PROBE_HOST overrides where the paired host is stored.
import CetusRemoteKit
import Foundation

let hostFile = URL(fileURLWithPath: ProcessInfo.processInfo.environment["CETUS_PROBE_HOST"] ?? "/tmp/cetus-probe-host.json")
let deviceId = "probe-\(ProcessInfo.processInfo.hostName)"

func fail(_ s: String) -> Never {
    FileHandle.standardError.write(Data((s + "\n").utf8))
    exit(1)
}

func connect(_ host: PairedHost) async throws -> RemoteConnection {
    let c = RemoteConnection()
    try await c.connect(relay: host.relay, direct: host.direct, sid: host.sid, publicKey: host.publicKey)
    _ = try await c.hello(deviceId: deviceId, deviceName: "Probe", token: host.deviceToken, pairingSecret: nil)
    return c
}

func loadHost() -> PairedHost {
    guard let d = try? Data(contentsOf: hostFile), let h = try? JSONDecoder().decode(PairedHost.self, from: d) else {
        fail("not paired; run `pair` first")
    }
    return h
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("usage: cetus-remote-probe pair|list|get|send|usage|big") }

do {
    switch cmd {
    case "pair":
        guard args.count > 1, let offer = PairingOffer.parse(args[1]) else { fail("bad pairing link") }
        let c = RemoteConnection()
        try await c.connect(relay: offer.relay, direct: offer.direct, sid: offer.sid, publicKey: offer.pk)
        let r = try await c.hello(deviceId: deviceId, deviceName: "Probe", token: nil, pairingSecret: offer.ps)
        guard let token = r.deviceToken else { fail("no token returned") }
        let host = PairedHost(offer: offer, macName: r.macName, deviceToken: token)
        try JSONEncoder().encode(host).write(to: hostFile)
        print("paired with \(r.macName)")
    case "fold":
        let snap = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
        for item in ChatTimeline(snapshot: snap).items(running: false) {
            switch item {
            case .user(let m): print("USER", m.blocks.count, "blocks")
            case .assistant(let t):
                print("ASSISTANT")
                for seg in t.segments {
                    switch seg {
                    case .activity(_, let steps, let trailing):
                        print("  [fold]", AssistantSegment.summary(steps), "(\(steps.count) steps)", trailing ? "trailing" : "")
                    case .answer(let b): print("  answer:", b.id)
                    }
                }
            }
        }
    case "list":
        let c = try await connect(loadHost())
        let rows = try await c.request("conversations.list", ["archived": false])
        for row in (rows.array ?? []).prefix(10) {
            print(row["id"].string ?? "?", "|", row["backend"].string ?? "", "|", row["title"].string ?? "")
        }
        print("total:", rows.array?.count ?? 0)
    case "get":
        let c = try await connect(loadHost())
        let r = try await c.request("conversations.get", ["id": .string(args[1])])
        print("messages:", r["messages"].array?.count ?? 0, "controls:", r["pendingControls"].array?.count ?? 0)
        print("bytes:", (try? r.data().count) ?? 0)
    case "send":
        let c = try await connect(loadHost())
        let secs = args.count > 3 ? Double(args[3]) ?? 30 : 30
        let events = c.events
        let reader = Task {
            for await e in events {
                let inner = e["event"]
                var line = "\(e["type"].string ?? "?") \(inner["type"].string ?? "")"
                if let d = inner["assistantMessageEvent"]["delta"].string { line += " " + d }
                print(line)
                if inner["type"].string == "agent_end" { break }
            }
        }
        _ = try await c.request("conversations.send", ["id": .string(args[1]), "message": .string(args[2])])
        print("sent")
        _ = await withTaskGroup(of: Void.self) { g in
            g.addTask { await reader.value }
            g.addTask { try? await Task.sleep(for: .seconds(secs)) }
            await g.next()
            g.cancelAll()
        }
    case "timeline":
        let c = try await connect(loadHost())
        let r = try await c.request("conversations.get", ["id": .string(args[1])])
        let t = ChatTimeline(snapshot: r)
        var tools = 0, texts = 0, thinking = 0, withResult = 0
        for m in t.messages {
            for b in m.blocks {
                switch b {
                case .text: texts += 1
                case .thinking: thinking += 1
                case .tool(_, _, _, _, let res): tools += 1; if res != nil { withResult += 1 }
                case .image: break
                }
            }
        }
        print("messages \(t.messages.count) text \(texts) thinking \(thinking) tools \(tools) (with result \(withResult))")
    case "rpc":
        // rpc <method> [json-params]
        let c = try await connect(loadHost())
        let params = args.count > 2 ? try JSON.parse(Data(args[2].utf8)) : [:]
        print(try await c.request(args[1], params).prettyText)
    case "usage":
        let c = try await connect(loadHost())
        print(try await c.request("usage.get").prettyText)
    case "big":
        // The longest conversation exercises multi-chunk replies.
        let c = try await connect(loadHost())
        let rows = try await c.request("conversations.list", ["archived": true]).array ?? []
        var best = (0, "")
        for row in rows.prefix(40) {
            guard let id = row["id"].string else { continue }
            let r = try await c.request("conversations.get", ["id": .string(id)])
            let n = (try? r.data().count) ?? 0
            if n > best.0 { best = (n, id) }
        }
        print("largest reply: \(best.0) bytes (\(best.1))")
    default:
        fail("unknown command \(cmd)")
    }
} catch {
    fail("error: \(error.localizedDescription) [\(error)]")
}
