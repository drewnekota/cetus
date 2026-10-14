import AppKit
import SwiftUI

// MARK: - Tool helpers

enum ToolInfo {
    static func args(_ a: JSON) -> JSON {
        if let s = a.string { return JSON.parse(s) ?? ["input": .string(s)] }
        return a.object != nil ? a : [:]
    }

    static func str(_ v: JSON) -> String {
        if let s = v.string { return s }
        if let a = v.array { return a.map(\.stringValue).joined(separator: " ") }
        return ""
    }

    static func pick(_ a: JSON, _ keys: String...) -> String {
        for k in keys {
            let s = str(a[k])
            if !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return s }
        }
        return ""
    }

    /// One-line summary of a tool call's arguments, like Cetus's tool cards.
    static func summary(_ name: String, _ raw: JSON) -> String {
        let a = args(raw)
        let questions = (a["questions"].array ?? []).map { str($0["question"]) }.filter { !$0.isEmpty }.joined(separator: " · ")
        var value = questions
        if value.isEmpty, let todos = a["todos"].array { value = "\(todos.count) todos" }
        if value.isEmpty { value = pick(a, "command", "cmd") }
        if value.isEmpty { value = pick(a, "file_path", "path", "file", "notebook_path") }
        if value.isEmpty { value = pick(a, "pattern", "query", "url", "description", "prompt") }
        if value.isEmpty, let o = a.object, !o.isEmpty { value = a.compact }
        let line = value.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? ""
        if line.isEmpty { return name }
        return line.count > 140 ? String(line.prefix(140)) + "…" : line
    }

    /// Replacement pairs of an edit-style call: bridge-normalized or raw Claude args.
    static func edits(_ raw: JSON) -> (path: String, edits: [(old: String, new: String)])? {
        let a = args(raw)
        let path = pick(a, "path", "file_path", "file", "filename")
        var out: [(old: String, new: String)] = []
        func push(_ e: JSON) {
            let o = str(e["oldText"].isNull ? e["old_string"] : e["oldText"])
            let n = str(e["newText"].isNull ? e["new_string"] : e["newText"])
            if !o.isEmpty || !n.isEmpty { out.append((old: o, new: n)) }
        }
        if let list = a["edits"].array { list.forEach(push) }
        else if a["edits"].object != nil { push(a["edits"]) }
        else { push(a) }
        return out.isEmpty ? nil : (path.isEmpty ? "file" : path, out)
    }

    static func isSubagent(_ name: String) -> Bool {
        let n = name.lowercased()
        return n == "task" || n == "agent" || n.contains("subagent")
    }

    /// Cetus's row summary: Bash `$ cmd`, Edit `path · +A -D`, subagent `type — description`, else the first useful field.
    static func rowSummary(_ name: String, _ raw: JSON) -> String {
        let a = args(raw)
        let n = name.lowercased()
        func one(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        if ["bash", "shell", "exec_command", "exec"].contains(n) || (n.contains("bash")) {
            let c = pick(a, "command", "cmd")
            if !c.isEmpty { return "$ " + one(c) }
        }
        if isEdit(n), let e = edits(raw) {
            let d = e.edits.reduce((0, 0)) { acc, x in let d = LineDiff.compute(x.old, x.new); return (acc.0 + d.added, acc.1 + d.removed) }
            return "\(e.path) · +\(d.0) -\(d.1)"
        }
        if isSubagent(n) {
            let t = pick(a, "subagent_type", "type"), d = pick(a, "description")
            return one([t, d].filter { !$0.isEmpty }.joined(separator: " — "))
        }
        let v = pick(a, "command", "cmd", "path", "file", "file_path", "query", "url", "pattern", "name")
        if !v.isEmpty { return one(v) }
        if let o = a.object, let first = o.values.compactMap(\.string).first { return one(first) }
        return ""
    }

    static func readRange(_ a: JSON) -> String {
        let o = a["offset"].int, l = a["limit"].int
        return [o.map { "offset \($0)" }, l.map { "limit \($0)" }].compactMap { $0 }.joined(separator: " · ")
    }

    static func isEdit(_ name: String) -> Bool {
        let n = name.lowercased()
        return n.contains("edit") || n.contains("apply_patch") || n.contains("str_replace")
    }

    static func icon(_ name: String) -> String {
        let n = name.lowercased()
        if ["bash", "shell", "exec", "command"].contains(where: n.contains) { return "terminal" }
        if ["edit", "write", "patch", "replace"].contains(where: n.contains) { return "pencil" }
        if ["grep", "glob", "search"].contains(where: n.contains) { return "magnifyingglass" }
        if ["read", "view", "ls"].contains(where: n.contains) { return "doc.text" }
        if ["web", "fetch", "url"].contains(where: n.contains) { return "globe" }
        if n.contains("todo") { return "checklist" }
        if n.contains("question") { return "questionmark.bubble" }
        if ["task", "agent"].contains(where: n.contains) { return "person.2" }
        return "wrench.and.screwdriver"
    }
}

/// The three-dot activity indicator (kept for places Cetus pulses dots).
struct Dots: View {
    var color: Color = Theme.mutedForeground
    var size: CGFloat = 4
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 20)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(spacing: size * 0.6) {
                ForEach(0 ..< 3) { i in
                    Circle().fill(color).frame(width: size, height: size)
                        .opacity(0.35 + 0.65 * max(0, sin((t * 4) - Double(i) * 0.9)))
                }
            }
        }
        .frame(height: size + 4)
    }
}

enum ToolStatus { case running, error, incomplete, settled }

