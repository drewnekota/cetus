import AppKit
import SwiftUI

// SwiftUI surfaces of the quick panel (quick-panel.tsx): the launcher and the
// visual quick-reply surface, plus their in-panel menus.

private let dark = NSAppearance.Name.darkAqua

/// Alpha overlays that keep the vibrancy visible (black/x in light, white/x in dark).
private struct QuickInk {
    let isDark: Bool
    var hairline: Color { isDark ? .white.opacity(0.06) : .black.opacity(0.06) }
    var hover: Color { isDark ? .white.opacity(0.08) : .black.opacity(0.05) }
    var selected: Color { isDark ? .white.opacity(0.15) : .black.opacity(0.10) }
    var chipBorder: Color { isDark ? .white.opacity(0.08) : .black.opacity(0.06) }
    var chipFill: Color { isDark ? .white.opacity(0.06) : .black.opacity(0.05) }
    var kbdBorder: Color { isDark ? .white.opacity(0.08) : .black.opacity(0.06) }
    var kbdFill: Color { isDark ? .white.opacity(0.06) : .black.opacity(0.05) }
    var tileFill: Color { isDark ? .white.opacity(0.04) : .black.opacity(0.03) }
    var panelFill: Color { isDark ? Theme.card.opacity(0.55) : Theme.background.opacity(0.58) }
}

/// `dark:[text-shadow:0_1px_2px_rgb(0_0_0/0.35)]`.
private struct QuickTextShadow: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    func body(content: Content) -> some View {
        content.shadow(color: scheme == .dark ? .black.opacity(0.35) : .clear, radius: 1, x: 0, y: 1)
    }
}

extension View {
    fileprivate func ts() -> some View { modifier(QuickTextShadow()) }
}

struct QuickRoot: View {
    @Environment(QuickModel.self) private var m
    var body: some View {
        Group {
            if m.surface == .reply { QuickReplySurface() } else { QuickLauncher() }
        }
    }
}

// MARK: - Launcher

