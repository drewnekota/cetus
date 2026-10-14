import AppKit
import SwiftUI

/// Window: sidebar-colored shell, sidebar on the left, and the content as a
/// floating card (8px margin, 14px continuous corners, hairline border).
struct RootView: View {
    @Environment(AppState.self) private var app
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let p = app.prefs
        GeometryReader { g in
            HStack(spacing: 0) {
                if p.sidebar {
                    SidebarView()
                        .frame(width: CGFloat(p.sidebarWidth))
                        .overlay(alignment: .trailing) { sidebarHandle.offset(x: 4) }
                        .zIndex(1)
                }
                card
                    .padding(8)
            }
            .background(Theme.sidebar)
            .environment(\.windowWidth, g.size.width)
            .environment(\.windowHeight, g.size.height)
        }
        .overlay { overlays }
        .environment(\.fontScale, CGFloat(p.fontSize / 14))
        .environment(\.lineScale, CGFloat(p.lineScale))
        .tint(Theme.primary)
        .ignoresSafeArea()
        .modifier(WorkspaceFileDropHost())
        .onAppear { CaptureArchiveSweeper.start(app); ScreenCapture.start(); AmbientCollector.start() }
    }

    private var card: some View {
        let side = app.side, bottom = app.bottom
        let shape = RoundedRectangle(cornerRadius: 14)
        return GeometryReader { g in
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        ContentHeader()
                        mainContent.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    if side.open {
                        // `border-l` is part of the panel's border box: content starts 1px in.
                        WorkspacePanel(layout: .side)
                            .padding(.leading, 1)
                            .frame(width: min(g.size.width * 0.5, 768))
                            .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                }
                if bottom.open {
                    WorkspaceBottomDock()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.2), value: side.open)
            .animation(.timingCurve(0.2, 0, 0, 1, duration: 0.2), value: bottom.open)
        }
        .padding(0.5) // the 0.5px border takes layout space (border-box)
        .background(Theme.background)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Theme.border, lineWidth: 0.5))
        .overlay(alignment: .top) {
            // Inset top highlight.
            shape.strokeBorder(LinearGradient(colors: [.white.opacity(scheme == .dark ? 0.10 : 0.45), .clear], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.004)), lineWidth: 1)
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(scheme == .dark ? 0.14 : 0.045), radius: scheme == .dark ? 9 : 8, y: scheme == .dark ? 4 : 3)
    }

    @ViewBuilder
    private var mainContent: some View {
        switch app.page {
        case .chats: ChatView()
        case .kanban: KanbanView()
        case .automations: AutomationsView()
        }
    }

    @ViewBuilder
    private var overlays: some View {
        ZStack {
            if app.remoteSSH { RemoteSSHDialog() }
            if app.palette {
                Color.black.opacity(0.2).onTapGesture { app.palette = false }
                GeometryReader { g in
                    PaletteView()
                        .frame(maxWidth: min(640, g.size.width - 32))
                        .frame(maxWidth: .infinity)
                        .padding(.top, g.size.height * 0.12)
                }
            }
            if app.settings { SettingsView() }
            if ScreenHistoryModel.shared.open { ScreenHistoryPage() }
            OnboardingOverlay()
            PopupLayer()
            if let s = app.switcher {
                Color.black.opacity(0.25).onTapGesture { app.switcher = nil }
                SwitcherView(ids: s.ids, index: s.index)
            }
            if let z = app.zoomHud { ZoomHud(pct: z.pct) }
            TooltipLayer()
            ToastStack()
        }
    }

    /// 8px hit strip straddling the sidebar edge; double-click resets to 224.
    private var sidebarHandle: some View {
        SidebarHandle(onDrag: { d in app.controller.setPrefs { $0.sidebarWidth = min(420, max(180, $0.sidebarWidth + d)) } },
                      onReset: { app.controller.setPrefs { $0.sidebarWidth = 224 } })
    }
}

