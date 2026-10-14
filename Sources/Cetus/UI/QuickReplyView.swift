import AppKit
import SwiftUI

/// QuickReplySurface (quick-panel.tsx): the streamed, editable draft above a
/// read-only band of what rode along, and a thin strip with the runtime picker.
struct QuickReplySurface: View {
    @Environment(QuickModel.self) private var m
    @Environment(\.colorScheme) private var scheme
    @State private var frames: [String: CGRect] = [:]
    @State private var draftHeight: CGFloat = 28
    private var c: QuickController { QuickController.shared }

    private var streaming: Bool { m.replyResult == nil && !m.replyDraft.isEmpty }
    private var errorText: String? { if case .failure(let e) = m.replyResult { return e.message }; return nil }
    private var drafted: Bool { if case .success = m.replyResult { return true }; return false }

    var body: some View {
        let hair = scheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.06)
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                if m.replyResult == nil && !streaming {
                    VStack(spacing: 12) {
                        Spinner(size: 20)
                        Text(m.replyOpen?.screenshotPermission == false ? "Screen Recording permission is required" : "Understanding the conversation and drafting a reply…")
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineBox(20.02).ts2()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = errorText {
                    VStack(spacing: 12) {
                        Glyph(name: "image-off", size: 20, color: Theme.warning)
                        Text(err).font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).multilineTextAlignment(.center)
                            .lineSpacing(20.02 - 17).frame(maxWidth: 576).ts2()
                        Text("Try another runtime below, or dismiss and trigger quick reply again.").font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.mutedForeground).lineBox(16.2).ts2()
                    }
                    .padding(.horizontal, 40)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    QuickTextView(text: Binding(get: { m.replyDraft }, set: { m.replyDraft = $0 }), height: $draftHeight, token: 0, focusToken: m.focusToken,
                                  placeholder: "", fontSize: 18, lineHeight: 28, weight: .medium, maxLines: 1000, testID: "quick-reply-draft",
                                  onCommand: handle)
                        .padding(.horizontal, 24).padding(.top, 20)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
                if let o = m.replyOpen, o.screenshot != nil || o.context != nil || o.axChars > 0 { band(o) }
                strip.overlay(alignment: .top) { Rectangle().fill(hair).frame(height: 1) }
            }
            QuickMenuLayer(frames: frames)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 16).fill(scheme == .dark ? Theme.card.opacity(0.55) : Theme.background.opacity(0.58)))
        .overlay { if scheme == .dark { RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.07), lineWidth: 1) } }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .onPreferenceChange(QuickFrameKey.self) { frames = $0 }
        .coordinateSpace(name: "quick")
        .background(QuickKeyCatcher(onCommand: handle))
        .testID("quick-reply")
    }

    private func handle(_ cmd: ComposerCommand) -> Bool {
        switch cmd {
        case .escape:
            if m.menu != nil { m.menu = nil; return true }
            c.dismiss(); return true
        case .tab:
            let list = c.enabledRuntimes()
            guard !list.isEmpty else { return true }
            let i = list.firstIndex { $0.id == m.replyBackend } ?? -1
            c.regenerateReply(list[(i + 1) % list.count].id)
            return true
        case .submit: c.insertReply(); return true
        default: return false
        }
    }

    private func band(_ o: QuickReplyOpen) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            if let shot = o.screenshot, let img = NSImage(data: shot.data) {
                let w = img.size.height > 0 ? 54 * img.size.width / img.size.height + 2 : 56
                Image(nsImage: img).resizable().aspectRatio(contentMode: .fill).frame(width: w, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(scheme == .dark ? .white.opacity(0.08) : .black.opacity(0.06), lineWidth: 1))
            }
            QuickFlow(spacing: 6) {
                if let a = o.context?.app, !a.isEmpty { QuickContextChip(icon: "app-window", label: a) }
                if let u = o.context?.url, !u.isEmpty { QuickContextChip(icon: "globe", label: URL(string: u)?.host ?? u) }
                if let s = o.context?.selection, !s.isEmpty { QuickContextChip(icon: "text-select", label: "Selection (\(s.count) chars)") }
                if o.axChars > 0 { QuickContextChip(icon: "scan-text", label: "Screen text (\(o.axChars) chars)") }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 10)
    }

    private var strip: some View {
        let rt = Runtimes.byId(m.replyBackend)
        let status = (m.replyOpen?.app ?? "").isEmpty ? "Reading the current screen" : "Reading \(m.replyOpen!.app)"
        return HStack(spacing: 10) {
            QuickHoverButton(fill: nil, hover: scheme == .dark ? .white.opacity(0.08) : .black.opacity(0.05), action: { m.menu = m.menu == "reply-runtime" ? nil : "reply-runtime" }) { _ in
                HStack(spacing: 6) {
                    HStack(spacing: 6) {
                        RuntimeIcon(id: rt.id, size: 14)
                        Text(rt.label).lineLimit(1).ts2()
                    }
                    .foregroundStyle(Theme.runtimeColor(rt.id))
                    Glyph(name: "chevron-down", size: 12, color: Theme.mutedForeground).opacity(0.5)
                }
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 8).frame(height: 28)
            }
            .background(GeometryReader { g in Color.clear.preference(key: QuickFrameKey.self, value: ["reply-runtime": g.frame(in: .named("quick"))]) })
            .testID("quick-reply-runtime")
            Text(drafted ? "Draft ready" : status).foregroundStyle(Theme.mutedForeground.opacity(0.7)).lineLimit(1).truncationMode(.tail).lineBox(18.2).ts2()
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                if drafted {
                    QuickKbd(text: "", icon: "corner-down-left")
                    Text(m.inserting ? "inserting…" : "insert").lineBox(18.2).ts2()
                    Text("·").foregroundStyle(Theme.mutedForeground.opacity(0.4)).lineBox(18.2).ts2()
                }
                QuickKbd(text: "⇥")
                Text("re-draft").lineBox(18.2).ts2()
                Text("·").foregroundStyle(Theme.mutedForeground.opacity(0.4)).lineBox(18.2).ts2()
                QuickKbd(text: "esc")
                Text("dismiss").lineBox(18.2).ts2()
            }
            .padding(.leading, 16).padding(.trailing, 4)
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .padding(.top, 1)
    }
}

