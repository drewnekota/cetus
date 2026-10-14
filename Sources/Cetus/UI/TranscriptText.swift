import AppKit
import SwiftUI

/// TextKit-backed text that lays out like a CSS block of inline content:
/// every line box is exactly `lineHeight` tall with the primary font's
/// content area centered in it (half-leading), greedy line breaking, and
/// prose inline-code boxes (`px-1 py-0.5 rounded bg-secondary`) painted
/// behind their runs. Selectable; links open on click.
enum ProseKey {
    /// Inline code run: draws the rounded secondary box behind it.
    static let code = NSAttributedString.Key("cetusProseCode")
    /// Find highlight (inactive/active) painted like CSS ::highlight over the content area.
    static let find = NSAttributedString.Key("cetusProseFind")
    /// Mention pill (user prompt `@label`).
    static let mention = NSAttributedString.Key("cetusProseMention")
    /// Italic requested: fallback fonts without an italic face get WebKit's synthetic 14° oblique.
    static let italic = NSAttributedString.Key("cetusProseItalic")
}

/// Line metrics shared by layout and drawing.
struct ProseMetrics: Equatable {
    var lineHeight: CGFloat
    /// Primary font ascent/descent: the CSS content area the half-leading is computed from.
    var ascent: CGFloat
    var descent: CGFloat

    init(font: NSFont, lineHeight: CGFloat) {
        self.lineHeight = lineHeight
        ascent = font.ascender
        descent = -font.descender
    }

    /// Distance from a line box's top to its baseline.
    var baseline: CGFloat { (lineHeight - (ascent + descent)) / 2 + ascent }
}

final class ProseLayoutDelegate: NSObject, NSLayoutManagerDelegate {
    var metrics: ProseMetrics
    init(_ m: ProseMetrics) { metrics = m }

    func layoutManager(_ layoutManager: NSLayoutManager, shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<NSRect>,
                       lineFragmentUsedRect: UnsafeMutablePointer<NSRect>, baselineOffset: UnsafeMutablePointer<CGFloat>,
                       in textContainer: NSTextContainer, forGlyphRange glyphRange: NSRange) -> Bool {
        lineFragmentRect.pointee.size.height = metrics.lineHeight
        lineFragmentUsedRect.pointee.size.height = metrics.lineHeight
        baselineOffset.pointee = metrics.baseline
        return true
    }
}

