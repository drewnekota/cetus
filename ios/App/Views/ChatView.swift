import CetusRemoteKit
import PhotosUI
import SwiftUI

struct ChatView: View {
    @Environment(RemoteStore.self) private var store
    let conversationId: String
    @State private var model: ChatModel?

    var body: some View {
        Group {
            if let model {
                ChatContent(model: model)
            } else {
                ProgressView()
            }
        }
        .task(id: conversationId) {
            let m = ChatModel(conversationId: conversationId, store: store)
            model = m
            store.activeChat = m
            await m.load()
        }
        .onDisappear {
            if store.activeChat?.conversationId == conversationId { store.activeChat = nil }
        }
    }
}

private struct ChatContent: View {
    @Environment(RemoteStore.self) private var store
    @Bindable var model: ChatModel
    @State private var renaming = false
    @State private var newTitle = ""
    /// Open activity groups, kept here so they survive LazyVStack recycling.
    @State private var expanded: Set<String> = []
    /// The bottom of the transcript is on screen.
    @State private var atBottom = true
    @State private var sent = 0
    private static let bottomId = "bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.timeline.truncated {
                        Text("Showing recent messages. Earlier ones are on your Mac.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity)
                    }
                    let items = model.timeline.items(running: model.running)
                    ForEach(items) { item in
                        switch item {
                        case .user(let m):
                            UserBubble(message: m)
                        case .assistant(let turn):
                            AssistantTurnView(turn: turn, startedAt: model.turnStartedAt, expanded: $expanded)
                        }
                    }
                    // Between the send and the first block of the reply; an
                    // open turn carries the line itself.
                    if model.running, !(items.last?.isActiveTurn ?? false) {
                        VStack(alignment: .leading, spacing: 8) {
                            AssistantLabel()
                            WorkingIndicator(startedAt: model.turnStartedAt)
                        }
                    }
                    if let error = model.error {
                        MessageErrorRow(
                            message: error,
                            retrying: model.retrying,
                            onRetry: { Task { await model.retry() } },
                            onDismiss: { model.error = nil }
                        )
                    }
                    if !model.loaded && model.error == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomId)
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(Theme.background)
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .tapDismissesKeyboard()
            .overlay(alignment: .bottom) {
                if !atBottom && model.loaded {
                    Button {
                        withAnimation(.snappy) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.text)
                            .frame(width: 36, height: 36)
                            .background(Theme.surface, in: Circle())
                            .overlay(Circle().strokeBorder(Theme.borderAccent, lineWidth: 1))
                            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
                    }
                    .padding(.bottom, 10)
                    .transition(.opacity.combined(with: .scale(scale: 0.8)))
                }
            }
            .animation(.snappy(duration: 0.2), value: atBottom)
            .onChange(of: sent) {
                withAnimation(.snappy) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 8) {
                    if !model.queued.isEmpty {
                        QueuedMessagesView(
                            items: model.queued,
                            onSteer: model.steer,
                            onEdit: model.editQueued,
                            onRemove: model.removeQueued
                        )
                    }
                    if let control = model.timeline.controls.first {
                        ControlCard(control: control) { allow, answers in
                            Task { await model.respond(control, allow: allow, answers: answers) }
                        }
                    }
                    if let reason = model.timeline.compacting {
                        CompactionBar(reason: reason)
                    }
                    ComposerBar(
                        text: $model.draft,
                        images: $model.images,
                        placeholder: model.running ? "Queue a follow-up" : "Message",
                        running: model.running,
                        onSend: {
                            sent += 1
                            Task { await model.send() }
                        },
                        onStop: { Task { await model.abort() } }
                    ) {
                        RuntimeMenu(selected: model.conversation?.backend ?? "pi") { r in
                            Task { try? await store.update(model.conversationId, ["backend": .string(r.rawValue)]) }
                        } label: {
                            RuntimeChip(backend: model.conversation?.backend ?? "pi")
                        }
                        if let c = model.conversation, let tuning = store.tunings[c.backend], !tuning.isEmpty,
                           let summary = tuning.summary(model: c.model, effort: c.effort)
                        {
                            TuningMenu(tuning: tuning, model: c.model, effort: c.effort) { choice in
                                choice.save(c.backend)
                                Task {
                                    do {
                                        try await store.update(c.id, store.tuningParams(choice, backend: c.backend))
                                    } catch {
                                        model.error = error.localizedDescription
                                    }
                                }
                            } label: {
                                TuningChip(text: summary)
                            }
                            // A new model restarts the runtime's process, which
                            // would cut a run short.
                            .disabled(model.running)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 6)
                .padding(.bottom, 6)
                .background(Theme.background)
            }
        }
        .task(id: "\(model.conversation?.backend ?? "") \(store.state == .connected)") {
            if let backend = model.conversation?.backend { await store.loadTuning(backend) }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(model.conversation?.displayTitle ?? "Chat")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    if let c = model.conversation {
                        HStack(spacing: 4) {
                            Text(store.folderName(c.workspaceDir))
                            Text("·")
                            Image(systemName: "laptopcomputer").font(.system(size: 9))
                            Text(store.selectedHost?.macName ?? "Mac")
                        }
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Rename", systemImage: "pencil") {
                        newTitle = model.conversation?.title ?? ""
                        renaming = true
                    }
                    RuntimeMenu(selected: model.conversation?.backend ?? "pi") { r in
                        Task { try? await store.update(model.conversationId, ["backend": .string(r.rawValue)]) }
                    } label: {
                        Label("Switch Runtime", systemImage: "arrow.left.arrow.right")
                    }
                    if let c = model.conversation {
                        Button(c.archived ? "Unarchive" : "Archive", systemImage: "archivebox") {
                            Task { try? await store.update(c.id, ["archived": .bool(!c.archived)]) }
                        }
                    }
                    if model.running {
                        Button("Stop", systemImage: "stop.circle", role: .destructive) {
                            Task { await model.abort() }
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .foregroundStyle(Theme.text)
                        .frame(width: 32, height: 32)
                }
            }
        }
        .alert("Rename Chat", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Cancel", role: .cancel) {}
            Button("Save") {
                Task { try? await store.update(model.conversationId, ["title": .string(newTitle)]) }
            }
        }
        #if DEBUG
        // `-demoExpand YES` (with `-demoSnapshot`): open every activity group.
        .task(id: model.loaded) {
            guard UserDefaults.standard.bool(forKey: "demoExpand") else { return }
            for case .assistant(let turn) in model.timeline.items(running: model.running) {
                for case .activity(let key, let steps, _) in turn.segments {
                    expanded.insert(key)
                    // `-demoExpandSteps YES`: open the tool rows too.
                    guard UserDefaults.standard.bool(forKey: "demoExpandSteps") else { continue }
                    for case .tool(_, let callId, _, _, _) in steps { expanded.insert("st\(callId)") }
                }
            }
        }
        #endif
    }
}

