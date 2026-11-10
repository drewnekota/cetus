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
    var error: String?
    var draft = ""
    var images: [OutgoingImage] = []
    private weak var store: RemoteStore?

    init(conversationId: String, store: RemoteStore) {
        self.conversationId = conversationId
        self.store = store
        conversation = store.conversations.first { $0.id == conversationId }
    }

    var running: Bool { timeline.running || (store?.running.contains(conversationId) ?? false) }

    func load() async {
        guard let store else { return }
        do {
            #if DEBUG
            // `-demoSnapshot <file>`: render a saved conversations.get reply.
            if let path = UserDefaults.standard.string(forKey: "demoSnapshot") {
                timeline = ChatTimeline(snapshot: try JSONDecoder().decode(JSON.self, from: Data(contentsOf: URL(fileURLWithPath: path))))
                loaded = true
                return
            }
            #endif
            let snapshot = try await store.request("conversations.get", ["id": .string(conversationId)])
            timeline = ChatTimeline(snapshot: snapshot)
            if let c = Conversation(snapshot["conversation"]) { conversation = c }
            loaded = true
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func apply(_ event: JSON) {
        if timeline.apply(event) == .refetch {
            Task { await load() }
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
