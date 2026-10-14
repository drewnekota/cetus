import AppKit
import SwiftUI

/// Assistant markdown, laid out like Cetus's `prose prose-sm text-base!`
/// column: block margins collapse like CSS, every text leaf is a `ProseText`
/// (exact line boxes, inline-code chips), lists/tables/code follow the
/// Tailwind Typography metrics measured from the Tauri app.

/// Tailwind Typography metrics for the given base size.
enum Prose {
    /// SwiftUI lineSpacing that yields a CSS line-height of `lh` px for a font of `size`.
    static func spacing(_ size: CGFloat, _ lh: CGFloat, weight: NSFont.Weight = .regular, mono: Bool = false) -> CGFloat {
        let f = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
        return max(0, lh - NSLayoutManager().defaultLineHeight(for: f))
    }
}

extension MDNode {
    /// Text leaves in render order (find units).
    var leaves: [String] {
        switch self {
        case .paragraph(let a), .heading(_, let a): return [a.plain]
        case .code(_, let s): return [s]
        case .rule: return []
        case .quote(let c): return c.flatMap(\.leaves)
        case .list(_, _, _, let items): return items.flatMap { $0.blocks.flatMap(\.leaves) }
        case .table(let head, let rows, _): return head.map(\.plain) + rows.flatMap { $0.map(\.plain) }
        }
    }
}

enum MarkdownParser {
    /// Plain text per find unit, in document order.
    static func searchable(_ text: String) -> [String] { MDParser.parse(text).flatMap(\.leaves) }
}

/// Where a rendered block sits in the prose flow: its CSS margins (collapsed with neighbours).
private struct MDBox {
    var view: AnyView
    var top: CGFloat
    var bottom: CGFloat
    /// Descendant margins that collapse through this box (its own margin excluded).
    var innerTop: CGFloat = 0
    var innerBottom: CGFloat = 0
}

private final class MDCounter { var n = 0 }

struct MarkdownView: View {
    let text: String
    /// Prefix of the text units' find ids ("<message>:<block>").
    var unit: String = ""
    /// 15 in chat (`text-base!`), 14 in the file preview (prose-sm).
    var baseSize: CGFloat = 15
    /// Overrides the prose body color (muted narration rows).
    var bodyColor: Color? = nil
    @Environment(\.findHighlight) private var find
    @Environment(\.fontScale) private var scale
    @Environment(\.lineScale) private var lineScale

