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
    /// Line metrics of a merged block (`ProseMetricsBox`), overriding the view's own.
    static let metrics = NSAttributedString.Key("cetusProseMetrics")
    /// Collapsed margin above a merged block, on its first character only (CGFloat).
    static let gap = NSAttributedString.Key("cetusProseGap")
    /// List marker drawn left of a merged block's first line (`ProseMarker`).
    static let marker = NSAttributedString.Key("cetusProseMarker")
}

/// Several markdown blocks in one text view: each block carries its own line
/// metrics and the collapsed margin above it as attributes. Values compare by
/// content so an unchanged rebuild doesn't reset the text storage.
final class ProseMetricsBox: NSObject {
    let metrics: ProseMetrics
    init(_ m: ProseMetrics) { metrics = m }
    override func isEqual(_ object: Any?) -> Bool { (object as? ProseMetricsBox)?.metrics == metrics }
    override var hash: Int { metrics.lineHeight.hashValue ^ metrics.ascent.hashValue }
}

/// A list item's marker, drawn in the indent left of its first line like MDBullet / the ordered counter.
final class ProseMarker: NSObject {
    enum Kind: Equatable { case bullet, ordered(String), task(Bool) }
    let kind: Kind
    /// Body size and line height the marker is laid out for.
    let size: CGFloat
    let lineHeight: CGFloat
    /// The list's indent: the marker box spans [textStart - indent, textStart).
    let indent: CGFloat
    /// Ordered counters: the right-aligned number box width (4ch).
    let numberWidth: CGFloat
    init(_ kind: Kind, size: CGFloat, lineHeight: CGFloat, indent: CGFloat, numberWidth: CGFloat = 0) {
        self.kind = kind; self.size = size; self.lineHeight = lineHeight; self.indent = indent; self.numberWidth = numberWidth
    }
    override func isEqual(_ object: Any?) -> Bool {
        guard let o = object as? ProseMarker else { return false }
        return o.kind == kind && o.size == size && o.lineHeight == lineHeight && o.indent == indent && o.numberWidth == numberWidth
    }
    override var hash: Int { size.hashValue ^ indent.hashValue }
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
        var m = metrics
        var gap: CGFloat = 0
        if let storage = layoutManager.textStorage, storage.length > 0 {
            let c = layoutManager.characterIndexForGlyph(at: glyphRange.location)
            if c < storage.length {
                if let box = storage.attribute(ProseKey.metrics, at: c, effectiveRange: nil) as? ProseMetricsBox { m = box.metrics }
                if let g = storage.attribute(ProseKey.gap, at: c, effectiveRange: nil) as? CGFloat { gap = g }
            }
        }
        lineFragmentRect.pointee.size.height = m.lineHeight + gap
        lineFragmentUsedRect.pointee.origin.y = lineFragmentRect.pointee.origin.y + gap
        lineFragmentUsedRect.pointee.size.height = m.lineHeight
        baselineOffset.pointee = gap + m.baseline
        return true
    }
}

