import AppKit
import SwiftUI

/// Finds the NSScrollView hosting the transcript (via a zero-size probe view
/// placed in a row) so tests can drive its scroll offset, and keeps a freshly
/// opened conversation pinned to its bottom while lazy rows settle their heights.
@MainActor
final class TranscriptScroller {
    static let shared = TranscriptScroller()
    weak var scrollView: NSScrollView?
    private var timer: Timer?
    private var commandPath: String?

    private init() {
        if let base = ProcessInfo.processInfo.environment["CETUS_CONTROL"] {
            commandPath = base + ".scroll"
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
                MainActor.assumeIsolated { TranscriptScroller.shared.poll() }
            }
        }
    }

    private var pinUntil: Date = .distantPast
    private var pinTimer: Timer?
    private var liveObserver: NSObjectProtocol?

    /// Set by the transcript: the mounted rows run through the end, so growth at the
    /// bottom is the live tail and following it is wanted.
    var followTail = true
    /// Set by the transcript: points its ScrollPosition at the bottom edge.
    var onFollow: (() -> Void)?
    private var followQueued = false
    /// A jump (turn navigator) took the reader off the tail: no following until they're
    /// back at the bottom. Queued ScrollPosition syncs from before the jump are dropped.
    private var detached = false
    private var detachedAt = Date.distantPast
    private var followGen = 0

    /// Bumped by each jump and by any live scroll, so a jump's follow-up re-aims stop
    /// once something newer moves the transcript.
    private(set) var jumpGen = 0

    func detach() {
        jumpGen += 1
        detached = true
        detachedAt = Date()
        followGen += 1
        pinUntil = .distantPast
    }

    /// Called with the distance from the bottom on every scroll change. Ignores the
    /// first moments after a jump, while the target scroll is still landing.
    func reattach(fromBottom: Double) {
        guard detached, fromBottom < 1, Date().timeIntervalSince(detachedAt) > 0.5 else { return }
        detached = false
    }
    private var liveScrolling = false
    private var endObserver: NSObjectProtocol?
    private var docObserver: NSObjectProtocol?
    private var docHeight: CGFloat = 0

    func register(_ sv: NSScrollView) {
        guard scrollView !== sv else { return }
        scrollView = sv
        for o in [liveObserver, endObserver, docObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(o) }
        // A user gesture ends the open-time pin.
        liveObserver = NotificationCenter.default.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: sv, queue: .main) { _ in
            MainActor.assumeIsolated {
                TranscriptScroller.shared.pinUntil = .distantPast
                TranscriptScroller.shared.liveScrolling = true
                TranscriptScroller.shared.jumpGen += 1
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: sv, queue: .main) { _ in
            MainActor.assumeIsolated { TranscriptScroller.shared.liveScrolling = false }
        }
        guard let doc = sv.documentView else { return }
        docHeight = doc.frame.height
        doc.postsFrameChangedNotifications = true
        // Posted synchronously inside the layout pass that resized the content, so
        // following here lands before the frame draws. Scrolling only when the height
        // changed (not on every streamed token) keeps the offset from re-rounding to a
        // different sub-pixel each time under zoom's scaleEffect, which shimmered the transcript.
        docObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: doc, queue: nil) { _ in
            MainActor.assumeIsolated { TranscriptScroller.shared.documentResized() }
        }
    }

    /// A prose view inside the transcript just grew by `dh` ahead of SwiftUI's layout:
    /// while following the bottom, grow the document by as much now so the follow scroll
    /// lands in the same pass. SwiftUI's next layout sets its own (equal or sub-point
    /// different) height.
    func contentGrew(_ v: NSView, by dh: CGFloat) {
        guard followTail, !detached, !liveScrolling, let sv = scrollView, let doc = sv.documentView,
              offset >= maxOffset - 1, v.isDescendant(of: doc) else { return }
        doc.setFrameSize(NSSize(width: doc.frame.width, height: doc.frame.height + dh))
    }

    private func documentResized() {
        guard let sv = scrollView, let doc = sv.documentView else { return }
        let h = doc.frame.height, old = docHeight
        docHeight = h
        guard h != old, followTail, !detached, !liveScrolling else { return }
        let wasFromBottom = max(0, old - sv.contentView.bounds.height) - offset
        guard wasFromBottom < 60 else { return }
        if offset < maxOffset - 0.5 { scroll(to: .greatestFiniteMagnitude) }
        // Tell SwiftUI too: its ScrollPosition otherwise keeps the last point it scrolled to
        // itself and restores it on a later layout change, yanking the transcript back up.
        if !followQueued {
            followQueued = true
            let gen = followGen
            DispatchQueue.main.async {
                let s = TranscriptScroller.shared
                s.followQueued = false
                if gen == s.followGen { s.onFollow?() }
            }
        }
    }

    /// Keep the transcript at its bottom while lazy rows replace their
    /// estimated heights (Cetus: virtualizer.scrollToIndex(last, end) on open).
    func pinBottom(for seconds: Double = 1.2) {
        if ProcessInfo.processInfo.environment["CETUS_TR_NOPIN"] != nil { return }
        pinUntil = Date().addingTimeInterval(seconds)
        pinTimer?.invalidate()
        pinTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { t in
            MainActor.assumeIsolated {
                let s = TranscriptScroller.shared
                guard Date() < s.pinUntil else { t.invalidate(); return }
                if s.offset < s.maxOffset - 0.5 { s.scroll(to: .greatestFiniteMagnitude) }
            }
        }
    }

    /// Inside the open-time pin (a user scroll ends it early).
    var pinned: Bool { Date() < pinUntil }

    /// Test hook: `echo top > $CETUS_CONTROL.scroll` (also `bottom`, `y <px>`, `by <px>`).
    private func poll() {
        guard let path = commandPath, let s = try? String(contentsOfFile: path, encoding: .utf8) else { return }
        try? FileManager.default.removeItem(atPath: path)
        let parts = s.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
        guard let cmd = parts.first else { return }
        switch cmd {
        case "top": scroll(to: 0)
        case "bottom": scroll(to: .greatestFiniteMagnitude)
        case "y": scroll(to: Double(parts.count > 1 ? parts[1] : "0") ?? 0)
        case "by": scroll(to: offset + (Double(parts.count > 1 ? parts[1] : "0") ?? 0))
        default: break
        }
        let line = "offset \(offset) max \(maxOffset) frame \(scrollView?.frame.size ?? .zero) doc \(scrollView?.documentView?.frame.size ?? .zero)\n"
        try? line.write(toFile: path + ".out", atomically: true, encoding: .utf8)
    }

    var offset: Double { Double(scrollView?.contentView.bounds.origin.y ?? 0) }
    var maxOffset: Double {
        guard let sv = scrollView, let doc = sv.documentView else { return 0 }
        return max(0, Double(doc.frame.height - sv.contentView.bounds.height))
    }

    func scroll(to y: Double) {
        guard let sv = scrollView else { return }
        let target = min(max(0, y), maxOffset)
        sv.contentView.scroll(to: NSPoint(x: sv.contentView.bounds.origin.x, y: target))
        sv.reflectScrolledClipView(sv.contentView)
    }
}

