import AppKit
import SwiftUI

// Shared building blocks matching Cetus's shadcn components.

/// `Kbd`: 16px chip, radius 4, 11px text, muted/40 fill.
struct Kbd: View {
    let text: String
    var bordered = true
    var inverted = false
    var body: some View {
        if !text.isEmpty {
            Text(text)
                .font(.system(size: 11))
                .tracking(0.275)
                .foregroundStyle(inverted ? Theme.background.opacity(0.75) : Theme.mutedForeground.opacity(0.8))
                .padding(.horizontal, 5) // px-1 plus the 1px (possibly transparent) border
                .frame(height: 16)
                .background(RoundedRectangle(cornerRadius: inverted ? 6 : 4).fill(inverted ? Theme.background.opacity(0.1) : Theme.muted.opacity(0.4)))
                .overlay(RoundedRectangle(cornerRadius: inverted ? 6 : 4)
                    .strokeBorder(inverted ? Theme.background.opacity(0.2) : bordered ? Theme.border.opacity(0.5) : .clear, lineWidth: 1))
        }
    }
}

/// Cetus's spinner: a fixed track plus a dash that travels around it (the circle never rotates).
struct Spinner: View {
    var size: CGFloat = 16
    var color: Color = Theme.mutedForeground
    @State private var phase: CGFloat = 0
    var body: some View {
        ZStack {
            Circle().stroke(color.opacity(0.25), lineWidth: 2 * size / 24)
            Circle()
                .stroke(color, style: StrokeStyle(lineWidth: 2 * size / 24, lineCap: .round, dash: [14 * size / 24, 43 * size / 24], dashPhase: phase))
        }
        .padding(3 * size / 24)
        .frame(width: size, height: size)
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { phase = 57 * size / 24 }
        }
    }
}

/// Text that animates a light sweep (Cetus's `animate-shimmer-text`).
struct ShimmerText: View {
    let text: String
    var size: CGFloat = 14
    var weight: Font.Weight = .medium
    @State private var x: CGFloat = -1
    var body: some View {
        Text(text)
            .cetusFont(size, weight)
            .foregroundStyle(Theme.mutedForeground)
            .overlay {
                GeometryReader { g in
                    LinearGradient(colors: [.clear, Theme.foreground, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: g.size.width)
                        .offset(x: x * g.size.width)
                }
                .mask(Text(text).cetusFont(size, weight))
            }
            .onAppear { withAnimation(.linear(duration: 2).repeatForever(autoreverses: false)) { x = 1 } }
    }
}

// MARK: - Tooltips (inverted chip with optional Kbd, drawn in the app overlay)

struct TooltipSpec: Equatable {
    enum Side { case right, bottom, top, left }
    var text: String
    var kbd: String = ""
    var side: Side
    var anchor: CGRect
    /// Radix `sideOffset` (added to the arrow's 10px).
    var offset: CGFloat = 0
    /// `align="start"` instead of centered on the trigger.
    var alignStart = false
    /// Rich content (e.g. the conversation hover card) replacing the text chip.
    var content: AnyView? = nil
    static func == (l: Self, r: Self) -> Bool { l.text == r.text && l.anchor == r.anchor && l.side == r.side }
}

private struct TooltipModifier: ViewModifier {
    @Environment(AppState.self) private var app
    let spec: (CGRect) -> TooltipSpec
    let text: String
    let delay: Double
    @State private var frame: CGRect = .zero
    @State private var token = 0

    func body(content: Content) -> some View {
        content
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { frame = g.frame(in: .global); TooltipLayer.registry[text] = { spec(g.frame(in: .global)) } }
                    .onChange(of: g.frame(in: .global)) { _, f in frame = f; TooltipLayer.registry[text] = { spec(f) } }
            })
            .onHover { inside in
                token += 1
                let t = token
                if inside {
                    // Radix skipDelayDuration: moving straight from one tooltip to the next opens it instantly.
                    let warm = app.tooltip != nil || Date().timeIntervalSince(TooltipLayer.lastClosed) < 0.3
                    DispatchQueue.main.asyncAfter(deadline: .now() + (warm ? 0 : delay)) {
                        if t == token { app.tooltip = spec(frame) }
                    }
                } else if app.tooltip?.text == text {
                    app.tooltip = nil
                    TooltipLayer.lastClosed = Date()
                }
            }
            .onDisappear { if app.tooltip?.text == text { app.tooltip = nil } }
            .simultaneousGesture(TapGesture().onEnded { token += 1; app.tooltip = nil })
    }
}