extension Block {
    /// Cetus toolActivityStatus.
    var toolStatus: ToolStatus {
        let sub = result?.details["subagent"]["status"].string
        if streaming || sub == "running" { return .running }
        if result?.isError == true || sub == "failed" || sub == "error" { return .error }
        if result == nil || ["cancelled", "canceled", "interrupted"].contains(sub ?? "") { return .incomplete }
        return .settled
    }
}

private struct StatusIcon: View {
    let status: ToolStatus
    var size: CGFloat = 12
    var body: some View {
        switch status {
        case .running: Spinner(size: size)
        case .error: Glyph(name: "alert-circle", size: size, color: Theme.warning)
        case .incomplete: Glyph(name: "circle-slash", size: size, color: Theme.mutedForeground)
        case .settled: Glyph(name: "check-circle-2", size: size, color: Theme.success)
        }
    }
}

// MARK: - Timeline rows (inside activity groups)

/// Collapsed tool row: chevron, wrench, mono name, args summary, status.
struct ToolCard: View {
    let block: Block
    var defaultOpen = false
    @State private var open: Bool? = nil

    var body: some View {
        let isOpen = open ?? defaultOpen
        VStack(alignment: .leading, spacing: 0) {
            Button { open = !isOpen } label: {
                HStack(spacing: 8) {
                    Glyph(name: isOpen ? "chevron-down" : "chevron-right", size: 12, color: Theme.mutedForeground)
                    Glyph(name: ToolInfo.isSubagent(block.name) ? "bot" : "wrench", size: 12, color: Theme.mutedForeground)
                    if block.name.isEmpty {
                        Text("calling…").font(.system(size: 12, design: .monospaced).italic()).foregroundStyle(Theme.mutedForeground).lineBox(16.1875)
                    } else {
                        Text(block.name).font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Theme.foreground).fixedSize().lineBox(16.1875)
                    }
                    Text(ToolInfo.rowSummary(block.name, block.args)).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                        .lineLimit(1).truncationMode(.tail).lineBox(16.1875)
                    Spacer(minLength: 4)
                    StatusIcon(status: block.toolStatus)
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
                .hoverFill(Theme.muted.opacity(0.6), radius: 4)
            }
            .buttonStyle(.plain)
            if isOpen { ToolBody(block: block).padding(.horizontal, 8).padding(.bottom, 8).padding(.top, 4) }
        }
        .testID("tool-\(block.toolId)")
    }
}

/// `mb-1 text-2xs uppercase tracking-wide` caption over a body box.
private struct Caption: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 11)).tracking(0.275).foregroundStyle(Theme.mutedForeground).padding(.bottom, 4)
    }
}

private struct PreBox: View {
    let text: AttributedString
    var color: Color = Theme.foreground
    var maxHeight: CGFloat = 192
    var relaxed = true
    var body: some View {
        ScrollView {
            Text(text).font(.system(size: 12, design: .monospaced)).foregroundStyle(color)
                .lineSpacing(relaxed ? Prose.spacing(12, 19.5, mono: true) : 0)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8).padding(.vertical, 6)
        }
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: false, vertical: true)
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.background.opacity(0.6)))
    }
}

struct MonoText: View {
    let text: String
    var color: Color = Theme.foreground
    var body: some View {
        Text(text).font(.system(size: 12, design: .monospaced)).foregroundStyle(color).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ToolBody: View {
    let block: Block
    static let maxOutput = 12_000

    var body: some View {
        let a = ToolInfo.args(block.args)
        let name = block.name.lowercased()
        let output = block.result?.content.map { $0["type"].string == "text" ? $0["text"].stringValue : "[\($0["type"].stringValue)]" }.joined(separator: "\n") ?? ""
        let failed = block.result?.isError == true
        let clipped = output.count > Self.maxOutput ? String(output.prefix(Self.maxOutput)) : output
        let path = ToolInfo.pick(a, "file_path", "path", "file")
        let command = ToolInfo.pick(a, "command", "cmd")
        VStack(alignment: .leading, spacing: 8) {
            if ToolInfo.isEdit(name), let edit = ToolInfo.edits(block.args) {
                VStack(alignment: .leading, spacing: 0) {
                    Caption(text: "Diff")
                    DiffBox(path: edit.path, edits: edit.edits)
                }
            } else if !command.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Caption(text: "Command")
                    PreBox(text: { var s = AttributedString("$ "); s.foregroundColor = Theme.mutedForeground; return s + AttributedString(command) }())
                }
            } else if (name == "write" || name.contains("write_file") || name.contains("create")), let content = (a["content"].string ?? a["contents"].string) {
                VStack(alignment: .leading, spacing: 0) {
                    FileHeader(path: path, trailing: Fmt.bytes(content.utf8.count))
                    PreBox(text: Highlighter.highlight(String(content.prefix(Self.maxOutput)), language: Highlighter.language(forPath: path)), maxHeight: 288)
                }
            } else if !(name == "read" || name.contains("read_file") || name == "view") {
                VStack(alignment: .leading, spacing: 0) {
                    Caption(text: "Args")
                    PreBox(text: AttributedString(String(a.pretty.prefix(Self.maxOutput))), relaxed: false)
                }
            }
            if !clipped.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    if (name == "read" || name.contains("read_file") || name == "view") && !failed {
                        FileHeader(path: path, trailing: ToolInfo.readRange(a))
                        let code = clipped.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
                            if let r = line.range(of: "→"), line[..<r.lowerBound].allSatisfy({ $0 == " " || $0.isNumber }) { return String(line[r.upperBound...]) }
                            return String(line)
                        }.joined(separator: "\n")
                        PreBox(text: Highlighter.highlight(code, language: Highlighter.language(forPath: path)), maxHeight: 288, relaxed: false)
                    } else {
                        Caption(text: "Result")
                        PreBox(text: AttributedString(clipped), color: failed ? Theme.warning : Theme.foreground, maxHeight: 288, relaxed: false)
                    }
                    if output.count > Self.maxOutput {
                        Text("Preview limited · \(Fmt.bytes(output.utf8.count)) total").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground).padding(.top, 4)
                    }
                }
            }
        }
    }
}

