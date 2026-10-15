import Foundation

/// A small GFM parser producing the same block tree remark/react-markdown
/// renders in Cetus: paragraphs, ATX/setext headings, fenced/indented code,
/// thematic breaks, blockquotes, tight/loose (nested) lists with task items,
/// pipe tables. Inlines follow CommonMark's delimiter algorithm with
/// remark-cjk-friendly flanking, plus GFM strikethrough and literal autolinks.

struct MDStyle: OptionSet, Hashable {
    let rawValue: Int
    static let bold = MDStyle(rawValue: 1)
    static let italic = MDStyle(rawValue: 2)
    static let code = MDStyle(rawValue: 4)
    static let strike = MDStyle(rawValue: 8)
}

struct MDSpan: Hashable {
    var text: String
    var style: MDStyle = []
    var link: String? = nil
}

typealias MDInline = [MDSpan]

enum MDAlign: Hashable { case none, left, center, right }

struct MDItem: Equatable {
    var blocks: [MDNode]
    var task: Bool? = nil
}

indirect enum MDNode: Equatable {
    case paragraph(MDInline)
    case heading(Int, MDInline)
    case code(language: String?, text: String)
    case rule
    case quote([MDNode])
    case list(ordered: Bool, start: Int, loose: Bool, items: [MDItem])
    case table(head: [MDInline], rows: [[MDInline]], align: [MDAlign])
}

extension MDInline {
    var plain: String { map(\.text).joined() }
}

