import AppKit
import SwiftUI

/// The Chats page body (the 40px header lives in RootView's content column).
struct ChatView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        Group {
            if let id = app.active {
                ChatPane(chat: app.controller.chat(id))
            } else {
                NewChatView()
            }
        }
        .chatWallpaper()
        .task { TranscriptControl.install() }
    }
}

/// The card's 40px header: no title, just a drag area and the panel buttons.
struct ContentHeader: View {
    @Environment(AppState.self) private var app
    var body: some View {
        HStack(spacing: 12) {
            if !app.prefs.sidebar {
                Color.clear.frame(width: 56)
                GhostIconButton(icon: "panel-left", tip: "Toggle Sidebar", kbd: Shortcuts.hint("toggleSidebar", app.prefs), testID: "expand-sidebar") {
                    app.runShortcut("toggleSidebar")
                }
            }
            Spacer(minLength: 0)
            ArtifactsInboxButton()
            GhostIconButton(icon: "panel-right", tip: "Open side panel", kbd: Shortcuts.hint("toggleWorkspace", app.prefs), testID: "workspace-open-side") {
                app.openWorkspace(layout: .side)
            }
            GhostIconButton(icon: "panel-bottom", tip: "Open bottom panel", kbd: Shortcuts.hint("toggleTerminal", app.prefs), testID: "workspace-open-bottom") {
                app.openWorkspace(layout: .bottom)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 40)
    }
}

/// Optical-center nudge: with the sidebar open and no side dock, wide windows
/// shift the reading column left (−40 at ≥1280, −48 at ≥1536).
struct OpticalNudge: ViewModifier {
    @Environment(AppState.self) private var app
    @Environment(\.windowWidth) private var width
    func body(content: Content) -> some View {
        let on = app.prefs.sidebar && !app.side.open
        let dx: CGFloat = !on ? 0 : width >= 1536 ? -48 : width >= 1280 ? -40 : 0
        content.offset(x: dx).animation(.timingCurve(0.2, 0, 0, 1, duration: 0.2), value: dx)
    }
}

struct WindowWidthKey: EnvironmentKey { static let defaultValue: CGFloat = 1200 }
struct WindowHeightKey: EnvironmentKey { static let defaultValue: CGFloat = 800 }
extension EnvironmentValues {
    /// Viewport height (CSS `vh`), after zoom.
    var windowHeight: CGFloat {
        get { self[WindowHeightKey.self] }
        set { self[WindowHeightKey.self] = newValue }
    }
    var windowWidth: CGFloat {
        get { self[WindowWidthKey.self] }
        set { self[WindowWidthKey.self] = newValue }
    }
}

enum HeroCopy {
    static let headlines = [
        "What should we work on?", "Where shall we begin?", "What are we building today?",
        "What's on your mind?", "Ready when you are.", "Let's make something.",
        "What can I help you ship?", "Got something in mind?", "What's the plan?", "Let's dig in.",
        "What are we tackling?", "Point me at something.",
    ]
    static let placeholders = [
        "Do anything", "Ask, build, explore…", "Describe a task, or just say hi", "What needs doing?",
        "Give me a task", "Start with a sentence", "Type a task, a question, anything", "What's on the docket?",
        "Tell me what to build", "Drop an idea here", "Ask me something", "Let's get into it",
    ]

