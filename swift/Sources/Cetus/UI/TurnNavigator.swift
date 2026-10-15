import SwiftUI

/// Codex-style turn navigator (Cetus message-list.tsx `TurnNavigator`): a thin
/// gutter of ticks down the transcript's left edge, one per user turn, clustered
/// and vertically centered. The active tick (the turn at the top of the viewport,
/// the newest at the bottom) brightens; hovering a tick previews the prompt and
/// the start of its reply; clicking scrolls that turn to the top. Only the ticks
/// take the pointer, so it never fights text selection.
struct TurnNavigator: View, Equatable {
    /// Transcript item ids of the user turns, in order.
    let turns: [String]
    let active: Int
    let preview: (String) -> (prompt: String, reply: String)
    let jump: (String) -> Void

    static func == (a: Self, b: Self) -> Bool { a.turns == b.turns && a.active == b.active }

    @Environment(\.windowWidth) private var width

    var body: some View {
        // `hidden sm:flex`, and nothing to navigate with fewer than two turns.
        if turns.count >= 2, width >= 640 {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(turns.enumerated()), id: \.element) { i, id in
                    TurnTick(index: i, active: i == active, preview: { preview(id) }, jump: { jump(id) })
                }
            }
            .frame(width: 48, alignment: .leading)
            .frame(maxHeight: .infinity)
            .testID("turn-navigator")
        }
    }
}

private struct TurnTick: View {
    let index: Int
    let active: Bool
    let preview: () -> (prompt: String, reply: String)
    let jump: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: jump) {
            // h-1.5 hit row, pl-3 pr-2; the 10×2 bar doubles its width from the left on hover.
            Capsule()
                .fill(hover ? Theme.foreground : active ? Theme.foreground.opacity(0.6) : Theme.mutedForeground.opacity(0.4))
                .frame(width: 10, height: 2)
                .scaleEffect(x: hover ? 2 : 1, anchor: .leading)
                .animation(.linear(duration: 0.1), value: hover)
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(height: 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .overlay(alignment: .leading) {
            if hover { TurnPreview(content: preview()).offset(x: 36).allowsHitTesting(false) }
        }
        .zIndex(hover ? 1 : 0)
        .accessibilityLabel("Jump to message \(index + 1)")
        .testID("turn-tick-\(index)")
    }
}

/// `w-72 rounded-md border bg-popover p-3`, prompt clamped to 2 lines, reply to 3.
private struct TurnPreview: View {
    let content: (prompt: String, reply: String)

    var body: some View {
        if !content.prompt.isEmpty || !content.reply.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if !content.prompt.isEmpty {
                    Text(content.prompt).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(2)
                }
                if !content.reply.isEmpty {
                    Text(content.reply).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(3)
                }
            }
            .frame(width: 288 - 24, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.popover))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.08), radius: 9, y: 6)
            .shadow(color: .black.opacity(0.06), radius: 1.5, y: 1)
            .fixedSize()
        }
    }
}

extension TranscriptLayout {
    /// The navigator's preview for a user turn: its prompt, and the first text of
    /// the reply that followed it (Cetus getTurnPreview).
    static func turnPreview(_ messages: [RenderedMessage], key: String) -> (prompt: String, reply: String) {
        func firstText(_ m: RenderedMessage) -> String {
            m.blocks.first { $0.kind == .text && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }?
                .text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        }
        guard let i = messages.firstIndex(where: { $0.key == key }) else { return ("", "") }
        var reply = ""
        for m in messages[(i + 1)...] {
            if m.role == .user { break }
            if m.role == .assistant {
                let t = firstText(m)
                if !t.isEmpty { reply = t; break }
            }
        }
        return (firstText(messages[i]), reply)
    }
}
