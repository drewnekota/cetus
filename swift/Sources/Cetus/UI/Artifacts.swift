import AppKit
import AVKit
import PDFKit
import QuickLookThumbnailing
import SwiftUI
import WebKit

// Artifacts the agent delivers (send_artifact tool results), after Cetus's
// lib/artifact.ts, components/chat/artifact-view.tsx (card + full preview),
// components/board/artifacts-dialog.tsx (the chat header's inbox panel) and
// components/artifact-save-toasts.tsx.

struct ArtifactDetails: Identifiable, Equatable, Hashable {
    var artifactKind: String
    var path: String
    var name: String
    var mimeType: String
    var caption: String?
    var sizeBytes: Int
    var id: String { path }

    /// artifactsFromDetails: one artifact, an artifact_collection, or a nested `artifacts`.
    static func from(_ d: JSON) -> [ArtifactDetails] {
        if d["kind"].string == "artifact" {
            return [ArtifactDetails(artifactKind: d["artifactKind"].string ?? "other", path: d["path"].stringValue, name: d["name"].stringValue,
                                    mimeType: d["mimeType"].stringValue, caption: d["caption"].string, sizeBytes: Int(d["sizeBytes"].double ?? 0))]
        }
        if case .array(let list) = d { return list.filter { $0["kind"].string == "artifact" }.flatMap(from) }
        guard case .object = d else { return [] }
        if d["kind"].string == "artifact_collection", case .array(let list) = d["artifacts"] { return list.filter { $0["kind"].string == "artifact" }.flatMap(from) }
        if d["artifacts"] != .null { return from(d["artifacts"]) }
        return []
    }

    /// Every artifact a conversation produced (in order; `dedupe` keeps the first per path).
    static func all(_ state: ChatState?, dedupe: Bool = false) -> [ArtifactDetails] {
        guard let state else { return [] }
        var seen = Set<String>()
        var out: [ArtifactDetails] = []
        for m in state.messages {
            for b in m.blocks where b.kind == .toolUse {
                guard let r = b.result else { continue }
                for a in from(r.details) where !dedupe || seen.insert(a.path).inserted { out.append(a) }
            }
        }
        return out
    }

    static let richKinds: Set<String> = ["image", "video", "html", "markdown", "text", "pdf"]
    static let copyableKinds: Set<String> = ["markdown", "text", "html"]

    var kindLabel: String {
        switch artifactKind {
        case "image": "Image"
        case "video": "Video"
        case "audio": "Audio"
        case "pdf": "PDF"
        case "markdown": "Markdown"
        case "html": "HTML"
        case "text": "Text"
        default: extLabel
        }
    }

    var extLabel: String {
        let ext = (name as NSString).pathExtension
        if !ext.isEmpty && ext.count <= 5 && name.contains(".") { return ext.uppercased() }
        let sub = mimeType.split(separator: "/").dropFirst().first
        return sub.map { $0.uppercased() } ?? "FILE"
    }

    /// `{caption ? name · : ""}{kind} · {size}`.
    var metaLine: String { (caption != nil ? "\(name) · " : "") + "\(kindLabel) · \(workspaceFormatBytes(Int64(sizeBytes)))" }
}

enum ArtifactActions {
    /// save_artifact_copy: native save panel, then a "Saved {name}" / "Couldn't save" toast.
    @MainActor static func saveCopy(_ a: ArtifactDetails, app: AppState) {
        guard FileManager.default.fileExists(atPath: a.path) else { app.toast("Couldn't save \(a.name): artifact is missing: \(a.path)", kind: .error); return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = (a.path as NSString).lastPathComponent
        let done: (NSApplication.ModalResponse) -> Void = { r in
            guard r == .OK, let url = panel.url else { return }
            do {
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                try FileManager.default.copyItem(atPath: a.path, toPath: url.path)
                app.toast("Saved \(panel.nameFieldStringValue.isEmpty ? a.name : (a.path as NSString).lastPathComponent)", url.path, kind: .success, action: ("Reveal", { NSWorkspace.shared.activateFileViewerSelecting([url]) }))
            } catch {
                app.toast("Couldn't save \((a.path as NSString).lastPathComponent): \(error.localizedDescription)", kind: .error)
            }
        }
        if let w = app.window { panel.beginSheetModal(for: w, completionHandler: done) } else { done(panel.runModal()) }
    }
}

// MARK: - Thumbnails

/// Quick Look thumbnail (get_artifact_thumbnail), cached per path.
@MainActor
final class ArtifactThumbs {
    static var cache: [String: NSImage] = [:]
    static var missing: Set<String> = []
    static func load(_ path: String, edge: CGFloat = 512, completion: @escaping (NSImage?) -> Void) {
        if let hit = cache[path] { completion(hit); return }
        if missing.contains(path) { completion(nil); return }
        let req = QLThumbnailGenerator.Request(fileAt: URL(fileURLWithPath: path), size: CGSize(width: edge, height: edge), scale: 2, representationTypes: .thumbnail)
        QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, _ in
            DispatchQueue.main.async {
                if let img = rep?.nsImage { cache[path] = img } else { missing.insert(path) }
                completion(rep?.nsImage)
            }
        }
    }
}