private struct FileHeader: View {
    let path: String
    let trailing: String
    var body: some View {
        HStack(spacing: 6) {
            Glyph(name: "file-text", size: 12, color: Theme.mutedForeground)
            Text(path).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 4)
            Text(trailing)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.background.opacity(0.6)))
        .padding(.bottom, 4)
    }
}

/// Edit diff: header (FileDiff, path, +N −N) over the line diff.
private struct DiffBox: View {
    let path: String
    let edits: [(old: String, new: String)]
    var body: some View {
        let diffs = edits.map { LineDiff.compute($0.old, $0.new) }
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Glyph(name: "file-diff", size: 12, color: Theme.mutedForeground)
                Text(path).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                Text("+\(diffs.reduce(0) { $0 + $1.added })").foregroundStyle(Theme.success)
                Text("-\(diffs.reduce(0) { $0 + $1.removed })").foregroundStyle(Theme.destructive)
            }
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Theme.mutedForeground)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.muted.opacity(0.4))
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border.opacity(0.4)).frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(diffs.enumerated()), id: \.offset) { i, d in
                        if diffs.count > 1 {
                            Text("\(i + 1) / \(diffs.count)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.muted.opacity(0.3))
                        }
                        DiffView(diff: d)
                    }
                }
            }
            .frame(maxHeight: 256)
            .fixedSize(horizontal: false, vertical: true)
        }
        .background(RoundedRectangle(cornerRadius: 4).fill(Theme.background.opacity(0.6)))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }
}

/// `font-mono text-xs` pre-wrap text on CSS line boxes (leading-relaxed by default).
func monoProse(_ text: String, size: CGFloat = 12, lineHeight: CGFloat = 19.5, color: Color, prefix: (String, Color)? = nil) -> ProseText {
    let p = ProseBuilder.paragraphStyle()
    let m = NSMutableAttributedString()
    let font = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
    if let prefix {
        m.append(NSAttributedString(string: prefix.0, attributes: [.font: font, .foregroundColor: NSColor(prefix.1), .paragraphStyle: p, ProseBuilder.language: "en"]))
    }
    m.append(NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: NSColor(color), .paragraphStyle: p, ProseBuilder.language: "en"]))
    ProseBuilder.fallback(m)
    return ProseText(text: m, metrics: ProseMetrics(font: font, lineHeight: lineHeight))
}

/// Thinking row: chevron, brain, "Thinking", char count; body is mono muted.
struct ThinkingView: View {
    let text: String
    let streaming: Bool
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open.toggle() } label: {
                HStack(spacing: 8) {
                    Glyph(name: open ? "chevron-down" : "chevron-right", size: 12, color: Theme.mutedForeground)
                    Glyph(name: "brain", size: 12, color: Theme.mutedForeground)
                    Text("Thinking").font(.system(size: 12, weight: .medium)).lineBox(16.1875)
                    if streaming { Text("…").font(.system(size: 11)) }
                    Spacer(minLength: 4)
                    Text("\(text.count) chars").font(.system(size: 11).monospacedDigit())
                }
                .foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .hoverFill(Theme.muted.opacity(0.6), radius: 4)
            }
            .buttonStyle(.plain)
            .testID("thinking-step")
            if open {
                // `max-h-72 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 pt-1 font-mono text-xs leading-relaxed`
                ScrollView {
                    monoProse(text, color: Theme.mutedForeground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 8)
                }
                .frame(maxHeight: 288)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

enum ImageCache {
    nonisolated(unsafe) private static var cache: [Int: NSImage] = [:]
    static func image(_ base64: String) -> NSImage? {
        let key = base64.hashValue
        if let hit = cache[key] { return hit }
        guard let data = Data(base64Encoded: base64), let img = NSImage(data: data) else { return nil }
        cache[key] = img
        return img
    }
}

/// `flex max-w-xs items-center gap-2 rounded-lg border px-3 py-2`.
struct FileChip: View {
    let name: String
    let path: String
    var size: Int? = nil
    var user = false
    var body: some View {
        Button { System.reveal(path) } label: {
            HStack(spacing: 8) {
                Glyph(name: "file-text", size: 16, color: Theme.foreground.opacity(0.7))
                VStack(alignment: .leading, spacing: 0) {
                    Text(name).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    if let size { Text(Fmt.bytes(size)).font(.system(size: 11)).opacity(0.7) }
                }
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: 320, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(user ? Theme.primary.opacity(0.1) : Theme.muted.opacity(0.4)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(user ? Theme.primary.opacity(0.25) : Theme.border.opacity(0.6), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .help("\(path) — reveal in Finder")
    }
}

struct ImageThumb: View {
    let block: Block
    var body: some View {
        if let data = block.data, let img = ImageCache.image(data) {
            Image(nsImage: img).resizable().scaledToFit()
                .frame(maxHeight: 288)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border.opacity(0.4), lineWidth: 1))
                .help("Click to enlarge")
                .onTapGesture {
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("cetus-image-\(abs(data.hashValue)).png")
                    if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: url)
                        System.open(url.path)
                    }
                }
        }
    }
}

/// An answer block (text, image, file, custom).
struct BlockView: View {
    let block: Block
    var unit = ""
    var body: some View {
        switch block.kind {
        case .text:
            if !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                HStack(alignment: .lastTextBaseline, spacing: 0) {
                    MarkdownView(text: block.text, unit: unit)
                }
                .overlay(alignment: .bottomTrailing) { if block.streaming { StreamingCaret() } }
            }
        case .thinking:
            if !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { ThinkingView(text: block.text, streaming: block.streaming) }
        case .toolUse:
            if let r = block.result, case let list = ArtifactDetails.from(r.details), !list.isEmpty { ArtifactInlineList(artifacts: list) }
            else { ToolCard(block: block) }
        case .custom:
            if block.customType == "quick_context" { ContextChip(inner: block.text, user: false) }
            else if !block.text.isEmpty { Text(block.text).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground) }
        case .file:
            FileChip(name: block.text, path: block.path, size: block.sizeBytes)
        case .image:
            ImageThumb(block: block)
        }
    }
}