struct QuickLauncher: View {
    @Environment(QuickModel.self) private var m
    @Environment(AppState.self) private var app
    @Environment(\.colorScheme) private var scheme
    @State private var textHeight: CGFloat = 22.5
    @State private var frames: [String: CGRect] = [:]
    private var c: QuickController { QuickController.shared }
    private var ink: QuickInk { QuickInk(isDark: scheme == .dark) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    input
                    footer
                }
                .frame(minHeight: 240, alignment: .top)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { c.setContentHeight($0) }
                Spacer(minLength: 0)
            }
            if let e = m.attachError {
                Text(e).font(.system(size: 12)).foregroundStyle(Theme.destructive).ts()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(.leading, 16).padding(.bottom, 48)
            }
            QuickMenuLayer(frames: frames)
            QuickTipLayer(frames: frames)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16).fill(ink.panelFill))
        .overlay {
            if m.dragging {
                RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.primary, lineWidth: 2)
            } else if scheme == .dark {
                RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.07), lineWidth: 1)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .onDrop(of: [.fileURL], isTargeted: Binding(get: { m.dragging }, set: { m.dragging = $0 })) { providers in
            for p in providers {
                _ = p.loadObject(ofClass: URL.self) { url, _ in
                    if let url { DispatchQueue.main.async { c.addPaths([url.path]) } }
                }
            }
            return true
        }
        .onPreferenceChange(QuickFrameKey.self) { frames = $0 }
        .coordinateSpace(name: "quick")
        .testID("quick-launcher")
    }

    // MARK: Input

    private var showBand: Bool {
        !m.attachments.isEmpty || (m.includeScreenshot && (m.screenshot != nil || m.screenshotDenied || (m.context.map { !$0.url.isEmpty || !$0.selection.isEmpty } ?? false)))
    }

    private var input: some View {
        VStack(alignment: .leading, spacing: 0) {
            QuickTextView(text: Binding(get: { m.text }, set: { m.text = $0 }), height: $textHeight, token: m.textToken, focusToken: m.focusToken,
                          placeholder: "Ask Cetus anything…", rightInset: 263, testID: "quick-input",
                          onCommand: handle, onPasteFiles: { c.addPaths($0) }, onPasteImage: { c.addImage($0) })
                .frame(height: textHeight)
            if showBand { band.padding(.top, 8) }
        }
        .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .topTrailing) { prefs.padding(.trailing, 12).padding(.top, 10) }
    }

    private func handle(_ cmd: ComposerCommand) -> Bool {
        switch cmd {
        case .escape:
            if m.menu != nil { m.menu = nil; return true }
            c.dismiss(); return true
        case .tab: c.cycleBackend(); return true
        case .submit: c.submit(); return true
        case .newline, .backtab, .up, .down: return false
        }
    }

    private var prefs: some View {
        HStack(spacing: 8) {
            QuickPrefLabel(title: "Create more", isOn: m.keepOpen, disabled: false, testID: "quick-create-more") { c.setKeepOpen(!m.keepOpen) }
                .quickTip("Keep the launcher open after starting a task so you can start another right away, without switching to Cetus.", id: "create-more")
            QuickPrefLabel(title: "Open main app", isOn: m.openMain, disabled: m.keepOpen, testID: "quick-open-main") { c.setOpenMain(!m.openMain) }
                .quickTip(m.keepOpen ? "Create more keeps the launcher open and tasks in the background. This preference applies when Create more is off."
                          : "Open Cetus after sending. When off, the launcher closes and the task runs in the background.", id: "open-main")
        }
    }

    // MARK: Attachments band

    private var band: some View {
        QuickFlow(spacing: 8) {
            ForEach(m.attachments) { a in
                QuickRemovable(onRemove: { m.attachments.removeAll { $0.id == a.id } }) {
                    if a.isImage, let img = NSImage(contentsOfFile: a.path) {
                        Image(nsImage: img).resizable().aspectRatio(contentMode: .fill).frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ink.chipBorder, lineWidth: 1))
                    } else {
                        HStack(spacing: 8) {
                            Glyph(name: "file", size: 16, color: Theme.foreground)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(a.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).truncationMode(.tail).lineBox(16.2).ts()
                                Text(Fmt.bytes(a.size)).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.foreground).opacity(0.6).lineBox(15.4).ts()
                            }
                        }
                        .padding(.horizontal, 10)
                        .frame(maxWidth: 176, alignment: .leading)
                        .frame(height: 56)
                        .background(RoundedRectangle(cornerRadius: 8).fill(ink.tileFill))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ink.chipBorder, lineWidth: 1))
                    }
                }
            }
            if m.includeScreenshot, let shot = m.screenshot, let img = NSImage(data: shot.data) {
                QuickRemovable(onRemove: { m.includeScreenshot = false; m.screenshot = nil }) {
                    let w = img.size.height > 0 ? 54 * img.size.width / img.size.height + 2 : 56
                    Image(nsImage: img).resizable().aspectRatio(contentMode: .fill).frame(width: w, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(ink.chipBorder, lineWidth: 1))
                }
                .testID("quick-screenshot")
            } else if m.includeScreenshot && m.screenshotDenied {
                HStack(spacing: 6) {
                    Glyph(name: "image-off", size: 14, color: Theme.warning)
                    Text("Grant Screen Recording to capture your screen").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.warning).lineBox(16.2).ts()
                }
            }
            if m.includeScreenshot, let ctx = m.context, !ctx.url.isEmpty || !ctx.selection.isEmpty {
                HStack(spacing: 6) {
                    if !ctx.url.isEmpty {
                        QuickContextChip(icon: "globe", label: URL(string: ctx.url)?.host ?? ctx.url) { m.context?.url = ""; m.context?.title = "" }
                    }
                    if !ctx.selection.isEmpty {
                        QuickContextChip(icon: "text-select", label: "Selection (\(ctx.selection.count) chars)") { m.context?.selection = "" }
                    }
                }
            }
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 6) {
            QuickIconButton(icon: "paperclip", testID: "quick-attach") { c.pickFiles() }
            HStack(spacing: 2) {
                segment("new", "New", disabled: false)
                segment("last", "Last", disabled: !m.hasLastChat)
            }
            trigger("workspace", disabled: m.sessionMode == "last") {
                let dir = m.workspaceDir ?? Env.chatDir
                Glyph(name: ComposerView.isChatWorkspace(dir) ? "message-square" : "folder", size: 12, color: Theme.mutedForeground)
                Text(ComposerView.workspaceLabel(dir)).lineLimit(1).ts()
            }
            let rt = Runtimes.byId(m.backend)
            trigger("runtime", color: Theme.runtimeColor(rt.id)) {
                RuntimeIcon(id: rt.id, size: 14)
                Text(rt.label).lineLimit(1).ts()
            }
            if Runtimes.hasModelMenu(m.backend) {
                trigger("model", chevronOpacity: 0.6, gap: 4) {
                    Text(QuickTuning.label(m, app: app)).lineLimit(1).ts()
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                if m.launchedTick > 0 {
                    HStack(spacing: 4) {
                        Glyph(name: "check", size: 14, color: Theme.success)
                        Text("Started").foregroundStyle(Theme.success).lineBox(16.2).ts()
                    }
                } else {
                    HStack(spacing: 6) {
                        HStack(spacing: 4) {
                            QuickKbd(text: "⇥")
                            Text("switch").lineBox(16.2).ts()
                        }
                        .compositingGroup().opacity(m.hasLastChat ? 1 : 0.35)
                        Text("·").foregroundStyle(Theme.mutedForeground.opacity(0.4)).lineBox(16.2).ts()
                        QuickKbd(text: "esc")
                        Text("dismiss").lineBox(16.2).ts()
                    }
                    .foregroundStyle(Theme.mutedForeground.opacity(0.7))
                }
                QuickSendButton(spinning: m.submitting,
                                disabled: m.submitting || (m.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && m.attachments.isEmpty && m.screenshot == nil)) { c.submit() }
            }
            .padding(.leading, 8)
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(height: 49, alignment: .center)
        .overlay(alignment: .top) { Rectangle().fill(ink.hairline).frame(height: 1) }
        .padding(.top, 0)
    }

    private func segment(_ value: String, _ label: String, disabled: Bool) -> some View {
        let on = m.sessionMode == value
        return QuickHoverButton(fill: on ? ink.selected : nil, hover: ink.hover, action: { if !disabled { m.sessionMode = value } }) { hovered in
            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(on || hovered ? Theme.foreground : Theme.mutedForeground).lineBox(16.2).ts()
                .padding(.horizontal, 8).frame(height: 28)
        }
        .compositingGroup().opacity(disabled ? 0.35 : 1)
        .allowsHitTesting(!disabled)
        .if(disabled) { $0.quickTip("No chats yet", id: "last-empty", side: .top) }
        .testID("quick-session-\(value)")
    }

    private func trigger<L: View>(_ id: String, color: Color? = nil, disabled: Bool = false, chevronOpacity: Double = 0.5, gap: CGFloat = 6,
                                  @ViewBuilder label: () -> L) -> some View {
        let content = label()
        return QuickHoverButton(fill: nil, hover: ink.hover, action: { if !disabled { m.menu = m.menu == id ? nil : id } }) { _ in
            HStack(spacing: gap) {
                HStack(spacing: 6) { content }.foregroundStyle(color ?? Theme.mutedForeground)
                Glyph(name: "chevron-down", size: 12, color: Theme.mutedForeground).opacity(chevronOpacity)
            }
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 8).frame(height: 28)
        }
        .compositingGroup().opacity(disabled ? 0.5 : 1)
        .allowsHitTesting(!disabled)
        .background(GeometryReader { g in Color.clear.preference(key: QuickFrameKey.self, value: [id: g.frame(in: .named("quick"))]) })
        .testID("quick-\(id)")
    }
}

