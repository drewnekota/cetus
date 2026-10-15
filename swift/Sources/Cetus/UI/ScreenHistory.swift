import AppKit
import SwiftUI

// Full-window viewer for the screen-context collection (screen-history-page.tsx):
// a searchable, day-grouped grid mixing captured frames with AX text
// observations; clicking one opens a lightbox. Opened from the command palette
// or Settings → Screen context; closed with Back or Esc.

@Observable
final class ScreenHistoryModel {
    static let shared = ScreenHistoryModel()
    var open = false
    var initialQuery = ""
    var initialFrame: ScreenFrame?
    /// Bumped whenever the store changes (live refresh of counts / pages).
    var revision = 0

    init() {
        ScreenStore.onChange = { [weak self] in self?.revision += 1 }
    }

    /// home-view's onOpenScreenHistory / openHistoryFromSettings.
    @MainActor func show(_ app: AppState, query: String = "", frame: ScreenFrame? = nil) {
        app.palette = false
        app.settings = false
        initialQuery = query
        initialFrame = frame
        open = true
    }
}

/// One row of the merged history.
enum ScreenHistoryItem: Identifiable, Hashable {
    case frame(ScreenFrame)
    case ax(AmbientEntry)
    var id: String { switch self { case .frame(let f): "f-\(f.id)"; case .ax(let e): "a-\(e.id)" } }
    var ts: Double { switch self { case .frame(let f): f.ts; case .ax(let e): e.ts } }
}

enum ScreenFmt {
    private static func formatter(_ f: String) -> DateFormatter {
        let d = DateFormatter()
        d.locale = Locale(identifier: "en_US")
        d.dateFormat = f
        return d
    }
    private static let time = formatter("hh:mm:ss a")
    private static let full = formatter("M/d/yyyy, h:mm:ss a")
    private static let day = formatter("EEE, MMM d, yyyy")

    /// toLocaleTimeString([], {hour,minute,second: 2-digit}).
    static func time(_ ts: Double) -> String { time.string(from: Date(timeIntervalSince1970: ts / 1000)) }
    /// toLocaleString().
    static func full(_ ts: Double) -> String { full.string(from: Date(timeIntervalSince1970: ts / 1000)) }

    static func dayLabel(_ ts: Double) -> String {
        let d = Date(timeIntervalSince1970: ts / 1000), cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        return day.string(from: d)
    }