/// 6×14 block in the text color, pulsing.
private struct StreamingCaret: View {
    @State private var on = true
    var body: some View {
        Rectangle().fill(Theme.proseBody.opacity(0.7)).frame(width: 6, height: 14)
            .opacity(on ? 1 : 0.3)
            .onAppear { withAnimation(.easeInOut(duration: 1).repeatForever()) { on = false } }
            .hidden()
    }
}

/// Local `!` shell output card.
struct BashCard: View {
    let command: String
    let details: JSON
    var body: some View {
        let r = details["result"]
        let done = details["status"].string == "done"
        let output = [r["stdout"].stringValue, r["stderr"].stringValue].filter { !$0.isEmpty }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let code = r["exitCode"].int ?? 0
        let failed = done && (code != 0 || r["timedOut"].truthy)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Glyph(name: "terminal", size: 14, color: Theme.mutedForeground)
                Text("$").foregroundStyle(Theme.mutedForeground)
                Text(command).foregroundStyle(Theme.foreground.opacity(0.9)).lineLimit(1)
                Spacer(minLength: 4)
                if !done { Spinner(size: 12) }
                else {
                    Text(r["timedOut"].truthy ? "timed out" : "exit \(code)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(failed ? Theme.destructive : Theme.success)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill((failed ? Theme.destructive : Theme.success).opacity(0.1)))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border.opacity(0.4)).frame(height: 1) }
            ScrollView {
                Group {
                    if output.isEmpty && done { Text("(no output)").italic().foregroundStyle(Theme.mutedForeground) }
                    else { Text(output.count > 12000 ? "…" + output.suffix(12000) : output).foregroundStyle(Theme.foreground.opacity(0.9)) }
                }
                .lineSpacing(Prose.spacing(12, 19.5, mono: true))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 8)
            }
            .frame(maxHeight: 288)
            .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 12, design: .monospaced))
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.4)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .testID("bash-card")
    }
}

/// System notices in place of a bubble. Runtime switches are a full-width
/// divider (`py-3`); other breadcrumbs sit left in an 88% column (`py-2 gap-2`):
/// vision_describe → VisionCard, bash_exec → BashCard; anything else renders nothing.
struct CustomMessageView: View {
    let message: RenderedMessage
    var body: some View {
        Group {
            if let sw = message.blocks.first(where: { $0.kind == .custom && $0.customType == "runtime_switch" }) {
                HStack(spacing: 12) {
                    Rectangle().fill(Theme.border.opacity(0.6)).frame(height: 1)
                    HStack(spacing: 6) {
                        Glyph(name: "arrow-left-right", size: 12, color: Theme.mutedForeground.opacity(0.7))
                        Text("Runtime switched: \(sw.text)").lineBox(16.1875)
                    }
                    .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).fixedSize()
                    Rectangle().fill(Theme.border.opacity(0.6)).frame(height: 1)
                }
                .padding(.vertical, 12)
                .testID("runtime-switch")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, b in
                        if b.kind == .custom && b.customType == "vision_describe" { VisionCard(text: b.text, details: b.details) }
                        else if b.kind == .custom && b.customType == "bash_exec" { BashCard(command: b.text, details: b.details) }
                    }
                }
                .containerRelativeFrame(.horizontal, alignment: .leading) { w, _ in min(w, 768) * 0.88 }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transcriptRow()
    }
}

/// `rounded-md border border-border/60 bg-muted/40` disclosure of the vision model's description.
struct VisionCard: View {
    let text: String
    let details: JSON
    @State private var open = false
    var body: some View {
        let count = details["count"].int ?? 1
        let model = details["model"].string ?? "vision"
        VStack(alignment: .leading, spacing: 0) {
            Button { open.toggle() } label: {
                HStack(spacing: 8) {
                    Glyph(name: open ? "chevron-down" : "chevron-right", size: 14, color: Theme.foreground)
                    Glyph(name: "eye", size: 14, color: Theme.mutedForeground)
                    Text("vision_describe").font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Theme.foreground).lineBox(16.1875)
                    Spacer(minLength: 0)
                    Text("\(count) image\(count == 1 ? "" : "s") · \(model)").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.1875)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .testID("vision-card")
            if open {
                ScrollView {
                    ProseText(text: {
                        let m = NSMutableAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor(Theme.foreground).withAlphaComponent(0.9),
                                                                                    .paragraphStyle: ProseBuilder.paragraphStyle(), ProseBuilder.language: "en"])
                        ProseBuilder.fallback(m)
                        return m
                    }(), metrics: ProseMetrics(font: .systemFont(ofSize: 12), lineHeight: 19.5))
                    .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .frame(maxHeight: 288)
                .fixedSize(horizontal: false, vertical: true)
                .overlay(alignment: .top) { Rectangle().fill(Theme.border.opacity(0.4)).frame(height: 1) }
            }
        }
        .padding(1)
        .fixedSize(horizontal: !open, vertical: false)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.4)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
    }
}

