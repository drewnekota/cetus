import AppKit
import SwiftUI

/// Selection that spans the transcript's text views. Every markdown block is
/// its own `ProseTextView`, so a native NSTextView selection stops at the
/// paragraph edge; a drag that starts in transcript prose is tracked here
/// instead, painted with temporary attributes in every view it covers, and
/// copied/quoted as one string (quote-selection.tsx's role in Cetus).
@MainActor
final class TranscriptSelection {
    static let shared = TranscriptSelection()

    private struct Piece {
        weak var view: ProseTextView?
        var range: NSRange
    }

    private var pieces: [Piece] = []
    /// Ordered prose views of the transcript, captured when a drag starts.
    private var views: [ProseTextView] = []
    private var anchor: (view: Int, index: Int) = (0, 0)
    private var toolbar: NSView?
    private var monitor: Any?
    private var scrollObserver: NSObjectProtocol?

    var hasSelection: Bool { !text.isEmpty }

    /// Does this prose view belong to the transcript (vs. a dialog or panel)?
    func owns(_ tv: ProseTextView) -> Bool {
        guard let sv = TranscriptScroller.shared.scrollView, tv.window === sv.window else { return false }
        return tv.isDescendant(of: sv)
    }

    // MARK: Tracking

    /// Runs the drag loop for a plain click in transcript prose.
    func track(_ tv: ProseTextView, _ event: NSEvent) {
        guard let window = tv.window, let sv = TranscriptScroller.shared.scrollView, let root = sv.documentView else { return }
        clear()
        views = Self.collect(root)
        guard let a = views.firstIndex(where: { $0 === tv }) else { return }
        anchor = (a, tv.characterIndexForInsertion(at: tv.convert(event.locationInWindow, from: nil)))
        window.makeFirstResponder(tv)

        let start = event.locationInWindow
        var last = start
        var dragged = false
        NSEvent.startPeriodicEvents(afterDelay: 0.1, withPeriod: 0.05)
        defer { NSEvent.stopPeriodicEvents() }
        while let e = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp, .periodic], until: .distantFuture, inMode: .eventTracking, dequeue: true) {
            if e.type == .leftMouseUp { break }
            if e.type == .leftMouseDragged { last = e.locationInWindow }
            if !dragged {
                guard hypot(last.x - start.x, last.y - start.y) >= 3 else { continue }
                dragged = true
            }
            // Past the transcript's edge: scroll (periodic events keep it going while the mouse rests).
            Self.edgeScroll(sv, last)
            select(to: focus(at: last))
        }
        if dragged { finish() } else { views = [] }
    }

    /// Vertical-only edge scrolling while the pointer is above or below the viewport.
    /// NSClipView.autoscroll nudged the SwiftUI clip view by fractions of a point on
    /// every drag event even with the pointer inside, shaking the whole transcript.
    private static func edgeScroll(_ sv: NSScrollView, _ p: NSPoint) {
        let clip = sv.contentView
        guard let doc = sv.documentView else { return }
        let r = clip.convert(clip.bounds, to: nil)
        // Window coordinates grow upward.
        let over = p.y > r.maxY ? p.y - r.maxY : p.y < r.minY ? p.y - r.minY : 0
        guard over != 0 else { return }
        let step = min(abs(over), 40) * (over > 0 ? -1 : 1) * (clip.isFlipped ? 1 : -1)
        let maxY = max(0, doc.frame.height - clip.bounds.height)
        let y = min(max(clip.bounds.origin.y + step, 0), maxY)
        guard y != clip.bounds.origin.y else { return }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
        sv.reflectScrolledClipView(clip)
    }

    /// Adopt a native selection (double-click word, triple-click paragraph) so it quotes the same way.
    func adoptNative(_ tv: ProseTextView) {
        let r = tv.selectedRange()
        guard r.length > 0 else { return }
        clear()
        tv.setSelectedRange(NSRange(location: r.location, length: 0))
        paint([Piece(view: tv, range: r)])
        finish()
    }

    /// The point's position in document order: the view under it, or the end
    /// of the last view above it when it sits in a gap between blocks.
    private func focus(at p: NSPoint) -> (view: Int, index: Int) {
        guard !views.isEmpty else { return anchor }
        let rects = views.map { $0.convert($0.bounds, to: nil) }
        var best: (Int, CGFloat)?
        for (i, r) in rects.enumerated() where r.minY <= p.y && p.y <= r.maxY {
            let dx = p.x < r.minX ? r.minX - p.x : p.x > r.maxX ? p.x - r.maxX : 0
            if best == nil || dx < best!.1 { best = (i, dx) }
        }
        if let (i, _) = best {
            let v = views[i]
            return (i, v.characterIndexForInsertion(at: v.convert(p, from: nil)))
        }
        // Window coordinates grow upward: views above the point have minY > p.y.
        if let i = rects.lastIndex(where: { $0.minY > p.y }) { return (i, views[i].textStorage?.length ?? 0) }
        return (0, 0)
    }

    private func select(to f: (view: Int, index: Int)) {
        let forward = anchor.view < f.view || (anchor.view == f.view && anchor.index <= f.index)
        let (s, e) = forward ? (anchor, f) : (f, anchor)
        var next: [Piece] = []
        for i in s.view...e.view {
            let len = views[i].textStorage?.length ?? 0
            let lo = i == s.view ? min(s.index, len) : 0
            let hi = i == e.view ? min(e.index, len) : len
            if hi > lo { next.append(Piece(view: views[i], range: NSRange(location: lo, length: hi - lo))) }
        }
        paint(next)
    }

    private func paint(_ next: [Piece]) {
        let color = NSColor(Theme.primary).withAlphaComponent(0.32)
        for p in pieces { p.view.map(Self.unpaint) }
        for p in next {
            guard let v = p.view, let lm = v.layoutManager else { continue }
            lm.addTemporaryAttribute(.backgroundColor, value: color, forCharacterRange: p.range)
        }
        pieces = next
    }

    private static func unpaint(_ v: ProseTextView) {
        v.layoutManager?.removeTemporaryAttribute(.backgroundColor, forCharacterRange: NSRange(location: 0, length: v.textStorage?.length ?? 0))
    }

    private static func collect(_ root: NSView) -> [ProseTextView] {
        var out: [(ProseTextView, CGRect)] = []
        func walk(_ v: NSView) {
            for s in v.subviews where !s.isHidden {
                if let tv = s as? ProseTextView {
                    if tv.isSelectable { out.append((tv, tv.convert(tv.bounds, to: nil))) }
                } else {
                    walk(s)
                }
            }
        }
        walk(root)
        // Reading order: top to bottom (window y grows upward), then left to right (table cells).
        return out.sorted { a, b in
            abs(a.1.maxY - b.1.maxY) > 1 ? a.1.maxY > b.1.maxY : a.1.minX < b.1.minX
        }.map(\.0)
    }

    // MARK: Text

    /// The selected text, blocks separated by newlines (table cells on one row by tabs).
    var text: String {
        var out = ""
        var prev: CGRect?
        for p in pieces {
            guard let v = p.view, let s = v.textStorage?.string as NSString? else { continue }
            let r = NSIntersectionRange(p.range, NSRange(location: 0, length: s.length))
            guard r.length > 0 else { continue }
            let rect = v.convert(v.bounds, to: nil)
            if let prev {
                let sameRow = rect.maxY > prev.minY + 1 && rect.minY < prev.maxY - 1
                out += sameRow ? "\t" : prev.minY - rect.maxY >= 8 ? "\n\n" : "\n"
            }
            out += s.substring(with: r).replacingOccurrences(of: "\u{2028}", with: "\n")
            prev = rect
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Toolbar

    private func finish() {
        views = []
        guard hasSelection else { clear(); return }
        showToolbar()
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .keyDown]) { e in
                MainActor.assumeIsolated {
                    let s = TranscriptSelection.shared
                    if e.type == .keyDown {
                        if e.keyCode == 53 { s.clear() }
                    } else if let t = s.toolbar, t.window === e.window, t.bounds.contains(t.convert(e.locationInWindow, from: nil)) {
                        // Clicks on the toolbar keep the selection.
                    } else {
                        s.clear()
                    }
                }
                return e
            }
        }
    }

    func clear() {
        for p in pieces { p.view.map(Self.unpaint) }
        pieces = []
        toolbar?.removeFromSuperview()
        toolbar = nil
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
        if let o = scrollObserver { NotificationCenter.default.removeObserver(o); scrollObserver = nil }
    }

    func copy() {
        let t = text
        guard !t.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(t, forType: .string)
    }

    private func quote() {
        let t = text
        clear()
        guard !t.isEmpty, let app = AppShell.state else { return }
        app.quoteRequest = (text: t, token: (app.quoteRequest?.token ?? 0) + 1)
    }

    private func showToolbar() {
        guard let sv = TranscriptScroller.shared.scrollView else { return }
        let host = NSHostingView(rootView: QuoteToolbar { [weak self] in self?.quote() })
        host.setFrameSize(host.fittingSize)
        sv.addSubview(host)
        toolbar = host
        place()
        sv.contentView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: sv.contentView, queue: .main) { _ in
            MainActor.assumeIsolated { TranscriptSelection.shared.place() }
        }
    }

    /// Centers the toolbar 8px above the selection's first line; hidden while that line is scrolled out of view.
    private func place() {
        guard let t = toolbar, let sv = t.superview as? NSScrollView, let first = pieces.first, let v = first.view,
              let lm = v.layoutManager, let tc = v.textContainer, v.window != nil else { toolbar?.isHidden = true; return }
        let glyphs = lm.glyphRange(forCharacterRange: first.range, actualCharacterRange: nil)
        var line: NSRect?
        lm.enumerateLineFragments(forGlyphRange: glyphs) { _, _, _, lineGlyphs, stop in
            let r = NSIntersectionRange(lineGlyphs, glyphs)
            if r.length > 0 { line = lm.boundingRect(forGlyphRange: r, in: tc); stop.pointee = true }
        }
        guard var rect = line else { t.isHidden = true; return }
        rect.origin.x += v.textContainerOrigin.x
        rect.origin.y += v.textContainerOrigin.y
        let inScroll = sv.convert(v.convert(rect, to: nil), from: nil)
        let visible = sv.convert(sv.contentView.bounds, from: sv.contentView)
        let top = sv.isFlipped ? inScroll.minY : inScroll.maxY
        let size = t.frame.size
        var x = inScroll.midX - size.width / 2
        x = max(8, min(x, sv.bounds.width - size.width - 8))
        // The hosting view pads the pill by 10 for its shadow.
        var y = sv.isFlipped ? top + 2 - size.height : top - 2
        // Keep it inside the viewport when the first line sits at the top edge (quote-selection: max(8, top - 8)).
        y = sv.isFlipped ? max(y, visible.minY - 2) : min(y, visible.maxY - size.height + 2)
        t.setFrameOrigin(NSPoint(x: x, y: y))
        t.isHidden = !visible.intersects(inScroll)
    }
}

