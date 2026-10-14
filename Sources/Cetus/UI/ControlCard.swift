import SwiftUI

/// Blocking runtime requests shown above the composer, as in Cetus's
/// cli-control-card.tsx: Claude's AskUserQuestion and permission prompts,
/// Codex's request_user_input and approvals, ACP permissions.
struct ControlCard: View {
    let request: JSON
    let respond: (JSON) -> Void

    struct Question: Identifiable {
        let id: String
        let header: String?
        let question: String
        let multiSelect: Bool
        let options: [(label: String, description: String?)]
    }

    private var questions: [Question] {
        (request["input"]["questions"].array ?? []).enumerated().map { i, q in
            Question(
                id: q["id"].string ?? q["question"].string ?? String(i),
                header: q["header"].string,
                question: q["question"].stringValue,
                multiSelect: q["multiSelect"].truthy,
                options: (q["options"].array ?? []).map { ($0["label"].stringValue, $0["description"].string) })
        }
    }

    var body: some View {
        let source = request["source"].string
        let hasQuestions = !questions.isEmpty
        Group {
            if source == "codex" || source == "dsh" {
                if request["requestKind"].string == "request_user_input" && hasQuestions {
                    QuestionCard(agent: agentName(request), questions: questions) { answers in
                        var obj: [String: JSON] = [:]
                        for (k, v) in answers { obj[k] = ["answers": .array(v.map { .string($0) })] }
                        respond(["answers": .object(obj)])
                    }
                } else {
                    ApprovalCard(request: request,
                                 onAllow: { respond(["action": "accept", "content": [:], "_meta": nil]) },
                                 onDeny: { respond(["action": "decline", "content": nil, "_meta": nil]) })
                }
            } else if source == "acp" {
                ApprovalCard(request: request, onAllow: { respond(["behavior": "allow"]) }, onDeny: { respond(["behavior": "deny"]) })
            } else if request["toolName"].string == "AskUserQuestion" && hasQuestions {
                QuestionCard(agent: agentName(request), questions: questions) { answers in
                    var input = request["input"]
                    var obj: [String: JSON] = [:]
                    for q in questions { obj[q.question] = .string((answers[q.id] ?? []).joined(separator: ", ")) }
                    input["answers"] = .object(obj)
                    respond(["behavior": "allow", "updatedInput": input])
                }
            } else {
                ApprovalCard(request: request,
                             onAllow: { respond(["behavior": "allow", "updatedInput": request["input"]]) },
                             onDeny: { respond(["behavior": "deny", "message": "The user denied this tool use."]) })
            }
        }
        .id(request["requestId"].stringValue)
    }
}

/// Card shell: radius 14, 1px border, card fill, 12px padding, shadow-sm.
private struct CardFrame<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14).fill(Theme.card))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.05), radius: 1.5, y: 1)
            .testID("control-card")
    }
}

private func agentName(_ request: JSON) -> String {
    switch request["source"].string {
    case "codex": "Codex"
    case "dsh": "DeepSeek Harness"
    case "acp": "Agent"
    default: "Claude Code"
    }
}

private struct QuestionCard: View {
    let agent: String
    let questions: [ControlCard.Question]
    let onSubmit: ([String: [String]]) -> Void
    @State private var step = 0
    @State private var answers: [String: [String]] = [:]
    @State private var other = ""
    @FocusState private var otherFocused: Bool