/// Zero-size view that registers its enclosing scroll view with `TranscriptScroller`.
struct TranscriptScrollProbe: NSViewRepresentable {
    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in
                // Outermost scroller: rows also contain horizontal/inner scroll views.
                guard var sv = self?.enclosingScrollView else { return }
                while let outer = sv.superview?.enclosingScrollView { sv = outer }
                MainActor.assumeIsolated { TranscriptScroller.shared.register(sv) }
            }
        }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ nsView: Probe, context: Context) {}
}

/// TanStack Virtual measures each transcript row with `Math.round(blockSize)`
/// and stacks rows at those rounded offsets; rows report the same rounded height.
struct TranscriptRowRounding: Layout {
    /// The row's measured size per proposed width: placing it reuses the measurement
    /// instead of laying the whole row out a second time. Reset when the row changes.
    final class Sizes { var byWidth: [CGFloat: CGSize] = [:] }
    func makeCache(subviews: Subviews) -> Sizes { Sizes() }

    private func measure(_ v: LayoutSubview, width: CGFloat?, _ cache: Sizes) -> CGSize {
        if let w = width, let hit = cache.byWidth[w] { return hit }
        let s = v.sizeThatFits(ProposedViewSize(width: width, height: nil))
        if let w = width { cache.byWidth[w] = s }
        return s
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Sizes) -> CGSize {
        guard let v = subviews.first else { return .zero }
        let s = proposal.height == nil ? measure(v, width: proposal.width, cache) : v.sizeThatFits(proposal)
        return CGSize(width: s.width, height: (s.height).rounded(.toNearestOrAwayFromZero))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Sizes) {
        guard let v = subviews.first else { return }
        let s = measure(v, width: bounds.width, cache)
        v.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: s.height))
    }
}

extension View {
    func transcriptRow() -> some View { TranscriptRowRounding { self } }
}
