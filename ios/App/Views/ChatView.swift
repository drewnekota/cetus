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
    @State private var switchingRuntime = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if model.timeline.truncated {
                    Text("Showing recent messages. Earlier ones are on your Mac.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity)
                }
                ForEach(model.timeline.messages) { m in
                    MessageView(message: m)
                }
                if model.running {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).tint(Theme.muted)
                        Text("Working…").font(.subheadline).foregroundStyle(Theme.muted)
                    }
                    .padding(.leading, 2)
                }
                if !model.loaded && model.error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Theme.background)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if let control = model.timeline.controls.first {
                    ControlCard(control: control) { allow, answers in
                        Task { await model.respond(control, allow: allow, answers: answers) }
                    }
                }
                if let error = model.error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .onTapGesture { model.error = nil }
                }
                ComposerBar(
                    text: $model.draft,
                    images: $model.images,
                    running: model.running,
                    onSend: { Task { await model.send() } },
                    onStop: { Task { await model.abort() } }
                ) {
                    Button {
                        switchingRuntime = true
                    } label: {
                        RuntimeChip(backend: model.conversation?.backend ?? "pi")
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 6)
            .background(Theme.background)
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
                    Button("Switch Runtime", systemImage: "arrow.left.arrow.right") { switchingRuntime = true }
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
        .confirmationDialog("Switch Runtime", isPresented: $switchingRuntime) {
            ForEach(Runtime.allCases) { r in
                Button(r.label) {
                    Task {
                        try? await store.update(model.conversationId, ["backend": .string(r.rawValue)])
                    }
                }
            }
        }
    }
}

// MARK: - Messages

private struct MessageView: View {
    let message: ChatMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(message.blocks) { block in
                        switch block {
                        case .text(_, let text, _):
                            Text(text)
                                .font(Theme.content)
                                .textSelection(.enabled)
                        case .image:
                            Label("Image", systemImage: "photo")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        default:
                            EmptyView()
                        }
                    }
                }
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.raised, in: UnevenRoundedRectangle(
                    topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 3,
                    style: .continuous))
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(message.blocks) { block in
                    switch block {
                    case .text(_, let text, _):
                        MarkdownText(text: text)
                    case .thinking(_, let text, let streaming):
                        ThinkingView(text: text, streaming: streaming)
                    case .tool(_, _, let name, let args, let result):
                        ToolView(name: name, arguments: args, result: result)
                    case .image:
                        Label("Image", systemImage: "photo").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct ThinkingView: View {
    let text: String
    let streaming: Bool
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
                .textSelection(.enabled)
        } label: {
            Label(streaming ? "Thinking…" : "Thought", systemImage: "sparkle")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
        }
        .tint(Theme.muted)
    }
}

private struct ToolView: View {
    let name: String
    let arguments: JSON
    let result: JSON?
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    if result == nil {
                        ProgressView().controlSize(.mini).tint(Theme.muted)
                    } else {
                        Image(systemName: ToolView.symbol(for: name))
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 14)
                    }
                    Text(name)
                        .font(Theme.label)
                        .foregroundStyle(Theme.muted)
                    Text(arguments.argumentPreview)
                        .font(.footnote.monospaced())
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.faint)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    CodeBox(title: "Arguments", text: arguments.prettyText)
                    if let result {
                        CodeBox(title: "Result", text: String(result.toolResultText.prefix(8000)))
                    }
                }
                .padding(10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    static func symbol(for tool: String) -> String {
        switch tool.lowercased() {
        case "bash", "shell", "exec_command", "local_shell": "terminal"
        case "read", "read_file", "view": "doc.text"
        case "edit", "write", "multiedit", "apply_patch", "str_replace_editor": "pencil"
        case "grep", "glob", "search", "find": "magnifyingglass"
        case "webfetch", "websearch", "web_search": "globe"
        case "task", "agent": "person.2"
        case "todowrite", "update_plan": "checklist"
        default: "wrench.and.screwdriver"
        }
    }
}

private struct CodeBox: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
            }
            .frame(maxHeight: 280)
        }
    }
}

/// Light Markdown: fenced code blocks as monospaced boxes, `#` headings in
/// semibold, everything else through Foundation's inline Markdown.
struct MarkdownText: View {
    let text: String

    private enum Part: Hashable {
        case prose(String)
        case code(String)
    }

    private var parts: [Part] {
        var out: [Part] = []
        var prose: [Substring] = []
        var code: [Substring] = []
        var inCode = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if inCode {
                    out.append(.code(code.joined(separator: "\n")))
                    code = []
                } else if !prose.isEmpty {
                    out.append(.prose(prose.joined(separator: "\n")))
                    prose = []
                }
                inCode.toggle()
            } else if inCode {
                code.append(line)
            } else {
                prose.append(line)
            }
        }
        if inCode { out.append(.code(code.joined(separator: "\n"))) }
        if !prose.isEmpty { out.append(.prose(prose.joined(separator: "\n"))) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                switch part {
                case .prose(let s):
                    Text(Self.render(s))
                        .font(Theme.content)
                        .foregroundStyle(Theme.text)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let s):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(s)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(10)
                    }
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
            if let m = line.firstMatch(of: /^#{1,6}\s+/) {
                line.removeSubrange(m.range)
                heading = true
            } else if let m = line.firstMatch(of: /^(\s*)[-*]\s+/) {
                line.replaceSubrange(m.range, with: "\(m.1)• ")
            }
            var piece = (try? AttributedString(
                markdown: line,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
            )) ?? AttributedString(line)
            if heading { piece.font = .system(size: 15, weight: .semibold) }
            result += piece
            if i < lines.count - 1 { result += AttributedString("\n") }
        }
        return result
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
