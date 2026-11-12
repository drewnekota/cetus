import CetusRemoteKit
import CryptoKit
import Observation
import SwiftUI
import UIKit

/// The desktop sidebar's folder layout, pushed by the Mac's webview.
struct SidebarLayout {
    var defaultDir = ""
    var dirs: [String] = []
    var hidden: Set<String> = []
    var collapsed: Set<String> = []
    /// Chats the Mac's sidebar leaves out (Cetus coordinator sessions).
    var hiddenChats: Set<String> = []
    /// Colors / emoji the user picked for folders on the Mac, by dir.
    var avatars: [String: FolderStyle] = [:]
}

/// A folder avatar the user chose on the Mac: a palette color, an emoji
/// instead of the initial, or both.
struct FolderStyle: Equatable {
    var color: UInt32?
    var emoji: String?

    init?(_ j: JSON) {
        if let hex = j["color"].string, hex.hasPrefix("#") { color = UInt32(hex.dropFirst(), radix: 16) }
        emoji = j["emoji"].string.flatMap { $0.isEmpty ? nil : $0 }
        if color == nil && emoji == nil { return nil }
    }
}

/// One folder section of the chat list (or the global Pinned section).
struct ChatGroup: Identifiable {
    var id: String { dir }
    let dir: String
    let name: String
    let items: [Conversation]
    var isPinned = false
    var isDefault = false
}

/// A folder suggestion from the Mac.
struct DirHit: Identifiable, Hashable {
    var id: String { path }
    let path: String
    let display: String
}

enum ConnectionState: Equatable {
    case idle
    case connecting
    case connected
    case failed(String)
    case unpaired
}

/// App-wide state: paired Macs, the live encrypted connection to the selected
/// one, and the conversation list it streams.
@MainActor
@Observable
final class RemoteStore {
    private(set) var hosts: [PairedHost] = []
    var selectedHostId: String? {
        didSet {
            UserDefaults.standard.set(selectedHostId, forKey: "selectedHost")
            if oldValue != selectedHostId { reconnect() }
        }
    }
    private(set) var state: ConnectionState = .idle
    private(set) var conversations: [Conversation] = []
    private(set) var running: Set<String> = []
    private(set) var sidebar = SidebarLayout()
    /// Repo icons of git folders (an icon file from the repo, or its GitHub
    /// owner's avatar), by dir. Kept on disk so they show before the Mac answers.
    private(set) var folderIcons: [String: UIImage] = [:]
    private var iconVersions: [String: String] = [:]
    private var iconTask: Task<Void, Never>?
    var showArchived = false {
        didSet { Task { await refreshList() } }
    }

    /// Follow-ups typed while a chat's agent runs, per conversation. The next
    /// one goes out when the run ends; Steer sends one right away.
    private(set) var queued: [String: [QueuedMessage]] = [:]

    /// The chat on screen, fed this connection's events.
    weak var activeChat: ChatModel?

    private var connection: RemoteConnection?
    private var eventTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var attempt = 0

    let deviceId: String = {
        if let d = Keychain.data("deviceId"), let s = String(data: d, encoding: .utf8) { return s }
        let id = UUID().uuidString
        Keychain.set(Data(id.utf8), for: "deviceId")
        return id
    }()

    init() {
        if let d = Keychain.data("hosts"), let h = try? JSONDecoder().decode([PairedHost].self, from: d) {
            hosts = h
        }
        let saved = UserDefaults.standard.string(forKey: "selectedHost")
        selectedHostId = hosts.first { $0.sid == saved }?.sid ?? hosts.first?.sid
    }

    var selectedHost: PairedHost? { hosts.first { $0.sid == selectedHostId } }

    private func saveHosts() {
        if let d = try? JSONEncoder().encode(hosts) { Keychain.set(d, for: "hosts") }
    }

    // MARK: Pairing