/// "Add to chat" pill: `rounded-full border bg-popover px-1 py-0.5 shadow`.
private struct QuoteToolbar: View {
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Glyph(name: "message-circle", size: 14, color: Theme.foreground)
                Text("Add to chat").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
            }
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Capsule().fill(hover ? Theme.muted : Color.clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .padding(.horizontal, 4).padding(.vertical, 2)
        .background(Capsule().fill(Theme.popover))
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.10), radius: 7, y: 4)
        .padding(10) // room for the shadow inside the hosting view
        .testID("quote-add-to-chat")
    }
}

/// The quote wire format (user-quote.ts / composer-utils.tsx): a leading `>`
/// blockquote the user bubble lifts back out as its quote header.
enum UserQuote {
    static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n?", with: "\n", options: .regularExpression)
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func compose(_ quote: String, _ body: String) -> String {
        guard !quote.isEmpty else { return body }
        let md = quote.components(separatedBy: "\n").map { "> \($0)" }.joined(separator: "\n")
        return body.isEmpty ? md : md + "\n\n" + body
    }

    static func split(_ text: String) -> (quote: String, text: String)? {
        let lines = text.components(separatedBy: "\n")
        var end = 0
        while end < lines.count, lines[end] == ">" || lines[end].hasPrefix("> ") || lines[end].hasPrefix(">\t") { end += 1 }
        guard end > 0 else { return nil }
        let quote = lines[..<end].map { l -> String in
            var s = Substring(l.dropFirst())
            if s.first == " " { s = s.dropFirst() }
            return String(s)
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !quote.isEmpty else { return nil }
        return (quote, lines[end...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