    var body: some View {
        let nodes = MDParser.parse(text)
        let counter = MDCounter()
        let boxes = nodes.map { box($0, counter: counter, tight: false) }
        // `[&>*:first-child]:mt-0 [&>*:last-child]:mb-0` trims the outer children's own
        // margins, but the prose div is a BFC (overflow-x-hidden): margins collapsing
        // up from inside them (a quote's p, a list's li) stay inside it.
        return MDStack(boxes: boxes).view
            .padding(.top, boxes.first?.innerTop ?? 0)
            .padding(.bottom, boxes.last?.innerBottom ?? 0)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Metrics

    private var size: CGFloat { (baseSize * scale).rounded() }
    private var lh: CGFloat { size * 1.5 * lineScale }
    private var body_: NSColor { bodyColor.map { NSColor($0) } ?? NSColor(Theme.proseBody) }
    private var heading: NSColor { bodyColor.map { NSColor($0) } ?? NSColor(Theme.proseHeading) }
    private var strong: NSColor { bodyColor.map { NSColor($0) } ?? NSColor(Theme.proseHeading) }

    private func fonts(size s: CGFloat? = nil, weight: NSFont.Weight = .regular, color: NSColor? = nil, codeScale: CGFloat = 0.85, italic: Bool = false) -> ProseBuilder.Fonts {
        let c = color ?? body_
        return ProseBuilder.Fonts(size: s ?? size, weight: weight, color: c, strongColor: color ?? strong, linkColor: color ?? heading,
                                  codeScale: codeScale, codeColor: color ?? heading, italic: italic)
    }

    private func findRanges(_ plain: String, unit u: String) -> [NSRange: NSColor] {
        guard let find, !find.query.isEmpty, let base = find.offsets[u] else { return [:] }
        var out: [NSRange: NSColor] = [:]
        for (i, r) in FindHighlight.ranges(plain, find.query).enumerated() {
            let ns = NSRange(r, in: plain)
            out[ns] = base + i == find.active ? NSColor(Theme.primary).withAlphaComponent(0.55) : NSColor(Theme.foreground).withAlphaComponent(0.18)
        }
        return out
    }

    private func leaf(_ spans: MDInline, _ f: ProseBuilder.Fonts, lineHeight: CGFloat, counter: MDCounter, align: NSTextAlignment = .natural) -> AnyView {
        let u = "\(unit):\(counter.n)"
        counter.n += 1
        let (attr, startsWithCode) = ProseBuilder.build(spans, f, align: align, find: findRanges(spans.plain.replacingOccurrences(of: "\n", with: " "), unit: u))
        let primary = ProseBuilder.font(f.size, f.weight)
        return AnyView(ProseText(text: attr, metrics: ProseMetrics(font: primary, lineHeight: lineHeight), firstLineIndent: startsWithCode ? 4 : 0))
    }

    // MARK: Blocks

    private func box(_ node: MDNode, counter: MDCounter, tight: Bool) -> MDBox {
        switch node {
        case .paragraph(let a):
            let v = leaf(a, fonts(), lineHeight: lh, counter: counter)
            return MDBox(view: v, top: tight ? 0 : 8, bottom: tight ? 0 : 8)
        case .heading(let level, let a):
            let (k, w, l): (CGFloat, NSFont.Weight, CGFloat) = switch level {
            case 1: (2.1428571, .heavy, 1.2)
            case 2: (1.4285714, .bold, 1.4)
            case 3: (1.2857143, .semibold, 1.5555556)
            case 4: (1, .semibold, 1.4285714)
            case 5: (0.83, .bold, 1.5)
            default: (0.67, .bold, 1.5)
            }
            let fs = size * k
            var f = fonts(size: fs, weight: w, color: heading)
            f.strongWeight = w == .semibold ? .semibold : .bold
            if level >= 5 { f = fonts(size: fs, weight: w, color: body_) }
            let v = leaf(a, f, lineHeight: level >= 5 ? lh : fs * l * lineScale, counter: counter)
            return MDBox(view: v, top: 12, bottom: 12)
        case .code(let lang, let code):
            let u = "\(unit):\(counter.n)"
            counter.n += 1
            return MDBox(view: AnyView(CodeBlockView(code: code, language: lang, unit: u, baseSize: size)), top: 8, bottom: 8)
        case .rule:
            return MDBox(view: AnyView(Rectangle().fill(Theme.proseRule).frame(height: 1)), top: size * 2.8571429, bottom: size * 2.8571429)
        case .quote(let children):
            // prose adds “ ” around the quote (p:first-of-type::before / last-of-type::after).
            let paras = children.indices.filter { if case .paragraph = children[$0] { return true }; return false }
            var quoted = children
            if let f = paras.first, case .paragraph(var a) = quoted[f] { a.insert(MDSpan(text: "“"), at: 0); quoted[f] = .paragraph(a) }
            if let l = paras.last, case .paragraph(var a) = quoted[l] { a.append(MDSpan(text: "”")); quoted[l] = .paragraph(a) }
            let inner = MDStack(boxes: quoted.map { quoteBox($0, counter: counter) })
            let v = inner.view
                .padding(.leading, 4 + size * 1.1111111)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.proseRule).frame(width: 4) }
            // blockquote has no vertical padding: child margins collapse through it.
            return MDBox(view: AnyView(v), top: max(size * 1.3333333, inner.top), bottom: max(size * 1.3333333, inner.bottom),
                         innerTop: inner.top, innerBottom: inner.bottom)
        case .list(let ordered, let start, let loose, let items):
            return listBox(ordered: ordered, start: start, loose: loose, items: items, counter: counter)
        case .table(let head, let rows, let align):
            let u = "\(unit):"
            let first = counter.n
            counter.n += head.count + rows.reduce(0) { $0 + $1.count }
            let v = MDTable(head: head, rows: rows, align: align, size: size, unitPrefix: u, firstUnit: first, find: find,
                            bodyColor: body_, heading: heading)
            return MDBox(view: AnyView(v), top: 8, bottom: 8)
        }
    }

    /// Blockquote paragraphs: `font-medium italic text-quotes`.
    private func quoteBox(_ node: MDNode, counter: MDCounter) -> MDBox {
        if case .paragraph(let a) = node {
            let c = NSColor(Theme.proseQuote)
            var f = fonts(weight: .medium, color: c, italic: true)
            f.strongWeight = .semibold
            return MDBox(view: leaf(a, f, lineHeight: lh, counter: counter), top: 8, bottom: 8)
        }
        return box(node, counter: counter, tight: false)
    }

    private func listBox(ordered: Bool, start: Int, loose: Bool, items: [MDItem], counter: MDCounter) -> MDBox {
        let liMargin = size * 0.2857143
        let ch = ("0" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size)]).width
        let indent = ordered ? 4 * ch + size * 0.75 : size * 2.25 + size * 0.4285714
        var itemBoxes: [MDBox] = []
        for (k, item) in items.enumerated() {
            let inner = MDStack(boxes: item.blocks.map { box($0, counter: counter, tight: !loose) })
            let marker: AnyView
            if ordered {
                marker = AnyView(
                    Text("\(start + k).")
                        .font(.system(size: size).monospacedDigit())
                        .foregroundStyle(Theme.proseCounter)
                        .frame(width: 4 * ch, height: lh, alignment: .trailing)
                )
            } else {
                marker = AnyView(MDBullet(size: size, lineHeight: lh, task: item.task))
            }
            let row = HStack(alignment: .top, spacing: 0) {
                marker.frame(width: ordered ? 4 * ch : size * 2.25 + size * 0.4285714, alignment: ordered ? .leading : .leading)
                    .padding(.trailing, ordered ? indent - 4 * ch : 0)
                inner.view.frame(maxWidth: .infinity, alignment: .leading)
            }
            _ = indent
            itemBoxes.append(MDBox(view: AnyView(row), top: max(liMargin, inner.top), bottom: max(liMargin, inner.bottom)))
        }
        let stack = MDStack(boxes: itemBoxes)
        return MDBox(view: stack.view, top: max(8, stack.top), bottom: max(8, stack.bottom), innerTop: stack.top, innerBottom: stack.bottom)
    }
}