    static func collapse(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

/// Decoded thumbnails, loaded off the main thread.
@MainActor
final class ScreenThumbCache {
    static let shared = ScreenThumbCache()
    private let cache = NSCache<NSString, NSImage>()
    func cached(_ path: String) -> NSImage? { cache.object(forKey: path as NSString) }
    func load(_ path: String) async -> NSImage? {
        if let c = cached(path) { return c }
        let img = await Task.detached(priority: .userInitiated) { NSImage(contentsOfFile: path) }.value
        if let img { cache.setObject(img, forKey: path as NSString) }
        return img
    }
}

/// An image file drawn `object-cover` (or contain) with a fade-in, nothing while loading.
struct ScreenImage: View {
    let path: String
    var contain = false
    @State private var image: NSImage?
    @State private var shown = false
    var body: some View {
        GeometryReader { g in
            if let image {
                Image(nsImage: image).resizable().interpolation(.high)
                    .aspectRatio(contentMode: contain ? .fit : .fill)
                    .frame(width: g.size.width, height: g.size.height)
                    .clipped()
                    .opacity(shown ? 1 : 0)
                    .onAppear { withAnimation(.easeOut(duration: 0.2)) { shown = true } }
            }
        }
        .task(id: path) {
            image = ScreenThumbCache.shared.cached(path)
            shown = image != nil
            if image == nil { image = await ScreenThumbCache.shared.load(path) }
        }
    }
}

private let pageSize = 200

struct ScreenHistoryPage: View {
    @Environment(AppState.self) private var app
    @State private var model = ScreenHistoryModel.shared
    @State private var query = ""
    @State private var frames: [ScreenFrame] = []
    @State private var axRows: [AmbientEntry] = []
    @State private var frameDone = true
    @State private var axDone = true
    @State private var loadingMore = false
    @State private var selected: ScreenHistoryItem?
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var searchFocused: Bool

    private var items: [ScreenHistoryItem] {
        var all = frames.map(ScreenHistoryItem.frame) + axRows.map(ScreenHistoryItem.ax)
        all.sort { $0.ts > $1.ts }
        var frontier = -Double.infinity
        if !frameDone, let last = frames.last { frontier = max(frontier, last.ts) }
        if !axDone, let last = axRows.last { frontier = max(frontier, last.ts) }
        return frontier == -.infinity ? all : all.filter { $0.ts >= frontier }
    }

    private var groups: [(key: String, label: String, items: [ScreenHistoryItem])] {
        var out: [(key: String, label: String, items: [ScreenHistoryItem])] = []
        let cal = Calendar.current
        for it in items {
            let c = cal.dateComponents([.year, .month, .day], from: Date(timeIntervalSince1970: it.ts / 1000))
            let key = "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
            if out.last?.key == key { out[out.count - 1].items.append(it) } else { out.append((key, ScreenFmt.dayLabel(it.ts), [it])) }
        }
        return out
    }

    var body: some View {
        let list = items
        VStack(spacing: 0) {
            header(count: list.count)
            content(list)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .overlay {
            switch selected {
            case .frame(let f): ScreenFrameLightbox(frame: f) { selected = nil }
            case .ax(let e): ScreenAxLightbox(entry: e) { selected = nil }
            case nil: EmptyView()
            }
        }
        .onAppear {
            query = model.initialQuery
            selected = model.initialFrame.map(ScreenHistoryItem.frame)
            load(query)
            // Esc closes the lightbox first, then the page.
            app.recorder = { event in
                guard event.keyCode == 53 else { return false }
                if selected != nil { selected = nil } else { close() }
                return true
            }
        }
        .onDisappear { app.recorder = nil }
        .onChange(of: query) { _, q in
            searchTask?.cancel()
            searchTask = Task { @MainActor in
                if !q.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
                if !Task.isCancelled { load(q) }
            }
        }
        .onChange(of: model.revision) { _, _ in if query.isEmpty, selected == nil { load(query) } }
        .testID("screen-history")
    }

    private func close() {
        app.recorder = nil
        model.open = false
    }

    private func load(_ q: String) {
        let qt = q.trimmingCharacters(in: .whitespaces)
        let store = ScreenStore.shared
        frames = qt.isEmpty ? store.recentScreenshots(limit: pageSize) : store.searchScreenshots(qt, limit: pageSize)
        axRows = qt.isEmpty ? store.recentAxContext(limit: pageSize) : store.searchAxContext(qt, limit: pageSize)
        frameDone = frames.count < pageSize
        axDone = axRows.count < pageSize
    }

    private func loadMore() {
        guard !loadingMore, !frameDone || !axDone else { return }
        loadingMore = true
        let q = query.trimmingCharacters(in: .whitespaces)
        let store = ScreenStore.shared
        if !frameDone, let cursor = frames.last?.ts {
            let rows = q.isEmpty ? store.recentScreenshots(limit: pageSize, before: cursor) : store.searchScreenshots(q, limit: pageSize, before: cursor)
            frames += rows
            frameDone = rows.count < pageSize
        }
        if !axDone, let cursor = axRows.last?.ts {
            let rows = q.isEmpty ? store.recentAxContext(limit: pageSize, before: cursor) : store.searchAxContext(q, limit: pageSize, before: cursor)
            axRows += rows
            axDone = rows.count < pageSize
        }
        loadingMore = false
    }

    // MARK: header

    private func header(count: Int) -> some View {
        HStack(spacing: 8) {
            Button { close() } label: {
                HStack(spacing: 6) {
                    Glyph(name: "arrow-left", size: 16, color: Theme.foreground)
                    Text("Back")
                }
            }
            .buttonStyle(CetusButtonStyle(variant: .ghost, height: 32, fontSize: 14, horizontal: 10))
            .testID("screen-history-back")
            ScreenSerifTitle(text: "Screen history")
            Text(count == 1 ? "1 entry" : "\(count) entries")
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                .padding(.leading, 4)
            Spacer(minLength: 0)
            searchField
        }
        .padding(.leading, 80).padding(.trailing, 12)
        .frame(height: 47)
        .padding(.bottom, 1)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
        .background(WindowDragArea())
    }

    private var searchField: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 8).fill(Theme.input.opacity(0.3))
            RoundedRectangle(cornerRadius: 8).strokeBorder(searchFocused ? Theme.mutedForeground : Theme.input, lineWidth: 1)
            Glyph(name: "search", size: 14, color: Theme.mutedForeground).padding(.leading, 10)
            TextField("", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 14))
                .foregroundStyle(Theme.foreground)
                .focused($searchFocused)
                .background(alignment: .leading) {
                    if query.isEmpty {
                        Text("Search captured screen text…").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).allowsHitTesting(false)
                    }
                }
                .padding(.leading, 33).padding(.trailing, 29)
                .testID("screen-history-search")
            if !query.isEmpty {
                Button { query = "" } label: { Glyph(name: "x", size: 14, color: Theme.mutedForeground) }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 8)
                    .help("Clear search")
            }
        }
        .frame(width: 288, height: 32)
    }

    // MARK: content

    @ViewBuilder
    private func content(_ list: [ScreenHistoryItem]) -> some View {
        if list.isEmpty {
            VStack(spacing: 4) {
                if !query.isEmpty {
                    Text("No frames match “\(query)”.").font(.system(size: 14)).foregroundStyle(Theme.mutedForeground)
                } else {
                    Text("No screen history yet").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(20.02)
                    Text("Turn on capture in Settings → Screen context. Frames appear here a few seconds after it starts.")
                        .font(.system(size: 14)).foregroundStyle(Theme.mutedForeground).lineSpacing(0)
                        .multilineTextAlignment(.center).frame(maxWidth: 448)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            GeometryReader { g in
                let width = min(1152, g.size.width - 48)
                let cols = max(1, Int((width + 12) / 232))
                let cardW = (width - CGFloat(cols - 1) * 12) / CGFloat(cols)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        ForEach(Array(groups.enumerated()), id: \.element.key) { gi, group in
                            Section {
                                // CSS grid rows stretch every tile to the tallest one in the row.
                                LazyVStack(alignment: .leading, spacing: 12) {
                                    ForEach(Array(stride(from: 0, to: group.items.count, by: cols)), id: \.self) { start in
                                        HStack(alignment: .top, spacing: 12) {
                                            ForEach(group.items[start ..< min(start + cols, group.items.count)]) { it in
                                                card(it, width: cardW).frame(maxHeight: .infinity, alignment: .top)
                                            }
                                        }
                                        .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                .padding(.bottom, gi == groups.count - 1 ? 0 : 32)
                            } header: {
                                Text("\(group.label) · \(group.items.count)".uppercased())
                                    .font(.system(size: 12, weight: .semibold)).tracking(0.3)
                                    .foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                                    .padding(.vertical, 4).padding(.horizontal, 4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Theme.background)
                                    .padding(.horizontal, -4)
                                    .padding(.bottom, 12)
                            }
                        }
                        if !frameDone || !axDone {
                            Color.clear.frame(height: 1).onAppear { loadMore() }
                        }
                    }
                    .frame(width: width)
                    .padding(.vertical, 24)
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    @ViewBuilder
    private func card(_ it: ScreenHistoryItem, width: CGFloat) -> some View {
        switch it {
        case .frame(let f):
            ScreenFrameCard(frame: f, width: width) { selected = it }
        case .ax(let e):
            ScreenAxCard(entry: e, width: width) { selected = it }
        }
    }
}

/// `font-serif text-base font-semibold italic` — Old Standard ships 400 italic
/// only, so WebKit synthesizes the bold (painted twice, offset).
struct ScreenSerifTitle: View {
    let text: String
    var body: some View {
        Text(text).font(SerifFont.italic(15)).tracking(0.42).foregroundStyle(Theme.foreground)
            .overlay(alignment: .leading) { Text(text).font(SerifFont.italic(15)).tracking(0.42).foregroundStyle(Theme.foreground).offset(x: 0.5) }
            .padding(.trailing, 0.5)
            .lineBox(22.5)
    }
}

/// Lets the header double as a window drag handle (data-tauri-drag-region).
private struct WindowDragArea: NSViewRepresentable {
    final class V: NSView { override var mouseDownCanMoveWindow: Bool { true } }
    func makeNSView(context: Context) -> NSView { V() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

/// Shared tile chrome: rounded-lg border bg-card, hover border-foreground/30.
private struct ScreenTile<Top: View, Meta: View>: View {
    let width: CGFloat
    let action: () -> Void
    @ViewBuilder var top: (Bool) -> Top
    @ViewBuilder var meta: Meta
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 0) {
                top(hover)
                    .frame(width: width - 2, height: (width - 2) * 10 / 16)
                    .clipped()
                meta
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(width: width - 2, alignment: .leading)
                Spacer(minLength: 0)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(1)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(hover ? Theme.foreground.opacity(0.3) : Theme.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hover = h } }
    }
}

private struct ScreenMetaRow: View {
    let app: String
    let ts: Double
    var body: some View {
        HStack(spacing: 8) {
            Text(app).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 0)
            Text(ScreenFmt.time(ts)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground).fixedSize()
        }
        .lineBox(16.2)
    }
}

/// line-clamp-2 text-xs leading-snug text-muted-foreground.
private struct ScreenClamp: View {
    let text: String
    var lines = 2
    var body: some View {
        Text(text).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
            .lineSpacing(1.2).lineLimit(lines).truncationMode(.tail)
            .padding(.top, 0.5).padding(.bottom, 0.95)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ScreenFrameCard: View {
    let frame: ScreenFrame
    let width: CGFloat
    let action: () -> Void
    var body: some View {
        let path = frame.thumbPath ?? (frame.filePath.isEmpty ? nil : frame.filePath)
        let snippet = ScreenFmt.collapse(frame.ocrText ?? "")
        ScreenTile(width: width, action: action) { hover in
            ZStack {
                Theme.muted
                if let path {
                    ScreenImage(path: path).scaleEffect(hover ? 1.02 : 1)
                } else {
                    VStack(spacing: 6) {
                        Glyph(name: "file-text", size: 20, color: Theme.mutedForeground)
                        Text("Image expired — text kept").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground).lineBox(15.4)
                    }
                    .padding(12)
                }
            }
        } meta: {
            VStack(alignment: .leading, spacing: 2) {
                ScreenMetaRow(app: frame.appName?.nonEmptyScreen ?? "Unknown", ts: frame.ts)
                if !snippet.isEmpty { ScreenClamp(text: snippet) }
            }
        }
        .testID("screen-frame-\(frame.id)")
    }
}

struct ScreenAxCard: View {
    let entry: AmbientEntry
    let width: CGFloat
    let action: () -> Void
    var body: some View {
        let excerpt = ScreenFmt.collapse(entry.text)
        let title = (entry.pageTitle?.nonEmptyScreen ?? entry.windowTitle ?? "").trimmingCharacters(in: .whitespaces)
        ScreenTile(width: width, action: action) { _ in
            ZStack(alignment: .topLeading) {
                Theme.muted.opacity(0.6)
                ScreenClamp(text: excerpt.isEmpty ? title : excerpt, lines: 7).padding(10)
                ScreenBadge(fill: Theme.background.opacity(0.85))
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(6)
            }
        } meta: {
            VStack(alignment: .leading, spacing: 2) {
                ScreenMetaRow(app: entry.appName?.nonEmptyScreen ?? "Unknown", ts: entry.ts)
                if !title.isEmpty { ScreenClamp(text: title) }
            }
        }
    }
}

/// The "Text" badge: rounded border px-1 py-px text-2xs font-medium uppercase tracking-wide.
private struct ScreenBadge: View {
    let fill: Color
    var body: some View {
        Text("TEXT").font(.system(size: 11, weight: .medium)).tracking(0.275).foregroundStyle(Theme.mutedForeground)
            .lineBox(15.4)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .padding(1)
            .background(RoundedRectangle(cornerRadius: 4).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border, lineWidth: 1))
    }
}

extension String {
    var nonEmptyScreen: String? { isEmpty ? nil : self }
}

// MARK: - Lightboxes

private struct ScreenCloseButton: View {
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Glyph(name: "x", size: 16, color: hover ? Theme.foreground : Theme.mutedForeground)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 4).fill(hover ? Theme.muted : .clear))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("Close")
        .testID("screen-lightbox-close")
    }
}

private struct ScreenSectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 12, weight: .semibold)).tracking(0.3).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            .padding(.bottom, 6)
    }
}

