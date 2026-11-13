import CetusRemoteKit
import SwiftUI

/// The live "the agent is working" line: a braille spinner and the time the
/// turn has taken so far, as on the desktop. The steps themselves stay
/// folded behind the summary row above it.
struct WorkingIndicator: View {
    let startedAt: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    var body: some View {
        TimelineView(.periodic(from: startedAt, by: reduceMotion ? 1 : 0.08)) { context in
            // The Mac's clock may run ahead of the phone's.
            let t = max(0, context.date.timeIntervalSince(startedAt))
            let s = Int(t)
            HStack(spacing: 8) {
                Text(reduceMotion ? Self.frames[0] : Self.frames[Int(t / 0.08) % Self.frames.count])
                    .font(.system(size: 15, design: .monospaced))
                    .frame(width: 14)
                Text(s < 60 ? "\(s)s" : "\(s / 60)m \(String(format: "%02d", s % 60))s")
                    .font(Theme.label)
                    .monospacedDigit()
            }
            .foregroundStyle(Theme.muted)
            .padding(.vertical, 4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Working")
    }
}

/// A run of the agent's work (thinking, tool calls, narration between them)
/// folded into one summary line that expands the full timeline in place.
struct ActivityGroupView: View {
    let steps: [ChatBlock]
    let turnEnded: Bool
    /// The turn is still running: a step without a result is in progress.
    let active: Bool
    @Binding var open: Bool
    @Binding var expanded: Set<String>

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "wrench.adjustable")
                        .font(.system(size: 12))
                        .frame(width: 14)
                    Text((turnEnded ? "Turn ended · " : "") + AssistantSegment.summary(steps))
                        .font(Theme.label)
                        .lineLimit(1)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.faint)
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.muted)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(steps) { step in
                        switch step {
                        case .text(_, let text, _):
                            // Narration between tool runs: muted, still process.
                            MarkdownText(text: text, color: Theme.muted)
                                .padding(.vertical, 4)
                        default:
                            StepView(block: step, active: active, expanded: $expanded)
                        }
                    }
                }
            }
        }
    }
}

/// One block of a turn outside the prose: a thinking or tool row, an image.
struct StepView: View {
    let block: ChatBlock
    let active: Bool
    @Binding var expanded: Set<String>

    private var open: Binding<Bool> {
        let key = "s\(block.stepKey)"
        return Binding(
            get: { expanded.contains(key) },
            set: { if $0 { expanded.insert(key) } else { expanded.remove(key) } }
        )
    }

    var body: some View {
        switch block {
        case .text(_, let text, _):
            MarkdownText(text: text)
        case .thinking(_, let text, let streaming):
            ThinkingStepView(text: text, streaming: streaming, open: open)
        case .tool(_, _, let name, let args, let result):
            if let card = block.threadCard {
                ThreadCardView(card: card)
            } else if case let artifacts = block.artifacts, !artifacts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(artifacts) { ArtifactCard(artifact: $0) }
                }
            } else {
                ToolStepView(tool: ToolPresentation(name: name, arguments: args, result: result, active: active), open: open)
            }
        case .image(let id, let data):
            MessageImage(id: id, data: data)
        }
    }
}

private extension ChatBlock {
    /// Tool call ids outlive the refetch after a turn ends; block ids don't.
    var stepKey: String {
        if case .tool(_, let callId, _, _, _) = self, !callId.isEmpty { return "t\(callId)" }
        return "b\(id)"
    }
}

/// The leading part every step row shares: chevron, icon, title.
private struct StepRow<Title: View, Trailing: View>: View {
    let icon: String
    @Binding var open: Bool
    @ViewBuilder var title: Title
    @ViewBuilder var trailing: Trailing

    var body: some View {
        Button {
            withAnimation(.snappy(duration: 0.2)) { open.toggle() }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .frame(width: 10)
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .frame(width: 14)
                title
                Spacer(minLength: 4)
                trailing
            }
            .foregroundStyle(Theme.muted)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct ThinkingStepView: View {
    let text: String
    let streaming: Bool
    @Binding var open: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepRow(icon: "brain", open: $open) {
                Text("Thinking" + (streaming ? " …" : ""))
                    .font(.system(size: 13, weight: .medium))
            } trailing: {
                Text("\(text.count) chars")
                    .font(.system(size: 11))
                    .monospacedDigit()
            }
            if open {
                CodeBox(text: text, color: Theme.muted, plain: true)
                    .padding(.bottom, 6)
            }
        }
    }
}