enum MDParser {
    private final class Box { let nodes: [MDNode]; init(_ n: [MDNode]) { nodes = n } }
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 1000
        return c
    }()

    /// `cache: false` for text still streaming: each prefix is parsed once and
    /// never again, and caching them evicted finished messages.
    static func parse(_ text: String, cache useCache: Bool = true) -> [MDNode] {
        if let hit = cache.object(forKey: text as NSString) { return hit.nodes }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\t", with: "    ")
        let nodes = parseBlocks(normalized.components(separatedBy: "\n"))
        if useCache { cache.setObject(Box(nodes), forKey: text as NSString) }
        return nodes
    }

    // MARK: Blocks

    private static func indent(_ s: Substring) -> Int { s.prefix { $0 == " " }.count }
    private static func indent(_ s: String) -> Int { s.prefix { $0 == " " }.count }
    private static func isBlank(_ s: String) -> Bool { s.allSatisfy { $0 == " " } }

    private static func dropIndent(_ s: String, _ n: Int) -> String {
        var k = 0
        var i = s.startIndex
        while k < n, i < s.endIndex, s[i] == " " { k += 1; i = s.index(after: i) }
        return String(s[i...])
    }

    private static func fence(_ line: String) -> (char: Character, count: Int, indent: Int, info: String)? {
        let ind = indent(line)
        guard ind <= 3 else { return nil }
        let rest = line.dropFirst(ind)
        guard let c = rest.first, c == "`" || c == "~" else { return nil }
        let count = rest.prefix { $0 == c }.count
        guard count >= 3 else { return nil }
        let info = rest.dropFirst(count).trimmingCharacters(in: .whitespaces)
        if c == "`" && info.contains("`") { return nil }
        return (c, count, ind, info)
    }

    private static func atx(_ line: String) -> (Int, String)? {
        let ind = indent(line)
        guard ind <= 3 else { return nil }
        let rest = line.dropFirst(ind)
        let hashes = rest.prefix { $0 == "#" }.count
        guard (1 ... 6).contains(hashes) else { return nil }
        let after = rest.dropFirst(hashes)
        guard after.isEmpty || after.first == " " else { return nil }
        var content = after.trimmingCharacters(in: .whitespaces)
        // Optional closing sequence.
        if let r = content.range(of: "(^|\\s)#+\\s*$", options: .regularExpression) {
            content = String(content[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        return (hashes, content)
    }

    private static func isRule(_ line: String) -> Bool {
        guard indent(line) <= 3 else { return false }
        let chars = line.filter { $0 != " " }
        guard let c = chars.first, c == "-" || c == "*" || c == "_", chars.count >= 3 else { return false }
        return chars.allSatisfy { $0 == c }
    }

    private struct ListMarker {
        var ordered: Bool
        var bullet: Character // '-', '+', '*' or '.' / ')'
        var start: Int
        var indent: Int // columns before marker
        var contentIndent: Int // columns from line start to content
        var rest: String
    }

    private static func listMarker(_ line: String) -> ListMarker? {
        let ind = indent(line)
        guard ind <= 3 else { return nil }
        let rest = line.dropFirst(ind)
        guard let c = rest.first else { return nil }
        var ordered = false
        var bullet: Character = c
        var start = 1
        var markerLen = 1
        if c == "-" || c == "+" || c == "*" {
            ordered = false
        } else if c.isASCII, c.isNumber {
            let digits = rest.prefix { $0.isASCII && $0.isNumber }
            guard digits.count <= 9 else { return nil }
            let after = rest.dropFirst(digits.count)
            guard let d = after.first, d == "." || d == ")" else { return nil }
            ordered = true
            bullet = d
            start = Int(digits) ?? 1
            markerLen = digits.count + 1
        } else { return nil }
        let after = rest.dropFirst(markerLen)
        if after.isEmpty { return ListMarker(ordered: ordered, bullet: bullet, start: start, indent: ind, contentIndent: ind + markerLen + 1, rest: "") }
        guard after.first == " " else { return nil }
        let spaces = after.prefix { $0 == " " }.count
        let content = after.dropFirst(spaces)
        let pad = (spaces > 4 || content.isEmpty) ? 1 : spaces
        let text = spaces > 4 ? String(after.dropFirst(1)) : String(content)
        return ListMarker(ordered: ordered, bullet: bullet, start: start, indent: ind, contentIndent: ind + markerLen + pad, rest: text)
    }

    private static func splitRow(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") && !s.hasSuffix("\\|") { s.removeLast() }
        var cells: [String] = []
        var cur = ""
        var inCode = 0
        var prev: Character = " "
        var it = s.makeIterator()
        while let ch = it.next() {
            if ch == "`" { inCode = inCode == 0 ? 1 : 0 }
            if ch == "|" && prev != "\\" && inCode == 0 {
                cells.append(cur)
                cur = ""
            } else if ch == "|" && prev == "\\" {
                cur.removeLast()
                cur.append(ch)
            } else {
                cur.append(ch)
            }
            prev = ch
        }
        cells.append(cur)
        return cells.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func delimiterRow(_ line: String) -> [MDAlign]? {
        guard line.contains("-") else { return nil }
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.allSatisfy({ "|-: ".contains($0) }) else { return nil }
        let cells = splitRow(line)
        var out: [MDAlign] = []
        for c in cells {
            guard !c.isEmpty, c.contains("-"), c.allSatisfy({ $0 == "-" || $0 == ":" }) else { return nil }
            let l = c.hasPrefix(":"), r = c.hasSuffix(":")
            out.append(l && r ? .center : r ? .right : l ? .left : .none)
        }
        return out
    }

    /// Lines that end a paragraph (besides a blank line).
    private static func interrupts(_ line: String) -> Bool {
        if fence(line) != nil || atx(line) != nil || isRule(line) { return true }
        let ind = indent(line)
        if ind <= 3, line.dropFirst(ind).first == ">" { return true }
        if let m = listMarker(line), !m.rest.isEmpty, !m.ordered || m.start == 1 { return true }
        return false
    }

    static func parseBlocks(_ lines: [String]) -> [MDNode] {
        var out: [MDNode] = []
        var i = 0
        let n = lines.count
        while i < n {
            let line = lines[i]
            if isBlank(line) { i += 1; continue }
            // Fenced code.
            if let f = fence(line) {
                var body: [String] = []
                i += 1
                while i < n {
                    let l = lines[i]
                    if let c = fence(l), c.char == f.char, c.count >= f.count, c.info.isEmpty { i += 1; break }
                    body.append(dropIndent(l, f.indent))
                    i += 1
                }
                let lang = f.info.split(separator: " ").first.map(String.init)
                out.append(.code(language: lang?.isEmpty == false ? lang : nil, text: body.joined(separator: "\n")))
                continue
            }
            if let (level, content) = atx(line) {
                out.append(.heading(level, parseInline(content)))
                i += 1
                continue
            }
            if isRule(line) {
                out.append(.rule)
                i += 1
                continue
            }
            // Indented code.
            if indent(line) >= 4 {
                var body: [String] = []
                while i < n, isBlank(lines[i]) || indent(lines[i]) >= 4 {
                    body.append(dropIndent(lines[i], 4))
                    i += 1
                }
                while let last = body.last, isBlank(last) { body.removeLast() }
                out.append(.code(language: nil, text: body.joined(separator: "\n")))
                continue
            }
            // Blockquote.
            if indent(line) <= 3, line.dropFirst(indent(line)).first == ">" {
                var inner: [String] = []
                var lastWasText = false
                while i < n {
                    let l = lines[i]
                    let ind = indent(l)
                    if ind <= 3, l.dropFirst(ind).first == ">" {
                        var rest = l.dropFirst(ind + 1)
                        if rest.first == " " { rest = rest.dropFirst() }
                        inner.append(String(rest))
                        lastWasText = !isBlank(String(rest)) && !interrupts(String(rest))
                        i += 1
                    } else if !isBlank(l), lastWasText, !interrupts(l) {
                        inner.append(l) // lazy continuation
                        i += 1
                    } else { break }
                }
                out.append(.quote(parseBlocks(inner)))
                continue
            }
            // List.
            if let first = listMarker(line) {
                var items: [MDItem] = []
                var loose = false
                var marker = first
                var sawBlankBetween = false
                while i < n {
                    // One item.
                    var body: [String] = [marker.rest]
                    let ci = marker.contentIndent
                    i += 1
                    var blankRun = 0
                    var lastText = !marker.rest.isEmpty
                    while i < n {
                        let l = lines[i]
                        if isBlank(l) {
                            blankRun += 1
                            body.append("")
                            i += 1
                            // An item can begin with at most one blank line.
                            if body.count == 2 && body[0].isEmpty { break }
                            continue
                        }
                        if indent(l) >= ci {
                            body.append(dropIndent(l, ci))
                            lastText = true
                            blankRun = 0
                            i += 1
                            continue
                        }
                        if blankRun == 0, lastText, listMarker(l) == nil, !interrupts(l) {
                            body.append(l.trimmingCharacters(in: .whitespaces)) // lazy continuation
                            i += 1
                            continue
                        }
                        break
                    }
                    // Trailing blank lines belong between items, not to this one.
                    var trailingBlank = 0
                    while let last = body.last, last.isEmpty, body.count > 1 { body.removeLast(); trailingBlank += 1 }
                    // Loose if blank lines separate blocks inside the item.
                    let inner = parseBlocks(body)
                    if inner.count > 1, body.contains(where: { $0.isEmpty }) {
                        // A blank between two direct children (not inside a nested list/code) makes it loose.
                        if hasBlankBetweenChildren(body) { loose = true }
                    }
                    var item = MDItem(blocks: inner)
                    if case .paragraph(var p)? = inner.first, let t = p.first?.text, p.first?.style == [], p.first?.link == nil,
                       t.hasPrefix("[ ] ") || t.hasPrefix("[x] ") || t.hasPrefix("[X] ") {
                        item.task = !t.hasPrefix("[ ]")
                        p[0].text = String(t.dropFirst(4))
                        item.blocks[0] = .paragraph(p)
                    }
                    items.append(item)
                    if i >= n { break }
                    guard let next = listMarker(lines[i]), next.ordered == first.ordered, next.bullet == first.bullet, indent(lines[i]) < ci else { break }
                    if trailingBlank > 0 { sawBlankBetween = true }
                    marker = next
                }
                if sawBlankBetween { loose = true }
                out.append(.list(ordered: first.ordered, start: first.start, loose: loose, items: items))
                continue
            }
            // Table.
            if i + 1 < n, line.contains("|"), let align = delimiterRow(lines[i + 1]) {
                let head = splitRow(line)
                if head.count == align.count {
                    var rows: [[MDInline]] = []
                    i += 2
                    while i < n, !isBlank(lines[i]), !interrupts(lines[i]) {
                        var cells = splitRow(lines[i])
                        if cells.count < align.count { cells += Array(repeating: "", count: align.count - cells.count) }
                        rows.append(cells.prefix(align.count).map { parseInline($0) })
                        i += 1
                    }
                    out.append(.table(head: head.map { parseInline($0) }, rows: rows, align: align))
                    continue
                }
            }
            // Paragraph (maybe setext heading).
            var para: [String] = [line]
            i += 1
            var setext: Int?
            while i < n {
                let l = lines[i]
                if isBlank(l) { break }
                let t = l.trimmingCharacters(in: .whitespaces)
                if indent(l) <= 3, !t.isEmpty, t.allSatisfy({ $0 == "=" }) { setext = 1; i += 1; break }
                if indent(l) <= 3, !t.isEmpty, t.allSatisfy({ $0 == "-" }) { setext = 2; i += 1; break }
                if interrupts(l) { break }
                if l.contains("|"), i + 1 < n, delimiterRow(lines[i + 1]) != nil { break }
                para.append(l)
                i += 1
            }
            let inline = parseInline(joinParagraph(para))
            if let level = setext { out.append(.heading(level, inline)) } else { out.append(.paragraph(inline)) }
        }
        return out
    }

    private static func hasBlankBetweenChildren(_ body: [String]) -> Bool {
        // Blank line followed by more content at the item's own level (not a nested list's indent).
        var sawBlank = false
        var inFence = false
        for l in body {
            if fence(l) != nil { inFence.toggle() }
            if inFence { continue }
            if l.isEmpty { sawBlank = true; continue }
            if sawBlank && indent(l) < 2 { return true }
            sawBlank = false
        }
        return false
    }

    /// Soft breaks become spaces, hard breaks (two trailing spaces or a backslash) U+2028.
    private static func joinParagraph(_ lines: [String]) -> String {
        var out = ""
        for (k, raw) in lines.enumerated() {
            var l = String(raw.drop { $0 == " " })
            if k == lines.count - 1 {
                out += l.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
                break
            }
            if l.hasSuffix("  ") {
                while l.hasSuffix(" ") { l.removeLast() }
                out += l + "\u{2028}"
            } else if l.hasSuffix("\\") && !l.hasSuffix("\\\\") {
                l.removeLast()
                out += l + "\u{2028}"
            } else {
                while l.hasSuffix(" ") { l.removeLast() }
                out += l + "\n"
            }
        }
        return out
    }

    // MARK: Inlines

    private final class Tok {
        var text: String
        var style: MDStyle = []
        var link: String?
        // delimiter run
        var delim: Character?
        var count = 0
        var canOpen = false
        var canClose = false
        var active = true
        init(_ t: String) { text = t }
    }

    private static func isPunct(_ c: Character?) -> Bool {
        guard let c else { return false }
        return c.unicodeScalars.allSatisfy { CharacterSet.punctuationCharacters.contains($0) || CharacterSet.symbols.contains($0) }
    }

    private static func isSpace(_ c: Character?) -> Bool {
        guard let c else { return true }
        return c.isWhitespace || c == "\u{2028}"
    }

    static func isCJK(_ c: Character?) -> Bool {
        guard let s = c?.unicodeScalars.first?.value else { return false }
        return (0x2E80 ... 0x9FFF).contains(s) || (0xAC00 ... 0xD7AF).contains(s) || (0xF900 ... 0xFAFF).contains(s)
            || (0xFE30 ... 0xFE4F).contains(s) || (0xFF00 ... 0xFFEF).contains(s) || (0x20000 ... 0x2FA1F).contains(s)
            || (0x3000 ... 0x303F).contains(s)
    }

    static func parseInline(_ src: String) -> MDInline {
        let chars = Array(src)
        var toks: [Tok] = []
        var buf = ""
        func flush() {
            if !buf.isEmpty { toks.append(Tok(buf)); buf = "" }
        }
        var brackets: [(tok: Int, image: Bool, active: Bool)] = []
        var i = 0
        let n = chars.count
        while i < n {
            let c = chars[i]
            if c == "\\", i + 1 < n, chars[i + 1].isASCII, isPunct(chars[i + 1]) {
                buf.append(chars[i + 1])
                i += 2
                continue
            }
            if c == "`" {
                var run = 0
                while i + run < n, chars[i + run] == "`" { run += 1 }
                // Find a closing run of the same length.
                var j = i + run
                var found = -1
                while j < n {
                    if chars[j] == "`" {
                        var r = 0
                        while j + r < n, chars[j + r] == "`" { r += 1 }
                        if r == run { found = j; break }
                        j += r
                    } else { j += 1 }
                }
                if found >= 0 {
                    flush()
                    var code = String(chars[(i + run) ..< found]).replacingOccurrences(of: "\n", with: " ")
                    if code.count >= 2, code.hasPrefix(" "), code.hasSuffix(" "), !code.allSatisfy({ $0 == " " }) {
                        code = String(code.dropFirst().dropLast())
                    }
                    let t = Tok(code)
                    t.style = .code
                    toks.append(t)
                    i = found + run
                } else {
                    buf += String(repeating: "`", count: run)
                    i += run
                }
                continue
            }
            if c == "<" {
                // Autolink <scheme:...> / <email>.
                if let close = chars[(i + 1)...].firstIndex(of: ">") {
                    let inner = String(chars[(i + 1) ..< close])
                    if !inner.contains(" "), inner.range(of: "^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>]*$", options: .regularExpression) != nil
                        || inner.range(of: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", options: .regularExpression) != nil {
                        flush()
                        let t = Tok(inner)
                        t.link = inner.contains(":") ? inner : "mailto:" + inner
                        toks.append(t)
                        i = close + 1
                        continue
                    }
                }
            }
            if c == "!" && i + 1 < n && chars[i + 1] == "[" {
                flush()
                toks.append(Tok("!["))
                brackets.append((toks.count - 1, true, true))
                i += 2
                continue
            }
            if c == "[" {
                flush()
                toks.append(Tok("["))
                brackets.append((toks.count - 1, false, true))
                i += 1
                continue
            }
            if c == "]" {
                flush()
                if let open = brackets.last {
                    brackets.removeLast()
                    // Inline link destination.
                    if open.active, i + 1 < n, chars[i + 1] == "(", let (dest, end) = linkDestination(chars, i + 2) {
                        let start = open.tok
                        processEmphasis(&toks, bottom: start + 1)
                        for k in (start + 1) ..< toks.count where toks[k].link == nil { toks[k].link = dest }
                        toks[start].text = ""
                        if open.image {
                            // Images render as their alt text link.
                        }
                        // Links may not contain other links: deactivate earlier openers.
                        if !open.image { for b in brackets.indices { brackets[b].active = false } }
                        i = end
                        continue
                    }
                }
                buf.append("]")
                i += 1
                continue
            }
            if c == "*" || c == "_" || c == "~" {
                var run = 0
                while i + run < n, chars[i + run] == c { run += 1 }
                let before: Character? = i > 0 ? chars[i - 1] : nil
                let after: Character? = i + run < n ? chars[i + run] : nil
                if c == "~" && run != 2 {
                    buf += String(repeating: "~", count: run)
                    i += run
                    continue
                }
                // CommonMark flanking, relaxed next to CJK (remark-cjk-friendly).
                let left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before) || isCJK(before) || isCJK(after))
                let right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after) || isCJK(after) || isCJK(before))
                flush()
                let t = Tok(String(repeating: String(c), count: run))
                t.delim = c
                t.count = run
                if c == "_" {
                    t.canOpen = left && (!right || isPunct(before))
                    t.canClose = right && (!left || isPunct(after))
                } else {
                    t.canOpen = left
                    t.canClose = right
                }
                toks.append(t)
                i += run
                continue
            }
            if c == "&", let semi = chars[i...].prefix(10).firstIndex(of: ";") {
                let name = String(chars[i ... semi])
                let map = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": "\u{00A0}", "&apos;": "'"]
                if let v = map[name] {
                    buf += v
                    i = semi + 1
                    continue
                }
            }
            buf.append(c)
            i += 1
        }
        flush()
        processEmphasis(&toks, bottom: 0)
        var spans: MDInline = []
        for t in toks where !t.text.isEmpty {
            if let last = spans.last, last.style == t.style, last.link == t.link, !t.style.contains(.code) {
                spans[spans.count - 1].text += t.text
            } else {
                spans.append(MDSpan(text: t.text, style: t.style, link: t.link))
            }
        }
        return autolink(spans)
    }

    private static func linkDestination(_ chars: [Character], _ start: Int) -> (String, Int)? {
        var i = start
        let n = chars.count
        while i < n, chars[i] == " " { i += 1 }
        var dest = ""
        if i < n, chars[i] == "<" {
            i += 1
            while i < n, chars[i] != ">" { dest.append(chars[i]); i += 1 }
            guard i < n else { return nil }
            i += 1
        } else {
            var depth = 0
            while i < n {
                let c = chars[i]
                if c == " " { break }
                if c == "(" { depth += 1 }
                if c == ")" { if depth == 0 { break }; depth -= 1 }
                if c == "\\", i + 1 < n { dest.append(chars[i + 1]); i += 2; continue }
                dest.append(c)
                i += 1
            }
        }
        while i < n, chars[i] == " " { i += 1 }
        // Optional title.
        if i < n, chars[i] == "\"" || chars[i] == "'" {
            let q = chars[i]
            i += 1
            while i < n, chars[i] != q { i += 1 }
            i += 1
            while i < n, chars[i] == " " { i += 1 }
        }
        guard i < n, chars[i] == ")" else { return nil }
        return (dest, i + 1)
    }

    private static func processEmphasis(_ toks: inout [Tok], bottom: Int) {
        var closerIdx = bottom
        while closerIdx < toks.count {
            let closer = toks[closerIdx]
            guard closer.delim != nil, closer.canClose, closer.count > 0 else { closerIdx += 1; continue }
            var openerIdx = closerIdx - 1
            var found = false
            while openerIdx >= bottom {
                let o = toks[openerIdx]
                if o.delim == closer.delim, o.canOpen, o.count > 0 {
                    // Rule of 3.
                    let both = (o.canOpen && o.canClose) || (closer.canOpen && closer.canClose)
                    if closer.delim == "~" ? (o.count == closer.count) : !(both && (o.count + closer.count) % 3 == 0 && !(o.count % 3 == 0 && closer.count % 3 == 0)) {
                        found = true
                        break
                    }
                }
                openerIdx -= 1
            }
            if !found {
                if !closer.canOpen { closer.delim = closer.delim == "~" ? "~" : closer.delim; closer.canClose = false }
                closerIdx += 1
                continue
            }
            let opener = toks[openerIdx]
            let use = closer.delim == "~" ? 2 : (opener.count >= 2 && closer.count >= 2 ? 2 : 1)
            let style: MDStyle = closer.delim == "~" ? .strike : use == 2 ? .bold : .italic
            for k in (openerIdx + 1) ..< closerIdx { toks[k].style.insert(style) }
            // Delimiters between opener and closer become literal.
            for k in (openerIdx + 1) ..< closerIdx where toks[k].delim != nil { toks[k].canOpen = false; toks[k].canClose = false }
            opener.count -= use
            closer.count -= use
            opener.text = String(opener.text.dropLast(use))
            closer.text = String(closer.text.dropFirst(use))
            if closer.count == 0 { closerIdx += 1 }
        }
        // Remaining delimiter text stays literal; inherit style of neighbours for runs.
        for k in bottom ..< toks.count where toks[k].delim != nil { toks[k].delim = nil }
    }

    /// GFM literal autolinks (http(s)://, www.) in plain text spans, cut before CJK punctuation.
    nonisolated(unsafe) private static let urlPattern = try? NSRegularExpression(pattern: "(?:https?://|www\\.)[^\\s<]+")

    private static func autolink(_ spans: MDInline) -> MDInline {
        guard let re = urlPattern else { return spans }
        var out: MDInline = []
        for s in spans {
            guard s.link == nil, !s.style.contains(.code), s.text.contains("://") || s.text.contains("www.") else { out.append(s); continue }
            let ns = s.text as NSString
            var last = 0
            for m in re.matches(in: s.text, range: NSRange(location: 0, length: ns.length)) {
                var url = ns.substring(with: m.range)
                // Cut at the first non-ASCII punctuation/symbol, then GFM trailing punctuation and unbalanced ')'.
                if let cut = url.firstIndex(where: { !$0.isASCII && isPunct($0) }) { url = String(url[..<cut]) }
                while true {
                    let trimmed = url.replacingOccurrences(of: "[?!.,:*_~]+$", with: "", options: .regularExpression)
                    if trimmed.hasSuffix(")"), trimmed.filter({ $0 == "(" }).count < trimmed.filter({ $0 == ")" }).count {
                        url = String(trimmed.dropLast())
                        continue
                    }
                    url = trimmed
                    break
                }
                guard !url.isEmpty else { continue }
                if m.range.location > last { out.append(MDSpan(text: ns.substring(with: NSRange(location: last, length: m.range.location - last)), style: s.style)) }
                out.append(MDSpan(text: url, style: s.style, link: url.hasPrefix("www.") ? "http://" + url : url))
                last = m.range.location + (url as NSString).length
            }
            if last < ns.length { out.append(MDSpan(text: ns.substring(from: last), style: s.style)) }
        }
        return out
    }
}