    /// Cetus withFocusHint: " Press / to focus." joined after terminal punctuation, else ". ".
    static func withFocusHint(_ s: String) -> String {
        let ends = [".", "!", "?", "。", "！", "？", "…"].contains { s.hasSuffix($0) }
        return s + (ends ? " " : ". ") + "Press / to focus."
    }
}

/// New chat: the serif greeting over the glyph backdrop, with the hero composer.
struct NewChatView: View {
    @Environment(AppState.self) private var app
    @AppStorage("settings.wallpaper") private var wallpaper = ""
    var body: some View {
        ZStack {
            // The wallpaper replaces the glyph.
            if ChatWallpaper.image(wallpaper) == nil { GlyphBackdrop() }
            VStack(spacing: 24) {
                Text(HeroCopy.headlines[app.heroIndex % HeroCopy.headlines.count])
                    .font(SerifFont.italic(36))
                    .tracking(-0.9)
                    .foregroundStyle(Theme.foreground)
                    .multilineTextAlignment(.center)
                    .lineBox(40)
                    .testID("hero")
                ComposerView(convId: nil, hero: true)
            }
            .frame(maxWidth: 672)
            .modifier(OpticalNudge())
            .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The faint, huge outline of the Cetus glyph behind the new-chat hero.
struct GlyphBackdrop: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.windowWidth) private var vw
    @Environment(\.windowHeight) private var vh
    var body: some View {
        GeometryReader { g in
            let side = min(vw, vh) * 0.96 // 96vmin
            let path = Self.glyph
            ZStack {
                path.stroke(lineWidth: 4)
                    .fill(LinearGradient(stops: [.init(color: .white, location: 0), .init(color: .white.opacity(0.62), location: 0.55), .init(color: .white.opacity(0.2), location: 1)],
                                         startPoint: UnitPoint(x: 0.5, y: 108.0 / 1024), endPoint: UnitPoint(x: 0.5, y: 916.0 / 1024)))
                    .clipShape(path)
            }
            .frame(width: 1024, height: 1024)
            .scaleEffect(side / 1024)
            .frame(width: side, height: side)
            .foregroundStyle(Theme.primary)
            .colorMultiply(Theme.primary)
            .opacity(scheme == .dark ? 0.22 : 0.16)
            .mask(RadialGradient(stops: [.init(color: .black, location: 0.48 * 0.7 / 0.7), .init(color: .clear, location: 0.86)],
                                 center: UnitPoint(x: 0.5, y: 0.47), startRadius: 0, endRadius: side * 0.7))
            .position(x: g.size.width / 2, y: g.size.height / 2 - side * 0.02)
        }
        .allowsHitTesting(false)
    }

    static let glyph: Path = svgPath("M512 108C739.541 108 924 292.459 924 520C924 700.997 807.285 854.733 645.012 910.054C632.927 914.174 626.884 916.234 619.386 915.916C613.304 915.658 605.851 913.437 600.62 910.323C594.171 906.484 589.642 900.683 580.583 889.081L369.758 619.073C352.563 597.052 343.965 586.041 333.522 582.073C324.369 578.594 314.258 578.594 305.105 582.072C294.661 586.041 286.064 597.052 268.869 619.073L223.165 677.607C205.689 699.989 196.951 711.18 184.352 714.738C174.521 717.514 160.565 715.455 151.955 709.958C140.92 702.912 136.525 691.579 127.735 668.912C109.824 622.728 100 572.511 100 520C100 292.459 284.459 108 512 108Z")

    /// Absolute M/L/C/Z only (all the glyph needs).
    static func svgPath(_ d: String) -> Path {
        var p = Path()
        var nums: [CGFloat] = []
        var cmd: Character = "M"
        func flush() {
            switch cmd {
            case "M": if nums.count >= 2 { p.move(to: CGPoint(x: nums[0], y: nums[1])) }
            case "L": if nums.count >= 2 { p.addLine(to: CGPoint(x: nums[0], y: nums[1])) }
            case "C": if nums.count >= 6 { p.addCurve(to: CGPoint(x: nums[4], y: nums[5]), control1: CGPoint(x: nums[0], y: nums[1]), control2: CGPoint(x: nums[2], y: nums[3])) }
            case "Z": p.closeSubpath()
            default: break
            }
            nums = []
        }
        var token = ""
        for ch in d + " " {
            if "MLCZ".contains(ch) {
                if !token.isEmpty { nums.append(CGFloat(Double(token) ?? 0)); token = "" }
                flush(); cmd = ch
                if ch == "Z" { flush() }
            } else if ch == " " || ch == "," {
                if !token.isEmpty { nums.append(CGFloat(Double(token) ?? 0)); token = "" }
            } else {
                token.append(ch)
            }
        }
        flush()
        return p
    }
}

/// A chat: the transcript, rebuilt per chat (`.id`) so its scroll window starts
/// fresh, over a footer that persists across switches. Rebuilding the composer on
/// every switch (new text view, focus, async branch lookup) made it flicker.
struct ChatPane: View {
    let chat: ChatModel

