import CetusRemoteKit
import Observation
import UIKit

struct OutgoingImage: Identifiable {
    let id = UUID()
    let preview: UIImage
    let jpeg: Data
    var base64: String { jpeg.base64EncodedString() }

    /// Downscaled JPEG, small enough for the Mac's relay uplink.
    init?(_ image: UIImage) {
        let scaled = image.downscaled(maxSide: 1600)
        guard let data = scaled.jpegData(compressionQuality: 0.8) else { return nil }
        preview = scaled
        jpeg = data
    }
}

extension RemoteStore {
    /// `conversations.send` for text plus optional photos.
    func send(_ text: String, images: [OutgoingImage], to id: String) async throws {
        var params: [String: JSON] = [
            "id": .string(id),
            "message": .string(text.isEmpty ? "Please look at these images." : text),
        ]
        if !images.isEmpty {
            params["images"] = .array(images.map {
                ["type": "image", "data": .string($0.base64), "mimeType": "image/jpeg"]
            })
        }
        _ = try await request("conversations.send", .object(params))
    }
}

/// A follow-up waiting for the current run to end.
struct QueuedMessage: Identifiable {
    let id = UUID()
    var text: String
    var images: [OutgoingImage]
}

/// One open conversation: its timeline plus the actions the chat screen takes.
@MainActor
@Observable
final class ChatModel {
    let conversationId: String
    private(set) var conversation: Conversation?
    private(set) var timeline = ChatTimeline()
    private(set) var loaded = false
    /// A failed request or run, shown where the reply would be.
    var error: String?
    private(set) var retrying = false
    /// The error on screen is a failed history load; the next good one clears it.
    private var loadFailed = false
    var draft = ""
    var images: [OutgoingImage] = []
    private weak var store: RemoteStore?
    /// Snapshot requests in flight, and the stream events that arrived
    /// meanwhile: the reply decides which of them it already holds.
    private var loads = 0
    private var arrived: [(event: JSON, seq: Int?)] = []

    init(conversationId: String, store: RemoteStore) {
        self.conversationId = conversationId
        self.store = store
        conversation = store.conversations.first { $0.id == conversationId }
    }

    var running: Bool { timeline.running || (store?.running.contains(conversationId) ?? false) }

    /// When the open turn began. A run this screen first saw mid-way counts
    /// from then.
    var turnStartedAt: Date { timeline.turnStartedAt ?? seenRunningAt }
    private let seenRunningAt = Date()

    func load() async {
        guard let store else { return }
        do {
            #if DEBUG
            // `-demoSnapshot <file>`: render a saved conversations.get reply.
            if let path = UserDefaults.standard.string(forKey: "demoSnapshot") {
                let snapshot = try JSONDecoder().decode(JSON.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
                timeline = ChatTimeline(snapshot: snapshot)
                error = timeline.takeError()
                if let c = Conversation(snapshot["conversation"]) { conversation = c }
                loaded = true
                return
            }
            #endif
            loads += 1
            defer {
                loads -= 1
                if loads == 0 { arrived = [] }
            }
            let snapshot = try await store.request("conversations.get", ["id": .string(conversationId)])
            var fresh = ChatTimeline(snapshot: snapshot)
            // Events newer than the snapshot go on top of it. A Mac that
            // doesn't number its events can't say which ones those are.
            var refetch = false
            for (event, seq) in arrived where seq.map({ $0 > fresh.liveSeq }) ?? false {
                if fresh.apply(event) == .refetch { refetch = true }
            }
            let failure = fresh.takeError()
            timeline = fresh
            if let c = Conversation(snapshot["conversation"]) { conversation = c }
            loaded = true
            // A run's error outlives the reload that follows its end.
            if loadFailed { error = nil }
            loadFailed = false
            if let failure { error = failure }
            if refetch { Task { await load() } }
        } catch {
            self.error = error.localizedDescription
            loadFailed = true
        }
    }

    func apply(_ event: JSON, seq: Int? = nil) {
        if loads > 0 { arrived.append((event, seq)) }
        // Already part of the snapshot on screen.
        if let seq, seq <= timeline.liveSeq { return }
        if event["type"].string == "agent_start" { error = nil }
        let effect = timeline.apply(event)
        if let failure = timeline.takeError() { error = failure }
        if effect == .refetch {
            Task { await load() }
        }
    }

    /// Roll the last turn out of the history and run it again, so a failed
    /// or empty turn doesn't stay in the context.
    func retry() async {
        guard !retrying, let store else { return }
        retrying = true
        defer { retrying = false }
        let onScreen = timeline.messages.last { $0.role == .user }?.blocks.compactMap { b -> String? in
            if case .text(_, let t, _) = b { return t }
            return nil
        }.joined(separator: "\n\n")
        do {
            var text: String
            do {
                text = try await store.request("conversations.retry", ["id": .string(conversationId)])["text"].string ?? ""
                await load()
            } catch {
                // The send never reached the session: resend what's on screen.
                guard error.localizedDescription.contains("nothing to retry"), let onScreen, !onScreen.isEmpty else { throw error }
                text = onScreen
            }
            error = nil
            loadFailed = false
            if timeline.messages.last?.role != .user { timeline.appendUser(text, images: []) }
            try await store.send(text, images: [], to: conversationId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    func conversationChanged(_ c: Conversation) {
        if c.id == conversationId { conversation = c }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let pending = images
        guard !text.isEmpty || !pending.isEmpty, let store else { return }
        draft = ""
        images = []
        // Mid-run, follow-ups queue (as on the desktop); Steer sends one now.
        if running {
            store.enqueue(text, images: pending, for: conversationId)
            return
        }
        timeline.appendUser(text, images: pending.map(\.jpeg))
        do {
            try await store.send(text, images: pending, to: conversationId)
        } catch {
            self.error = error.localizedDescription
            draft = text
            images = pending
            await load()
        }
    }

    var queued: [QueuedMessage] { store?.queued[conversationId] ?? [] }

    /// Optimistic echo of a queued message the store just delivered.
    func echo(_ item: QueuedMessage) {
        timeline.appendUser(item.text, images: item.images.map(\.jpeg))
    }

    func steer(_ item: QueuedMessage) {
        store?.steerQueued(item.id, in: conversationId)
    }

    func removeQueued(_ item: QueuedMessage) {
        store?.removeQueued(item.id, from: conversationId)
    }

    /// Pull a queued message back into the composer.
    func editQueued(_ item: QueuedMessage) {
        removeQueued(item)
        draft = draft.isEmpty ? item.text : draft + "\n" + item.text
        images += item.images
    }

    func abort() async {
        _ = try? await store?.request("conversations.abort", ["id": .string(conversationId)])
    }

    func respond(_ control: ControlRequest, allow: Bool, answers: [String: String] = [:]) async {
        guard let store else { return }
        var params: [String: JSON] = [
            "id": .string(conversationId),
            "requestId": control.raw["requestId"],
            "response": control.response(allow: allow, answers: answers),
        ]
        if let source = control.source { params["source"] = .string(source) }
        do {
            _ = try await store.request("conversations.control", .object(params))
            timeline.removeControl(control.requestKey)
        } catch {
            self.error = error.localizedDescription
        }
    }

}

extension UIImage {
    func downscaled(maxSide: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxSide else { return self }
        let scale = maxSide / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