/// Stacks boxes with collapsed margins; exposes its own outer margins (which
/// collapse through the parent, as nothing pads the containers).
private struct MDStack {
    let boxes: [MDBox]
    var top: CGFloat { boxes.first?.top ?? 0 }
    var bottom: CGFloat { boxes.last?.bottom ?? 0 }
    var view: AnyView {
        AnyView(
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(boxes.enumerated()), id: \.offset) { i, b in
                    b.view.padding(.top, i == 0 ? 0 : max(boxes[i - 1].bottom, b.top))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        )
    }
}

/// `list-style: disc` marker in `--tw-prose-bullets`, or a GFM task checkbox.
private struct MDBullet: View {
    let size: CGFloat
    let lineHeight: CGFloat
    let task: Bool?
    var body: some View {
        if let task {
            RoundedRectangle(cornerRadius: 3)
                .strokeBorder(Theme.mutedForeground, lineWidth: 1)
                .background(RoundedRectangle(cornerRadius: 3).fill(task ? Theme.primary : .clear))
                .frame(width: 13, height: 13)
                .frame(maxWidth: .infinity, maxHeight: lineHeight, alignment: .trailing)
                .padding(.trailing, 6)
        } else {
            // WebKit's disc: ~0.33em circle, its center on the x-height middle, right edge 0.5em before the text box.
            Circle().fill(Theme.proseBullet)
                .frame(width: size * 0.3333, height: size * 0.3333)
                .offset(x: MDBullet.dx(size), y: MDBullet.dy(size, lineHeight))
                .frame(maxWidth: .infinity, maxHeight: lineHeight, alignment: .topLeading)
        }
    }
    /// Measured against WebKit: disc center 19.4px (at 15px) left of the li's text start (2.25em + 0.4286em).
    static func dx(_ size: CGFloat) -> CGFloat { size * 1.1267 }
    static func dy(_ size: CGFloat, _ lh: CGFloat) -> CGFloat {
        let m = ProseMetrics(font: .systemFont(ofSize: size), lineHeight: lh)
        let xMid = m.baseline - NSFont.systemFont(ofSize: size).xHeight / 2
        return xMid - size * 0.3333 / 2 - 0.5
    }
}