    func pair(with offer: PairingOffer) async throws {
        let c = RemoteConnection()
        try await c.connect(relay: offer.relay, direct: offer.direct, sid: offer.sid, publicKey: offer.pk)
        let hello = try await c.hello(
            deviceId: deviceId, deviceName: UIDevice.current.name, token: nil, pairingSecret: offer.ps)
        await c.close()
        guard let token = hello.deviceToken else { throw RemoteError.handshakeFailed }
        let host = PairedHost(offer: offer, macName: hello.macName, deviceToken: token)
        hosts.removeAll { $0.sid == host.sid }
        hosts.append(host)
        saveHosts()
        selectedHostId = host.sid
        reconnect()
    }

    func forget(_ host: PairedHost) {
        hosts.removeAll { $0.sid == host.sid }
        saveHosts()
        if selectedHostId == host.sid {
            selectedHostId = hosts.first?.sid
            if hosts.isEmpty { disconnect(); state = .idle; conversations = [] }
        }
    }

    // MARK: Connection

    func ensureConnected() {
        switch state {
        case .connected, .connecting, .unpaired: return
        default: reconnect()
        }
    }

    func reconnect() {
        disconnect()
        loadCachedIcons()
        guard let host = selectedHost else { state = .idle; return }
        state = .connecting
        retryTask = Task { await connect(host) }
    }

    private func disconnect() {
        iconTask?.cancel()
        retryTask?.cancel()
        eventTask?.cancel()
        let old = connection
        connection = nil
        Task { await old?.close() }
    }

    private func connect(_ host: PairedHost) async {
        let c = RemoteConnection()
        do {
            try await c.connect(relay: host.relay, direct: host.direct, sid: host.sid, publicKey: host.publicKey)
            let hello = try await c.hello(
                deviceId: deviceId, deviceName: UIDevice.current.name, token: host.deviceToken, pairingSecret: nil)
            guard !Task.isCancelled, host.sid == selectedHostId else { await c.close(); return }
            if hello.macName != host.macName, let i = hosts.firstIndex(where: { $0.sid == host.sid }) {
                hosts[i].macName = hello.macName
                saveHosts()
            }
            connection = c
            state = .connected
            attempt = 0
            eventTask = Task { [weak self] in
                for await e in c.events { self?.handle(e) }
                self?.connectionDropped(c)
            }
            await refreshList()
            await activeChat?.load()
        } catch RemoteError.unpaired {
            state = .unpaired
        } catch {
            guard !Task.isCancelled else { return }
            state = .failed(error.localizedDescription)
            scheduleRetry()
        }
    }

    private func connectionDropped(_ c: RemoteConnection) {
        guard connection === c else { return }
        connection = nil
        Task {
            let reason = await c.closeReason
            state = .failed((reason ?? .closed).localizedDescription)
            scheduleRetry()
        }
    }

    private func scheduleRetry() {
        attempt += 1
        let delay = min(30, pow(2, Double(min(attempt, 5))))
        retryTask = Task {
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let host = selectedHost else { return }
            state = .connecting
            await connect(host)
        }
    }

    func request(_ method: String, _ params: JSON = [:]) async throws -> JSON {
        guard let connection else { throw RemoteError.closed }
        return try await connection.request(method, params)
    }

    // MARK: Conversations

    func refreshList() async {
        async let layout: Void = refreshSidebar()
        await refreshConversations()
        await layout
    }

    private func refreshSidebar() async {
        guard let j = try? await request("workspaces.list") else { return }
        applySidebar(j)
        refreshIcons()
    }

    private func applySidebar(_ j: JSON) {
        let strings = { (key: String) in (j[key].array ?? []).compactMap(\.string) }
        sidebar = SidebarLayout(
            defaultDir: j["defaultWorkspace"].string ?? "",
            dirs: strings("dirs"),
            hidden: Set(strings("hidden")),
            collapsed: Set(strings("collapsed")),
            hiddenChats: Set(strings("hiddenChats")),
            avatars: (j["avatars"].object ?? [:]).compactMapValues(FolderStyle.init)
        )
    }

    // MARK: Folder icons

    private var iconsKey: String { "folderIcons.\(selectedHostId ?? "")" }

