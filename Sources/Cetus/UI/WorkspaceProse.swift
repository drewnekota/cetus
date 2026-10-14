import AppKit
import SwiftUI

/// The file preview's markdown: Tailwind Typography `prose prose-sm
/// dark:prose-invert max-w-none` with `prose-pre:bg-secondary
/// prose-pre:text-foreground` and Cetus's global `.prose ul/ol` overrides.
/// Unlike the chat column (MarkdownView), inline code is plain semibold mono
/// wrapped in literal backticks and fenced code has no Copy chip.
struct WorkspaceProse: View {
    let text: String

    private let size: CGFloat = 14
    private var lh: CGFloat { 24 }
    private var body_: NSColor { NSColor(Theme.proseBody) }
    private var heading: NSColor { NSColor(Theme.proseHeading) }

    var body: some View {
        let nodes = MDParser.parse(text)
        let boxes = blocks(nodes, tight: false)
        return LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(Array(boxes.enumerated()), id: \.offset) { i, b in
                b.view.padding(.top, i == 0 ? 0 : max(boxes[i - 1].bottom, b.top))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Inline

    private func fonts(size s: CGFloat? = nil, weight: NSFont.Weight = .regular, color: NSColor? = nil, italic: Bool = false) -> ProseBuilder.Fonts {
        let c = color ?? body_
        return ProseBuilder.Fonts(size: s ?? size, weight: weight, color: c, strongColor: color ?? heading, linkColor: color ?? heading,
                                  codeScale: 0.8571429, codeColor: color ?? heading, italic: italic)
    }

    /// prose `code::before/::after { content: "`" }`, no chip.
    static func attributed(_ spans: MDInline, _ f: ProseBuilder.Fonts) -> NSAttributedString {
        let ticked = spans.map { s -> MDSpan in
            guard s.style.contains(.code) else { return s }
            var t = s
            t.text = "`" + s.text + "`"
            return t
        }
        let (built, _) = ProseBuilder.build(ticked, f)
        let out = NSMutableAttributedString(attributedString: built)
        let all = NSRange(location: 0, length: out.length)
        out.enumerateAttribute(ProseKey.code, in: all) { v, r, _ in
            guard v != nil else { return }
            out.removeAttribute(ProseKey.code, range: r)
            out.removeAttribute(.kern, range: r)
            if r.location > 0 { out.removeAttribute(.kern, range: NSRange(location: r.location - 1, length: 1)) }
        }
        return out
    }

    private func leaf(_ spans: MDInline, _ f: ProseBuilder.Fonts, lineHeight: CGFloat) -> AnyView {
        let attr = Self.attributed(spans, f)
        let primary = ProseBuilder.font(f.size, f.weight)
        return AnyView(ProseText(text: attr, metrics: ProseMetrics(font: primary, lineHeight: lineHeight)))
    }

    // MARK: Blocks

    private func blocks(_ nodes: [MDNode], tight: Bool) -> [WSProseBox] {
        var out: [WSProseBox] = []
        for n in nodes {
            var b = box(n, tight: tight)
            // `h2 + *, h3 + *, h4 + *, hr + *`: margin-top 0.
            if let prev = out.last, prev.zeroNext { b.top = 0; b.innerTopZero = true }
            out.append(b)
        }
        return out
    }

    private func box(_ node: MDNode, tight: Bool) -> WSProseBox {
        switch node {
        case .paragraph(let a):
            return WSProseBox(view: leaf(a, fonts(), lineHeight: lh), top: tight ? 0 : 16, bottom: tight ? 0 : 16)
        case .heading(let level, let a):
            let (fs, w, l, mt, mb): (CGFloat, NSFont.Weight, CGFloat, CGFloat, CGFloat) = switch level {
            case 1: (30, .heavy, 36, 0, 24)
            case 2: (20, .bold, 28, 32, 16)
            case 3: (18, .semibold, 28, 28, 8)
            case 4: (14, .semibold, 20, 20, 8)
            default: (14, .regular, 24, 0, 0)
            }
            var f = level <= 4 ? fonts(size: fs, weight: w, color: heading) : fonts()
            f.strongWeight = level == 1 ? .black : level == 2 ? .heavy : .bold
            return WSProseBox(view: leaf(a, f, lineHeight: l), top: mt, bottom: mb, zeroNext: level <= 4)
        case .code(_, let code):
            return WSProseBox(view: AnyView(WSPre(code: code)), top: 20, bottom: 20)
        case .rule:
            return WSProseBox(view: AnyView(Rectangle().fill(Theme.proseRule).frame(height: 1)), top: 40, bottom: 40, zeroNext: true)
        case .quote(let children):
            let paras = children.indices.filter { if case .paragraph = children[$0] { return true }; return false }
            var quoted = children
            if let f = paras.first, case .paragraph(var a) = quoted[f] { a.insert(MDSpan(text: "“"), at: 0); quoted[f] = .paragraph(a) }
            if let l = paras.last, case .paragraph(var a) = quoted[l] { a.append(MDSpan(text: "”")); quoted[l] = .paragraph(a) }
            let inner = quoted.map { n -> WSProseBox in
                if case .paragraph(let a) = n {
                    var f = fonts(weight: .medium, color: NSColor(Theme.proseQuote), italic: true)
                    f.strongWeight = .semibold
                    return WSProseBox(view: leaf(a, f, lineHeight: lh), top: 16, bottom: 16)
                }
                return box(n, tight: false)
            }
            let stack = WSProseStack(boxes: inner, trimOuter: false)
            let v = stack.inner
                .padding(.leading, 15.55554)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.proseRule).frame(width: 4) }
            return WSProseBox(view: AnyView(v), top: max(18.65625, stack.top), bottom: max(18.65625, stack.bottom))
        case .list(let ordered, let start, let loose, let items):
            return list(ordered: ordered, start: start, loose: loose, items: items)
        case .table(let head, let rows, let align):
            return WSProseBox(view: AnyView(WSProseTable(head: head, rows: rows, cols: align.count)), top: 24, bottom: 24)
        }
    }