/// GFM table: `width: 100%`, CSS auto layout, `py-2` cells with 1em inner
/// gutters (none on the outer edges), th/td at the body size, header rule
/// in th-borders and row rules in td-borders.
private struct MDTable: View {
    let head: [MDInline]
    let rows: [[MDInline]]
    let align: [MDAlign]
    let size: CGFloat
    let unitPrefix: String
    let firstUnit: Int
    let find: FindHighlight?
    let bodyColor: NSColor
    let heading: NSColor
    @Environment(\.lineScale) private var lineScale

    private var lh: CGFloat { size * 1.5 * lineScale }

    private func attr(_ spans: MDInline, header: Bool, unit: Int) -> (NSAttributedString, Bool) {
        let f = ProseBuilder.Fonts(size: size, weight: header ? .semibold : .regular, color: header ? heading : bodyColor, strongColor: heading,
                                   linkColor: heading, codeScale: 0.95, codeColor: heading)
        let plain = spans.plain.replacingOccurrences(of: "\n", with: " ")
        var ranges: [NSRange: NSColor] = [:]
        if let find, !find.query.isEmpty, let base = find.offsets["\(unitPrefix)\(unit)"] {
            for (i, r) in FindHighlight.ranges(plain, find.query).enumerated() {
                ranges[NSRange(r, in: plain)] = base + i == find.active ? NSColor(Theme.primary).withAlphaComponent(0.55) : NSColor(Theme.foreground).withAlphaComponent(0.18)
            }
        }
        let alignment: NSTextAlignment = .natural
        return ProseBuilder.build(spans, f, align: alignment, find: ranges)
    }

    private func pad(_ c: Int, _ cols: Int) -> (CGFloat, CGFloat) {
        (c == 0 ? 0 : size, c == cols - 1 ? 0 : size)
    }

    var body: some View {
        MDHeightLayout(height: tableHeight(width:)) {
            GeometryReader { geo in content(width: geo.size.width) }
        }
    }

    private var cells: [[(NSAttributedString, Bool)]] {
        var unit = firstUnit
        var out: [[(NSAttributedString, Bool)]] = []
        out.append(head.map { let a = attr($0, header: true, unit: unit); unit += 1; return a })
        for r in rows { out.append(r.map { let a = attr($0, header: false, unit: unit); unit += 1; return a }) }
        return out
    }

    private func metrics(header: Bool) -> ProseMetrics {
        ProseMetrics(font: .systemFont(ofSize: size, weight: header ? .semibold : .regular), lineHeight: lh)
    }

    /// CSS auto table layout with `width: 100%`.
    private func columnWidths(_ width: CGFloat, _ cells: [[(NSAttributedString, Bool)]]) -> [CGFloat] {
        let cols = align.count
        var minW = Array(repeating: CGFloat(0), count: cols)
        var maxW = Array(repeating: CGFloat(0), count: cols)
        for (r, row) in cells.enumerated() {
            for (c, cell) in row.enumerated() where c < cols {
                let (l, t) = pad(c, cols)
                let m = metrics(header: r == 0)
                let indent: CGFloat = cell.1 ? 4 : 0
                let mx = ProseText.width(cell.0, metrics: m, firstLineIndent: indent)
                let mn = MDTable.minContent(cell.0) + indent
                maxW[c] = max(maxW[c], ceil(mx * 64) / 64 + l + t)
                minW[c] = max(minW[c], ceil(mn * 64) / 64 + l + t)
            }
        }
        let sumMax = maxW.reduce(0, +), sumMin = minW.reduce(0, +)
        if ProcessInfo.processInfo.environment["CETUS_TR_DEBUG"] != nil { FileHandle.standardError.write("table w=\(width) min=\(minW) max=\(maxW)\n".data(using: .utf8)!) }
        if sumMax <= width {
            guard sumMax > 0 else { return Array(repeating: width / CGFloat(max(cols, 1)), count: cols) }
            return maxW.map { $0 + (width - sumMax) * $0 / sumMax }
        }
        if sumMin >= width { return minW }
        let span = sumMax - sumMin
        return zip(minW, maxW).map { mn, mx in mn + (width - sumMin) * (span > 0 ? (mx - mn) / span : 0) }
    }