final class ProseLayoutManager: NSLayoutManager {
    var codeFill: NSColor = NSColor(Theme.secondary)

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let tc = textContainers.first else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        let baseline = (delegate as? ProseLayoutDelegate)?.metrics.baseline ?? 0
        storage.enumerateAttribute(ProseKey.find, in: chars) { value, range, _ in
            guard let color = value as? NSColor else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, lineGlyphs, _ in
                let r = NSIntersectionRange(lineGlyphs, glyphs)
                guard r.length > 0 else { return }
                let b = self.boundingRect(forGlyphRange: r, in: tc)
                let font = storage.attribute(.font, at: self.characterIndexForGlyph(at: r.location), effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: 15)
                let top = rect.minY + baseline - font.ascender
                color.setFill()
                NSRect(x: b.minX + origin.x, y: top + origin.y, width: b.width, height: font.ascender - font.descender).fill()
            }
        }
        storage.enumerateAttribute(ProseKey.code, in: chars) { value, range, _ in
            guard value != nil else { return }
            // Expand to the whole code run so first/last fragments are known.
            var full = NSRange()
            _ = storage.attribute(ProseKey.code, at: range.location, longestEffectiveRange: &full, in: NSRange(location: 0, length: storage.length))
            let glyphs = glyphRange(forCharacterRange: full, actualCharacterRange: nil)
            let font = storage.attribute(.font, at: full.location, effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: 12)
            let mention = storage.attribute(ProseKey.mention, at: full.location, effectiveRange: nil) as? NSColor
            enumerateLineFragments(forGlyphRange: glyphs) { rect, used, _, lineGlyphs, _ in
                let r = NSIntersectionRange(lineGlyphs, glyphs)
                guard r.length > 0 else { return }
                let first = r.location == glyphs.location
                let last = NSMaxRange(r) == NSMaxRange(glyphs)
                let b = self.boundingRect(forGlyphRange: r, in: tc)
                let x0 = first ? b.minX - 4 : b.minX
                let x1 = last ? b.maxX : min(b.maxX, used.maxX)
                let top = rect.minY + baseline - font.ascender - 2
                let bottom = rect.minY + baseline - font.descender + 2
                let box = NSRect(x: x0 + origin.x, y: top + origin.y, width: x1 - x0, height: bottom - top)
                let path = Self.slicedRoundRect(box, radius: mention != nil ? 8 : 4, left: first, right: last)
                self.codeFill.setFill()
                if let mention {
                    mention.setFill()
                }
                path.fill()
                if mention != nil {
                    NSColor(Theme.primary).withAlphaComponent(0.2).setStroke()
                    let ring = Self.slicedRoundRect(box.insetBy(dx: -0.5, dy: -0.5), radius: 8.5, left: first, right: last)
                    ring.lineWidth = 1
                    ring.stroke()
                }
            }
        }
    }

    static func slicedRoundRect(_ r: NSRect, radius: CGFloat, left: Bool, right: Bool) -> NSBezierPath {
        if left && right { return NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius) }
        let p = NSBezierPath()
        let rl = left ? radius : 0, rr = right ? radius : 0
        p.move(to: NSPoint(x: r.minX + rl, y: r.minY))
        p.line(to: NSPoint(x: r.maxX - rr, y: r.minY))
        if rr > 0 { p.appendArc(withCenter: NSPoint(x: r.maxX - rr, y: r.minY + rr), radius: rr, startAngle: 270, endAngle: 360) }
        p.line(to: NSPoint(x: r.maxX, y: r.maxY - rr))
        if rr > 0 { p.appendArc(withCenter: NSPoint(x: r.maxX - rr, y: r.maxY - rr), radius: rr, startAngle: 0, endAngle: 90) }
        p.line(to: NSPoint(x: r.minX + rl, y: r.maxY))
        if rl > 0 { p.appendArc(withCenter: NSPoint(x: r.minX + rl, y: r.maxY - rl), radius: rl, startAngle: 90, endAngle: 180) }
        p.line(to: NSPoint(x: r.minX, y: r.minY + rl))
        if rl > 0 { p.appendArc(withCenter: NSPoint(x: r.minX + rl, y: r.minY + rl), radius: rl, startAngle: 180, endAngle: 270) }
        p.close()
        return p
    }
}

final class ProseTextView: NSTextView {
    var onLink: ((URL) -> Void)?

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }

    // Scrolls go to the transcript, never to this view.
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }

    override func resignFirstResponder() -> Bool {
        setSelectedRange(NSRange(location: 0, length: 0))
        return super.resignFirstResponder()
    }

    override func clicked(onLink link: Any, at charIndex: Int) {
        if let url = link as? URL { onLink?(url) } else if let s = link as? String, let url = URL(string: s) { onLink?(url) }
    }
}

/// Lays text out with a throwaway TextKit stack: size for a given width.
enum ProseMeasure {
    private final class Entry { let size: CGSize; init(_ s: CGSize) { size = s } }
    nonisolated(unsafe) private static let cache = NSCache<NSString, Entry>()
    nonisolated(unsafe) private static var keys: [ObjectIdentifier: Int] = [:]