private struct IconThumb: View {
    let icon: String
    var label: String?
    var body: some View {
        VStack(spacing: 8) {
            Glyph(name: icon, size: 40, color: Theme.mutedForeground.opacity(0.4))
            if let label { Text(label).font(.system(size: 11, weight: .medium)).tracking(0.275).foregroundStyle(Theme.mutedForeground) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.muted.opacity(0.3))
    }
}

private struct NativeThumb<Fallback: View>: View {
    let path: String
    var cover = false
    @ViewBuilder var fallback: Fallback
    @State private var img: NSImage?
    var body: some View {
        Group {
            if let img {
                if cover { Image(nsImage: img).resizable().scaledToFill() }
                else { Image(nsImage: img).resizable().scaledToFit().shadow(color: .black.opacity(0.05), radius: 1, y: 1).padding(12).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.muted.opacity(0.2)) }
            } else { fallback }
        }
        .onAppear { ArtifactThumbs.load(path) { img = $0 } }
    }
}

/// The text of a small artifact file, read once.
private struct FileText<Content: View>: View {
    let path: String
    @ViewBuilder var content: (String?) -> Content
    @State private var text: String?
    @State private var failed = false
    var body: some View {
        content(failed ? nil : text)
            .task(id: path) {
                let p = path
                let t = await Task.detached { try? String(contentsOfFile: p, encoding: .utf8) }.value
                if let t { text = t } else { failed = true }
            }
    }
}

/// A non-interactive WKWebView of a local HTML file (thumbnail: 200% box at scale 0.5).
struct ArtifactWebView: NSViewRepresentable {
    let path: String
    var interactive = false
    func makeNSView(context: Context) -> WKWebView {
        let w = WKWebView(frame: .zero)
        w.setValue(false, forKey: "drawsBackground")
        let url = URL(fileURLWithPath: path)
        w.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return w
    }
    func updateNSView(_ w: WKWebView, context: Context) {}
}

private struct Thumbnail: View {
    let a: ArtifactDetails
    var body: some View {
        switch a.artifactKind {
        case "image":
            if let img = FileImageCache.image(a.path, maxPixel: 640) { Image(nsImage: img).resizable().scaledToFill() } else { IconThumb(icon: "image") }
        case "video":
            NativeThumb(path: a.path, cover: true) { Color.black }
                .overlay {
                    Glyph(name: "play", size: 20, color: Theme.foreground)
                        .padding(10).background(Circle().fill(Theme.background.opacity(0.8)))
                        .shadow(color: .black.opacity(0.1), radius: 3, y: 2)
                }
        case "audio": IconThumb(icon: "headphones")
        case "html":
            GeometryReader { g in
                ArtifactWebView(path: a.path)
                    .frame(width: g.size.width * 2, height: g.size.height * 2)
                    .scaleEffect(0.5, anchor: .topLeading)
                    .allowsHitTesting(false)
            }
            .background(Color.white)
            .clipped()
        case "markdown":
            FileText(path: a.path) { t in
                if let t {
                    MarkdownView(text: String(t.prefix(4000)), baseSize: 12)
                        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).clipped().background(Theme.card)
                } else { IconThumb(icon: "file-text") }
            }
        case "text":
            FileText(path: a.path) { t in
                if let t {
                    Text(String(t.prefix(4000))).font(.system(size: 11, design: .monospaced)).lineSpacing(11 * 0.6 - 2)
                        .foregroundStyle(Theme.foreground.opacity(0.8))
                        .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).clipped().background(Theme.card)
                } else { IconThumb(icon: "file-text") }
            }
        case "pdf": NativeThumb(path: a.path) { IconThumb(icon: "file-text", label: "PDF") }
        default: NativeThumb(path: a.path) { IconThumb(icon: "file", label: a.extLabel) }
        }
    }
}