private struct ToolStepView: View {
    let tool: ToolPresentation
    @Binding var open: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepRow(icon: tool.subagent == nil ? "wrench.adjustable" : "person.2", open: $open) {
                if tool.name.isEmpty {
                    Text("calling…").font(.system(size: 13, design: .monospaced)).italic()
                } else {
                    Text(tool.name)
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                if !tool.preview.isEmpty {
                    Text(tool.preview)
                        .font(.system(size: 13, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            } trailing: {
                switch tool.status {
                case .running:
                    ProgressView().controlSize(.mini).tint(Theme.muted)
                case .error:
                    Image(systemName: "exclamationmark.circle").font(.system(size: 12)).foregroundStyle(Theme.warning)
                case .incomplete:
                    Image(systemName: "circle.slash").font(.system(size: 12))
                case .settled:
                    Image(systemName: "checkmark.circle").font(.system(size: 12)).foregroundStyle(Theme.success)
                }
            }
            if let steps = tool.subagent?.steps, !steps.isEmpty {
                SubagentSteps(steps: steps, all: open, running: tool.status == .running)
            }
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if let kind = tool.argumentsKind {
                        section(kind == .diff ? "Diff" : kind == .command ? "Command" : "Args") {
                            if kind == .diff, let edit = tool.edit {
                                DiffBox(edit: edit)
                            } else if kind == .command {
                                CodeBox(text: tool.argumentsText, prefix: "$ ")
                            } else {
                                CodeBox(text: tool.argumentsText)
                            }
                        }
                    }
                    if tool.hasResult {
                        section("Result") {
                            if let path = tool.filePath {
                                FileHeader(icon: "doc.text", path: path) {
                                    Text(tool.fileMeta)
                                }
                            }
                            CodeBox(
                                text: tool.body,
                                color: tool.status == .error ? Theme.warning : Theme.text,
                                // A file's contents take its language's colors.
                                language: tool.status == .error ? nil : tool.filePath.map { ($0 as NSString).pathExtension })
                            if let total = tool.truncatedBytes {
                                Text("Preview limited · \(ToolPresentation.bytes(total)) total")
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                    }
                }
                .padding(.leading, 17)
                .padding(.bottom, 8)
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .medium))
                .kerning(0.4)
                .foregroundStyle(Theme.muted)
            content()
        }
    }
}

/// A subagent's own tool calls under its row: the last few while collapsed,
/// all of them once the row is open.
private struct SubagentSteps: View {
    let steps: [ToolPresentation.SubagentStep]
    let all: Bool
    let running: Bool

    var body: some View {
        let shown = all ? steps[...] : steps.suffix(5)
        let hidden = steps.count - shown.count
        VStack(alignment: .leading, spacing: 3) {
            if hidden > 0 {
                Text("+\(hidden) earlier steps")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
            }
            ForEach(Array(shown.enumerated()), id: \.offset) { _, step in
                HStack(spacing: 6) {
                    if step.done {
                        Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.success)
                            .frame(width: 12)
                    } else if running {
                        ProgressView().controlSize(.mini).scaleEffect(0.7).frame(width: 12)
                    } else {
                        Image(systemName: "circle.slash").font(.system(size: 9)).frame(width: 12)
                    }
                    Text(step.tool).font(.system(size: 12, design: .monospaced)).layoutPriority(1)
                    if !step.detail.isEmpty {
                        Text(step.detail).font(.system(size: 12)).truncationMode(.tail)
                    }
                }
                .lineLimit(1)
                .foregroundStyle(Theme.muted)
            }
        }
        .padding(.leading, 38)
        .padding(.bottom, 6)
    }
}

private struct FileHeader<Trailing: View>: View {
    let icon: String
    let path: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10))
            Text(path).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 6)
            trailing
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// Wrapped monospaced text in a box that scrolls once it gets tall.
private struct CodeBox: View {
    let text: String
    var prefix = ""
    var color: Color = Theme.text
    /// No box: the thinking text reads as part of the timeline.
    var plain = false
    var language: String?

    var body: some View {
        ScrollView {
            (Text(prefix).foregroundStyle(Theme.muted)
                + Text(SyntaxHighlighter.attributed(text.isEmpty ? " " : String(text.prefix(8000)), language: language)))
                .font(.system(size: 12, design: .monospaced))
                .lineSpacing(3)
                .foregroundStyle(color)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, plain ? 17 : 8)
                .padding(.vertical, plain ? 0 : 6)
        }
        .frame(maxHeight: 288)
        .fixedSize(horizontal: false, vertical: true)
        .background(plain ? Color.clear : Theme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// A unified diff of one edit call: the file with its +/- counts, then the
/// changed lines in git's red and green.
private struct DiffBox: View {
    let edit: ToolPresentation.Edit

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let path = edit.path {
                FileHeader(icon: "plus.forwardslash.minus", path: path) {
                    Text("+\(edit.adds)").foregroundStyle(Theme.success)
                    Text("-\(edit.dels)").foregroundStyle(Theme.danger)
                }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(edit.diffs.enumerated()), id: \.offset) { i, lines in
                        if edit.diffs.count > 1 {
                            Text("\(i + 1) / \(edit.diffs.count)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.muted)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 2)
                        }
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                            HStack(alignment: .top, spacing: 0) {
                                Text(line.kind == .add ? "+" : line.kind == .del ? "-" : " ")
                                    .frame(width: 16)
                                Text(line.text.isEmpty ? " " : line.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(line.kind == .add ? Theme.diffAddText : line.kind == .del ? Theme.diffDelText : Theme.muted)
                            .background(line.kind == .add ? Theme.diffAdd : line.kind == .del ? Theme.diffDel : Color.clear)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(maxHeight: 256)
            .fixedSize(horizontal: false, vertical: true)
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}