    private func list(ordered: Bool, start: Int, loose: Bool, items: [MDItem]) -> WSProseBox {
        let ch = ("0" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: size)]).width
        var rows: [WSProseBox] = []
        for (k, item) in items.enumerated() {
            var inner = blocks(item.blocks, tight: !loose)
            // Loose items: `li p` 8px; `> li > :first-child` 16 top, `> li > :last-child` 16 bottom.
            if loose {
                for i in inner.indices {
                    if case .paragraph = item.blocks[i] { inner[i].top = 8; inner[i].bottom = 8 }
                }
                if !inner.isEmpty { inner[0].top = 16; inner[inner.count - 1].bottom = 16 }
            }
            // Nested lists: `ul ul, ol ol…` 8px.
            for i in inner.indices { if case .list = item.blocks[i] { inner[i].top = 8; inner[i].bottom = 8 } }
            let stack = WSProseStack(boxes: inner, trimOuter: false)
            let marker: AnyView = ordered
                ? AnyView(Text("\(start + k).").font(.system(size: size).monospacedDigit()).foregroundStyle(Theme.proseCounter)
                    .frame(width: 4 * ch, height: lh, alignment: .trailing)
                    .frame(width: 4 * ch + size * 0.75, alignment: .leading))
                : AnyView(WSBullet(size: size, lineHeight: lh, task: item.task).frame(width: size * 2.25 + size * 0.4285714))
            let row = HStack(alignment: .top, spacing: 0) {
                marker
                stack.inner.frame(maxWidth: .infinity, alignment: .leading)
            }
            rows.append(WSProseBox(view: AnyView(row), top: max(3.984375, stack.top), bottom: max(3.984375, stack.bottom)))
        }
        let stack = WSProseStack(boxes: rows, trimOuter: false)
        return WSProseBox(view: AnyView(stack.inner), top: max(16, stack.top), bottom: max(16, stack.bottom))
    }
}

struct WSProseBox {
    var view: AnyView
    var top: CGFloat
    var bottom: CGFloat
    /// The following sibling's margin-top is 0 (after h2–h4 and hr).
    var zeroNext = false
    var innerTopZero = false
}

/// Collapsed sibling margins; `trimOuter` drops the first top / last bottom margin (`> :first-child` / `> :last-child`).
struct WSProseStack {
    let boxes: [WSProseBox]
    let trimOuter: Bool
    var top: CGFloat { boxes.first?.top ?? 0 }
    var bottom: CGFloat { boxes.last?.bottom ?? 0 }
    var inner: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(boxes.enumerated()), id: \.offset) { i, b in
                b.view.padding(.top, i == 0 ? 0 : max(boxes[i - 1].bottom, b.top))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    var view: AnyView { AnyView(inner) }
}

/// `pre`: bg-secondary, radius 4, 8/12 padding, 12px strut with 20px lines, code at 0.857em.
private struct WSPre: View {
    let code: String
    var body: some View {
        let fs: CGFloat = 12 * 0.8571429
        let body = code.hasSuffix("\n") ? String(code.dropLast()) : code
        let attr = NSAttributedString(string: body, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: fs, weight: .regular),
            .foregroundColor: NSColor(Theme.foreground),
            ProseBuilder.language: "en",
            .paragraphStyle: { let p = NSMutableParagraphStyle(); p.lineBreakMode = .byClipping; return p }(),
        ])
        let m = ProseMetrics(font: .monospacedSystemFont(ofSize: 12, weight: .regular), lineHeight: 20)
        return ScrollView(.horizontal, showsIndicators: false) {
            ProseText(text: attr, metrics: m, fit: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.secondary))
    }
}