    var body: some View {
        VStack(spacing: 0) {
            ConversationView(chat: chat).id(chat.id)
            ConversationFooter(chat: chat)
        }
    }
}

/// Banners, the pending control card, and the composer under the transcript.
struct ConversationFooter: View {
    @Environment(AppState.self) private var app
    let chat: ChatModel
    @AppStorage("settings.wallpaper") private var wallpaper = ""

    var body: some View {
        let conversation = app.controller.conversation(chat.id)
        VStack(spacing: 8) {
            if !chat.background.isEmpty { backgroundTasks(conversation?.backend ?? "claude-code") }
            if let c = conversation, c.runState == .interrupted && !chat.isStreaming { interruptedBanner(c) }
            if chat.compacting { compactionStrip }
            if let request = chat.controls.first {
                ControlCard(request: request) { response in app.controller.respondToControl(chat.id, request: request, response: response) }
            }
            ComposerView(convId: chat.id)
        }
        .frame(maxWidth: 768)
        .modifier(OpticalNudge())
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(ChatWallpaper.image(wallpaper) == nil ? Theme.background : .clear)
    }

    private func strip<C: View>(border: Color, fill: Color, @ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 8) { content() }
            .font(.system(size: 12))
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(border, lineWidth: 1))
    }

    private func backgroundTasks(_ backend: String) -> some View {
        let color = Theme.runtimeColor(backend)
        let names = chat.background.map { t in t["description"].string ?? t["kind"].stringValue }
        return strip(border: color.opacity(0.3), fill: color.opacity(0.06)) {
            Glyph(name: "bot", size: 14, color: color)
            Spinner(size: 12, color: color)
            Text("\(chat.background.count) background task\(chat.background.count == 1 ? "" : "s") running").fontWeight(.medium).foregroundStyle(Theme.foreground)
            Text(names.prefix(3).joined(separator: ", ") + (names.count > 3 ? " +\(names.count - 3) more" : "")).lineLimit(1)
        }
        .testID("background-tasks")
    }

    private var compactionStrip: some View {
        strip(border: Theme.sky.opacity(0.25), fill: Theme.sky.opacity(0.05)) {
            Spinner(size: 12, color: Color(nsColor: NSColor(hex: 0x0084D1)))
            Text("Compacting context…").fontWeight(.medium).foregroundStyle(Theme.foreground)
        }
    }

    private func interruptedBanner(_ c: Conversation) -> some View {
        strip(border: Theme.amber.opacity(0.25), fill: Theme.amber.opacity(0.05)) {
            Text("Run interrupted").fontWeight(.medium).foregroundStyle(Theme.foreground)
            Text("The last run was cut short by a restart.").lineLimit(1)
            Spacer(minLength: 6)
            Button {
                app.controller.send(SendOptions(conversationId: c.id, text: "Continue from where you left off.", backend: c.backend, model: c.cliModel, effort: c.cliEffort, workspaceDir: c.workspaceDir))
            } label: {
                Text("Resume").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.background)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.foreground))
            }
            .buttonStyle(.plain)
            Button { app.controller.markIdle(c.id) } label: {
                Text("Dismiss").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .hoverFill(Theme.muted)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .testID("interrupted-banner")
    }
}

struct ConversationView: View {
    @Environment(AppState.self) private var app
    let chat: ChatModel
    @State private var position = ScrollPosition(edge: .bottom)
    /// Scroll metrics change every frame: kept in a plain box so scrolling doesn't
    /// re-run the body. Only the derived flags below are observed, written when they flip.
    @State private var metrics = ScrollMetrics()
    @State private var nearBottom = true
    @State private var farFromBottom = false
    @State private var rowFrames = ChatFindRowFrames()
    @State private var memo = LayoutMemo()
    /// Mounted row window [lo, hi): only rows near the viewport exist as views.
    /// Building every row of a long chat (text views, layout) blocked a switch for
    /// 300ms+ and kept growing with the chat; the window opens on the tail and
    /// grows a chunk at a time as the reader nears either edge, and rows far
    /// off-screen are dropped. `lo == nil`: the last `firstChunk` rows.
    /// `hi == nil`: through the end, following new rows.
    @State private var lo: Int?
    @State private var hi: Int?
    @State private var windowCheck = false
    private static let firstChunk = 3, chunk = 2