extension View {
    /// Cetus-style tooltip (200ms delay), e.g. `.tip("Toggle Sidebar", kbd: "⌘B", side: .right)`.
    func tip(_ text: String, kbd: String = "", side: TooltipSpec.Side = .bottom, delay: Double = 0.2) -> some View {
        modifier(TooltipModifier(spec: { TooltipSpec(text: text, kbd: kbd, side: side, anchor: $0) }, text: text, delay: delay))
    }

    /// Tooltip with custom content (`id` identifies it), e.g. the sidebar row's hover card.
    func tip<C: View>(id: String, side: TooltipSpec.Side = .right, offset: CGFloat = 0, alignStart: Bool = false, delay: Double = 0.2, @ViewBuilder content: @escaping () -> C) -> some View {
        modifier(TooltipModifier(spec: { TooltipSpec(text: id, side: side, anchor: $0, offset: offset, alignStart: alignStart, content: AnyView(content())) }, text: id, delay: delay))
    }
}

/// shadcn TooltipContent: bg-foreground, rounded-md, px-3 py-1.5 text-xs, a
/// 10px rotated-square arrow whose center sits 2px inside the edge, and the
/// arrow's 10px between trigger and surface (plus `sideOffset`).
struct TooltipLayer: View {
    @Environment(AppState.self) private var app
    @State private var size: CGSize = .zero
    static var lastClosed = Date.distantPast
    /// Control mode: tooltip text/id → its spec at the trigger's current frame (`tip <text>`).
    static var registry: [String: () -> TooltipSpec] = [:]
    var body: some View {
        GeometryReader { g in
            if let t = app.tooltip {
                let origin = g.frame(in: .global).origin
                let a = PopupLayer.local(t.anchor, origin, app)
                let p = position(t, a, g.size)
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 2).fill(Theme.tooltip)
                        .frame(width: 10, height: 10).rotationEffect(.degrees(45))
                        .position(arrow(t, a, p))
                    surface(t)
                        .fixedSize()
                        .background(GeometryReader { c in Color.clear.onAppear { size = c.size }.onChange(of: c.size) { _, s in size = s } })
                        .offset(x: p.x, y: p.y)
                }
                .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
                .allowsHitTesting(false)
                .transition(.opacity)
            }
        }
    }

    /// Top-left of the surface.
    private func position(_ t: TooltipSpec, _ a: CGRect, _ bounds: CGSize) -> CGPoint {
        let gap = 10 + t.offset
        var p: CGPoint
        switch t.side {
        case .right: p = CGPoint(x: a.maxX + gap, y: t.alignStart ? a.minY : a.midY - size.height / 2)
        case .left: p = CGPoint(x: a.minX - gap - size.width, y: t.alignStart ? a.minY : a.midY - size.height / 2)
        case .bottom: p = CGPoint(x: t.alignStart ? a.minX : a.midX - size.width / 2, y: a.maxY + gap)
        case .top: p = CGPoint(x: t.alignStart ? a.minX : a.midX - size.width / 2, y: a.minY - gap - size.height)
        }
        p.x = min(max(p.x, 0), bounds.width - size.width)
        p.y = min(max(p.y, 0), bounds.height - size.height)
        return p
    }

    /// Arrow center: on the trigger's center line, 2px inside the surface edge.
    private func arrow(_ t: TooltipSpec, _ a: CGRect, _ p: CGPoint) -> CGPoint {
        switch t.side {
        case .right: CGPoint(x: p.x + 2, y: min(max(a.midY, p.y + 9), p.y + size.height - 9))
        case .left: CGPoint(x: p.x + size.width - 2, y: min(max(a.midY, p.y + 9), p.y + size.height - 9))
        case .bottom: CGPoint(x: min(max(a.midX, p.x + 9), p.x + size.width - 9), y: p.y + 2)
        case .top: CGPoint(x: min(max(a.midX, p.x + 9), p.x + size.width - 9), y: p.y + size.height - 2)
        }
    }

    @ViewBuilder private func surface(_ t: TooltipSpec) -> some View {
        if let c = t.content {
            c.background(RoundedRectangle(cornerRadius: 6).fill(Theme.tooltip))
        } else {
            HStack(spacing: 6) {
                Text(t.text).font(.system(size: 12)).foregroundStyle(Theme.background).lineBox(16.19)
                if !t.kbd.isEmpty { Kbd(text: t.kbd, inverted: true) }
            }
            .padding(.leading, 12)
            .padding(.trailing, t.kbd.isEmpty ? 12 : 6)
            .padding(.vertical, 6)
            .frame(maxWidth: 320)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.tooltip))
        }
    }
}