private struct CompactThumb: View {
    let a: ArtifactDetails
    @State private var img: NSImage?
    var body: some View {
        Group {
            if let img { Image(nsImage: img).resizable().scaledToFit().padding(4) }
            else { Glyph(name: a.artifactKind == "audio" ? "headphones" : "file", size: 20, color: Theme.mutedForeground.opacity(0.6)) }
        }
        .frame(width: 40, height: 40)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.4)))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
        .onAppear { ArtifactThumbs.load(a.path) { img = $0 } }
    }
}

// MARK: - Card

/// ArtifactView: aspect-square preview + footer (rich kinds, w-80) or a compact row (w-72).
struct ArtifactCard: View {
    let artifact: ArtifactDetails
    /// Conversation whose artifacts the preview pages through.
    var convId: String?
    /// Fill the cell (grid) instead of the card's own width.
    var fill = false
    @Environment(AppState.self) private var app

    var body: some View {
        let a = artifact
        let compact = !ArtifactDetails.richKinds.contains(a.artifactKind)
        let shape = RoundedRectangle(cornerRadius: 14)
        Group {
            if compact {
                HStack(spacing: 12) {
                    CompactThumb(a: a)
                    meta.frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
            } else {
                VStack(spacing: 0) {
                    Color.clear.aspectRatio(1, contentMode: .fit)
                        .overlay { Thumbnail(a: a) }
                        .clipped()
                        .background(Theme.card)
                    meta.frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Theme.muted.opacity(0.4))
                        .overlay(alignment: .top) { Rectangle().fill(Theme.border.opacity(0.6)).frame(height: 1) }
                }
            }
        }
        .background(shape.fill(Theme.card))
        .clipShape(shape)
        .overlay(shape.strokeBorder(Theme.border.opacity(0.8), lineWidth: 1))
        .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
        .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
        .frame(maxWidth: fill ? .infinity : (compact ? 288 : 320))
        .contentShape(Rectangle())
        .onTapGesture { ArtifactPreview.present(a, convId: convId, app: app) }
        .help("Open \(a.name)")
        .testID("artifact-card")
    }

    private var meta: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(artifact.caption ?? artifact.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground)
                .lineLimit(1).truncationMode(.tail).lineBox(19.5)
            Text(artifact.metaLine).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).truncationMode(.tail).lineBox(16.2)
        }
    }
}

// MARK: - Full preview

enum ArtifactPreview {
    @MainActor static func present(_ a: ArtifactDetails, convId: String?, app: AppState) {
        let list = convId.map { ArtifactDetails.all(app.controller.chat($0).state, dedupe: true) } ?? []
        DialogHost.present("artifact-preview", app: app) { ArtifactPreviewView(initial: a, list: list) }
    }
}

/// h-[calc(100svh-4rem)] w-[calc(100svw-4rem)]: header (title, meta, Copy/Open/Download/Reveal/×) over the preview.
struct ArtifactPreviewView: View {
    let initial: ArtifactDetails
    let list: [ArtifactDetails]
    @State private var path: String?
    @State private var copied = false
    @Environment(AppState.self) private var app
    @Environment(\.windowWidth) private var vw
    @Environment(\.windowHeight) private var vh