// MARK: - Pieces

struct QuickFrameKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}

/// A button with a hover fill (radius 8), handing its hover state to the label.
struct QuickHoverButton<Label: View>: View {
    var fill: Color?
    var hover: Color
    var radius: CGFloat = 8
    let action: () -> Void
    @ViewBuilder let label: (Bool) -> Label
    @State private var hovered = false
    var body: some View {
        Button(action: action) {
            label(hovered)
                .background(RoundedRectangle(cornerRadius: radius).fill(fill ?? (hovered ? hover : .clear)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}

private struct QuickIconButton: View {
    let icon: String
    var testID: String?
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        QuickHoverButton(fill: nil, hover: QuickInk(isDark: scheme == .dark).hover, action: action) { h in
            Glyph(name: icon, size: 12, color: h ? Theme.foreground : Theme.mutedForeground).frame(width: 28, height: 28)
        }
        .quickTip("Add attachments", id: "attach", side: .top)
        .testID(testID)
    }
}

/// "Create more" / "Open main app": label + small switch.
private struct QuickPrefLabel: View {
    let title: String
    let isOn: Bool
    let disabled: Bool
    var testID: String?
    let toggle: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        QuickHoverButton(fill: nil, hover: disabled ? .clear : QuickInk(isDark: scheme == .dark).hover, action: { if !disabled { toggle() } }) { h in
            HStack(spacing: 8) {
                Text(title).font(.system(size: 12, weight: .medium)).lineBox(16.2).ts()
                    .foregroundStyle(disabled ? Theme.mutedForeground : isOn || h ? Theme.foreground : Theme.mutedForeground)
                QuickSwitch(isOn: isOn)
            }
            .padding(.horizontal, 8).frame(height: 28)
        }
        .compositingGroup().opacity(disabled ? 0.5 : 1)
        .testID(testID)
    }
}

/// shadcn Switch size="sm": 24×14 track (1px transparent border), 12px thumb.
struct QuickSwitch: View {
    let isOn: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Capsule()
            .fill(isOn ? Theme.primary : scheme == .dark ? Theme.input.opacity(0.8) : Theme.input)
            .frame(width: 24, height: 14)
            .overlay(alignment: .leading) {
                Circle().fill(scheme == .dark ? (isOn ? Theme.primaryForeground : Theme.foreground) : Theme.background)
                    .frame(width: 12, height: 12).offset(x: isOn ? 11 : 1)
            }
            .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
            .animation(.easeOut(duration: 0.15), value: isOn)
    }
}

/// The launcher's `[&_kbd]` override: h-5, 12px, alpha fills.
struct QuickKbd: View {
    let text: String
    var icon: String?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let ink = QuickInk(isDark: scheme == .dark)
        Group {
            if let icon { Glyph(name: icon, size: 10, color: Theme.mutedForeground.opacity(0.8)) }
            else { Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground.opacity(0.8)).ts() }
        }
        .padding(.horizontal, 5)
        .frame(minWidth: 20)
        .frame(height: 20)
        .background(RoundedRectangle(cornerRadius: 4).fill(ink.kbdFill))
        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(ink.kbdBorder, lineWidth: 1))
    }
}

