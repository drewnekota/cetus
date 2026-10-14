import AppKit
import SwiftUI

/// Window-level host for shadcn `Dialog`s (automation editor, new task, session
/// detail). Radix portals the dialog to <body>, so its bg-black/20 overlay covers
/// the whole window — sidebar included — which a view inside the content card
/// can't do (the card clips). The dialog is mounted in its own NSHostingView on
/// top of the window content, with a PopupLayer of its own so the dialog's
/// selects and menus still render above it.
@MainActor
enum DialogHost {
    private static var host: NSView?
    private static var monitor: Any?
    private static var current: String?
    /// Cmd+Enter handler of the open dialog (DialogContent onKeyDown).
    static var onSubmit: (() -> Void)?
    static var onEscape: (() -> Bool)?
    /// Runs once when the dialog closes (any path: Esc, overlay click, Cancel).
    static var onDismiss: (() -> Void)?

    static var isOpen: Bool { host != nil }
    static var openId: String? { current }

    static func present<Content: View>(_ id: String, app: AppState, @ViewBuilder content: () -> Content) {
        dismiss()
        guard let cv = app.window?.contentView else { return }
        let root = DialogLayer(content: AnyView(content()))
            .environment(app)
            .environment(\.fontScale, CGFloat(app.prefs.fontSize / 14))
            .environment(\.lineScale, CGFloat(app.prefs.lineScale))
            .tint(Theme.primary)
        let v = NSHostingView(rootView: AnyView(root))
        // A sibling above the content view (in the frame view): SwiftUI draws
        // the content hosting view's own layer over any subviews added to it.
        let parent = cv.superview ?? cv
        v.frame = parent === cv ? cv.bounds : cv.frame
        v.autoresizingMask = [.width, .height]
        parent.addSubview(v, positioned: .above, relativeTo: parent === cv ? nil : cv)
        host = v
        current = id
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
            guard host != nil else { return e }
            let f = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if e.keyCode == 53 {
                if app.subPopup != nil { app.subPopup = nil; return nil }
                if app.popup != nil { app.popup = nil; return nil }
                if let h = onEscape, h() { return nil }
                dismiss()
                return nil
            }
            if e.keyCode == 36 || e.keyCode == 76, f.contains(.command) || f.contains(.control), let s = onSubmit {
                s()
                return nil
            }
            return e
        }
    }

    static func dismiss() {
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
        host?.removeFromSuperview()
        host = nil
        current = nil
        onSubmit = nil
        onEscape = nil
        let done = onDismiss
        onDismiss = nil
        done?()
    }
}


/// bg-black/20 overlay (click closes) + the centered dialog + menus above it.
private struct DialogLayer: View {
    let content: AnyView
    @Environment(AppState.self) private var app
    var body: some View {
        GeometryReader { g in
            ZStack {
                Color.black.opacity(0.2)
                    .contentShape(Rectangle())
                    .onTapGesture { DialogHost.dismiss() }
                content
                PopupLayer()
                TooltipLayer()
            }
            .environment(\.windowWidth, g.size.width)
            .environment(\.windowHeight, g.size.height)
        }
        .ignoresSafeArea()
    }
}

/// DialogContent surface: popover fill, rounded-xl, ring-1 ring-foreground/10.
struct DialogSurface: ViewModifier {
    var fill: Color = Theme.popover
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: 10).fill(fill))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .background(RoundedRectangle(cornerRadius: 10).inset(by: -1).fill(Theme.foreground.opacity(0.1)))
            .contentShape(Rectangle())
            .onTapGesture {} // swallow: clicks inside don't reach the overlay
    }
}

extension View {
    func dialogSurface(fill: Color = Theme.popover) -> some View { modifier(DialogSurface(fill: fill)) }
}

/// "Automation › New" breadcrumb chip header shared by the automation and task dialogs.
struct DialogBreadcrumb<Trailing: View>: View {
    var icon: String?
    let root: String
    let leaf: String
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                if let icon { Glyph(name: icon, size: 12, color: Theme.foreground) }
                Text(root).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.foreground).lineBox(16.2)
            }
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.muted))
            Text("›").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            Text(leaf).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(16.2)
            Spacer(minLength: 0)
            trailing
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
        .padding(.bottom, 1)
    }
}