    final class ScrollMetrics {
        var viewport: CGFloat = 600
        var fromBottom: CGFloat = 0
        var fromTop: CGFloat = 0
    }

    /// Items and the find index per state revision: the body, the window checks
    /// (every frame while scrolling) and find all ask for them.
    final class LayoutMemo {
        private var rev = -1
        private var items: [TranscriptItem] = []
        private var findKey: (rev: Int, query: String)?
        private var index: (offsets: [String: Int], total: Int, owners: [String]) = ([:], 0, [])

        func items(_ chat: ChatModel) -> [TranscriptItem] {
            if rev != chat.revision {
                items = TranscriptLayout.items(chat.state)
                rev = chat.revision
            }
            return items
        }

        func index(_ chat: ChatModel, query: String) -> (offsets: [String: Int], total: Int, owners: [String]) {
            let all = items(chat)
            if let k = findKey, k.rev == rev, k.query == query { return index }
            index = TranscriptLayout.findIndex(all, query: query)
            findKey = (rev, query)
            return index
        }
    }

    /// At the real end: the last row is mounted and on screen (not just the window's last row).
    private var atBottom: Bool { metrics.fromBottom < 60 && hi == nil }

    private func updateScrollFlags() {
        let near = metrics.fromBottom < 60
        if nearBottom != near { nearBottom = near }
        let far = metrics.fromBottom > max(360, metrics.viewport * 0.5)
        if farFromBottom != far { farFromBottom = far }
    }

    private func bounds(_ count: Int) -> Range<Int> {
        let to = min(count, hi ?? count)
        let from = min(to, max(0, lo ?? count - Self.firstChunk))
        return from ..< to
    }