/// `Button size="icon-sm"`: 32×32 primary, ArrowUp 16 (spinner while submitting).
private struct QuickSendButton: View {
    let spinning: Bool
    let disabled: Bool
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Group {
                if spinning { Spinner(size: 16, color: Theme.primaryForeground) }
                else { Glyph(name: "arrow-up", size: 16, color: Theme.primaryForeground) }
            }
            .frame(width: 32, height: 32)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.primary.opacity(hover && !disabled ? 0.8 : 1)).padding(1))
            .compositingGroup().opacity(disabled ? 0.5 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .disabled(disabled)
        .onHover { hover = $0 }
        .quickTip("start · ⏎", id: "send", side: .top)
        .testID("quick-send")
    }
}

/// A thumb with the hover-only ✕ badge.
private struct QuickRemovable<Content: View>: View {
    let onRemove: () -> Void
    @ViewBuilder let content: Content
    @State private var hover = false
    var body: some View {
        content
            .overlay(alignment: .topTrailing) {
                Button(action: onRemove) {
                    Glyph(name: "x", size: 12, color: .white)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(.black.opacity(0.7)))
                        .overlay(Circle().strokeBorder(.white.opacity(0.2), lineWidth: 1).padding(-1))
                }
                .buttonStyle(.plain)
                .opacity(hover ? 1 : 0)
                .offset(x: 6, y: -6)
            }
            .onHover { hover = $0 }
    }
}

/// Removable (launcher) or read-only (reply) context chip.
struct QuickContextChip: View {
    let icon: String
    let label: String
    var onRemove: (() -> Void)?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let ink = QuickInk(isDark: scheme == .dark)
        HStack(spacing: 6) {
            Glyph(name: icon, size: 12, color: Theme.mutedForeground).opacity(0.7)
            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineLimit(1).truncationMode(.tail).lineBox(16.2).ts()
            if let onRemove {
                QuickHoverButton(fill: nil, hover: scheme == .dark ? .white.opacity(0.15) : .black.opacity(0.1), radius: 8, action: onRemove) { h in
                    Glyph(name: "x", size: 12, color: h ? Theme.foreground : Theme.mutedForeground.opacity(0.7)).frame(width: 16, height: 16)
                }
                .clipShape(Circle())
            }
        }
        .padding(.leading, 8).padding(.trailing, onRemove == nil ? 8 : 4).padding(.vertical, 4)
        .frame(maxWidth: 220, alignment: .leading)
        .background(Capsule().fill(ink.chipFill))
        .overlay(Capsule().strokeBorder(ink.chipBorder, lineWidth: 1))
        .fixedSize()
    }
}