/// Quick-context pill (globe, summary, chevron) with an expandable body.
struct ContextChip: View {
    let inner: String
    var user = true
    @State private var open = false
    var body: some View {
        VStack(alignment: user ? .trailing : .leading, spacing: 6) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Glyph(name: "globe", size: 12, color: user ? Theme.foreground.opacity(0.8) : Theme.mutedForeground)
                    Text(QuickContext.summary(inner))
                    Glyph(name: "chevron-right", size: 12, color: Theme.mutedForeground.opacity(0.6)).rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(user ? Theme.foreground.opacity(0.8) : Theme.mutedForeground)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(Capsule().fill(user ? Theme.primary.opacity(0.15) : Theme.muted.opacity(0.6)))
            }
            .buttonStyle(.plain)
            if open {
                ScrollView {
                    Text(inner).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240).fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.4)))
            }
        }
    }
}

/// Small icon-only action (kept for a few toolbars).
struct SmallAction: View {
    let icon: String
    let help: String
    var testID: String? = nil
    let action: () -> Void
    var body: some View {
        GhostIconButton(icon: icon, glyph: 12, testID: testID, action: action).help(help)
    }
}

/// Message action: `rounded-md px-1.5 py-1 text-xs` with a 12px icon and label.
struct MessageAction: View {
    let icon: String
    let label: String
    var testID: String? = nil
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Glyph(name: icon, size: 12, color: hover ? Theme.foreground : Theme.mutedForeground)
                Text(label).font(.system(size: 12)).foregroundStyle(hover ? Theme.foreground : Theme.mutedForeground)
                    .lineBox(16.1875)
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 8).fill(hover ? Theme.muted : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .testID(testID)
    }
}

/// Timestamp, Copy, Fork. Always occupies its row; only opacity changes.
struct MessageActions: View {
    /// Test hook: CETUS_TR_SHOWACTIONS=1 keeps every toolbar visible (hover can't reach a background window).
    static let forceVisible = ProcessInfo.processInfo.environment["CETUS_TR_SHOWACTIONS"] != nil

    /// WebKit en-US `toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})`.
    static func clock(_ ms: Double) -> String { fmt("hh:mm a").string(from: Date(timeIntervalSince1970: ms / 1000)) }
    /// `toLocaleString` with 2-digit date and seconds (the tooltip).
    static func full(_ ms: Double) -> String { fmt("MM/dd/yyyy, hh:mm:ss a").string(from: Date(timeIntervalSince1970: ms / 1000)) }
    /// DateFormatter is expensive to create and every transcript row formats its time.
    nonisolated(unsafe) private static var formatters: [String: DateFormatter] = [:]
    private static func fmt(_ f: String) -> DateFormatter {
        if let d = formatters[f] { return d }
        let d = DateFormatter()
        d.locale = Locale(identifier: "en_US_POSIX")
        d.dateFormat = f
        formatters[f] = d
        return d
    }
    let text: String
    let createdAt: Double
    let user: Bool
    let visible: Bool
    let onFork: () -> Void
    @State private var copied = false
    var body: some View {
        HStack(spacing: 4) {
            Text(Self.clock(createdAt)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground.opacity(0.7))
                .lineBox(16.1875)
                .padding(.horizontal, 4)
                .help(Self.full(createdAt))
            if !text.isEmpty {
                MessageAction(icon: copied ? "check" : "copy", label: copied ? "Copied" : "Copy") {
                    System.copy(text)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                }
            }
            MessageAction(icon: "git-fork", label: "Fork", action: onFork)
        }
        .frame(maxWidth: .infinity, alignment: user ? .trailing : .leading)
        .opacity(visible || MessageActions.forceVisible ? 1 : 0)
        .animation(.easeOut(duration: 0.12), value: visible)
    }
}

/// User prompt text with `@mention` tokens drawn as pills.
func mentionText(_ text: String, labels: [String], size: CGFloat) -> AttributedString {
    var a = AttributedString(text)
    for s in Mentions.spans(text, labels: labels) {
        let lower = text.distance(from: text.startIndex, to: s.range.lowerBound)
        let len = text.distance(from: s.range.lowerBound, to: s.range.upperBound)
        let start = a.characters.index(a.startIndex, offsetBy: lower)
        let end = a.characters.index(start, offsetBy: len)
        a[start ..< end].foregroundColor = Theme.primary
        a[start ..< end].font = .system(size: size, weight: .medium)
        a[start ..< end].backgroundColor = Theme.background.opacity(0.7)
    }
    // Bare URLs are links (underlined, text-colored).
    if let re = try? NSRegularExpression(pattern: "https?://[^\\s<>\"]+") {
        for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let r = Range(m.range, in: text), let url = URL(string: String(text[r])) else { continue }
            let lower = text.distance(from: text.startIndex, to: r.lowerBound)
            let start = a.characters.index(a.startIndex, offsetBy: lower)
            let end = a.characters.index(start, offsetBy: text.distance(from: r.lowerBound, to: r.upperBound))
            a[start ..< end].link = url
            a[start ..< end].underlineStyle = .single
            a[start ..< end].foregroundColor = Theme.foreground
        }
    }
    return a
}