    static func size(_ text: NSAttributedString, metrics: ProseMetrics, width: CGFloat, id: Int) -> CGSize {
        let key = "\(id)|\(width)|\(metrics.lineHeight)" as NSString
        if let hit = cache.object(forKey: key) { return hit.size }
        let storage = NSTextStorage(attributedString: text)
        let lm = NSLayoutManager()
        let delegate = ProseLayoutDelegate(metrics)
        lm.delegate = delegate
        lm.usesFontLeading = false
        storage.addLayoutManager(lm)
        let tc = NSTextContainer(size: CGSize(width: width, height: .greatestFiniteMagnitude))
        tc.lineFragmentPadding = 0
        lm.addTextContainer(tc)
        lm.ensureLayout(for: tc)
        var lines = 0
        var maxX: CGFloat = 0
        lm.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: lm.numberOfGlyphs)) { _, used, _, glyphs, _ in
            lines += 1
            // Trailing whitespace does not count toward the max-content width.
            var end = NSMaxRange(glyphs)
            let s = storage.string as NSString
            while end > glyphs.location {
                let ci = lm.characterIndexForGlyph(at: end - 1)
                guard ci < s.length, let u = UnicodeScalar(s.character(at: ci)), CharacterSet.whitespacesAndNewlines.contains(u) || u == "\u{2028}" else { break }
                end -= 1
            }
            if end > glyphs.location {
                let b = lm.boundingRect(forGlyphRange: NSRange(location: glyphs.location, length: end - glyphs.location), in: tc)
                maxX = max(maxX, b.maxX)
            }
            _ = used
        }
        if lines == 0 { lines = 1 }
        let size = CGSize(width: maxX, height: CGFloat(lines) * metrics.lineHeight)
        cache.setObject(Entry(size), forKey: key)
        return size
    }
}

/// SwiftUI wrapper. `fit` shrinks the view to its max-content width (CSS `w-fit`).
struct ProseText: NSViewRepresentable {
    let text: NSAttributedString
    let metrics: ProseMetrics
    var fit = false
    var selectable = true
    var firstLineIndent: CGFloat = 0