/// Wrapping row (`flex flex-wrap items-end gap-2`).
struct QuickFlow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1)))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y + row.height - s.height), proposal: .unspecified)
                x += s.width + spacing
            }
            y += row.height + spacing
        }
    }
    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
    private func arrange(_ maxW: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (i, v) in subviews.enumerated() {
            let s = v.sizeThatFits(.unspecified)
            if !rows[rows.count - 1].items.isEmpty && rows[rows.count - 1].width + spacing + s.width > maxW { rows.append(Row()) }
            var r = rows[rows.count - 1]
            r.width += (r.items.isEmpty ? 0 : spacing) + s.width
            r.height = max(r.height, s.height)
            r.items.append(i)
            rows[rows.count - 1] = r
        }
        return rows.filter { !$0.items.isEmpty }
    }
}

/// Model · effort label (ModelPicker / CliTuningMenu trigger).
enum QuickTuning {
    static func piModel(_ id: String) -> Option {
        if id.isEmpty || id == "flash" || id == "pro" { return Runtimes.byId("pi").models[0] }
        return Option(id: id, label: id.split(separator: "/").dropFirst().joined(separator: "/").nonEmpty ?? id)
    }
    @MainActor static func piEffort(_ m: QuickModel) -> Option? {
        let rt = Runtimes.byId("pi")
        guard piModel(m.piModel).id == "flash" else { return nil }
        let axis = Runtimes.piReasoningAxis
        let want = axis.contains(m.piEffort) ? m.piEffort : "high"
        let i = axis.firstIndex(of: want)!
        for id in Array(axis[i...]) + axis[..<i].reversed() { if let hit = rt.efforts.first(where: { $0.id == id }) { return hit } }
        return nil
    }
    @MainActor static func cliModel(_ m: QuickModel, app: AppState) -> Option? {
        let rt = Runtimes.byId(m.backend)
        let d = app.controller.cliDefaults[rt.id]
        return rt.id == "dsh" ? rt.models.first : CliDefaults.resolve(m.cliModel, d?.catalog(rt) ?? rt.models, d)
    }
    @MainActor static func cliEffort(_ m: QuickModel, app: AppState) -> Option? {
        let rt = Runtimes.byId(m.backend)
        return rt.efforts.first { $0.id == m.cliEffort } ?? CliDefaults.resolveDefault(app.controller.cliDefaults[rt.id]?.effort, rt.efforts)
    }
    @MainActor static func label(_ m: QuickModel, app: AppState) -> String {
        if m.backend == "pi" { return [piModel(m.piModel).label, piEffort(m)?.label].compactMap { $0 }.joined(separator: " · ") }
        let d = app.controller.cliDefaults[m.backend]
        let mdl = cliModel(m, app: app)?.label ?? m.cliModel.nonEmpty ?? d?.model ?? "Model"
        let e = cliEffort(m, app: app)?.label ?? m.cliEffort.nonEmpty ?? d?.effort
        return e.map { "\(mdl) · \($0)" } ?? mdl
    }
}

// MARK: - Menus

/// In-panel menus, placed like the webview's Radix poppers: above the
/// trigger (4px gap, the strip sits on the bottom edge), start-aligned,
/// capped to the room above it.
struct QuickMenuLayer: View {
    let frames: [String: CGRect]
    @Environment(QuickModel.self) private var m
    @Environment(AppState.self) private var app
    private var c: QuickController { QuickController.shared }