/// User prompt as plain pre-wrap text: `@mention` pills and underlined bare URLs.
@MainActor
func userTextAttributed(_ text: String, labels: [String], size: CGFloat, find: FindHighlight?, unit: String) -> NSAttributedString {
    let para = ProseBuilder.paragraphStyle()
    let m = NSMutableAttributedString(string: text, attributes: [
        .font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor(Theme.foreground),
        .paragraphStyle: para, ProseBuilder.language: "en",
    ])
    let ns = text as NSString
    // `bg-background/70 dark:bg-background/40`.
    let mentionFill = NSColor(name: nil) { a in
        NSColor(Theme.background).withAlphaComponent(a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? 0.4 : 0.7)
    }
    for sp in Mentions.spans(text, labels: labels) {
        let r = NSRange(sp.range, in: text)
        m.addAttributes([.font: NSFont.systemFont(ofSize: size, weight: .medium), .foregroundColor: NSColor(Theme.primary),
                         ProseKey.code: 1, ProseKey.mention: mentionFill], range: r)
        if r.location > 0, ns.character(at: r.location - 1) != 0x0A {
            let prev = (m.attribute(.kern, at: r.location - 1, effectiveRange: nil) as? CGFloat) ?? 0
            m.addAttribute(.kern, value: prev + 4, range: NSRange(location: r.location - 1, length: 1))
        } else {
            // A pill opening a paragraph (`@goal …`) has no previous glyph to kern:
            // indent the first line instead, or its left padding is clipped at x=0.
            let indented = para.mutableCopy() as! NSMutableParagraphStyle
            indented.firstLineHeadIndent = 4
            m.addAttribute(.paragraphStyle, value: indented, range: ns.paragraphRange(for: r))
        }
        if r.length > 0 { m.addAttribute(.kern, value: 4, range: NSRange(location: NSMaxRange(r) - 1, length: 1)) }
    }
    if let re = try? NSRegularExpression(pattern: "(?:https?://|www\\.)[^\\s<>\"]+") {
        for match in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var url = ns.substring(with: match.range)
            if let cut = url.firstIndex(where: { !$0.isASCII && ($0.isPunctuation || $0.isSymbol) }) { url = String(url[..<cut]) }
            url = url.replacingOccurrences(of: "[.,;:!?)\\]}'\"]+$", with: "", options: .regularExpression)
            guard !url.isEmpty, let u = URL(string: url.hasPrefix("www.") ? "https://" + url : url) else { continue }
            m.addAttributes([.link: u, .underlineStyle: NSUnderlineStyle.single.rawValue], range: NSRange(location: match.range.location, length: (url as NSString).length))
        }
    }
    if let find, !find.query.isEmpty, let base = find.offsets[unit] {
        for (i, r) in FindHighlight.ranges(text, find.query).enumerated() {
            m.addAttribute(ProseKey.find, value: base + i == find.active ? NSColor(Theme.primary).withAlphaComponent(0.55) : NSColor(Theme.foreground).withAlphaComponent(0.18), range: NSRange(r, in: text))
        }
    }
    ProseBuilder.fallback(m)
    return m
}

struct UserMessageView: View {
    @Environment(AppState.self) private var app
    let message: RenderedMessage
    let onFork: () -> Void
    @Environment(\.findHighlight) private var find
    @Environment(\.fontScale) private var scale
    @Environment(\.lineScale) private var lineScale
    @State private var hover = false

    private func userText(_ text: String, labels: [String], size: CGFloat, unit: String) -> NSAttributedString {
        userTextAttributed(text, labels: labels, size: size, find: find, unit: unit)
    }

    var body: some View {
        let textBlocks = message.blocks.filter { $0.kind == .text }
        let full = textBlocks.map(\.text).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        let quoted = UserQuote.split(full)
        let text = quoted?.text ?? full
        let labels = textBlocks.flatMap(\.mentions)
        let attachments = message.blocks.filter { $0.kind == .image || $0.kind == .file }
        let size = (15 * scale).rounded()
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(Array(message.blocks.enumerated()), id: \.offset) { _, b in
                if b.kind == .custom && b.customType == "quick_context" { ContextChip(inner: b.text) }
            }
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, b in
                if b.kind == .image { ImageThumb(block: b) } else { FileChip(name: b.text, path: b.path, size: b.sizeBytes, user: true) }
            }
            if let quoted {
                // Quote header: `text-md leading-relaxed text-muted-foreground line-clamp-2`.
                HStack(alignment: .top, spacing: 6) {
                    Glyph(name: "corner-down-right", size: 14, color: Theme.mutedForeground.opacity(0.7)).padding(.top, 4)
                    Text(quoted.quote).font(.system(size: (14 * scale).rounded())).foregroundStyle(Theme.mutedForeground)
                        .lineSpacing((14 * scale).rounded() * 0.625).lineLimit(2).truncationMode(.tail)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 4)
                .testID("message-quote")
            }
            if !text.isEmpty {
                // `rounded-2xl bg-primary/20 px-4 py-2`, `text-base leading-relaxed whitespace-pre-wrap`, w-fit.
                ProseText(text: userText(text, labels: labels, size: size, unit: "\(message.key):u"),
                          metrics: ProseMetrics(font: .systemFont(ofSize: size), lineHeight: size * 1.625 * lineScale), fit: true)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Theme.userBubble))
            }
            MessageActions(text: full, createdAt: message.createdAt, user: true, visible: hover, onFork: onFork)
        }
        .containerRelativeFrame(.horizontal, alignment: .trailing) { w, _ in min(w, 768) * 0.88 }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .background(TranscriptScrollProbe())
        .transcriptRow()
        .testID("message-\(message.key)")
    }
}