    var body: some View {
        let state = chat.state
        let items = memo.items(chat)
        let find = app.find
        let index = memo.index(chat, query: find?.query ?? "")
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(items[bounds(items.count)]) { item in
                            TranscriptRow(item: item, startedAt: chat.startedAt, lastDurationMs: chat.lastDurationMs, fork: fork)
                                .equatable()
                                .id(item.id)
                                .onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView) } action: { rowFrames.frames[item.id] = $0 }
                                .onDisappear { rowFrames.frames[item.id] = nil }
                        }
                        if state.awaitingAssistant {
                            ThinkingPlaceholder(since: chat.startedAt).padding(.vertical, 12).testID("thinking")
                        }
                        if let error = state.error { errorRow(error, streaming: state.isStreaming) }
                        Color.clear.frame(height: 0).id("bottom")
                    }
                    .frame(maxWidth: 768)
                    .modifier(OpticalNudge())
                    // Cetus's row gutter computes to pl-14 pr-4 (sm:pl-14 wins over min-[896px]:px-4).
                    .padding(.leading, 56)
                    .padding(.trailing, 16)
                    .padding(.top, 16)
                    .frame(maxWidth: .infinity)
                    .environment(\.findHighlight, find.map { FindHighlight(query: $0.query, active: $0.active, offsets: index.offsets) })
                }
                .scrollPosition($position)
                // Following the bottom: growth (new rows, older rows mounting above) keeps it pinned.
                // Elsewhere the top holds still and moveWindow compensates for rows changing above.
                .defaultScrollAnchor(nearBottom && hi == nil ? .bottom : nil, for: .sizeChanges)
                .onScrollGeometryChange(for: CGRect.self) { g in
                    CGRect(x: max(0, g.contentOffset.y), y: max(0, g.contentSize.height - g.contentOffset.y - g.containerSize.height),
                           width: g.containerSize.height, height: 0)
                } action: { _, v in
                    metrics.viewport = v.width
                    metrics.fromBottom = v.minY
                    metrics.fromTop = v.minX
                    updateScrollFlags()
                    // Opening lands short of the bottom by however much rows grew while the
                    // initial offset was resolved; the pin timer only fixed it a frame later.
                    // Correct it in this layout pass so the first frame is already at the end.
                    if v.minY > 0.5, hi == nil, TranscriptScroller.shared.pinned { position.scrollTo(edge: .bottom) }
                    scheduleWindowCheck()
                }
                .testID("transcript")
                if find != nil {
                    FindBar(total: index.total)
                        .frame(maxWidth: 768, alignment: .trailing)
                        .modifier(OpticalNudge())
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .frame(maxWidth: .infinity)
                }
            }
            .overlay(alignment: .bottom) { jumpButton }
        }
        .onChange(of: tailSignature(state)) { _, _ in
            if atBottom { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: app.scrollToBottomToken) { _, _ in
            resetToTail()
            metrics.fromBottom = 0
            updateScrollFlags()
            DispatchQueue.main.async { position.scrollTo(edge: .bottom) }
            TranscriptScroller.shared.pinBottom()
        }
        .onChange(of: find?.query) { _, q in
            // A fresh query lands on the first match at or below the top visible row (firstMatchFrom).
            guard var f = app.find, let q, !q.isEmpty else { return }
            let first = rowFrames.firstMatch(items: items, owners: index.owners)
            if f.active != first { f.active = first; app.find = f }
        }
        .onChange(of: find?.active) { _, a in
            guard let a, index.owners.indices.contains(a) else { return }
            let id = index.owners[a]
            guard let t = items.firstIndex(where: { $0.id == id }) else { return }
            if bounds(items.count).contains(t) {
                withAnimation(.easeOut(duration: 0.15)) { position.scrollTo(id: id, anchor: .center) }
            } else {
                // Off the mounted window: remount around the match, then center it.
                lo = max(0, t - Self.chunk)
                hi = t + Self.chunk + 1 >= items.count ? nil : t + Self.chunk + 1
                DispatchQueue.main.async { position.scrollTo(id: id, anchor: .center) }
            }
        }
        .onChange(of: index.total) { _, total in
            if var f = app.find, f.count != total {
                f.count = total
                if f.active >= total { f.active = 0 }
                app.find = f
            }
        }
        .onAppear {
            DispatchQueue.main.async { position.scrollTo(edge: .bottom) }
            TranscriptScroller.shared.pinBottom()
            TranscriptWindowProbe.frames = rowFrames
            scheduleWindowCheck()
        }
    }

    // MARK: Row window

    /// Back to the tail (sending, jump to bottom) when rows below were dropped.
    private func resetToTail() {
        guard hi != nil else { return }
        lo = nil
        hi = nil
    }

    /// One window step per frame while the reader is near an edge of the mounted rows, until it settles.
    /// (Dispatch, not a Task: a Task spawned from the scroll callback could sit unscheduled until the next event.)
    private func scheduleWindowCheck() {
        guard !windowCheck else { return }
        windowCheck = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) {
            windowCheck = false
            if adjustWindow() { scheduleWindowCheck() }
        }
    }

    /// Moves the window one step; false when it is where it should be.
    private func adjustWindow() -> Bool {
        let items = memo.items(chat)
        let n = items.count, r = bounds(n)
        let vp = max(metrics.viewport, 200)
        let distanceFromTop = metrics.fromTop, distanceFromBottom = metrics.fromBottom
        let near = vp * 1.5, far = vp * 5
        let report = { TranscriptWindowProbe.describe = "\(bounds(n).lowerBound)..<\(bounds(n).upperBound)/\(n)" }
        defer { report() }
        if r.lowerBound > 0 && distanceFromTop < near {
            moveWindow(above: true) { lo = max(0, r.lowerBound - Self.chunk) }
        } else if r.upperBound < n && distanceFromBottom < near {
            moveWindow(above: false) { hi = r.upperBound + Self.chunk >= n ? nil : r.upperBound + Self.chunk }
        } else if distanceFromBottom > far + vp, r.count > Self.firstChunk,
                  let cut = items[r].firstIndex(where: { (rowFrames.frames[$0.id]?.minY ?? 0) > vp + far }), cut > r.lowerBound {
            moveWindow(above: false) { hi = cut }
        } else if distanceFromTop > far + vp, r.count > Self.firstChunk,
                  let keep = items[r].lastIndex(where: { (rowFrames.frames[$0.id]?.maxY ?? 0) < -far }), keep + 1 < r.upperBound {
            moveWindow(above: true) { lo = keep + 1 }
        } else {
            return false
        }
        return true
    }

    /// Rows changing below the viewport leave it alone (top anchor). Rows changing above
    /// would shift it: lay the new rows out now and scroll by the height they added or
    /// removed before the frame draws. At the bottom the bottom anchor does this instead.
    private func moveWindow(above: Bool, _ change: () -> Void) {
        let sv = TranscriptScroller.shared.scrollView
        guard above, !atBottom, let sv, let doc = sv.documentView, let root = sv.window?.contentView else {
            change()
            // The anchor misses growth while the tail is shorter than the viewport.
            if above && atBottom { position.scrollTo(edge: .bottom) }
            return
        }
        // Settle any pending layout (e.g. rows just mounted below) so the delta is only this change's.
        root.layoutSubtreeIfNeeded()
        let height = doc.frame.height, y = sv.contentView.bounds.origin.y
        change()
        root.layoutSubtreeIfNeeded()
        let delta = doc.frame.height - height
        if delta != 0 {
            sv.contentView.scroll(to: NSPoint(x: sv.contentView.bounds.origin.x, y: max(0, y + delta)))
            sv.reflectScrolledClipView(sv.contentView)
        }
    }

    /// 36px circle, shown once the reader is max(360, half a screen) above the bottom.
    private var jumpButton: some View {
        let show = farFromBottom || hi != nil
        return Button {
            if hi != nil {
                // Rows below were dropped: remount the tail and jump there.
                resetToTail()
                DispatchQueue.main.async { position.scrollTo(edge: .bottom) }
                TranscriptScroller.shared.pinBottom(for: 0.4)
            } else {
                withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) }
            }
        } label: {
            Glyph(name: "arrow-down", size: 16, color: Theme.foreground)
                .frame(width: 36, height: 36)
                .hoverFill(Theme.muted, radius: 18)
                .background(Circle().fill(Theme.popover))
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 7, y: 4)
                .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
        }
        .buttonStyle(.plain)
        .help("Scroll to bottom")
        .frame(maxWidth: 768, alignment: .trailing)
        .modifier(OpticalNudge())
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .opacity(show ? 1 : 0)
        .offset(y: show ? 0 : 8)
        .allowsHitTesting(show)
        .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.2), value: show)
        .testID(show ? "jump-bottom" : nil)
    }

    private func tailSignature(_ s: ChatState) -> String {
        let last = s.messages.last
        return "\(s.messages.count):\(last?.blocks.count ?? 0):\(last?.blocks.last?.text.utf16.count ?? 0):\(last?.blocks.last?.result != nil):\(s.awaitingAssistant):\(chat.controls.count):\(chat.queue.count)"
    }

    /// One transcript row. Equatable on its content: the fork closure is new on every
    /// parent update, which made every mounted row re-render on each streamed delta.
    private struct TranscriptRow: View, Equatable {
        let item: TranscriptItem
        let startedAt: Double?
        let lastDurationMs: Double?
        let fork: (Int) -> Void

        static func == (a: Self, b: Self) -> Bool {
            a.item == b.item && a.startedAt == b.startedAt && a.lastDurationMs == b.lastDurationMs
        }

        var body: some View {
            switch item {
            case .user(let m, let turn):
                UserMessageView(message: m) { fork(turn) }
            case .custom(let m):
                CustomMessageView(message: m)
            case .assistant(let t):
                AssistantTurnView(turn: t, startedAt: startedAt, lastDurationMs: lastDurationMs, onFork: { fork(t.turn) })
            }
        }
    }

    private func fork(_ turn: Int) {
        if let id = app.controller.fork(chat.id, turn: turn) { app.openChat(id) }
    }

    private func errorRow(_ error: String, streaming: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Glyph(name: "alert-triangle", size: 16, color: Theme.destructive).padding(.top, 2)
            VStack(alignment: .leading, spacing: 6) {
                Text(error).font(.system(size: 14)).foregroundStyle(Theme.destructive).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if !streaming {
                    Button { app.controller.retry(chat.id) } label: {
                        HStack(spacing: 4) {
                            Glyph(name: "rotate-cw", size: 12, color: Theme.destructive)
                            Text("Retry").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.destructive)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .hoverFill(Theme.destructive.opacity(0.1))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.destructive.opacity(0.3), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .testID("retry")
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.destructive.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.destructive.opacity(0.3), lineWidth: 1))
        .containerRelativeFrame(.horizontal, alignment: .leading) { w, _ in min(w, 768) * 0.88 }
        .fixedSize(horizontal: true, vertical: false)
        .padding(.vertical, 12)
        .testID("chat-error")
    }
}