/// whitespace-pre-wrap text-xs leading-relaxed text-foreground/90 (or the italic empty line).
private struct ScreenBodyText: View {
    let text: String
    var body: some View {
        if text.isEmpty {
            Text("No text was recognized in this frame.").font(.system(size: 12).italic()).foregroundStyle(Theme.mutedForeground).lineBox(19.5)
        } else {
            Text(text).font(.system(size: 12)).foregroundStyle(Theme.foreground.opacity(0.9))
                .lineSpacing(4.48).padding(.vertical, 2.1)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct HeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

struct ScreenFrameLightbox: View {
    let frame: ScreenFrame
    let onClose: () -> Void
    @State private var asideBody: CGFloat = 0
    @State private var image: NSImage?

    var body: some View {
        let ocr = (frame.ocrText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        GeometryReader { g in
            let maxW = min(1152, g.size.width - 48), maxH = g.size.height - 48
            let asideW: CGFloat = 320
            let imgBoxW = maxW - 2 - asideW
            let imgSize: CGSize = {
                guard let image, image.size.width > 0 else { return CGSize(width: 0, height: 120) }
                let maxImgH = g.size.height * 0.82, maxImgW = imgBoxW - 24
                let k = min(1, maxImgW / image.size.width, maxImgH / image.size.height)
                return CGSize(width: image.size.width * k, height: image.size.height * k)
            }()
            let headerH: CGFloat = 16 + 24 + 16.2 + 16 + 1
            let footerH: CGFloat = frame.filePath.isEmpty ? 0 : 1 + 12 + 32 + 12
            let asideH = headerH + 32 + 22.2 + asideBody + footerH
            let panelH = min(maxH, max(imgSize.height + 24, asideH))
            ZStack {
                Color.black.opacity(0.7).onTapGesture(perform: onClose)
                HStack(spacing: 0) {
                    ZStack {
                        Color.black.opacity(0.4)
                        if frame.filePath.isEmpty {
                            VStack(spacing: 8) {
                                Glyph(name: "file-text", size: 32, color: Theme.mutedForeground)
                                Text("Image expired — text kept").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                            }
                        } else if let image {
                            Image(nsImage: image).resizable().interpolation(.high).frame(width: imgSize.width, height: imgSize.height)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    .frame(width: imgBoxW)
                    aside(ocr)
                        .frame(width: asideW - 1)
                        .padding(.leading, 1)
                        .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
                }
                .frame(height: panelH - 2)
                .padding(1)
                .background(Theme.background)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.25), radius: 25, y: 25)
                .frame(width: maxW)
                .onTapGesture {}
            }
        }
        .task(id: frame.filePath) {
            if !frame.filePath.isEmpty { image = await Task.detached { NSImage(contentsOfFile: frame.filePath) }.value }
        }
        .testID("screen-lightbox")
    }

    private func aside(_ ocr: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(frame.appName?.nonEmptyScreen ?? "Unknown app").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(24)
                    Text(ScreenFmt.full(frame.ts)).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                }
                Spacer(minLength: 0)
                ScreenCloseButton(action: onClose)
            }
            .padding(16)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            .padding(.bottom, 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ScreenSectionLabel(text: "Recognized text")
                    ScreenBodyText(text: ocr)
                        .background(GeometryReader { Color.clear.preference(key: HeightKey.self, value: $0.size.height) })
                }
                .padding(16)
            }
            .onPreferenceChange(HeightKey.self) { asideBody = $0 }
            .frame(maxHeight: .infinity)
            if !frame.filePath.isEmpty {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: frame.filePath)])
                } label: {
                    HStack(spacing: 6) {
                        Glyph(name: "folder-open", size: 14, color: Theme.foreground)
                        Text("Show in Finder")
                    }
                }
                .buttonStyle(CetusButtonStyle(variant: .outline, height: 32, fontSize: 14, horizontal: 10, fullWidth: true))
                .padding(12)
                .padding(.top, 1)
                .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
            }
        }
    }
}