// MARK: - Turns

/// A rendered transcript row: a user prompt, a custom breadcrumb, or one
/// assistant turn (all assistant messages between two prompts).
enum TranscriptItem: Identifiable {
    case user(RenderedMessage, turn: Int)
    case custom(RenderedMessage)
    case assistant(AssistantTurn)

    var id: String {
        switch self {
        case .user(let m, _), .custom(let m): return m.key
        case .assistant(let t): return t.key
        }
    }
}

struct AssistantTurn {
    var key: String
    var blocks: [Block]
    /// createdAt of the message each block came from.
    var times: [Double]
    var startAt: Double
    var endAt: Double
    var promptAt: Double?
    var turn: Int
    var live: Bool
    var last: Bool

    enum Segment {
        case activity(key: String, steps: [Block], durationMs: Double, defaultOpen: Bool, trailing: Bool)
        case answer(index: Int, block: Block)
    }

    /// Port of Cetus's buildAssistantSegments.
    var segments: [Segment] {
        let flat = blocks.enumerated().filter { _, b in
            !((b.kind == .thinking || b.kind == .text) && b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !b.streaming)
        }.map { (i: $0.offset, b: $0.element, at: times[$0.offset]) }
        func isProcess(_ b: Block) -> Bool { b.kind == .thinking || (b.kind == .toolUse && !ArtifactInlineList.has(b)) }
        var boundary = -1
        var hasProcess = false
        for (i, f) in flat.enumerated() {
            if isProcess(f.b) { hasProcess = true }
            if f.b.kind == .text && !f.b.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { boundary = i }
        }
        while boundary > 0 && flat[boundary - 1].b.kind == .text { boundary -= 1 }
        if boundary < 0 { boundary = max(0, flat.count - 1) }
        enum Mode { case history, tail, attention, live }
        var out: [Segment] = []
        var run: (key: String, steps: [Block], start: Double, dur: Double, open: Bool)?
        var mode: Mode?
        func close(_ at: Double?) {
            if var r = run {
                if let at { r.dur = max(r.dur, at - r.start) }
                out.append(.activity(key: r.key, steps: r.steps, durationMs: r.dur, defaultOpen: r.open, trailing: false))
            }
            run = nil
            mode = nil
        }
        for (i, f) in flat.enumerated() {
            let process = isProcess(f.b)
            let status = f.b.kind == .toolUse ? f.b.toolStatus : nil
            let attention = status == .running || status == .incomplete
            let keepText = f.b.kind == .text && f.b.phase == "final_answer"
            let foldText = !live && hasProcess && i < boundary && f.b.kind == .text && !keepText
            if !process && !foldText {
                close(f.at)
                out.append(.answer(index: f.i, block: f.b))
                continue
            }
            let m: Mode = live ? .live : attention ? .attention : i < boundary ? .history : .tail
            if run == nil || mode != m {
                close(f.at)
                run = ("\(key):\(f.i)", [], f.at, 0, !live && m != .history)
                mode = m
            }
            let end = max(run!.start + run!.dur, f.at)
            run!.start = min(run!.start, f.at)
            run!.dur = end - run!.start
            run!.steps.append(f.b)
        }
        if let r = run {
            out.append(.activity(key: r.key, steps: r.steps, durationMs: r.dur, defaultOpen: r.open, trailing: true))
        }
        return out
    }

    var answerText: String {
        segments.compactMap { if case .answer(_, let b) = $0, b.kind == .text { return b.text } else { return nil } }
            .joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum TranscriptLayout {
    static func items(_ state: ChatState) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var turn = -1
        var current: AssistantTurn?
        var lastPromptAt: Double?
        func flush() {
            if let c = current { items.append(.assistant(c)) }
            current = nil
        }
        for m in state.messages {
            switch m.role {
            case .user:
                flush()
                turn += 1
                lastPromptAt = m.createdAt
                items.append(.user(m, turn: turn))
            case .assistant:
                if current == nil {
                    current = AssistantTurn(key: "turn-\(m.key)", blocks: [], times: [], startAt: m.createdAt, endAt: m.createdAt, promptAt: lastPromptAt, turn: turn, live: false, last: false)
                }
                current!.blocks += m.blocks
                current!.times += Array(repeating: m.createdAt, count: m.blocks.count)
                current!.endAt = m.createdAt
            default:
                flush()
                items.append(.custom(m))
            }
        }
        flush()
        if case .assistant(var t) = items.last {
            t.last = true
            t.live = state.isStreaming
            items[items.count - 1] = .assistant(t)
        }
        return items
    }

    /// Each find unit's first match index, in document order, plus the total
    /// and which item holds each match (to scroll there).
    static func findIndex(_ items: [TranscriptItem], query: String) -> (offsets: [String: Int], total: Int, owners: [String]) {
        var offsets: [String: Int] = [:]
        var owners: [String] = []
        var total = 0
        guard !query.isEmpty else { return ([:], 0, []) }
        func add(_ unit: String, _ text: String, owner: String) {
            let n = FindHighlight.ranges(text, query).count
            offsets[unit] = total
            total += n
            owners += Array(repeating: owner, count: n)
        }
        for item in items {
            switch item {
            case .user(let m, _):
                let text = m.blocks.filter { $0.kind == .text }.map(\.text).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                add("\(m.key):u", text, owner: item.id)
                // messageFindText counts extension breadcrumbs (custom blocks) too.
                let crumbs = m.blocks.filter { $0.kind == .custom }.map(\.text).joined(separator: "\n")
                if !crumbs.isEmpty { add("\(m.key):c", crumbs, owner: item.id) }
            case .assistant(let t):
                for seg in t.segments {
                    guard case .answer(let bi, let b) = seg, b.kind == .text else { continue }
                    for (li, s) in MarkdownParser.searchable(b.text).enumerated() { add("\(t.key):\(bi):\(li)", s, owner: item.id) }
                }
            case .custom(let m):
                // Counted like Cetus (custom blocks' text), even where the card is collapsed.
                add("\(m.key):c", m.blocks.filter { $0.kind == .custom || $0.kind == .text }.map(\.text).joined(separator: "\n"), owner: item.id)
            }
        }
        return (offsets, total, owners)
    }
}

/// An activity run: a boxed live bar while the turn runs, a plain fold line once settled.
struct ActivityView: View {
    let steps: [Block]
    let live: Bool
    let trailing: Bool
    let startedAt: Double?
    let durationMs: Double
    let defaultOpen: Bool
    @State private var open: Bool? = nil