private extension TimelineItem {
    var isActiveTurn: Bool {
        if case .assistant(let turn) = self { return turn.active }
        return false
    }
}

// MARK: - Messages

private struct UserBubble: View {
    let message: ChatMessage

    private var text: String {
        message.blocks.compactMap { b -> String? in
            if case .text(_, let t, _) = b { return t }
            return nil
        }
        .joined(separator: "\n\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                // Photos sit above the bubble, as in Messages.
                ForEach(message.blocks) { block in
                    if case .image(let id, let data) = block {
                        MessageImage(id: id, data: data, maxSide: 200)
                    }
                }
                if !text.isEmpty {
                    Text(text)
                        .font(Theme.content)
                        .lineSpacing(2)
                        .foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.raised, in: UnevenRoundedRectangle(
                            topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 18, topTrailingRadius: 4,
                            style: .continuous))
                }
            }
        }
    }
}

/// A whole assistant turn: process steps fold into one-line summaries, the
/// answer stays open — the desktop's AssistantGroup.
private struct AssistantTurnView: View {
    let turn: AssistantTurn
    let startedAt: Date
    @Binding var expanded: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            AssistantLabel()
            ForEach(turn.segments) { seg in
                switch seg {
                case .activity(let key, let steps, let trailing):
                    // Pure thinking at the live edge has nothing to sum up
                    // yet; the working line below says it.
                    if !(turn.active && trailing && !seg.hasTool) {
                        ActivityGroupView(
                            steps: steps,
                            turnEnded: !turn.active && trailing,
                            active: turn.active,
                            open: Binding(
                                get: { expanded.contains(key) },
                                set: { if $0 { expanded.insert(key) } else { expanded.remove(key) } }
                            ),
                            expanded: $expanded
                        )
                    }
                case .answer(let block):
                    StepView(block: block, active: turn.active, expanded: $expanded)
                }
            }
            if turn.active {
                WorkingIndicator(startedAt: startedAt)
            }
            if !turn.active, !answerText.isEmpty {
                CopyButton(text: answerText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var answerText: String {
        turn.segments.compactMap { seg -> String? in
            if case .answer(.text(_, let t, _)) = seg { return t }
            return nil
        }
        .joined(separator: "\n\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The small caps line that heads every reply, as on the desktop.
struct AssistantLabel: View {
    var body: some View {
        Text("ASSISTANT")
            .font(.system(size: 11, weight: .medium))
            .kerning(0.6)
            .foregroundStyle(Theme.muted)
    }
}

private struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 13))
                .foregroundStyle(Theme.faint)
                .frame(width: 32, height: 28, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
        .accessibilityLabel(copied ? "Copied" : "Copy reply")
    }
}

/// Light Markdown: fenced code and pipe tables as horizontally scrolling
/// boxes, `#` headings in semibold, rules, quotes and lists, everything
/// else through Foundation's inline Markdown.
struct MarkdownText: View {
    let text: String
    var color: Color = Theme.text

    private enum Part: Hashable {
        case prose(String)
        case code(String, language: String?)
        case table([[String]])
        case rule
    }

    private var parts: [Part] {
        var out: [Part] = []
        var prose: [Substring] = []
        var code: [Substring] = []
        var table: [[String]] = []
        var inCode = false
        var language: String?
        func flushProse() {
            // Drop blank edges so spacing comes from the stack, not "\n\n".
            while let f = prose.first, f.trimmingCharacters(in: .whitespaces).isEmpty { prose.removeFirst() }
            while let l = prose.last, l.trimmingCharacters(in: .whitespaces).isEmpty { prose.removeLast() }
            if !prose.isEmpty { out.append(.prose(prose.joined(separator: "\n"))) }
            prose = []
        }
        func flushTable() {
            if !table.isEmpty { out.append(.table(table)) }
            table = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    out.append(.code(code.joined(separator: "\n"), language: language))
                    code = []
                } else {
                    flushProse()
                    flushTable()
                    // "```ts title=…" names the language first.
                    language = trimmed.dropFirst(3).split(whereSeparator: { $0 == " " || $0 == "{" || $0 == "," })
                        .first.map { $0.lowercased() }
                }
                inCode.toggle()
            } else if inCode {
                code.append(line)
            } else if trimmed.hasPrefix("|") && trimmed.count > 1 {
                flushProse()
                // Skip the |---|:---:| separator row.
                if trimmed.allSatisfy({ "|-: ".contains($0) }) { continue }
                var cells = trimmed.split(separator: "|", omittingEmptySubsequences: false)
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                if cells.first == "" { cells.removeFirst() }
                if cells.last == "" { cells.removeLast() }
                table.append(cells)
            } else if trimmed.count >= 3, trimmed.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }),
                      Set(trimmed).count == 1
            {
                flushProse()
                flushTable()
                out.append(.rule)
            } else {
                flushTable()
                prose.append(line)
            }
        }
        if inCode { out.append(.code(code.joined(separator: "\n"), language: language)) }
        flushTable()
        flushProse()
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .prose(let s):
                    Text(Self.render(s))
                        .font(Theme.content)
                        .foregroundStyle(color)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let s, let language):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(SyntaxHighlighter.attributed(s, language: language))
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(Theme.text)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(12)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                case .table(let rows):
                    TableBox(rows: rows)
                case .rule:
                    Rectangle().fill(Theme.border).frame(height: 1).padding(.vertical, 2)
                }
            }
        }
    }

    private static func render(_ s: String) -> AttributedString {
        var result = AttributedString()
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false)
        for (i, raw) in lines.enumerated() {
            var line = String(raw)
            var heading = false
            var quote = false
            if let m = line.firstMatch(of: /^#{1,6}\s+/) {
                line.removeSubrange(m.range)
                heading = true
            } else if let m = line.firstMatch(of: /^\s*>\s?/) {
                line.removeSubrange(m.range)
                quote = true
            } else if let m = line.firstMatch(of: /^(\s*)[-*+]\s+\[( |x|X)\]\s+/) {
                line.replaceSubrange(m.range, with: "\(m.1)\(m.2 == " " ? "☐" : "☑︎") ")
            } else if let m = line.firstMatch(of: /^(\s*)[-*+]\s+/) {
                line.replaceSubrange(m.range, with: "\(m.1)•  ")
            }
            var piece = (try? AttributedString(
                markdown: line,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
            )) ?? AttributedString(line)
            for run in piece.runs where run.inlinePresentationIntent?.contains(.code) == true {
                piece[run.range].font = .system(size: 14, design: .monospaced)
                piece[run.range].backgroundColor = Theme.surface
            }
            if heading { piece.font = .system(size: 16, weight: .semibold) }
            if quote { piece.foregroundColor = Theme.muted }
            result += piece
            if i < lines.count - 1 { result += AttributedString("\n") }
        }
        return result
    }
}