/// "ASSISTANT" + shimmering "Thinking…", with an elapsed counter after 3s.
struct ThinkingPlaceholder: View {
    let since: Double?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            RoleLabel()
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ShimmerText(text: "Thinking…", size: 14)
                    let s = since.map { Int((ctx.date.timeIntervalSince1970 * 1000 - $0) / 1000) } ?? 0
                    if s >= 3 { Text("\(s)s").font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground.opacity(0.7)) }
                }
            }
        }
    }
}

/// `text-2xs font-medium uppercase tracking-wider text-muted-foreground`.
struct RoleLabel: View {
    var body: some View {
        Text("ASSISTANT").font(.system(size: 11, weight: .medium)).tracking(0.55).foregroundStyle(Theme.mutedForeground)
    }
}

struct FindBar: View {
    @Environment(AppState.self) private var app
    let total: Int

    var body: some View {
        let query = app.find?.query ?? ""
        HStack(spacing: 4) {
            FindField(text: Binding(get: { app.find?.query ?? "" }, set: { q in
                guard var f = app.find else { return }
                f.query = q
                f.active = 0
                app.find = f
            }), miss: !query.isEmpty && total == 0, onNext: { step(1) }, onPrev: { step(-1) }, onEscape: { app.closeFind() }, register: { app.findField = $0 })
                .padding(.horizontal, 8)
                .frame(width: 176, height: 28)
                .testID("find-input")
            Text(query.isEmpty ? "" : total == 0 ? "No results" : "\((app.find?.active ?? 0) + 1)/\(total)")
                .font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                .lineBox(16.2)
                .frame(minWidth: 56)
                .testID("find-count")
            button("chevron-up", "Previous match") { step(-1) }
            button("chevron-down", "Next match") { step(1) }
            button("x", "Close find", enabled: true) { app.closeFind() }
        }
        .padding(.horizontal, 7).padding(.vertical, 5) // px-1.5 py-1 + the 1px border
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.popover.opacity(0.95)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 7, y: 4)
        .shadow(color: .black.opacity(0.08), radius: 1, y: 1)
        .testID("find-bar")
    }

    private func button(_ icon: String, _ label: String, enabled: Bool? = nil, _ action: @escaping () -> Void) -> some View {
        let on = enabled ?? (total > 0)
        return GhostIconButton(icon: icon, box: 28, glyph: 16, hoverFill: Theme.muted, action: action)
            .help(label)
            .disabled(!on)
            .opacity(on ? 1 : 0.4)
    }

    private func step(_ d: Int) {
        guard var f = app.find, total > 0 else { return }
        f.active = (f.active + d + total) % total
        app.find = f
    }
}