struct ScreenAxLightbox: View {
    let entry: AmbientEntry
    let onClose: () -> Void
    @State private var bodyH: CGFloat = 0
    var body: some View {
        let title = (entry.pageTitle?.nonEmptyScreen ?? entry.windowTitle ?? "").trimmingCharacters(in: .whitespaces)
        let text = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
        GeometryReader { g in
            ZStack {
                Color.black.opacity(0.7).onTapGesture(perform: onClose)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Text(entry.appName?.nonEmptyScreen ?? "Unknown app").font(.system(size: 16, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1)
                                ScreenBadge(fill: Theme.muted)
                            }
                            .lineBox(24)
                            if !title.isEmpty {
                                Text(title).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2)
                            }
                            Text(ScreenFmt.full(entry.ts)).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                            if let url = entry.url, !url.isEmpty {
                                Text(url).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).textSelection(.enabled)
                            }
                        }
                        Spacer(minLength: 0)
                        ScreenCloseButton(action: onClose)
                    }
                    .padding(16)
                    .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
                    .padding(.bottom, 1)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ScreenSectionLabel(text: "Captured text")
                            ScreenBodyText(text: text)
                        }
                        .padding(16)
                        .background(GeometryReader { Color.clear.preference(key: HeightKey.self, value: $0.size.height) })
                    }
                    .onPreferenceChange(HeightKey.self) { bodyH = $0 }
                    .frame(height: min(bodyH, g.size.height * 0.85 - 140))
                }
                .padding(1)
                .background(Theme.background)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.25), radius: 25, y: 25)
                .frame(width: min(672, g.size.width - 48))
                .frame(maxHeight: g.size.height * 0.85)
                .onTapGesture {}
            }
        }
    }
}

// MARK: - Command palette row

/// command-palette.tsx's screen-history CommandItem: 56x36 thumb, app + relative
/// time, one line of OCR text.
struct PaletteScreenRow: View {
    let frame: ScreenFrame
    let selected: Bool
    var body: some View {
        let path = frame.thumbPath ?? (frame.filePath.isEmpty ? nil : frame.filePath)
        let snippet = String(ScreenFmt.collapse(frame.ocrText ?? "").prefix(120))
        HStack(alignment: .top, spacing: 10) {
            ZStack {
                if let path { ScreenImage(path: path) } else { Theme.muted }
            }
            .frame(width: 54, height: 34)
            .clipShape(RoundedRectangle(cornerRadius: 3))
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(frame.appName?.nonEmptyScreen ?? "Screen").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground)
                        .lineLimit(1).lineBox(20.02).frame(maxWidth: .infinity, alignment: .leading)
                    Text(Fmt.relative(frame.ts)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground.opacity(0.7)).lineBox(16.2)
                }
                Text(snippet.isEmpty ? "(no recognized text)" : snippet).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16.2)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(selected ? Theme.accent : .clear))
        .contentShape(Rectangle())
    }
}