    var body: some View {
        if questions.indices.contains(step) {
            let q = questions[step]
            let isLast = step == questions.count - 1
            let selected = answers[q.id] ?? []
            let answered = !selected.isEmpty || !other.trimmingCharacters(in: .whitespaces).isEmpty
            CardFrame {
                HStack(spacing: 6) {
                    Glyph(name: "message-circle-question", size: 14, color: Theme.primary)
                    Text("\(agent) asks").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.primary)
                    Spacer()
                    if questions.count > 1 {
                        Text("\(step + 1) / \(questions.count)").font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                    }
                }
                .padding(.bottom, 8)
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let h = q.header, !h.isEmpty {
                                Text(h.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.3).foregroundStyle(Theme.mutedForeground)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(RoundedRectangle(cornerRadius: 4).fill(Theme.muted))
                            }
                            Text(q.question).font(.system(size: 14, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                        }
                        FlowLayout(spacing: 6) {
                            ForEach(Array(q.options.enumerated()), id: \.offset) { i, o in
                                OptionChip(label: o.label, description: o.description, multi: q.multiSelect, on: selected.contains(o.label)) { choose(q, o.label) }
                                    .testID("control-option-\(i)")
                            }
                        }
                        TextField("Other — type your own answer, or paste an image/file…", text: $other)
                            .textFieldStyle(.plain)
                            .font(.system(size: 12))
                            .padding(.horizontal, 8).frame(height: 28)
                            .background(RoundedRectangle(cornerRadius: 8).strokeBorder(otherFocused ? Theme.primary.opacity(0.6) : Theme.input, lineWidth: 1))
                            .focused($otherFocused)
                            .onSubmit { next(q, isLast: isLast) }
                            .testID("control-other")
                    }
                }
                .frame(maxHeight: 352)
                .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Spacer()
                    if step > 0 {
                        Button("Back") { step -= 1 }.buttonStyle(CetusButtonStyle(variant: .outline, height: 28, fontSize: 12))
                    }
                    Button(isLast ? "Submit" : "Next") { next(q, isLast: isLast) }
                        .buttonStyle(CetusButtonStyle(variant: .primary, height: 28, fontSize: 12))
                        .disabled(!answered)
                        .testID("control-next")
                }
                .padding(.top, 8)
            }
        }
    }

    private func choose(_ q: ControlCard.Question, _ label: String) {
        var set = answers[q.id] ?? []
        if q.multiSelect {
            if let i = set.firstIndex(of: label) { set.remove(at: i) } else { set.append(label) }
        } else {
            set = set == [label] ? [] : [label]
        }
        answers[q.id] = set
    }

    private func next(_ q: ControlCard.Question, isLast: Bool) {
        let typed = other.trimmingCharacters(in: .whitespaces)
        let combined = (answers[q.id] ?? []) + (typed.isEmpty ? [] : [typed])
        guard !combined.isEmpty else { return }
        answers[q.id] = combined
        other = ""
        if isLast { onSubmit(answers) } else { step += 1 }
    }
}

/// Answer chip: radius 10, 1px border; selected = primary border + primary/10.
private struct OptionChip: View {
    let label: String
    let description: String?
    let multi: Bool
    let on: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if multi {
                    RoundedRectangle(cornerRadius: 4).fill(on ? Theme.primary : .clear)
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(on ? Theme.primary : Theme.border, lineWidth: 1))
                        .overlay { if on { Glyph(name: "check", size: 10, color: Theme.primaryForeground) } }
                        .frame(width: 14, height: 14)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground)
                    if let d = description, !d.isEmpty { Text(d).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1) }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 10).fill(on ? Theme.primary.opacity(0.1) : hover ? Theme.muted : .clear))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? Theme.primary : hover ? Theme.primary.opacity(0.5) : Theme.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Wrapping row layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(width: min(s.width, bounds.width), height: s.height))
                x += min(s.width, bounds.width) + spacing
            }
        }
    }
    private struct Row { var items: [Int] = []; var y: CGFloat = 0; var width: CGFloat = 0; var height: CGFloat = 0 }
    private func arrange(_ maxW: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for i in subviews.indices {
            let s = subviews[i].sizeThatFits(ProposedViewSize(width: maxW, height: nil))
            let w = min(s.width, maxW)
            if !rows[rows.count - 1].items.isEmpty && rows[rows.count - 1].width + spacing + w > maxW {
                let last = rows[rows.count - 1]
                rows.append(Row(y: last.y + last.height + spacing))
            }
            var r = rows[rows.count - 1]
            r.width += (r.items.isEmpty ? 0 : spacing) + w
            r.height = max(r.height, s.height)
            r.items.append(i)
            rows[rows.count - 1] = r
        }
        return rows
    }
}

private struct ApprovalCard: View {
    let request: JSON
    let onAllow: () -> Void
    let onDeny: () -> Void
    var body: some View {
        CardFrame {
            HStack(spacing: 6) {
                Glyph(name: "shield-question", size: 14, color: Theme.primary)
                Text("Allow \(agentName(request)) to use \(request["toolName"].string ?? "this tool")?").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.primary).lineLimit(1)
            }
            .padding(.bottom, 6)
            ScrollView {
                Text(preview).font(.system(size: 12, design: .monospaced)).lineSpacing(4).foregroundStyle(Theme.foreground.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding(.horizontal, 8).padding(.vertical, 6)
            }
            .frame(maxHeight: 160)
            .fixedSize(horizontal: false, vertical: true)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.6)))
            .padding(.bottom, 8)
            HStack(spacing: 8) {
                Spacer()
                Button("Deny", action: onDeny).buttonStyle(CetusButtonStyle(variant: .outline, height: 28, fontSize: 12)).testID("control-deny")
                Button("Allow", action: onAllow).buttonStyle(CetusButtonStyle(variant: .primary, height: 28, fontSize: 12)).keyboardShortcut(.return, modifiers: .command).testID("control-allow")
            }
        }
    }

    private var preview: String {
        let input = request["input"]
        if let cmd = input["command"].string { return cmd }
        if let path = input["file_path"].string ?? input["path"].string {
            let body = input["content"].string ?? input["new_string"].string ?? ""
            return body.isEmpty ? path : path + "\n" + String(body.prefix(600))
        }
        return String(input.compact.prefix(800))
    }
}