/// A plain NSTextField for the find bar so Enter / Shift+Enter / Esc step and close.
struct FindField: NSViewRepresentable {
    @Binding var text: String
    var miss = false
    let onNext: () -> Void
    let onPrev: () -> Void
    let onEscape: () -> Void
    let register: (NSTextField) -> Void

    func makeNSView(context: Context) -> NSTextField {
        let f = NSTextField()
        f.isBordered = false
        f.drawsBackground = false
        f.focusRingType = .none
        f.placeholderString = "Find in conversation"
        f.font = .systemFont(ofSize: 14)
        f.delegate = context.coordinator
        register(f)
        return f
    }

    func updateNSView(_ f: NSTextField, context: Context) {
        context.coordinator.parent = self
        if f.stringValue != text { f.stringValue = text }
        f.textColor = miss ? NSColor(Theme.destructive) : .labelColor
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: FindField
        init(_ p: FindField) { parent = p }
        func controlTextDidChange(_ n: Notification) {
            if let f = n.object as? NSTextField { parent.text = f.stringValue }
        }
        func control(_ control: NSControl, textView: NSTextView, doCommandBy s: Selector) -> Bool {
            if s == #selector(NSResponder.insertNewline(_:)) {
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { parent.onPrev() } else { parent.onNext() }
                return true
            }
            if s == #selector(NSResponder.cancelOperation(_:)) { parent.onEscape(); return true }
            return false
        }
    }
}