    /// Widest unbreakable segment (CSS min-content).
    static func minContent(_ s: NSAttributedString) -> CGFloat {
        let full = NSRange(location: 0, length: s.length)
        guard s.length > 0 else { return 0 }
        var breaks: [Int] = [s.length]
        var i = s.length
        while i > 0 {
            let j = s.lineBreak(before: i, within: full)
            if j == NSNotFound || j <= 0 || j >= i { break }
            breaks.append(j)
            i = j
        }
        breaks.append(0)
        breaks.sort()
        var best: CGFloat = 0
        let str = s.string as NSString
        for k in 0 ..< breaks.count - 1 {
            var a = breaks[k], b = breaks[k + 1]
            while b > a, let u = UnicodeScalar(str.character(at: b - 1)), CharacterSet.whitespaces.contains(u) { b -= 1 }
            while a < b, let u = UnicodeScalar(str.character(at: a)), CharacterSet.whitespaces.contains(u) { a += 1 }
            guard b > a else { continue }
            let w = s.attributedSubstring(from: NSRange(location: a, length: b - a)).boundingRect(with: CGSize(width: 100_000, height: 100_000), options: [.usesLineFragmentOrigin]).width
            best = max(best, w)
        }
        return best
    }

    private func rowHeights(_ widths: [CGFloat], _ cells: [[(NSAttributedString, Bool)]]) -> [CGFloat] {
        cells.enumerated().map { r, row in
            row.enumerated().map { c, cell -> CGFloat in
                guard c < widths.count else { return 0 }
                let (l, t) = pad(c, widths.count)
                return ProseText.height(cell.0, metrics: metrics(header: r == 0), width: max(1, widths[c] - l - t), firstLineIndent: cell.1 ? 4 : 0)
            }.max() ?? lh
        }
    }

    private func tableHeight(width: CGFloat) -> CGFloat {
        let cs = cells
        let w = columnWidths(width, cs)
        let h = rowHeights(w, cs)
        return h.reduce(0) { $0 + $1 + 16 } + CGFloat(max(0, cs.count - 1))
    }

    private func content(width: CGFloat) -> some View {
        let cs = cells
        let widths = columnWidths(width, cs)
        let heights = rowHeights(widths, cs)
        return ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(cs.enumerated()), id: \.offset) { r, row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { c, cell in
                            if c < widths.count {
                                let (l, t) = pad(c, widths.count)
                                ProseText(text: cell.0, metrics: metrics(header: r == 0), firstLineIndent: cell.1 ? 4 : 0)
                                    .frame(width: max(1, widths[c] - l - t), height: heights[r], alignment: r == 0 ? .bottomLeading : .topLeading)
                                    .padding(.leading, l)
                                    .padding(.trailing, t)
                            }
                        }
                    }
                    .padding(.vertical, 8)
                    if r < cs.count - 1 {
                        Rectangle().fill(r == 0 ? Theme.proseThRule : Theme.proseRule)
                            .frame(width: widths.reduce(0, +), height: 1)
                    }
                }
            }
        }
        .scrollDisabled(widths.reduce(0, +) <= width + 0.5)
    }
}

/// Takes the proposed width and a height computed for it (no GeometryReader lag).
private struct MDHeightLayout: Layout {
    let height: (CGFloat) -> CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 676
        return CGSize(width: w, height: height(w))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for v in subviews { v.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size)) }
    }
}

/// Fenced code (`CopyablePre`): `bg-secondary` pre, 4px radius, 0.857em mono,
/// line-height 1.667, padding 0.667em/1em with pr-16, and an always-visible
/// Copy chip (`h-6 rounded-md border bg-background shadow-sm`) at top-1.5 right-1.5.
struct CodeBlockView: View {
    let code: String
    let language: String?
    var unit: String = ""
    var maxHeight: CGFloat? = nil
    /// Chat code blocks aren't highlighted in Cetus; file reads are.
    var highlight = false
    var baseSize: CGFloat = 15
    @Environment(\.findHighlight) private var find
    @State private var copied = false

    private var preSize: CGFloat { baseSize * 0.8571429 }
    private var fs: CGFloat { preSize * 0.85 }
    @Environment(\.lineScale) private var lineScale
    private var lineHeight: CGFloat { preSize * 1.6666667 * lineScale }