// MARK: - Buttons

/// shadcn ghost icon button: icon-xs 24×24 / icon-sm 32×32, radius 8, hover muted.
struct GhostIconButton: View {
    let icon: String
    var box: CGFloat = 24
    var glyph: CGFloat = 14
    var color: Color = Theme.mutedForeground
    var hoverColor: Color = Theme.foreground
    var hoverFill: Color = Theme.ghostHover
    var active = false
    var tip: String = ""
    var kbd: String = ""
    var tipSide: TooltipSpec.Side = .bottom
    var testID: String? = nil
    /// A plain rounded hover fill (no transparent border) instead of the shadcn Button's.
    var radius: CGFloat? = nil
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Glyph(name: icon, size: glyph, color: hover || active ? hoverColor : color)
                .frame(width: box, height: box)
                // border border-transparent bg-clip-padding: the fill stops 1px inside.
                .background(RoundedRectangle(cornerRadius: radius ?? 7).fill(hover || active ? hoverFill : .clear).padding(radius == nil ? 1 : 0))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressDownStyle())
        .onHover { hover = $0 }
        .if(!tip.isEmpty) { $0.tip(tip, kbd: kbd, side: tipSide) }
        .testID(testID)
    }
}

/// `active:translate-y-px`.
struct PressDownStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.offset(y: configuration.isPressed ? 1 : 0)
    }
}

/// shadcn Button. Sizes: sm (h32 px10 14/500), xs7 (h28 px10 12/500).
struct CetusButtonStyle: ButtonStyle {
    enum Variant { case primary, outline, ghost, destructive }
    var variant: Variant = .primary
    var height: CGFloat = 32
    var fontSize: CGFloat = 14
    var horizontal: CGFloat = 10
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        StyledBody(configuration: configuration, style: self)
    }

    private struct StyledBody: View {
        let configuration: Configuration
        let style: CetusButtonStyle
        @Environment(\.isEnabled) private var enabled
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: style.fontSize, weight: .medium))
                .foregroundStyle(fg)
                .padding(.horizontal, style.horizontal + 1) // px + the transparent 1px border
                .frame(maxWidth: style.fullWidth ? .infinity : nil)
                .frame(height: style.height)
                // border border-transparent bg-clip-padding: the fill stops inside the 1px border.
                .background(RoundedRectangle(cornerRadius: 7).fill(bg).padding(1))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(style.variant == .outline ? Theme.border : .clear, lineWidth: 1))
                .shadow(color: style.variant == .outline ? .black.opacity(0.05) : .clear, radius: 1, y: 1)
                .compositingGroup()
                .opacity(enabled ? 1 : 0.5)
                .offset(y: configuration.isPressed ? 1 : 0)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
        private var fg: Color {
            switch style.variant {
            case .primary: Theme.primaryForeground
            case .destructive: Theme.destructive
            default: Theme.foreground
            }
        }
        private var bg: Color {
            switch style.variant {
            case .primary: Theme.primary.opacity(hover ? 0.8 : 1)
            case .outline: hover ? Theme.muted : Theme.background
            case .ghost: hover ? Theme.ghostHover : .clear
            case .destructive: Theme.destructive.opacity(hover ? 0.2 : 0.1)
            }
        }
    }
}