/// `list-style: disc` in `--tw-prose-bullets`, or a GFM task checkbox.
private struct WSBullet: View {
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
            let m = ProseMetrics(font: .systemFont(ofSize: size), lineHeight: lineHeight)
            let dy = m.baseline - NSFont.systemFont(ofSize: size).xHeight / 2 - size * 0.3333 / 2 - 0.5
            Circle().fill(Theme.proseBullet)
                .frame(width: size * 0.3333, height: size * 0.3333)
                .offset(x: size * 1.1267, y: dy)
                .frame(maxWidth: .infinity, maxHeight: lineHeight, alignment: .topLeading)
        }
    }
}

/// prose-sm table: 12px / 18px, th `pb-2 px-3` (outer edges 0) semibold headings,
/// td `py-2 px-3`; th-borders under the head, td-borders between body rows.
private struct WSProseTable: View {
    let head: [MDInline]
    let rows: [[MDInline]]
    let cols: Int
    private let size: CGFloat = 12
    private let lh: CGFloat = 18

    private var cells: [[NSAttributedString]] {
        let h = NSColor(Theme.proseHeading), b = NSColor(Theme.proseBody)
        func f(_ header: Bool) -> ProseBuilder.Fonts {
            ProseBuilder.Fonts(size: size, weight: header ? .semibold : .regular, color: header ? h : b, strongColor: h, linkColor: h,
                               codeScale: 0.8571429, codeColor: h)
        }
        return [head.map { WorkspaceProse.attributed($0, f(true)) }] + rows.map { $0.map { WorkspaceProse.attributed($0, f(false)) } }
    }

    private func metrics(_ header: Bool) -> ProseMetrics {
        ProseMetrics(font: .systemFont(ofSize: size, weight: header ? .semibold : .regular), lineHeight: lh)
    }

    private func pad(_ c: Int) -> (CGFloat, CGFloat) { (c == 0 ? 0 : 12, c == cols - 1 ? 0 : 12) }

    private func widths(_ width: CGFloat, _ cs: [[NSAttributedString]]) -> [CGFloat] {
        var minW = Array(repeating: CGFloat(0), count: cols), maxW = minW
        for (r, row) in cs.enumerated() {
            for (c, cell) in row.enumerated() where c < cols {
                let (l, t) = pad(c)
                maxW[c] = max(maxW[c], ceil(ProseText.width(cell, metrics: metrics(r == 0)) * 64) / 64 + l + t)
                minW[c] = max(minW[c], ceil(Self.minContent(cell) * 64) / 64 + l + t)
            }
        }
        let sumMax = maxW.reduce(0, +), sumMin = minW.reduce(0, +)
        if sumMax <= width {
            guard sumMax > 0 else { return Array(repeating: width / CGFloat(max(cols, 1)), count: cols) }
            return maxW.map { $0 + (width - sumMax) * $0 / sumMax }
        }
        if sumMin >= width { return minW }
        let span = sumMax - sumMin
        return zip(minW, maxW).map { mn, mx in mn + (width - sumMin) * (span > 0 ? (mx - mn) / span : 0) }
    }

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
            best = max(best, s.attributedSubstring(from: NSRange(location: a, length: b - a))
                .boundingRect(with: CGSize(width: 100_000, height: 100_000), options: [.usesLineFragmentOrigin]).width)
        }
        return best
    }

    private func heights(_ w: [CGFloat], _ cs: [[NSAttributedString]]) -> [CGFloat] {
        cs.enumerated().map { r, row in
            row.enumerated().map { c, cell -> CGFloat in
                guard c < w.count else { return 0 }
                let (l, t) = pad(c)
                return ProseText.height(cell, metrics: metrics(r == 0), width: max(1, w[c] - l - t))
            }.max() ?? lh
        }
    }

    var body: some View {
        WSHeightLayout(height: { width in
            let cs = cells
            let h = heights(widths(width, cs), cs)
            return h.reduce(0, +) + 8 + CGFloat(max(0, cs.count - 1)) * 16 + CGFloat(max(0, cs.count - 1))
        }) {
            GeometryReader { geo in content(geo.size.width) }
        }
    }

    private func content(_ width: CGFloat) -> some View {
        let cs = cells
        let w = widths(width, cs)
        let h = heights(w, cs)
        return ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(cs.enumerated()), id: \.offset) { r, row in
                    HStack(alignment: .top, spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { c, cell in
                            if c < w.count {
                                let (l, t) = pad(c)
                                ProseText(text: cell, metrics: metrics(r == 0))
                                    .frame(width: max(1, w[c] - l - t), height: h[r], alignment: r == 0 ? .bottomLeading : .topLeading)
                                    .padding(.leading, l).padding(.trailing, t)
                            }
                        }
                    }
                    .padding(.top, r == 0 ? 0 : 8)
                    .padding(.bottom, 8)
                    if r < cs.count - 1 {
                        Rectangle().fill(r == 0 ? Theme.proseThRule : Theme.proseRule).frame(width: w.reduce(0, +), height: 1)
                    }
                }
            }
        }
        .scrollDisabled(w.reduce(0, +) <= width + 0.5)
    }
}

private struct WSHeightLayout: Layout {
    let height: (CGFloat) -> CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 380
        return CGSize(width: w, height: height(w))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for v in subviews { v.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size)) }
    }
}