/// Catches Esc/Tab/Enter while no text view has focus (loading / error states).
private struct QuickKeyCatcher: NSViewRepresentable {
    let onCommand: (ComposerCommand) -> Bool
    func makeNSView(context: Context) -> KeyView { let v = KeyView(); v.onCommand = onCommand; return v }
    func updateNSView(_ v: KeyView, context: Context) { v.onCommand = onCommand }
    final class KeyView: NSView {
        var onCommand: ((ComposerCommand) -> Bool)?
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let w = window, !QuickController.shared.testMode, !(w.firstResponder is NSTextView) { w.makeFirstResponder(self) }
        }
        override func keyDown(with e: NSEvent) {
            let shift = e.modifierFlags.contains(.shift)
            let handled: Bool
            switch e.keyCode {
            case 53: handled = onCommand?(.escape) ?? false
            case 48 where e.modifierFlags.intersection([.shift, .control, .command, .option]).isEmpty: handled = onCommand?(.tab) ?? false
            case 36, 76: handled = shift ? false : (onCommand?(.submit) ?? false)
            default: handled = false
            }
            if !handled { super.keyDown(with: e) }
        }
    }
}

private struct QuickTextShadow2: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View { content.shadow(color: scheme == .dark ? .black.opacity(0.35) : .clear, radius: 1, x: 0, y: 1) }
}

extension View {
    fileprivate func ts2() -> some View { modifier(QuickTextShadow2()) }
}