private struct SidebarHandle: View {
    let onDrag: (CGFloat) -> Void
    let onReset: () -> Void
    @State private var hover = false
    @State private var last: CGFloat?
    var body: some View {
        ZStack {
            Rectangle().fill(hover || last != nil ? Theme.border : .clear).frame(width: 1)
        }
        .frame(width: 8)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .onHover { inside in
            hover = inside
            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        .onTapGesture(count: 2) { onReset() }
        .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .global)
            .onChanged { g in
                onDrag(g.translation.width - (last ?? 0))
                last = g.translation.width
            }
            .onEnded { _ in last = nil })
    }
}

/// Sonner-style toasts, bottom-right: white card in both themes (as Cetus renders).
private struct ToastStack: View {
    @Environment(AppState.self) private var app
    var body: some View {
        VStack(alignment: .trailing, spacing: 14) {
            Spacer()
            ForEach(app.toasts.suffix(3)) { t in
                // Sonner: [data-icon] 16px with -3/+4 margins, then a 6px gap.
                HStack(alignment: .center, spacing: 6) {
                    if t.kind != .plain {
                        Image(systemName: t.kind == .error ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                            .font(.system(size: 15)).foregroundStyle(Color(nsColor: NSColor(hex: 0x171717)))
                            .frame(width: 16, height: 16).padding(.leading, -3).padding(.trailing, 4)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Color(nsColor: NSColor(hex: 0x171717))).lineBox(19.5)
                        if let d = t.detail { Text(d).font(.system(size: 13)).foregroundStyle(Color(nsColor: NSColor(hex: 0x3F3F3F))).lineBox(19.5) }
                    }
                    if let label = t.actionLabel {
                        Spacer(minLength: 0)
                        Button { t.action?(); app.toasts.removeAll { $0.id == t.id } } label: {
                            Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.primaryForeground)
                                .padding(.horizontal, 8).frame(height: 24)
                                .background(RoundedRectangle(cornerRadius: 4).fill(Theme.primary))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(17) // p-4 plus the 1px border
                .frame(width: 356, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8).fill(.white))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: NSColor(hex: 0xEDEDED)), lineWidth: 1))
                .shadow(color: .black.opacity(0.1), radius: 6, y: 4)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .padding(24)
        .allowsHitTesting(!app.toasts.isEmpty)
        .animation(.easeOut(duration: 0.4), value: app.toasts)
    }
}

/// Ctrl+Tab: recent chats while Ctrl is held; releasing opens the highlighted one.
struct SwitcherView: View {
    @Environment(AppState.self) private var app
    let ids: [String]
    let index: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(ids.prefix(12).enumerated()), id: \.element) { i, id in
                if let c = app.controller.conversation(id) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(c.title.isEmpty ? "Untitled" : c.title).font(.system(size: 14, weight: .medium)).lineLimit(1).lineBox(20)
                            Text([Env.folderName(c.workspaceDir), Runtimes.byId(c.backend).label].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(1).lineBox(16)
                        }
                        Spacer(minLength: 0)
                        Group {
                            if c.runState == .running { Spinner(size: 12, color: Theme.mutedForeground.opacity(0.7)) }
                            else if c.unread { Circle().fill(Theme.primary).frame(width: 8, height: 8) }
                            else { Text(Fmt.relative(c.updatedAt)).font(.system(size: 12, design: .monospaced).monospacedDigit()).foregroundStyle(Theme.mutedForeground.opacity(0.7)) }
                        }
                        .frame(minWidth: 28, alignment: .trailing)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 48)
                    .hoverFill(Theme.accent.opacity(0.5), radius: 10, active: i == index, activeFill: Theme.accent)
                    .onTapGesture { app.switcher = nil; app.openChat(id) }
                }
            }
        }
        .padding(7) // p-1.5 plus the 1px border
        .frame(width: 440)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.popover))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.foreground.opacity(0.1), lineWidth: 1))
        .shadow(color: .black.opacity(0.25), radius: 25, y: 25)
        .testID("switcher")
    }
}