    var body: some View {
        if let id = m.menu, let a = frames[id] {
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.001).onTapGesture { m.menu = nil; app.subPopup = nil }
                menu(id, anchor: a)
                    .alignmentGuide(.leading) { _ in -a.minX }
                    .alignmentGuide(.top) { d in -(a.minY - 4 - d.height) }
                if let s = app.subPopup, id == "model" {
                    let sa = s.anchor
                    PopupSurface(style: .sub) { s.content }
                        .alignmentGuide(.top) { d in -max(0, min(sa.minY, 240 - d.height)) }
                        .alignmentGuide(.leading) { _ in -(sa.maxX) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .onDisappear { app.subPopup = nil }
        }
    }

    @ViewBuilder
    private func menu(_ id: String, anchor a: CGRect) -> some View {
        let maxH = max(40, a.minY - 10)
        switch id {
        case "workspace":
            PopupSurface(style: .select) {
                ScrollView { MenuList(items: workspaceItems(), style: .select, minWidth: a.width, maxWidth: 352) }
                    .scrollIndicators(.never).frame(maxHeight: maxH).fixedSize(horizontal: true, vertical: true)
            }
            .testID("quick-menu-workspace")
        case "runtime", "reply-runtime":
            PopupSurface(style: .select) {
                QuickRuntimeList(current: id == "runtime" ? m.backend : m.replyBackend, minWidth: a.width, maxHeight: maxH) { rid in
                    m.menu = nil
                    if id == "runtime" { c.selectBackend(rid) } else { c.regenerateReply(rid) }
                }
            }
            .testID("quick-menu-runtime")
        default:
            PopupSurface(style: .dropdown) { MenuList(items: modelItems(), style: .dropdown, minWidth: 176) }
                .testID("quick-menu-model")
        }
    }

    private func close(_ f: @escaping () -> Void) -> () -> Void { { m.menu = nil; app.subPopup = nil; f() } }

    private func workspaceItems() -> [MenuItem] {
        let current = m.workspaceDir ?? Env.chatDir
        var dirs: [String] = []
        for d in [current, Env.chatDir] + app.prefs.recentWorkspaces where !dirs.contains(d) { dirs.append(d) }
        var items = dirs.enumerated().map { i, d in
            let chat = ComposerView.isChatWorkspace(d)
            let remote = d.hasPrefix("ssh://") || d.range(of: #"^[^/:\s]+@?[^/:\s]+:"#, options: .regularExpression) != nil
            return MenuItem(id: d, title: ComposerView.workspaceLabel(d), icon: AnyView(Glyph(name: chat ? "message-square" : remote ? "server" : "folder", size: 16)),
                            checked: d == current || (chat && ComposerView.isChatWorkspace(current)), testID: chat ? "quick-workspace-chat" : "quick-workspace-\(i)",
                            action: close { c.setWorkspace(d) })
        }
        items.append(MenuItem(id: "remote", title: "Remote SSH…", icon: AnyView(Glyph(name: "server", size: 16)), group: " ", muted: true,
                              action: close { app.remoteSSH = true; c.focusMain() }))
        items.append(MenuItem(id: "choose", title: "Add folder…", icon: AnyView(Glyph(name: "folder-plus", size: 16)), group: " ", muted: true,
                              action: close { c.chooseFolder() }))
        return items
    }

    private func modelItems() -> [MenuItem] {
        let rt = Runtimes.byId(m.backend)
        if rt.id == "pi" {
            let model = QuickTuning.piModel(m.piModel)
            let rows = model.id == "flash" ? rt.efforts : []
            let cur = QuickTuning.piEffort(m)?.id
            let efforts = rows.enumerated().map { i, e in
                MenuItem(id: "e:\(e.id)", title: e.label, checked: e.id == cur, group: "Reasoning", testID: "quick-effort-\(i)", action: close { c.setTuning(effort: e.id) })
            }
            let models = rt.models.map { o in
                MenuItem(id: "m:\(o.id)", title: o.label, icon: AnyView(Glyph(name: "zap", size: 16, color: Theme.foreground)), checked: o.id == model.id, group: "Model",
                         action: close { c.setTuning(model: o.id) })
            }
            return efforts + [MenuItem(id: "models", title: model.label, group: efforts.isEmpty ? nil : " ", testID: "quick-model-sub", submenu: models)]
        }
        let d = app.controller.cliDefaults[rt.id]
        let catalog = d?.catalog(rt) ?? rt.models
        let curM = QuickTuning.cliModel(m, app: app)
        let curE = QuickTuning.cliEffort(m, app: app)
        let efforts = rt.efforts.enumerated().map { i, e in
            MenuItem(id: "e:\(e.id)", title: e.label, checked: e.id == curE?.id, group: "Reasoning", testID: "quick-effort-\(i)", action: close { c.setTuning(effort: e.id) })
        }
        let models = catalog.map { o in
            MenuItem(id: "m:\(o.id)", title: o.label, checked: o.id == curM?.id, group: "Model", action: close { c.setTuning(model: o.id) })
        }
        let shown = curM?.label ?? m.cliModel.nonEmpty ?? d?.model ?? "Model"
        return efforts + [MenuItem(id: "models", title: shown, group: efforts.isEmpty ? nil : " ", testID: "quick-model-sub", submenu: models)]
    }
}

/// BackendSelect's list: 13px rows (text-md), runtime icon, ⌃n hint, check in the right gutter.
private struct QuickRuntimeList: View {
    let current: String
    let minWidth: CGFloat
    let maxHeight: CGFloat
    let pick: (String) -> Void
    @Environment(AppState.self) private var app
    @State private var hovered: String?
    var body: some View {
        let list = Runtimes.ordered(app.prefs)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, r in
                    Button { pick(r.id) } label: {
                        HStack(spacing: 8) {
                            RuntimeIcon(id: r.id, size: 16)
                            Text(r.label).font(.system(size: 13)).foregroundStyle(Theme.foreground).lineLimit(1).frame(height: 18.2)
                            Spacer(minLength: 0)
                            if i < 9 {
                                Text(Shortcuts.hint("runtime\(i + 1)", app.prefs)).font(.system(size: 11)).tracking(0.275)
                                    .foregroundStyle(Theme.mutedForeground.opacity(0.7)).padding(.leading, 12)
                            }
                        }
                        .padding(.leading, 8).padding(.trailing, 32).padding(.vertical, 6)
                        .overlay(alignment: .trailing) {
                            if r.id == current { Glyph(name: "check", size: 16, color: Theme.mutedForeground).frame(width: 14, height: 14).padding(.trailing, 8) }
                        }
                        .background(RoundedRectangle(cornerRadius: 6).fill(hovered == r.id || (hovered == nil && r.id == current) ? Theme.accent : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { if $0 { hovered = r.id } else if hovered == r.id { hovered = nil } }
                    .testID("quick-runtime-\(i)")
                }
            }
            .padding(5)
            .frame(minWidth: minWidth)
            .fixedSize(horizontal: true, vertical: false)
        }
        .scrollIndicators(.never)
        .frame(maxHeight: maxHeight)
        .fixedSize(horizontal: true, vertical: true)
    }
}

// MARK: - Tooltips

private struct QuickTipKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}

/// Registry of tooltip texts by id, for the panel's tooltip layer.
@MainActor enum QuickTips {
    static var texts: [String: (String, TooltipSpec.Side)] = [:]
}

private struct QuickTipModifier: ViewModifier {
    let text: String
    let id: String
    let side: TooltipSpec.Side
    @Environment(QuickModel.self) private var m
    func body(content: Content) -> some View {
        content
            .background(GeometryReader { g in Color.clear.preference(key: QuickFrameKey.self, value: ["tip:\(id)": g.frame(in: .named("quick"))]) })
            .onHover { inside in
                if inside {
                    QuickTips.texts[id] = (text, side)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { if QuickTips.texts[id] != nil, m.tooltip == nil || m.tooltip == id { m.tooltip = id } }
                } else if m.tooltip == id { m.tooltip = nil }
            }
            .onAppear { QuickTips.texts[id] = (text, side) }
            .onChange(of: text) { _, t in QuickTips.texts[id] = (t, side) }
    }
}

extension View {
    func quickTip(_ text: String, id: String, side: TooltipSpec.Side = .bottom) -> some View { modifier(QuickTipModifier(text: text, id: id, side: side)) }
}

/// shadcn TooltipContent: foreground fill, background text, 12px, px-3 py-1.5, radius 8, max-w-xs.
struct QuickTipLayer: View {
    let frames: [String: CGRect]
    @Environment(QuickModel.self) private var m
    var body: some View {
        GeometryReader { g in
            if let id = m.tooltip, m.menu == nil, let a = frames["tip:\(id)"], let (text, side) = QuickTips.texts[id] {
                Text(text).font(.system(size: 12)).foregroundStyle(Theme.background).multilineTextAlignment(.leading)
                    .lineSpacing(0)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(maxWidth: 320, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.foreground))
                    .alignmentGuide(.leading) { d in -max(4, min(a.midX - d.width / 2, g.size.width - d.width - 4)) }
                    .alignmentGuide(.top) { d in side == .top ? -(a.minY - 4 - d.height) : -(a.maxY + 4) }
                    .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
                    .allowsHitTesting(false)
                    .testID("quick-tooltip")
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Text view

/// The launcher's textarea: 15px on a 22.5px line, auto-growing to 8 lines.
struct QuickTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var token: Int
    var focusToken: Int
    var placeholder: String
    var fontSize: CGFloat = 15
    var lineHeight: CGFloat = 22.5
    var weight: NSFont.Weight = .regular
    var maxLines: CGFloat = 8
    var rightInset: CGFloat = 0
    var testID: String?
    var onCommand: (ComposerCommand) -> Bool
    var onPasteFiles: ([String]) -> Void = { _ in }
    var onPasteImage: (NSImage) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.borderType = .noBorder
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        let tv = ComposerNSTextView(frame: .zero, textContainer: container)
        tv.isRichText = false
        tv.importsGraphics = false
        tv.allowsUndo = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.drawsBackground = false
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainerInset = .zero
        tv.delegate = context.coordinator
        if let testID { tv.setAccessibilityIdentifier(testID) }
        scroll.documentView = tv
        context.coordinator.textView = tv
        apply(tv)
        tv.string = text
        QuickController.shared.textView = tv
        DispatchQueue.main.async { context.coordinator.recalc() }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = context.coordinator.textView else { return }
        apply(tv)
        if tv.string != text && !tv.hasMarkedText() {
            tv.string = text
            tv.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            context.coordinator.recalc()
        }
        if context.coordinator.focus != focusToken {
            context.coordinator.focus = focusToken
            DispatchQueue.main.async { if let w = tv.window, !QuickController.shared.testMode { w.makeFirstResponder(tv) } }
        }
        let h = scroll.contentSize.height
        if tv.minSize.height != h { tv.minSize = NSSize(width: 0, height: h) }
    }

    private func apply(_ tv: ComposerNSTextView) {
        let font = NSFont.systemFont(ofSize: fontSize, weight: weight)
        if tv.font != font { tv.font = font; tv.typingAttributes[.font] = font; tv.placeholderFont = font }
        let para = NSMutableParagraphStyle()
        para.minimumLineHeight = lineHeight
        para.maximumLineHeight = lineHeight
        para.tailIndent = rightInset > 0 ? -rightInset : 0
        let lift = ((lineHeight - (font.ascender - font.descender)) / 2 * 100).rounded() / 100
        tv.placeholderPara = para
        tv.placeholderLift = lift
        tv.placeholderColor = NSColor(Theme.mutedForeground).withAlphaComponent(0.6)
        tv.defaultParagraphStyle = para
        tv.typingAttributes[.paragraphStyle] = para
        tv.typingAttributes[.baselineOffset] = lift
        let ink = NSColor(Theme.foreground)
        tv.typingAttributes[.foregroundColor] = ink
        tv.textColor = ink
        tv.insertionPointColor = ink
        tv.placeholder = placeholder
        tv.onPasteFiles = onPasteFiles
        tv.onPasteImage = onPasteImage
        if let s = tv.textStorage, s.length > 0 {
            s.addAttributes([.paragraphStyle: para, .baselineOffset: lift, .font: font, .foregroundColor: ink], range: NSRange(location: 0, length: s.length))
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: QuickTextView
        weak var textView: ComposerNSTextView?
        var focus = -1
        init(_ p: QuickTextView) { parent = p }

        func textDidChange(_ notification: Notification) {
            guard let tv = textView else { return }
            if parent.text != tv.string { parent.text = tv.string }
            recalc()
        }

        func recalc() {
            guard let tv = textView, let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let used = max(parent.lineHeight, lm.usedRect(for: tc).height)
            let h = min(parent.lineHeight * parent.maxLines, ceil(used * 2) / 2)
            if abs(parent.height - h) > 0.4 { DispatchQueue.main.async { self.parent.height = h } }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if shift { return false }
                return parent.onCommand(.submit)
            case #selector(NSResponder.insertTab(_:)): return parent.onCommand(.tab)
            case #selector(NSResponder.cancelOperation(_:)): return parent.onCommand(.escape)
            default: return false
            }
        }
    }
}

extension QuickController {
    private static var textViewRef: [ObjectIdentifier: NSTextView] = [:]
    /// The live launcher/reply text view (for comparison-run typing).
    var textView: NSTextView? {
        get { Self.textViewRef[ObjectIdentifier(self)] }
        set { Self.textViewRef[ObjectIdentifier(self)] = newValue }
    }
}