    var body: some View {
        let index = list.firstIndex { $0.path == (path ?? initial.path) }
        let current = index.map { list[$0] } ?? initial
        let nav = list.count > 1 && index != nil
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(current.caption ?? current.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                    Text(current.metaLine + (nav ? " · \(index! + 1) / \(list.count)" : "")).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    if ArtifactDetails.copyableKinds.contains(current.artifactKind) {
                        action(copied ? "check" : "copy", copied ? "Copied" : "Copy") {
                            if let t = try? String(contentsOfFile: current.path, encoding: .utf8) {
                                System.copy(t)
                                copied = true
                                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                            }
                        }
                    }
                    action("external-link", "Open") { System.open(current.path) }
                    action("download", "Download") { ArtifactActions.saveCopy(current, app: app) }
                    action("folder-open", "Reveal", tip: "Reveal in Finder") { System.reveal(current.path) }
                    GhostIconButton(icon: "x", box: 32, glyph: 14, tip: "Close") { DialogHost.dismiss() }
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            ZStack {
                ArtifactFullPreview(a: current).id(current.path)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.muted.opacity(0.1))
                if nav {
                    HStack {
                        navButton("chevron-left", "Previous artifact") { step(-1, index!) }
                        Spacer()
                        navButton("chevron-right", "Next artifact") { step(1, index!) }
                    }
                    .padding(.horizontal, 12)
                }
            }
        }
        .frame(width: max(200, vw - 64), height: max(200, vh - 64))
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
        .background(ArtifactKeyCatcher { d in if nav { step(d, index!) } })
        .testID("artifact-preview")
    }

    private func step(_ d: Int, _ i: Int) { path = list[(i + d + list.count) % list.count].path }

    private func action(_ icon: String, _ label: String, tip: String? = nil, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: 6) {
                Glyph(name: icon, size: 14)
                Text(label)
            }
        }
        .buttonStyle(CetusButtonStyle(variant: .ghost))
        .help(tip ?? label)
    }

    private func navButton(_ icon: String, _ tip: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Glyph(name: icon, size: 20, color: Theme.foreground.opacity(0.8))
                .padding(8)
                .background(Circle().fill(Theme.background.opacity(0.85)))
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.1), radius: 3, y: 2)
        }
        .buttonStyle(.plain)
        .help(tip)
    }
}

/// ← / → page between a conversation's artifacts while the preview is open.
private struct ArtifactKeyCatcher: NSViewRepresentable {
    let onStep: (Int) -> Void
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        context.coordinator.monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            guard v.window != nil, e.modifierFlags.intersection([.command, .control, .option]).isEmpty else { return e }
            if let r = v.window?.firstResponder, r is NSTextView { return e }
            if e.keyCode == 123 { context.coordinator.step(-1); return nil }
            if e.keyCode == 124 { context.coordinator.step(1); return nil }
            return e
        }
        return v
    }
    func updateNSView(_ v: NSView, context: Context) { context.coordinator.step = onStep }
    static func dismantleNSView(_ v: NSView, coordinator: Coordinator) { if let m = coordinator.monitor { NSEvent.removeMonitor(m) } }
    func makeCoordinator() -> Coordinator { Coordinator(onStep) }
    final class Coordinator {
        var step: (Int) -> Void
        var monitor: Any?
        init(_ s: @escaping (Int) -> Void) { step = s }
    }
}

private struct PDFPreview: NSViewRepresentable {
    let path: String
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(url: URL(fileURLWithPath: path))
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) {}
}

