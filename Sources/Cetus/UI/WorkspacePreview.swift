import AppKit
import AVKit
import PDFKit
import SwiftUI
import WebKit

/// file-preview.tsx: header (kind icon, name, relative path, Preview/Source,
/// Open) and a body chosen by file kind. Text files open straight into the
/// editor (text-file-editor.tsx).
struct WorkspacePreview: View {
    let entry: WorkspaceEntry?
    let root: String
    let testPrefix: String
    @State private var text: String?
    @State private var loadedPath: String?
    @State private var error: String?
    @State private var truncatedTotal: Int64?
    @State private var modeByPath: [String: Bool] = [:] // true = source

    enum Kind { case image, video, audio, html, pdf, markdown, csv, text, office }

    static func kind(_ name: String) -> Kind {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"].contains(ext) { return .image }
        if ["mp4", "webm", "mov", "m4v", "ogv"].contains(ext) { return .video }
        if ["mp3", "wav", "ogg", "m4a", "flac"].contains(ext) { return .audio }
        if ["html", "htm"].contains(ext) { return .html }
        if ext == "pdf" { return .pdf }
        if ["md", "markdown", "mdx"].contains(ext) { return .markdown }
        if ["csv", "tsv"].contains(ext) { return .csv }
        if ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "numbers", "pages", "key"].contains(ext) { return .office }
        return .text
    }

    private static func canToggleSource(_ k: Kind, _ ext: String) -> Bool { k == .markdown || k == .html || k == .csv || ext == "svg" }
    private static func needsText(_ k: Kind, _ source: Bool, _ ext: String) -> Bool {
        k == .markdown || k == .text || k == .csv || (source && canToggleSource(k, ext))
    }

    var body: some View {
        if let entry {
            let ext = (entry.name as NSString).pathExtension.lowercased()
            let kind = Self.kind(entry.name)
            let toggles = Self.canToggleSource(kind, ext)
            let source = toggles && (modeByPath[entry.path] ?? false)
            let key = "\(entry.path)|\(source)"
            VStack(spacing: 0) {
                header(entry, kind: kind, toggles: toggles, source: source)
                content(entry, kind: kind, ext: ext, source: source)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .clipped()
            }
            .background(Theme.background)
            .onChange(of: key, initial: true) { _, _ in load(entry, kind: kind, source: source, ext: ext) }
        } else {
            Text("Select a file to preview").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                .lineBox(16.2)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: Header — `flex h-11 items-center gap-2 border-b px-3`

    private func header(_ e: WorkspaceEntry, kind: Kind, toggles: Bool, source: Bool) -> some View {
        HStack(spacing: 8) {
            WorkspacePreviewIcon(kind: kind)
            VStack(alignment: .leading, spacing: 0) {
                Text(e.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                    .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                Text(e.relativePath).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).truncationMode(.tail).lineBox(15.4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .help(e.path)
            if toggles {
                HStack(spacing: 0) {
                    seg("Preview", !source) { modeByPath[e.path] = false }
                    seg("Source", source) { modeByPath[e.path] = true }
                }
                .padding(2)
                .padding(1)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            }
            if let total = truncatedTotal {
                Text("First 1 MB of \(workspaceFormatBytes(total))").font(.system(size: 11))
                    .foregroundStyle(Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0xFFD230) : NSColor(hex: 0xBB4D00) }))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Theme.amber.opacity(0.1)))
            }
            GhostIconButton(icon: "external-link", color: Theme.foreground, testID: "\(testPrefix)-open") { System.open(e.path) }
                .help("Open")
        }
        .padding(.horizontal, 12)
        .frame(height: 43)
        .padding(.bottom, 1)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    /// `h-5 rounded-sm px-1.5 text-2xs`, active: bg-muted text-foreground.
    private func seg(_ label: String, _ on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 11)).foregroundStyle(on ? Theme.foreground : Theme.mutedForeground)
                .lineBox(15.4)
                .padding(.horizontal, 6).frame(height: 20)
                .background(RoundedRectangle(cornerRadius: 6).fill(on ? Theme.muted : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .testID("\(testPrefix)-mode-\(label)")
    }

    // MARK: Body

    @ViewBuilder
    private func content(_ e: WorkspaceEntry, kind: Kind, ext: String, source: Bool) -> some View {
        let ready = loadedPath == e.path ? text : nil
        if source || kind == .text {
            textState(ready) { value in
                if truncatedTotal != nil {
                    WorkspaceSourceView(text: value, path: e.path)
                } else {
                    WorkspaceTextEditor(path: e.path, root: root, text: value, testPrefix: testPrefix).id(e.path)
                }
            }
        } else {
            switch kind {
            case .image:
                ScrollView {
                    Group {
                        if let img = FileImageCache.image(e.path) {
                            Image(nsImage: img).resizable().scaledToFit()
                                .frame(maxWidth: img.size.width, maxHeight: img.size.height)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity)
                }
                .background(Theme.muted.opacity(0.2))
            case .video, .audio:
                PlayerView(url: URL(fileURLWithPath: e.path))
                    .padding(kind == .video ? 16 : 24)
                    .background(kind == .video ? Color.black : .clear)
            case .html:
                WorkspaceWebView(url: URL(fileURLWithPath: e.path))
            case .pdf:
                WorkspacePDFView(url: URL(fileURLWithPath: e.path))
            case .markdown:
                textState(ready) { value in
                    ScrollView {
                        WorkspaceProse(text: value)
                            .padding(.horizontal, 20).padding(.vertical, 16)
                    }
                }
            case .csv:
                textState(ready) { value in ScrollView { WorkspaceTable(rows: Self.parseCsv(value), clamp: 3).padding(16) } }
            case .office, .text:
                ScrollView { WorkspaceFileDetails(entry: e, kind: kind).padding(20) }
            }
        }
    }

    @ViewBuilder
    private func textState<C: View>(_ value: String?, @ViewBuilder _ body: (String) -> C) -> some View {
        if let error {
            Text("Failed to read: \(error)").font(.system(size: 12)).foregroundStyle(Theme.destructive)
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let value {
            body(value)
        } else {
            HStack(spacing: 8) { Spinner(size: 14); Text("Loading…").lineBox(16.2) }
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    static func parseCsv(_ text: String) -> [[String]] {
        let delim: Character = text.contains("\t") ? "\t" : ","
        return text.split(whereSeparator: \.isNewline).filter { !$0.isEmpty }.prefix(80)
            .map { $0.split(separator: delim, omittingEmptySubsequences: false).prefix(24).map(String.init) }
    }

    private func load(_ e: WorkspaceEntry, kind: Kind, source: Bool, ext: String) {
        text = nil
        loadedPath = nil
        error = nil
        truncatedTotal = nil
        guard Self.needsText(kind, source, ext) else { return }
        let path = e.path
        DispatchQueue.global(qos: .userInitiated).async {
            let result = WorkspaceTextFile.read(path)
            DispatchQueue.main.async {
                guard e.path == entry?.path else { return }
                switch result {
                case .success(let v):
                    loadedPath = path
                    text = v.text
                    truncatedTotal = v.truncated ? v.total : nil
                case .failure(let err):
                    error = err.message
                }
            }
        }
    }
}

/// `read_workspace_text_file`: first 1 MB, rejecting binary / non-UTF-8 data.
enum WorkspaceTextFile {
    struct Failure: Error { let message: String }
    static let maxBytes = 1024 * 1024

    /// `decode_workspace_text` for a complete buffer.
    static func decode(_ data: Data) -> Result<String, Failure> {
        if data.contains(where: { $0 < 32 && ![9, 10, 12, 13].contains($0) }) {
            return .failure(Failure(message: "This file contains binary data and cannot be edited as text."))
        }
        guard let s = String(data: data, encoding: .utf8) else {
            return .failure(Failure(message: "This file is not UTF-8 text and cannot be edited as text."))
        }
        return .success(s)
    }

    /// `write_workspace_text_file`: refuses oversize/binary text, files outside the
    /// workspace, and any file whose current content is not what the editor loaded.
    static func write(_ path: String, root: String, text: String, expected: String) -> Result<Void, Failure> {
        let bytes = Data(text.utf8)
        if bytes.count > maxBytes { return .failure(Failure(message: "File exceeds the 1 MB editing limit.")) }
        if case .failure(let f) = decode(bytes) { return .failure(f) }
        let realRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
        let target = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        guard target == realRoot || target.hasPrefix(realRoot.hasSuffix("/") ? realRoot : realRoot + "/") else {
            return .failure(Failure(message: "file symlink points outside the workspace"))
        }
        guard let h = FileHandle(forUpdatingAtPath: target) else {
            return .failure(Failure(message: "No such file or directory (os error 2)"))
        }
        defer { try? h.close() }
        var isDir: ObjCBool = false
        let size = ((try? FileManager.default.attributesOfItem(atPath: target))?[.size] as? NSNumber)?.intValue ?? 0
        guard FileManager.default.fileExists(atPath: target, isDirectory: &isDir), !isDir.boolValue, size <= maxBytes else {
            return .failure(Failure(message: "File is not a complete editable text file."))
        }
        let current = (try? h.read(upToCount: maxBytes + 1)) ?? Data()
        switch decode(current) {
        case .failure(let f): return .failure(f)
        case .success(let s) where s != expected:
            return .failure(Failure(message: "File changed on disk. Reopen it and reconcile your edits before saving."))
        default: break
        }
        do {
            try h.seek(toOffset: 0)
            try h.write(contentsOf: bytes)
            try h.truncate(atOffset: UInt64(bytes.count))
            try h.synchronize()
            return .success(())
        } catch {
            return .failure(Failure(message: error.localizedDescription))
        }
    }

    static func read(_ path: String) -> Result<(text: String, truncated: Bool, total: Int64), Failure> {
        guard let h = FileHandle(forReadingAtPath: path) else { return .failure(Failure(message: "No such file or directory (os error 2)")) }
        defer { try? h.close() }
        let total = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)??.int64Value ?? 0
        let data = (try? h.read(upToCount: maxBytes)) ?? Data()
        let truncated = total > Int64(maxBytes)
        if data.contains(where: { $0 < 32 && ![9, 10, 12, 13].contains($0) }) {
            return .failure(Failure(message: "This file contains binary data and cannot be edited as text."))
        }
        if let s = String(data: data, encoding: .utf8) { return .success((s, truncated, total)) }
        if truncated {
            for cut in 1 ... 3 where data.count > cut {
                if let s = String(data: data.dropLast(cut), encoding: .utf8) { return .success((s, truncated, total)) }
            }
        }
        return .failure(Failure(message: "This file is not UTF-8 text and cannot be edited as text."))
    }
}

struct WorkspacePreviewIcon: View {
    let kind: WorkspacePreview.Kind
    var body: some View {
        let name: String = switch kind {
        case .image: "image"
        case .video, .audio: "video"
        case .csv, .office: "table"
        case .html, .text: "code"
        default: "file-text"
        }
        Glyph(name: name, size: 16, color: Theme.mutedForeground)
    }
}

/// `FileDetails`: bordered card with the name, extension and a key/value list.
private struct WorkspaceFileDetails: View {
    let entry: WorkspaceEntry
    let kind: WorkspacePreview.Kind
    var body: some View {
        let ext = (entry.name as NSString).pathExtension
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                WorkspacePreviewIcon(kind: kind)
                VStack(alignment: .leading, spacing: 0) {
                    Text(entry.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                    Text(ext.isEmpty ? "File" : ext.uppercased()).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                }
            }
            Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 8) {
                row("Path", entry.path, mono: true)
                row("Size", workspaceFormatBytes(entry.sizeBytes ?? 0))
                row("Modified", entry.modified.map { DateFormatter.localizedString(from: $0, dateStyle: .short, timeStyle: .medium) } ?? "-")
                if let t = entry.symlinkTarget { row("Link target", t, mono: true) }
                if let g = entry.gitStatus { row("Git status", g.capitalized) }
            }
            .font(.system(size: 12))
        }
        .padding(16)
        .frame(maxWidth: 576, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func row(_ k: String, _ v: String, mono: Bool = false) -> some View {
        GridRow {
            Text(k).foregroundStyle(Theme.mutedForeground).frame(width: 84, alignment: .leading)
            Text(v).font(mono ? .system(size: 12, design: .monospaced) : .system(size: 12)).foregroundStyle(Theme.foreground)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// CSV / sheet table: `rounded-md border`, header row bg-muted/70 font-medium, cells px-2 py-1.
private struct WorkspaceTable: View {
    let rows: [[String]]
    let clamp: Int
    var body: some View {
        let cols = rows.map(\.count).max() ?? 0
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                    GridRow {
                        ForEach(0 ..< cols, id: \.self) { c in
                            Text(c < row.count ? row[c] : "").font(.system(size: 12, weight: i == 0 ? .medium : .regular))
                                .foregroundStyle(Theme.foreground).lineLimit(clamp)
                                .frame(maxWidth: 256, alignment: .leading)
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                                .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 1) }
                                .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                                .background(i == 0 ? Theme.muted.opacity(0.7) : .clear)
                        }
                    }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
    }
}

/// `SourcePreview`: GitHub-themed highlighted source, px-4 py-3, mono 12 / leading-relaxed.
private struct WorkspaceSourceView: View {
    let text: String
    let path: String
    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            Text(Highlighter.highlight(text, language: Highlighter.language(forPath: path)))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(WorkspaceGitHub.text)
                .lineSpacing(19.5 - 14.3)
                .textSelection(.enabled)
                .fixedSize()
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(WorkspaceGitHub.background)
    }
}

enum WorkspaceGitHub {
    static let background = Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0x0D1117) : .white })
    static let text = Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: 0xC9D1D9) : NSColor(hex: 0x24292F) })
}