/// A Markdown pipe table, first row as the header.
private struct TableBox: View {
    let rows: [[String]]

    var body: some View {
        let width = rows.map(\.count).max() ?? 0
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                    GridRow {
                        ForEach(0..<width, id: \.self) { c in
                            let cell = c < row.count ? row[c] : ""
                            Text((try? AttributedString(markdown: cell)) ?? AttributedString(cell))
                                .font(.system(size: 14, weight: r == 0 ? .semibold : .regular))
                                .foregroundStyle(Theme.text)
                                .frame(maxWidth: 240, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                        }
                    }
                    .background(r == 0 ? Theme.surface : Color.clear)
                    if r < rows.count - 1 {
                        Rectangle().fill(Theme.border).frame(height: 0.5).gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

// MARK: - Queue

/// Follow-ups waiting for the run to end, stacked above the composer. Steer
/// sends one into the running turn now.
private struct QueuedMessagesView: View {
    let items: [QueuedMessage]
    let onSteer: (QueuedMessage) -> Void
    let onEdit: (QueuedMessage) -> Void
    let onRemove: (QueuedMessage) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Divider().overlay(Theme.border) }
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                    Text(item.text.isEmpty ? "\(item.images.count) image\(item.images.count == 1 ? "" : "s")" : item.text)
                        .font(Theme.label)
                        .foregroundStyle(Theme.text)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !item.images.isEmpty && !item.text.isEmpty {
                        Image(systemName: "photo")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.muted)
                    }
                    Button {
                        onSteer(item)
                    } label: {
                        Label("Steer", systemImage: "arrow.turn.down.right")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, 10)
                            .frame(height: 28)
                            .background(Theme.raised, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    Menu {
                        Button("Edit", systemImage: "pencil") { onEdit(item) }
                        Button("Remove", systemImage: "trash", role: .destructive) { onRemove(item) }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 4)
                .padding(.vertical, 6)
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
        .sensoryFeedback(.impact(weight: .light), trigger: items.count)
    }
}

// MARK: - Control card

private struct ControlCard: View {
    let control: ControlRequest
    let respond: (Bool, [String: String]) -> Void
    @State private var answers: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(control.isQuestion ? "Question" : (control.toolName.isEmpty ? "Needs your approval" : control.toolName),
                  systemImage: control.isQuestion ? "questionmark.bubble" : "hand.raised")
                .font(.subheadline.weight(.semibold))
            if control.isQuestion {
                ForEach(control.questions, id: \.id) { q in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(q.text).font(.footnote)
                        if !q.options.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack {
                                    ForEach(q.options, id: \.self) { opt in
                                        Button(opt) { answers[q.id] = opt }
                                            .buttonStyle(.bordered)
                                            .tint(answers[q.id] == opt ? .accentColor : .secondary)
                                            .controlSize(.small)
                                    }
                                }
                            }
                        }
                        TextField("Answer", text: Binding(
                            get: { answers[q.id] ?? "" },
                            set: { answers[q.id] = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .font(.footnote)
                    }
                }
            } else {
                Text(control.input.argumentPreview.isEmpty ? control.input.prettyText : control.input.argumentPreview)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
            }
            HStack {
                Button("Deny", role: .destructive) { respond(false, [:]) }
                    .buttonStyle(.bordered)
                Spacer()
                Button(control.isQuestion ? "Submit" : "Allow") { respond(true, answers) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Theme.border, lineWidth: 0.5))
    }
}