    var body: some View {
        let expanded = open ?? defaultOpen
        if live { liveBox(expanded) } else { fold(expanded) }
    }

    private var tools: Int { steps.filter { $0.kind == .toolUse }.count }
    private var failed: Bool { steps.contains { $0.kind == .toolUse && $0.toolStatus == .error } }
    private var incomplete: Bool { steps.contains { $0.kind == .toolUse && $0.toolStatus == .incomplete } }

    private func rows() -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, b in
                switch b.kind {
                case .text: MarkdownView(text: b.text, baseSize: 15).padding(.horizontal, 8).padding(.vertical, 4)
                default: BlockView(block: b)
                }
            }
        }
    }

    private func liveBox(_ expanded: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open = !expanded } label: {
                HStack(spacing: 8) {
                    Glyph(name: expanded ? "chevron-down" : "chevron-right", size: 14, color: Theme.mutedForeground)
                    Spinner(size: 14)
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        HStack(spacing: 0) {
                            Text("Working…").fontWeight(.medium).foregroundStyle(Theme.foreground)
                            if let s = startedAt, let d = Fmt.stepDuration(nowMs() - s) { Text(" · \(d)").monospacedDigit() }
                            if tools > 0 { Text(" · \(tools) step\(tools == 1 ? "" : "s")") }
                            if let b = steps.last(where: { $0.kind == .toolUse }) {
                                Text(" · \(b.name) \(ToolInfo.rowSummary(b.name, b.args))").font(.system(size: 12, design: .monospaced)).lineLimit(1)
                            }
                        }
                        .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.mutedForeground)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .testID("activity")
            if expanded {
                rows()
                    .padding(6)
                    .overlay(alignment: .top) { Rectangle().fill(Theme.border.opacity(0.4)).frame(height: 1) }
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.3)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border.opacity(0.6), lineWidth: 1))
    }

    private func fold(_ expanded: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { open = !expanded } label: {
                HStack(spacing: 4) {
                    if failed { Glyph(name: "alert-circle", size: 12, color: Theme.warning) }
                    else if incomplete { Glyph(name: "circle-slash", size: 12, color: Theme.mutedForeground) }
                    Text(label).lineBox(16.1875)
                    Glyph(name: expanded ? "chevron-down" : "chevron-right", size: 12, color: Theme.mutedForeground)
                }
                .font(.system(size: 12))
                .foregroundStyle(Theme.mutedForeground)
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .testID("activity")
            if expanded { rows() }
        }
    }

    private var label: String {
        let d = Fmt.stepDuration(durationMs)
        var s: String
        if tools > 0 { s = "\(tools) step\(tools == 1 ? "" : "s")" + (d.map { " · \($0)" } ?? "") }
        else if let d { s = "Worked for \(d)" }
        else { s = steps.contains { $0.kind == .thinking } ? "Thought" : "Progress updates" }
        if trailing, let last = steps.last, last.kind == .toolUse || last.kind == .thinking, tools > 0 { s = "Turn ended · " + s }
        if failed { s += " · Contains failed steps" } else if incomplete { s += " · Result not received" }
        return s
    }
}

struct AssistantTurnView: View {
    let turn: AssistantTurn
    let startedAt: Double?
    let lastDurationMs: Double?
    let onFork: () -> Void
    @State private var hover = false

    var body: some View {
        let segments = turn.segments
        if segments.isEmpty {
            if turn.live { ThinkingPlaceholder(since: startedAt).padding(.vertical, 12) }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                RoleLabel().lineBox(15.390625)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                        switch seg {
                        case .activity(let key, let steps, let dur, let open, let trailing):
                            ActivityView(steps: steps, live: turn.live && trailing, trailing: trailing,
                                         startedAt: startedAt, durationMs: trailing && turn.last && !turn.live ? (lastDurationMs ?? dur) : dur,
                                         defaultOpen: open)
                                .id(key)
                                .containerRelativeFrame(.horizontal, alignment: .leading) { w, _ in min(w, 768) * 0.88 }
                        case .answer(let i, let b):
                            BlockView(block: b, unit: "\(turn.key):\(i)")
                                .containerRelativeFrame(.horizontal, alignment: .leading) { w, _ in min(w, 768) * 0.88 }
                        }
                    }
                }
                MessageActions(text: turn.answerText, createdAt: turn.endAt, user: false, visible: hover && !turn.live, onFork: onFork)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .background(TranscriptScrollProbe())
            .transcriptRow()
            .testID("message-\(turn.key)")
        }
    }
}
