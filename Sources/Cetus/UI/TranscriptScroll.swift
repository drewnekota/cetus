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

    func register(_ sv: NSScrollView) {
        guard scrollView !== sv else { return }
        scrollView = sv
        if let o = liveObserver { NotificationCenter.default.removeObserver(o) }
        // A user gesture ends the open-time pin.
        liveObserver = NotificationCenter.default.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: sv, queue: .main) { _ in
            MainActor.assumeIsolated { TranscriptScroller.shared.pinUntil = .distantPast }
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