private struct WorkspaceWebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = false // `sandbox=""`
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {
        if v.url != url { v.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
    }
}

private struct WorkspacePDFView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(url: url)
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) {
        if v.document?.documentURL != url { v.document = PDFDocument(url: url) }
    }
}

// MARK: - Editor

/// Unsaved buffers survive file switches and panel remounts (memory only).
@MainActor
enum WorkspaceDrafts {
    static var buffers: [String: (text: String, original: String)] = [:]
}

/// text-file-editor.tsx: status strip (Saved / Unsaved changes, Reload, Save) over a plain textarea.
struct WorkspaceTextEditor: View {
    let path: String
    var root: String = "/"
    let text: String
    let testPrefix: String
    @State private var buffer = ""
    @State private var original = ""
    @State private var error: String?
    @State private var saving = false
    @State private var ready = false

    private var dirty: Bool { buffer != original }

    var body: some View {
        VStack(spacing: 0) {
            // `flex items-center gap-2 border-b px-3 py-1`
            HStack(spacing: 8) {
                Text(dirty ? "Unsaved changes" : "Saved").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground)
                    .lineBox(15.4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Reload") { reload() }
                    .buttonStyle(WorkspaceXSButtonStyle()).disabled(saving)
                    .testID("\(testPrefix)-reload")
                Button(saving ? "Saving…" : "Save") { save() }
                    .buttonStyle(WorkspaceXSButtonStyle()).disabled(!dirty || saving)
                    .keyboardShortcut("s", modifiers: .command)
                    .testID("\(testPrefix)-save")
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
            .padding(.bottom, 1)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            if let error {
                Text(error).font(.system(size: 12)).foregroundStyle(Theme.destructive)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if ready {
                WorkspaceTextArea(text: Binding(get: { buffer }, set: { update($0) }))
                    .testID("workspace-text-editor")
            } else {
                Spacer()
            }
        }
        .onAppear {
            if let b = WorkspaceDrafts.buffers[path] { buffer = b.text; original = b.original } else { buffer = text; original = text }
            ready = true
        }
    }

    private func update(_ s: String) {
        var next = s
        if original.contains("\r\n") { next = next.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\n", with: "\r\n") }
        buffer = next
        if buffer == original { WorkspaceDrafts.buffers.removeValue(forKey: path) } else { WorkspaceDrafts.buffers[path] = (buffer, original) }
    }

    private func reload() {
        // Tauri's async `window.confirm` never blocks: Reload discards unsaved edits immediately.
        error = nil
        switch WorkspaceTextFile.read(path) {
        case .success(let v):
            if v.truncated { error = "This file exceeds the 1 MB editing limit."; return }
            buffer = v.text; original = v.text
            WorkspaceDrafts.buffers.removeValue(forKey: path)
        case .failure(let f): error = f.message
        }
    }

    private func save() {
        guard dirty, !saving else { return }
        saving = true
        error = nil
        let submitted = buffer
        let expected = original
        defer { saving = false }
        switch WorkspaceTextFile.write(path, root: root, text: submitted, expected: expected) {
        case .success:
            // Typing stays possible during the write: keep the live buffer, move the baseline.
            original = submitted
            if buffer == original { WorkspaceDrafts.buffers.removeValue(forKey: path) } else { WorkspaceDrafts.buffers[path] = (buffer, original) }
        case .failure(let f):
            error = f.message
        }
    }
}

/// shadcn `Button size="xs" variant="ghost"`: h-6 px-2 text-xs medium, radius 8.
struct WorkspaceXSButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { StyledBody(configuration: configuration) }
    private struct StyledBody: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.foreground)
                .lineBox(16.2)
                .padding(.horizontal, 9)
                .frame(height: 24)
                .background(RoundedRectangle(cornerRadius: 7).fill(hover && enabled ? Theme.ghostHover : .clear).padding(1))
                .compositingGroup()
                .opacity(enabled ? 1 : 0.5)
                .offset(y: configuration.isPressed ? 1 : 0)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

/// `textarea` with `bg-background px-4 py-3 font-mono text-xs leading-relaxed`, wrap="off".
struct WorkspaceTextArea: NSViewRepresentable {
    @Binding var text: String

    static let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    static var attributes: [NSAttributedString.Key: Any] {
        let lh: CGFloat = 19.5
        let natural = font.ascender - font.descender + font.leading
        let p = NSMutableParagraphStyle()
        p.minimumLineHeight = lh
        p.maximumLineHeight = lh
        return [.font: font, .foregroundColor: NSColor(Theme.foreground), .paragraphStyle: p, .baselineOffset: (lh - natural) / 2 - 0.5]
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        // TextKit 1: exact paragraph line heights (the 19.5px `leading-relaxed` box).
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        let tv = NSTextView(usingTextLayoutManager: false)
        tv.minSize = .zero
        tv.isVerticallyResizable = true
        tv.autoresizingMask = [.width]
        scroll.documentView = tv
        tv.isRichText = false
        tv.allowsUndo = true
        tv.drawsBackground = false
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.isGrammarCheckingEnabled = false
        tv.textContainer?.lineFragmentPadding = 0
        tv.textContainerInset = NSSize(width: 16, height: 12)
        tv.isHorizontallyResizable = true
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.textContainer?.widthTracksTextView = false
        tv.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.font = Self.font
        tv.defaultParagraphStyle = Self.attributes[.paragraphStyle] as? NSParagraphStyle
        tv.typingAttributes = Self.attributes
        tv.insertionPointColor = NSColor(Theme.foreground)
        tv.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))
        tv.delegate = context.coordinator
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? NSTextView, tv.string != text else { return }
        let sel = tv.selectedRanges
        tv.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))
        tv.selectedRanges = sel.filter { $0.rangeValue.upperBound <= (text as NSString).length }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: WorkspaceTextArea
        init(_ p: WorkspaceTextArea) { parent = p }
        func textDidChange(_ n: Notification) {
            guard let tv = n.object as? NSTextView else { return }
            parent.text = tv.string
        }
    }
}