    var body: some View {
        // `pre code`: 0.85em of the pre (10.93px) regular mono, inline (px-1) on the pre's 1.667 strut.
        let attr = NSMutableAttributedString(string: code, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: fs, weight: .regular),
            .foregroundColor: NSColor(Theme.foreground),
            ProseBuilder.language: "en",
            .paragraphStyle: { let p = NSMutableParagraphStyle(); p.lineBreakMode = .byClipping; return p }(),
        ])
        if let find, !find.query.isEmpty, let base = find.offsets[unit] {
            for (i, r) in FindHighlight.ranges(code, find.query).enumerated() {
                attr.addAttribute(ProseKey.find, value: base + i == find.active ? NSColor(Theme.primary).withAlphaComponent(0.55) : NSColor(Theme.foreground).withAlphaComponent(0.18), range: NSRange(r, in: code))
            }
        }
        ProseBuilder.fallback(attr)
        let m = ProseMetrics(font: .monospacedSystemFont(ofSize: preSize, weight: .regular), lineHeight: lineHeight)
        return ScrollView(.horizontal, showsIndicators: false) {
            ProseText(text: attr, metrics: m, fit: true)
                .padding(.leading, preSize + 4)
                .padding(.trailing, 64 + 4)
                .padding(.vertical, preSize * 0.6666667)
        }
        .frame(maxHeight: maxHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.secondary))
        .overlay(alignment: .topTrailing) {
            Button {
                System.copy(code)
                copied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
            } label: {
                CodeCopyChip(copied: copied)
            }
            .buttonStyle(.plain)
            .padding(6)
        }
    }
}

/// `h-6 rounded-md border border-border/60 bg-background px-1.5 text-xs text-muted-foreground shadow-sm`, hover text-foreground.
private struct CodeCopyChip: View {
    let copied: Bool
    @State private var hover = false
    var body: some View {
        let c = hover ? Theme.foreground : Theme.mutedForeground
        HStack(spacing: 4) {
            Glyph(name: copied ? "check" : "copy", size: 12, color: c)
            Text(copied ? "Copied" : "Copy").font(.system(size: 12)).foregroundStyle(c).lineBox(16.1875)
        }
        .padding(.horizontal, 7)
        .frame(height: 24)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
        .shadow(color: .black.opacity(0.1), radius: 1.5, y: 1)
        .shadow(color: .black.opacity(0.1), radius: 1, y: 1)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
    }
}

/// Find highlighting: the query and which global match is active. `offsets`
/// gives each text unit its first match index so highlights line up with the counter.
struct FindHighlight: Equatable {
    var query: String
    var active: Int
    var offsets: [String: Int]

    static func ranges(_ text: String, _ query: String) -> [Range<String.Index>] {
        guard !query.isEmpty else { return [] }
        var out: [Range<String.Index>] = []
        var from = text.startIndex
        while let r = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive], range: from ..< text.endIndex) {
            out.append(r)
            from = r.upperBound
        }
        return out
    }

    func apply(_ attr: AttributedString, unit: String) -> AttributedString {
        guard !query.isEmpty, let base = offsets[unit] else { return attr }
        var a = attr
        let plain = String(a.characters)
        for (i, r) in Self.ranges(plain, query).enumerated() {
            let lower = plain.distance(from: plain.startIndex, to: r.lowerBound)
            let len = plain.distance(from: r.lowerBound, to: r.upperBound)
            let start = a.characters.index(a.startIndex, offsetBy: lower)
            let end = a.characters.index(start, offsetBy: len)
            let isActive = base + i == active
            // Cetus: inactive matches foreground/18, the active one brand/55.
            a[start ..< end].backgroundColor = isActive ? Theme.primary.opacity(0.55) : Theme.foreground.opacity(0.18)
        }
        return a
    }
}

struct FindKey: EnvironmentKey { static let defaultValue: FindHighlight? = nil }
extension EnvironmentValues {
    var findHighlight: FindHighlight? {
        get { self[FindKey.self] }
        set { self[FindKey.self] = newValue }
    }
}

/// A small regex highlighter: comments, strings, numbers, keywords and types.
enum Highlighter {
    private static let cache = NSCache<NSString, NSAttributedStringBox>()
    final class NSAttributedStringBox { let value: AttributedString; init(_ v: AttributedString) { value = v } }