private struct ArtifactFullPreview: View {
    let a: ArtifactDetails
    var body: some View {
        switch a.artifactKind {
        case "image":
            if let img = FileImageCache.image(a.path) { Image(nsImage: img).resizable().scaledToFit().padding(16) } else { noPreview }
        case "video": VideoPlayer(player: AVPlayer(url: URL(fileURLWithPath: a.path))).background(Color.black)
        case "audio": VideoPlayer(player: AVPlayer(url: URL(fileURLWithPath: a.path))).frame(maxWidth: 576, maxHeight: 60).padding(24)
        case "pdf": PDFPreview(path: a.path).background(Color.white)
        case "html": ArtifactWebView(path: a.path, interactive: true).background(Color.white)
        case "markdown":
            FileText(path: a.path) { t in
                if let t { ScrollView { MarkdownView(text: t, baseSize: 14).frame(maxWidth: 768).padding(24).frame(maxWidth: .infinity) } }
                else { loading }
            }
        case "text":
            FileText(path: a.path) { t in
                if let t {
                    ScrollView {
                        Text(t).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.foreground.opacity(0.9)).textSelection(.enabled)
                            .frame(maxWidth: 1024, alignment: .leading).padding(24).frame(maxWidth: .infinity)
                    }
                } else { loading }
            }
        default: noPreview
        }
    }
    private var loading: some View { Text("Loading…").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading) }
    private var noPreview: some View {
        VStack(spacing: 12) {
            Glyph(name: "code", size: 48, color: Theme.mutedForeground.opacity(0.4))
            Text("No inline preview for this file type").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Header inbox button + panel

/// The chat header's Inbox button (icon-xs ghost), shown when the active chat has artifacts.
struct ArtifactsInboxButton: View {
    @Environment(AppState.self) private var app
    var body: some View {
        if let id = app.active, app.page == .chats, app.controller.chat(id).hasArtifacts {
            GhostIconButton(icon: "inbox", box: 24, glyph: 14) {
                if DialogHost.openId == "artifacts" { DialogHost.dismiss(); return }
                DialogHost.present("artifacts", app: app) { ArtifactsPanel(convId: id) }
            }
            .help("Toggle artifacts")
            .testID("artifacts-toggle")
        }
    }
}

/// ArtifactsDialog: max-w-5xl, header (Inbox + "Artifacts · title", count), 4-col grid of cards.
struct ArtifactsPanel: View {
    let convId: String
    @Environment(AppState.self) private var app
    @Environment(\.windowWidth) private var vw
    @Environment(\.windowHeight) private var vh

    var body: some View {
        let artifacts = ArtifactDetails.all(app.controller.chat(convId).state)
        let title = app.controller.conversation(convId)?.title
        let width = min(1024, vw - 96)
        let cols = vw >= 1024 ? 4 : vw >= 640 ? 3 : 2
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Glyph(name: "inbox", size: 16, color: Theme.mutedForeground)
                    (Text("Artifacts").fontWeight(.semibold) + Text(title.map { " · \($0)" } ?? "").foregroundColor(Theme.mutedForeground))
                        .font(.system(size: 15)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(22.5)
                }
                Text("\(artifacts.count) item\(artifacts.count == 1 ? "" : "s") in this task").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 24).padding(.trailing, 48).padding(.vertical, 16)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            .overlay(alignment: .topTrailing) {
                GhostIconButton(icon: "x", box: 24, glyph: 16) { DialogHost.dismiss() }.opacity(0.7).padding(.top, 12).padding(.trailing, 12)
            }
            ScrollView {
                if artifacts.isEmpty {
                    Text("No artifacts in this task yet.").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).padding(.vertical, 48).frame(maxWidth: .infinity)
                } else {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16, alignment: .top), count: cols), alignment: .leading, spacing: 16) {
                        ForEach(Array(artifacts.enumerated()), id: \.offset) { _, a in ArtifactCard(artifact: a, convId: convId, fill: true) }
                    }
                    .padding(24)
                }
            }
        }
        .frame(width: width, height: max(200, vh - 96))
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
        .testID("artifacts-panel")
    }
}

/// The composer's / bubble's image lightbox: the image alone, max 90vw × 90vh, rounded-lg shadow-xl.
enum ChatImagePreview {
    @MainActor static func present(path: String, app: AppState) {
        guard let img = NSImage(contentsOfFile: path) else { return }
        DialogHost.present("image-preview", app: app) { ChatImagePreviewView(image: img) }
    }
}

private struct ChatImagePreviewView: View {
    let image: NSImage
    @Environment(\.windowWidth) private var vw
    @Environment(\.windowHeight) private var vh
    var body: some View {
        Image(nsImage: image).resizable().scaledToFit()
            .frame(maxWidth: min(image.size.width, vw * 0.9), maxHeight: min(image.size.height, vh * 0.9))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .shadow(color: .black.opacity(0.1), radius: 12.5, y: 20)
            .shadow(color: .black.opacity(0.1), radius: 4, y: 8)
            .onTapGesture { DialogHost.dismiss() }
    }
}

/// A tool_use block that delivered artifacts renders as answer content: a
/// column of cards (message-blocks.tsx AnswerBlock, `flex w-full flex-col gap-3`).
struct ArtifactInlineList: View {
    let artifacts: [ArtifactDetails]
    @Environment(AppState.self) private var app
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(artifacts, id: \.path) { a in ArtifactCard(artifact: a, convId: app.active) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// assistant-segments.ts isProcess: a tool call with artifacts is part of the answer.
    static func has(_ b: Block) -> Bool {
        b.kind == .toolUse && !(b.result.map { ArtifactDetails.from($0.details) } ?? []).isEmpty
    }
}