    private func iconFile(_ dir: String) -> URL {
        let name = SHA256.hash(data: Data("\(selectedHostId ?? "")\u{0}\(dir)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        let folder = URL.cachesDirectory.appending(path: "folder-icons", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appending(path: name)
    }

    private func loadCachedIcons() {
        iconVersions = UserDefaults.standard.dictionary(forKey: iconsKey) as? [String: String] ?? [:]
        folderIcons = [:]
        for dir in iconVersions.keys {
            if let image = UIImage(contentsOfFile: iconFile(dir).path) { folderIcons[dir] = image }
        }
    }

    /// Ask the Mac which folders have a repo icon and fetch the ones the
    /// cache lacks. A Mac too old to know the call just leaves the initials.
    private func refreshIcons() {
        iconTask?.cancel()
        iconTask = Task {
            guard let listing = try? await request("workspaces.icons").object, !Task.isCancelled else { return }
            for dir in iconVersions.keys where listing[dir] == nil {
                iconVersions[dir] = nil
                folderIcons[dir] = nil
                try? FileManager.default.removeItem(at: iconFile(dir))
            }
            for (dir, info) in listing {
                guard let v = info["v"].string else { continue }
                if iconVersions[dir] == v, folderIcons[dir] != nil { continue }
                guard let data = await fetchIcon(dir, fallback: info["url"].string), !Task.isCancelled,
                      let image = UIImage(data: data) else { continue }
                try? data.write(to: iconFile(dir), options: .atomic)
                folderIcons[dir] = image
                iconVersions[dir] = v
            }
            guard !Task.isCancelled else { return }
            UserDefaults.standard.set(iconVersions, forKey: iconsKey)
        }
    }

    private func fetchIcon(_ dir: String, fallback: String?) async -> Data? {
        let j = try? await request("workspaces.icon", ["dir": .string(dir)])
        if let b64 = j?["data"].string, let data = Data(base64Encoded: b64) { return data }
        // The Mac couldn't reach GitHub; maybe the phone can.
        guard let url = (j?["url"].string ?? fallback).flatMap(URL.init(string:)) else { return nil }
        return try? await URLSession.shared.data(from: url).0
    }

    func isDefaultFolder(_ dir: String) -> Bool {
        dir.isEmpty || dir == sidebar.defaultDir
    }

    func folderName(_ dir: String) -> String {
        dir.isEmpty || dir == sidebar.defaultDir ? "Chat" : dir.folderName
    }

    /// Chats grouped the way the Mac's sidebar draws them: Pinned first, then
    /// the default "Chat" folder and the user's folders in their order;
    /// folders the user removed on the Mac stay hidden here too.
    var groups: [ChatGroup] {
        var order: [String] = []
        var map: [String: [Conversation]] = [:]
        func ensure(_ dir: String) {
            guard map[dir] == nil, !sidebar.hidden.contains(dir) || dir == sidebar.defaultDir else { return }
            map[dir] = []
            order.append(dir)
        }
        if !sidebar.defaultDir.isEmpty { ensure(sidebar.defaultDir) }
        sidebar.dirs.forEach(ensure)
        let listed = conversations.filter { !sidebar.hiddenChats.contains($0.id) }
        for c in listed {
            ensure(c.workspaceDir)
            if !c.pinned { map[c.workspaceDir]?.append(c) }
        }
        var out = order.map { ChatGroup(dir: $0, name: folderName($0), items: map[$0] ?? [], isDefault: isDefaultFolder($0)) }
        let pinned = listed.filter { $0.pinned && !sidebar.hidden.contains($0.workspaceDir) }
        if !pinned.isEmpty {
            out.insert(ChatGroup(dir: "\u{0}pinned", name: "Pinned", items: pinned, isPinned: true), at: 0)
        }
        return out
    }

    /// Folders a new chat can go in, in sidebar order.
    var folders: [String] {
        groups.filter { !$0.isPinned }.map(\.dir)
    }

    func addFolder(_ dir: String) async throws {
        let j = try await request("workspaces.add", ["dir": .string(dir)])
        applySidebar(j)
    }

    func searchDirs(_ query: String) async throws -> [DirHit] {
        let j = try await request("fs.searchDirs", ["query": .string(query)])
        return (j.array ?? []).compactMap { h in
            h["path"].string.map { DirHit(path: $0, display: h["display"].string ?? $0) }
        }
    }

    func makeFolder(in parent: String, named name: String) async throws -> String {
        let j = try await request("fs.mkdir", ["parent": .string(parent), "name": .string(name)])
        guard let path = j["path"].string else { throw RemoteError.server("Couldn't create the folder.") }
        return path
    }

    private func refreshConversations() async {
        guard let rows = try? await request("conversations.list", ["archived": .bool(showArchived)]) else { return }
        var list = (rows.array ?? []).compactMap(Conversation.init)
        if showArchived { list = list.filter(\.archived) }
        conversations = list.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            return $0.updatedAt > $1.updatedAt
        }
        running = Set(list.filter { $0.runState == "running" }.map(\.id))
        // A run may have ended while the app was away from the events.
        for id in queued.keys where !running.contains(id) { drainQueue(id) }
    }

    // MARK: Follow-up queue

    func enqueue(_ text: String, images: [OutgoingImage], for id: String) {
        queued[id, default: []].append(QueuedMessage(text: text, images: images))
    }

    func removeQueued(_ itemId: UUID, from id: String) {
        queued[id]?.removeAll { $0.id == itemId }
        if queued[id]?.isEmpty == true { queued[id] = nil }
    }

    /// Deliver a queued message now: pi and Claude Code inject it into the
    /// current run, Codex interrupts and resumes.
    func steerQueued(_ itemId: UUID, in id: String) {
        guard let item = queued[id]?.first(where: { $0.id == itemId }) else { return }
        removeQueued(itemId, from: id)
        deliver(item, to: id)
    }

    private func drainQueue(_ id: String) {
        guard !running.contains(id), let next = queued[id]?.first else { return }
        removeQueued(next.id, from: id)
        running.insert(id)
        deliver(next, to: id)
    }

    private func deliver(_ item: QueuedMessage, to id: String) {
        if activeChat?.conversationId == id { activeChat?.echo(item) }
        Task {
            do {
                try await send(item.text, images: item.images, to: id)
            } catch {
                // Put it back at the front so nothing typed is lost.
                queued[id, default: []].insert(item, at: 0)
                if activeChat?.conversationId == id { activeChat?.error = error.localizedDescription }
            }
        }
    }

    func createConversation(runtime: Runtime, workspaceDir: String?) async throws -> Conversation {
        var params: [String: JSON] = ["backend": .string(runtime.rawValue)]
        if let workspaceDir { params["workspaceDir"] = .string(workspaceDir) }
        let r = try await request("conversations.create", .object(params))
        guard let c = Conversation(r) else { throw RemoteError.server("Couldn't create the chat.") }
        await refreshList()
        return c
    }

    func update(_ id: String, _ patch: [String: JSON]) async throws {
        var params = patch
        params["id"] = .string(id)
        _ = try await request("conversations.update", .object(params))
        await refreshList()
    }

    private func handle(_ envelope: JSON) {
        switch envelope["type"].string {
        case "conversation_updated", "conversation_created":
            if let c = Conversation(envelope["conversation"]) {
                if let i = conversations.firstIndex(where: { $0.id == c.id }) {
                    conversations[i] = c
                } else if c.archived == showArchived {
                    conversations.insert(c, at: 0)
                }
                activeChat?.conversationChanged(c)
            }
        case "conversation_deleted":
            conversations.removeAll { $0.id == envelope["id"].string }
        case "resync":
            Task {
                await refreshList()
                await activeChat?.load()
            }
        case "pi_event":
            guard let id = envelope["conversationId"].string else { return }
            let e = envelope["event"]
            switch e["type"].string {
            case "agent_start": running.insert(id)
            case "agent_end": running.remove(id)
            default: break
            }
            if activeChat?.conversationId == id { activeChat?.apply(e) }
            if e["type"].string == "agent_end" { drainQueue(id) }
        default:
            break
        }
    }
}