/// shadcn Switch: 32×18.4 capsule, 16px thumb.
/// shadcn Switch: 32×18.4 track with a transparent 1px border (bg-input,
/// input/80 in dark; primary when on), 16px thumb (background in light;
/// foreground off / primary-foreground on in dark), shadow-xs.
struct CetusSwitch: View {
    @Binding var isOn: Bool
    var testID: String? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { isOn.toggle() } } label: {
            Capsule()
                .fill(isOn ? Theme.primary : scheme == .dark ? Theme.input.opacity(0.8) : Theme.input)
                .frame(width: 32, height: 18.4)
                .overlay(alignment: .leading) {
                    Circle().fill(scheme == .dark ? (isOn ? Theme.primaryForeground : Theme.foreground) : Theme.background)
                        .frame(width: 16, height: 16).offset(x: isOn ? 15 : 1)
                }
                .shadow(color: .black.opacity(0.05), radius: 0.5, y: 1)
        }
        .buttonStyle(.plain)
        .testID(testID)
    }
}

/// A row that paints `fill` while hovered.
struct HoverFill: ViewModifier {
    var radius: CGFloat = 8
    var fill: Color = Theme.accent
    var active = false
    var activeFill: Color? = nil
    @State private var hover = false
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius).fill(active ? (activeFill ?? fill) : hover ? fill : .clear))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
    }
}

extension View {
    func hoverFill(_ fill: Color = Theme.accent, radius: CGFloat = 8, active: Bool = false, activeFill: Color? = nil) -> some View {
        modifier(HoverFill(radius: radius, fill: fill, active: active, activeFill: activeFill))
    }
}

/// Native-feeling dropdown menu panel (Cetus DropdownMenu): popover fill, 1px hairline ring, shadow-md.
struct MenuPanel<Content: View>: View {
    var width: CGFloat? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .padding(4)
            .frame(width: width)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.popover))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(0.1), radius: 6, y: 4)
    }
}

enum SerifFont {
    static func italic(_ size: CGFloat) -> Font { .custom(Theme.serifName, size: size) }
}

/// `font-serif font-bold italic`: the web build only ships Old Standard TT 400
/// italic, so WebKit draws the italic face with synthetic bold (painted twice,
/// 1px apart). Same here.
struct Wordmark: View {
    let text: String
    var size: CGFloat = 14
    var body: some View {
        Text(text).font(SerifFont.italic(size)).tracking(0.5).foregroundStyle(Theme.foreground)
            .overlay(alignment: .leading) { Text(text).font(SerifFont.italic(size)).tracking(0.5).foregroundStyle(Theme.foreground).offset(x: 0.5) }
            .padding(.trailing, 0.5)
    }
}

extension View {
    /// CSS line box for single-line text: `line-height` tall with the glyphs
    /// centered (half-leading above and below), as the web build lays out text.
    /// Tailwind ramp: text-2xs 11/15.4, text-xs 12/16.2, text-sm 14/20.02, text-base 16/24.
    /// Scaled by the Line height setting.
    func lineBox(_ height: CGFloat) -> some View { modifier(LineBox(height: height)) }
}

private struct LineBox: ViewModifier {
    let height: CGFloat
    @Environment(\.lineScale) private var lineScale
    func body(content: Content) -> some View { content.frame(height: lineScale == 1 ? height : height * lineScale) }
}

// MARK: - Right click

/// `onContextMenu` + preventDefault: a right-click (or ⌃-click) inside the view
/// runs `action` instead of showing a native context menu.
struct RightClickCatcher: NSViewRepresentable {
    var enabled = true
    let action: () -> Void
    func makeNSView(context: Context) -> CatcherView { let v = CatcherView(); v.action = action; v.enabled = enabled; return v }
    func updateNSView(_ v: CatcherView, context: Context) { v.action = action; v.enabled = enabled }
    static func dismantleNSView(_ v: CatcherView, coordinator: ()) { v.stop() }

    final class CatcherView: NSView {
        var action: () -> Void = {}
        var enabled = true
        private var monitor: Any?
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown]) { [weak self] e in
                guard let self, self.enabled, let w = self.window, e.window === w, !self.isHiddenOrHasHiddenAncestor,
                      e.type == .rightMouseDown || e.modifierFlags.contains(.control),
                      self.bounds.contains(self.convert(e.locationInWindow, from: nil)) else { return e }
                self.action()
                return nil
            }
        }
        func stop() { if let m = monitor { NSEvent.removeMonitor(m); monitor = nil } }
        deinit { stop() }
    }
}

extension View {
    func onRightClick(enabled: Bool = true, _ action: @escaping () -> Void) -> some View {
        background(RightClickCatcher(enabled: enabled, action: action))
    }
}