    static let keywords: Set<String> = [
        "func", "let", "var", "if", "else", "for", "while", "return", "import", "struct", "class", "enum", "case", "switch",
        "default", "break", "continue", "in", "guard", "try", "catch", "throw", "throws", "async", "await", "public", "private",
        "static", "final", "extension", "protocol", "self", "Self", "nil", "true", "false", "const", "function", "export",
        "from", "new", "this", "typeof", "interface", "type", "def", "elif", "pass", "None", "True", "False", "with", "as",
        "fn", "pub", "impl", "mut", "use", "mod", "match", "where", "loop", "null", "undefined", "package", "go", "defer",
        "select", "chan", "range", "do", "then", "fi", "done", "esac", "echo", "local", "export", "lambda", "yield", "and",
        "or", "not", "is", "of", "void", "int", "string", "bool", "float", "double", "char", "long", "unsigned", "extends",
        "implements", "super", "override", "init", "deinit", "inout", "some", "any", "readonly", "declare", "namespace",
    ]

    static func highlight(_ code: String, language: String?) -> AttributedString {
        let key = "\(language ?? "")\u{1}\(code)" as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        var out = AttributedString(code)
        if code.count > 60_000 { return out }
        let ns = code as NSString
        func gh(_ light: UInt32, _ dark: UInt32) -> Color {
            Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: dark) : NSColor(hex: light) })
        }
        // GitHub light/dark (hljs) palette, as Cetus uses for file previews.
        let colors = (
            comment: gh(0x6E7781, 0x8B949E),
            string: gh(0x0A3069, 0xA5D6FF),
            number: gh(0x0550AE, 0x79C0FF),
            keyword: gh(0xCF222E, 0xFF7B72),
            type: gh(0x953800, 0xFFA657)
        )
        var claimed = IndexSet()
        func paint(_ pattern: String, _ color: Color, options: NSRegularExpression.Options = []) {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            for m in re.matches(in: code, range: NSRange(location: 0, length: ns.length)) {
                let r = m.range
                if claimed.intersects(integersIn: r.location ..< r.location + r.length) { continue }
                claimed.insert(integersIn: r.location ..< r.location + r.length)
                guard let sr = Range(r, in: code),
                      let lower = AttributedString.Index(sr.lowerBound, within: out),
                      let upper = AttributedString.Index(sr.upperBound, within: out)
                else { continue }
                out[lower ..< upper].foregroundColor = color
            }
        }
        let lang = (language ?? "").lowercased()
        let hashComments = ["python", "py", "sh", "bash", "zsh", "shell", "ruby", "rb", "yaml", "yml", "toml", "r", "perl", "makefile", "dockerfile"].contains(lang)
        paint(hashComments ? "#[^\\n]*" : "//[^\\n]*|/\\*[\\s\\S]*?\\*/", colors.comment)
        if lang == "" || lang == "text" || lang == "plaintext" {
            let c = out
            cache.setObject(NSAttributedStringBox(c), forKey: key)
            return c
        }
        paint("\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`", colors.string)
        paint("\\b\\d+(?:\\.\\d+)?\\b|\\b0x[0-9a-fA-F]+\\b", colors.number)
        guard let wordRe = try? NSRegularExpression(pattern: "\\b[A-Za-z_][A-Za-z0-9_]*\\b") else { return out }
        for m in wordRe.matches(in: code, range: NSRange(location: 0, length: ns.length)) {
            let r = m.range
            if claimed.intersects(integersIn: r.location ..< r.location + r.length) { continue }
            let word = ns.substring(with: r)
            let color: Color?
            if keywords.contains(word) { color = colors.keyword }
            else if let f = word.first, f.isUppercase, word.count > 1 { color = colors.type }
            else { color = nil }
            guard let color, let sr = Range(r, in: code),
                  let lower = AttributedString.Index(sr.lowerBound, within: out),
                  let upper = AttributedString.Index(sr.upperBound, within: out)
            else { continue }
            out[lower ..< upper].foregroundColor = color
        }
        cache.setObject(NSAttributedStringBox(out), forKey: key)
        return out
    }

    static func language(forPath path: String) -> String {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        let map = ["ts": "typescript", "tsx": "typescript", "js": "javascript", "jsx": "javascript", "py": "python", "rs": "rust",
                   "swift": "swift", "go": "go", "sh": "bash", "zsh": "bash", "rb": "ruby", "md": "markdown", "json": "json",
                   "yml": "yaml", "yaml": "yaml", "toml": "toml", "c": "c", "h": "c", "cpp": "cpp", "java": "java", "kt": "kotlin",
                   "css": "css", "html": "html", "sql": "sql"]
        return map[ext] ?? ext
    }
}