final class ProseLayoutManager: NSLayoutManager {
    var codeFill: NSColor = NSColor(Theme.secondary)

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage, let tc = textContainers.first else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        storage.enumerateAttribute(ProseKey.find, in: chars) { value, range, _ in
            guard let color = value as? NSColor else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            enumerateLineFragments(forGlyphRange: glyphs) { rect, _, _, lineGlyphs, _ in
                let r = NSIntersectionRange(lineGlyphs, glyphs)
                guard r.length > 0 else { return }
                let b = self.boundingRect(forGlyphRange: r, in: tc)
                let font = storage.attribute(.font, at: self.characterIndexForGlyph(at: r.location), effectiveRange: nil) as? NSFont ?? NSFont.systemFont(ofSize: 15)
                // Per line: merged blocks have their own line heights and gaps above.
                let baseline = self.location(forGlyphAt: r.location).y
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
                let baseline = self.location(forGlyphAt: r.location).y
                let top = rect.minY + baseline - font.ascender - 2
                let bottom = rect.minY + baseline - font.descender + 2
                let box = NSRect(x: x0 + origin.x, y: top + origin.y, width: x1 - x0, height: bottom - top)
                let path = Self.slicedRoundRect(box, radius: mention != nil ? 6 : 4, left: first, right: last)
                self.codeFill.setFill()
                if let mention {
                    mention.setFill()
                }
                path.fill()
                if mention != nil {
                    NSColor(Theme.primary).withAlphaComponent(0.2).setStroke()
                    let ring = Self.slicedRoundRect(box.insetBy(dx: -0.5, dy: -0.5), radius: 6.5, left: first, right: last)
                    ring.lineWidth = 1
                    ring.stroke()
                }
            }
        }
    }

    /// List markers of merged blocks, positioned like MDBullet / the ordered counter.
    override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: NSPoint) {
        super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage else { return }
        let chars = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
        storage.enumerateAttribute(ProseKey.marker, in: chars) { value, range, _ in
            guard let marker = value as? ProseMarker else { return }
            let g = glyphIndexForCharacter(at: range.location)
            let used = lineFragmentUsedRect(forGlyphAt: g, effectiveRange: nil)
            let para = storage.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle
            let boxX = origin.x + (para?.headIndent ?? 0) - marker.indent
            let top = origin.y + used.minY
            let size = marker.size, lh = marker.lineHeight
            switch marker.kind {
            case .bullet:
                let d = size * 0.3333
                NSColor(Theme.proseBullet).setFill()
                NSBezierPath(ovalIn: NSRect(x: boxX + MDBulletGeometry.dx(size), y: top + MDBulletGeometry.dy(size, lh), width: d, height: d)).fill()
            case .task(let done):
                let r = NSRect(x: boxX + marker.indent - 6 - 13, y: top + (lh - 13) / 2, width: 13, height: 13)
                let fill = NSBezierPath(roundedRect: r, xRadius: 3, yRadius: 3)
                if done { NSColor(Theme.primary).setFill(); fill.fill() }
                NSColor(Theme.mutedForeground).setStroke()
                let ring = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 2.5, yRadius: 2.5)
                ring.lineWidth = 1
                ring.stroke()
            case .ordered(let label):
                let font = NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
                let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(Theme.proseCounter)]
                let w = (label as NSString).size(withAttributes: attrs).width
                let m = ProseMetrics(font: font, lineHeight: lh)
                (label as NSString).draw(at: NSPoint(x: boxX + marker.numberWidth - w, y: top + m.baseline - font.ascender), withAttributes: attrs)
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

    /// Transcript prose selects across blocks (TranscriptSelection); a press on
    /// a link, a double/triple click, or shift-click stays native.
    override func mouseDown(with event: NSEvent) {
        let sel = TranscriptSelection.shared
        guard isSelectable, sel.owns(self) else { super.mouseDown(with: event); return }
        if event.clickCount == 1, !event.modifierFlags.contains(.shift), !onLinkText(event) {
            sel.track(self, event)
            return
        }
        sel.clear()
        super.mouseDown(with: event)
        sel.adoptNative(self)
    }

    private func onLinkText(_ event: NSEvent) -> Bool {
        guard let lm = layoutManager, let tc = textContainer, let storage = textStorage, storage.length > 0 else { return false }
        var p = convert(event.locationInWindow, from: nil)
        p.x -= textContainerOrigin.x
        p.y -= textContainerOrigin.y
        let g = lm.glyphIndex(for: p, in: tc)
        guard lm.boundingRect(forGlyphRange: NSRange(location: g, length: 1), in: tc).contains(p) else { return false }
        return storage.attribute(.link, at: lm.characterIndexForGlyph(at: g), effectiveRange: nil) != nil
    }

    override func copy(_ sender: Any?) {
        if TranscriptSelection.shared.hasSelection { TranscriptSelection.shared.copy() } else { super.copy(sender) }
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(copy(_:)), TranscriptSelection.shared.hasSelection { return true }
        return super.validateUserInterfaceItem(item)
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
        var bottom: CGFloat = 0
        lm.enumerateLineFragments(forGlyphRange: NSRange(location: 0, length: lm.numberOfGlyphs)) { rect, used, _, glyphs, _ in
            lines += 1
            bottom = max(bottom, rect.maxY)
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
        // Merged blocks have their own line heights and gaps: the last line's bottom is the height.
        let size = CGSize(width: maxX, height: lines == 0 ? metrics.lineHeight : bottom)
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
        h.combine(Self.textHash(text))
        h.combine(firstLineIndent)
        return h.finalize()
    }

    /// Per attributed-string instance: layout asks for the size many times per pass, and
    /// hashing the whole text and its attributes each time added up across a transcript.
    nonisolated(unsafe) private static let hashes = NSMapTable<NSAttributedString, NSNumber>(keyOptions: [.weakMemory, .objectPointerPersonality], valueOptions: .strongMemory)

    private static func textHash(_ text: NSAttributedString) -> Int {
        if let hit = hashes.object(forKey: text) { return hit.intValue }
        var h = Hasher()
        h.combine(text.string)
        text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attrs, r, _ in
            h.combine(r.location)
            if let f = attrs[.font] as? NSFont { h.combine(f.fontName); h.combine(f.pointSize) }
            if let k = attrs[.kern] as? CGFloat { h.combine(k) }
            // Merged blocks: their metrics, gaps and indents change the measured height.
            if let m = attrs[ProseKey.metrics] as? ProseMetricsBox { h.combine(m.metrics.lineHeight); h.combine(m.metrics.ascent) }
            if let g = attrs[ProseKey.gap] as? CGFloat { h.combine(g) }
            if let p = attrs[.paragraphStyle] as? NSParagraphStyle, p.headIndent != 0 || p.firstLineHeadIndent != 0 {
                h.combine(p.headIndent); h.combine(p.firstLineHeadIndent)
            }
        }
        let v = h.finalize()
        hashes.setObject(NSNumber(value: v), forKey: text)
        return v
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
        let metricsChanged = context.coordinator.delegate.metrics != metrics
        context.coordinator.delegate.metrics = metrics
        let full = withIndent(text)
        if context.coordinator.lastText != full {
            context.coordinator.lastText = full
            setText(tv, full)
        } else if metricsChanged {
            // Same text: only new line metrics need a relayout (not every SwiftUI update).
            tv.layoutManager?.invalidateLayout(forCharacterRange: NSRange(location: 0, length: tv.textStorage?.length ?? 0), actualCharacterRange: nil)
        }
    }

    /// New text that wraps to another line lands over three layout passes a few ms apart:
    /// the text, then the transcript growing (and following the bottom), then this view's
    /// frame. A frame composited in between showed the wrapped line clipped or a blank
    /// line, so streaming flashed its last line. Take the height the layout is about to
    /// give now (top edge in place) and grow the transcript with it, all in one pass.
    private func setText(_ tv: ProseTextView, _ full: NSAttributedString) {
        tv.textStorage?.setAttributedString(full)
        let w = tv.frame.width
        guard !fit, w > 1 else { return }
        let h = ProseMeasure.size(full, metrics: metrics, width: w, id: id).height
        guard abs(h - tv.frame.height) >= 0.5 else { return }
        let grew = h - tv.frame.height
        var f = tv.frame
        if let sv = tv.superview, !sv.isFlipped { f.origin.y -= grew }
        f.size.height = h
        tv.frame = f
        if grew > 0 { TranscriptScroller.shared.contentGrew(tv, by: grew) }
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
        var buf: [UniChar] = []
        var glyphs: [CGGlyph] = []
        s.enumerateAttribute(.font, in: NSRange(location: 0, length: s.length)) { value, range, _ in
            guard let font = value as? NSFont, range.length > 0 else { return }
            let ct = font as CTFont
            // One lookup for the whole run: when the font covers every character
            // (the usual case) nothing needs a fallback, so skip the per-character walk.
            buf = [UniChar](repeating: 0, count: range.length)
            glyphs = [CGGlyph](repeating: 0, count: range.length)
            str.getCharacters(&buf, range: range)
            if CTFontGetGlyphsForCharacters(ct, buf, &glyphs, range.length) { return }
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
                let covered: Bool, ch: UniChar
                if cr.location >= range.location, NSMaxRange(cr) <= NSMaxRange(range) {
                    let off = cr.location - range.location
                    covered = buf.withUnsafeBufferPointer { b in
                        glyphs.withUnsafeMutableBufferPointer { g in
                            CTFontGetGlyphsForCharacters(ct, b.baseAddress! + off, g.baseAddress! + off, cr.length)
                        }
                    }
                    ch = buf[off]
                } else {
                    // A composed sequence straddling the run edge.
                    var chars = [UniChar](repeating: 0, count: cr.length)
                    str.getCharacters(&chars, range: cr)
                    var gs = [CGGlyph](repeating: 0, count: cr.length)
                    covered = CTFontGetGlyphsForCharacters(ct, chars, &gs, cr.length)
                    ch = chars.first ?? 0
                }
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