    fileprivate var id: Int {
        var h = Hasher()
        h.combine(text.string)
        h.combine(firstLineIndent)
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attrs, r, _ in
            h.combine(r.location)
            if let f = attrs[.font] as? NSFont { h.combine(f.fontName); h.combine(f.pointSize) }
            if let k = attrs[.kern] as? CGFloat { h.combine(k) }
        }
        return h.finalize()
    }

    final class Coordinator {
        var lastText: NSAttributedString?
        var delegate = ProseLayoutDelegate(ProseMetrics(font: .systemFont(ofSize: 15), lineHeight: 22.5))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> ProseTextView {
        let storage = NSTextStorage()
        let lm = ProseLayoutManager()
        lm.usesFontLeading = false
        lm.delegate = context.coordinator.delegate
        storage.addLayoutManager(lm)
        let tc = NSTextContainer(size: CGSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        tc.lineFragmentPadding = 0
        tc.widthTracksTextView = true
        lm.addTextContainer(tc)
        let tv = ProseTextView(frame: .zero, textContainer: tc)
        tv.isEditable = false
        tv.isRichText = true
        tv.drawsBackground = false
        tv.textContainerInset = .zero
        tv.isVerticallyResizable = false
        tv.isHorizontallyResizable = false
        tv.linkTextAttributes = [.cursor: NSCursor.pointingHand]
        tv.selectedTextAttributes = [.backgroundColor: NSColor(Theme.primary).withAlphaComponent(0.32)]
        tv.onLink = { url in
            if url.isFileURL || url.scheme == nil { System.open(url.path) } else { NSWorkspace.shared.open(url) }
        }
        return tv
    }

    func updateNSView(_ tv: ProseTextView, context: Context) {
        tv.isSelectable = selectable
        context.coordinator.delegate.metrics = metrics
        let full = withIndent(text)
        if context.coordinator.lastText != full {
            context.coordinator.lastText = full
            tv.textStorage?.setAttributedString(full)
        } else {
            tv.layoutManager?.invalidateLayout(forCharacterRange: NSRange(location: 0, length: tv.textStorage?.length ?? 0), actualCharacterRange: nil)
        }
    }

    /// Height for a width, as the view will lay itself out.
    static func height(_ text: NSAttributedString, metrics: ProseMetrics, width: CGFloat, firstLineIndent: CGFloat = 0) -> CGFloat {
        let v = ProseText(text: text, metrics: metrics, firstLineIndent: firstLineIndent)
        return ProseMeasure.size(v.withIndent(text), metrics: metrics, width: width, id: v.id).height
    }

    /// Max-content width.
    static func width(_ text: NSAttributedString, metrics: ProseMetrics, firstLineIndent: CGFloat = 0) -> CGFloat {
        let v = ProseText(text: text, metrics: metrics, firstLineIndent: firstLineIndent)
        return ProseMeasure.size(v.withIndent(text), metrics: metrics, width: 100_000, id: v.id).width
    }

    fileprivate func withIndent(_ t: NSAttributedString) -> NSAttributedString {
        guard firstLineIndent != 0, t.length > 0 else { return t }
        let m = NSMutableAttributedString(attributedString: t)
        let p = (m.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle ?? NSMutableParagraphStyle()
        p.firstLineHeadIndent = firstLineIndent
        m.addAttribute(.paragraphStyle, value: p, range: NSRange(location: 0, length: m.length))
        return m
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: ProseTextView, context: Context) -> CGSize? {
        let full = withIndent(text)
        // Ideal/min probes (nil, 0, ∞) get the max-content size, never a
        // one-glyph-per-line column that lazy stacks would cache as the row height.
        let avail = proposal.width ?? 100_000
        let w = (avail.isFinite && avail > 1) ? avail : 100_000
        if fit {
            let natural = ProseMeasure.size(full, metrics: metrics, width: 100_000, id: id)
            let width = min(ceil(natural.width * 2) / 2 + 0.01, w)
            let h = ProseMeasure.size(full, metrics: metrics, width: width, id: id).height
            return CGSize(width: width, height: h)
        }
        return CGSize(width: w, height: ProseMeasure.size(full, metrics: metrics, width: w, id: id).height)
    }
}

/// Builds attributed strings with the transcript's paragraph defaults.
enum ProseBuilder {
    /// WebKit lays text out for the document language (`en`): CoreText's
    /// zh/ja CJK–Latin autospacing and punctuation compression stay off.
    static let language = NSAttributedString.Key(kCTLanguageAttributeName as String)

    static func paragraphStyle(align: NSTextAlignment = .natural) -> NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.lineBreakMode = .byWordWrapping
        p.lineBreakStrategy = []
        p.alignment = align
        return p
    }

    struct Fonts {
        var size: CGFloat
        var weight: NSFont.Weight = .regular
        var color: NSColor
        var strongColor: NSColor
        var linkColor: NSColor
        /// Inline code size factor (0.85em, 0.95em in tables).
        var codeScale: CGFloat = 0.85
        var codeColor: NSColor
        var strongWeight: NSFont.Weight = .semibold
        var italic = false
    }

    static func font(_ size: CGFloat, _ weight: NSFont.Weight, italic: Bool = false, mono: Bool = false) -> NSFont {
        var f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
        if italic {
            let d = f.fontDescriptor.withSymbolicTraits(.italic)
            f = NSFont(descriptor: d, size: size) ?? f
        }
        return f
    }

    /// Inline spans → attributed string (inline code gets its box + 4px side padding).
    static func build(_ spans: MDInline, _ f: Fonts, align: NSTextAlignment = .natural, find: [NSRange: NSColor] = [:]) -> (NSAttributedString, startsWithCode: Bool) {
        let out = NSMutableAttributedString()
        let para = paragraphStyle(align: align)
        var startsWithCode = false
        for (k, s) in spans.enumerated() {
            let text = s.style.contains(.code) ? s.text : s.text.replacingOccurrences(of: "\n", with: " ")
            var attrs: [NSAttributedString.Key: Any] = [.paragraphStyle: para, ProseBuilder.language: "en"]
            let bold = s.style.contains(.bold)
            let italic = s.style.contains(.italic) || f.italic
            if s.style.contains(.code) {
                let cs = (f.size * f.codeScale * 1000).rounded() / 1000
                attrs[.font] = font(cs, .semibold, mono: true)
                attrs[.foregroundColor] = f.codeColor
                attrs[ProseKey.code] = 1
            } else {
                var w = bold ? f.strongWeight : f.weight
                if s.link != nil && !bold { w = .medium }
                attrs[.font] = font(f.size, w, italic: italic)
                if italic { attrs[ProseKey.italic] = 1 }
                attrs[.foregroundColor] = bold ? f.strongColor : f.color
            }
            if let link = s.link {
                attrs[.foregroundColor] = f.linkColor
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
                if let url = URL(string: link) ?? URL(string: link.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") {
                    attrs[.link] = url
                }
            }
            if s.style.contains(.strike) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if s.style.contains(.code) {
                if out.length == 0 { if k == 0 { startsWithCode = true } }
                else {
                    // Left padding: widen the preceding character's advance.
                    let prev = (out.attribute(.kern, at: out.length - 1, effectiveRange: nil) as? CGFloat) ?? 0
                    out.addAttribute(.kern, value: prev + 4, range: NSRange(location: out.length - 1, length: 1))
                }
            }
            let piece = NSMutableAttributedString(string: text, attributes: attrs)
            if s.style.contains(.code), piece.length > 0 {
                piece.addAttribute(.kern, value: 4, range: NSRange(location: piece.length - 1, length: 1))
            }
            out.append(piece)
        }
        for (r, c) in find where NSMaxRange(r) <= out.length { out.addAttribute(ProseKey.find, value: c, range: r) }
        fallback(out)
        return (out, startsWithCode)
    }

    /// WebKit-style per-character font fallback: characters the run's font
    /// covers keep it (so `/`, `(` between CJK stay SF), the rest get the
    /// cascade font CoreText picks for them. Pre-assigning stops TextKit's
    /// script-run substitution from pulling neighbouring punctuation into PingFang.
    static func fallback(_ s: NSMutableAttributedString) {
        let str = s.string as NSString
        var fixes: [(NSRange, NSFont)] = []
        let italicRuns = s.length > 0 ? s : nil
        s.enumerateAttribute(.font, in: NSRange(location: 0, length: s.length)) { value, range, _ in
            guard let font = value as? NSFont else { return }
            let ct = font as CTFont
            var i = range.location
            var runStart = -1
            var runFont: NSFont?
            func close(_ end: Int) {
                if runStart >= 0, let f = runFont { fixes.append((NSRange(location: runStart, length: end - runStart), f)) }
                runStart = -1
                runFont = nil
            }
            while i < NSMaxRange(range) {
                let cr = str.rangeOfComposedCharacterSequence(at: i)
                var chars = [UniChar](repeating: 0, count: cr.length)
                str.getCharacters(&chars, range: cr)
                var glyphs = [CGGlyph](repeating: 0, count: cr.length)
                let covered = CTFontGetGlyphsForCharacters(ct, chars, &glyphs, cr.length)
                let ch = chars.first ?? 0
                if covered || ch == 0x2028 || ch == 0x20 {
                    close(cr.location)
                } else {
                    let sub = CTFontCreateForString(ct, str.substring(with: cr) as CFString, CFRange(location: 0, length: cr.length)) as NSFont
                    if runStart >= 0, runFont?.fontName == sub.fontName {} else {
                        close(cr.location)
                        runStart = cr.location
                        runFont = sub
                    }
                }
                i = NSMaxRange(cr)
            }
            close(NSMaxRange(range))
        }
        for (r, f) in fixes {
            s.addAttribute(.font, value: f, range: r)
            // CoreText switches PingFang to its Display cut at ≥20pt; WebKit's advances
            // stay Text-like (measured: +0.0333em per glyph over Display).
            if f.fontName.contains("PingFangUIDisplay") {
                let extra = 0.0333 * f.pointSize
                str.enumerateSubstrings(in: r, options: .byComposedCharacterSequences) { _, cr, _, _ in
                    let at = cr.location + cr.length - 1
                    let k = (s.attribute(.kern, at: at, effectiveRange: nil) as? CGFloat) ?? 0
                    s.addAttribute(.kern, value: k + extra, range: NSRange(location: at, length: 1))
                }
            }
            if italicRuns?.attribute(ProseKey.italic, at: r.location, effectiveRange: nil) != nil, !f.fontDescriptor.symbolicTraits.contains(.italic) {
                s.addAttribute(.obliqueness, value: 0.2493, range: r)
            }
        }
    }
}
