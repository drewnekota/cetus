import AppKit
import SwiftUI

// Region-select ("snip") overlay for the contextful launcher gesture
// (snip.rs + snip-overlay.tsx): a dimmed sheet over the cursor's screen. Drag
// to select, click for the full screen, Esc to cancel. The pixels still come
// from `screencapture -R` after the overlay is hidden.

@MainActor
@Observable
final class SnipModel {
    var drag: (x0: CGFloat, y0: CGFloat, x1: CGFloat, y1: CGFloat)?
    var done = false
}

@MainActor
final class Snip {
    static let shared = Snip()
    let model = SnipModel()
    private var panel: QuickLauncherPanel?
    private var frameCG: CGRect = .zero
    private var context: QuickAmbient?
    private var clickMonitor: Any?
    static let clickSlop: CGFloat = 4

    private var c: QuickController { QuickController.shared }

    var window: NSWindow? { panel }

    private func ensurePanel() -> QuickLauncherPanel {
        if let panel { return panel }
        let p = QuickLauncherPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.level = c.testMode ? .normal : .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = false
        p.isReleasedWhenClosed = false
        p.acceptsMouseMovedEvents = true
        let host = NSHostingView(rootView: SnipOverlayView().environment(model))
        p.contentView = host
        panel = p
        return p
    }

    /// `snip::begin`.
    func begin() {
        if c.recapturing { return }
        if c.snipActive { cancel(); return }
        if c.shown { c.park(); return }
        guard QuickCapture.screenRecordingGranted else { c.openPanel(capture: true); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let ctx = QuickCapture.preFocusContext()
            DispatchQueue.main.async { self.present(ctx) }
        }
    }

    private func present(_ ctx: QuickAmbient?) {
        let p = ensurePanel()
        c.snipActive = true
        context = ctx
        model.done = false
        model.drag = nil
        let frame: NSRect
        if c.testMode, let main = c.app?.window {
            frame = main.contentRect(forFrameRect: main.frame)
        } else {
            let mouse = NSEvent.mouseLocation
            guard let s = (NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main) else { c.snipActive = false; return }
            frame = s.frame
        }
        p.setFrame(frame, display: true)
        let primaryTop = NSScreen.screens.first.map { $0.frame.maxY } ?? frame.maxY
        frameCG = CGRect(x: frame.minX, y: primaryTop - frame.maxY, width: frame.width, height: frame.height)
        if c.testMode, let main = c.app?.window {
            p.order(.above, relativeTo: main.windowNumber)
        } else {
            p.orderFrontRegardless()
            p.makeKey()
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
                Task { @MainActor in self?.cancel() }
            }
        }
    }

    private func hide() {
        if let m = clickMonitor { NSEvent.removeMonitor(m) }
        clickMonitor = nil
        panel?.orderOut(nil)
    }

    /// Esc, an outside click, or a conflicting gesture.
    func cancel() {
        c.snipActive = false
        context = nil
        model.done = true
        model.drag = nil
        hide()
    }

    /// `snip_finish`: rect in overlay points (top-left), nil = full screen.
    func finish(_ rect: CGRect?) {
        guard c.snipActive else { return }
        c.snipActive = false
        let ctx = context
        context = nil
        hide()
        c.recapturing = true
        let f = frameCG
        let region: CGRect
        if let r = rect {
            let x = min(max(r.minX, 0), f.width - 1), y = min(max(r.minY, 0), f.height - 1)
            region = CGRect(x: f.minX + x, y: f.minY + y, width: min(max(r.width, 1), f.width - x), height: min(max(r.height, 1), f.height - y))
        } else {
            region = f
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
            DispatchQueue.global(qos: .userInitiated).async {
                let shot = QuickCapture.captureRegion(region)
                DispatchQueue.main.async {
                    self.c.recapturing = false
                    self.c.presentLauncher(shot: shot, context: ctx, screenshotDefault: true)
                }
            }
        }
    }

    /// Comparison helper: show a drag state without a real pointer.
    func simulate(_ d: (CGFloat, CGFloat, CGFloat, CGFloat)?) { model.drag = d.map { (x0: $0.0, y0: $0.1, x1: $0.2, y1: $0.3) } }
}

struct SnipOverlayView: View {
    @Environment(SnipModel.self) private var m

    var body: some View {
        let sel = m.drag.map { d in CGRect(x: min(d.x0, d.x1), y: min(d.y0, d.y1), width: abs(d.x1 - d.x0), height: abs(d.y1 - d.y0)) }
        let selecting = sel.map { $0.width > Snip.clickSlop && $0.height > Snip.clickSlop } ?? false
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                if selecting, let s = sel {
                    // Everything outside the selection dims (the 100000px box-shadow).
                    Path { p in
                        p.addRect(CGRect(origin: .zero, size: g.size))
                        p.addRect(s)
                    }
                    .fill(Color.black.opacity(0.35), style: FillStyle(eoFill: true))
                    Rectangle().strokeBorder(Color.white.opacity(0.9), lineWidth: 1)
                        .frame(width: s.width, height: s.height)
                        .offset(x: s.minX, y: s.minY)
                    Text("\(Int(s.width.rounded())) × \(Int(s.height.rounded()))")
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(.white.opacity(0.9))
                        .frame(height: 12)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.75)))
                        .fixedSize()
                        .alignmentGuide(.leading) { d in -(s.maxX - d.width) }
                        .alignmentGuide(.top) { _ in -(s.maxY + 6) }
                } else {
                    Color.black.opacity(0.25)
                    Text("Drag to select an area · Click for the full screen · Esc to cancel")
                        .font(.system(size: 12)).foregroundStyle(.white.opacity(0.9))
                        .lineBox(16.2)
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .background(Capsule().fill(Color.black.opacity(0.75)))
                        .shadow(color: .black.opacity(0.1), radius: 7.5, y: 10)
                        .shadow(color: .black.opacity(0.1), radius: 3, y: 4)
                        .fixedSize()
                        .frame(width: g.size.width)
                        .offset(y: 40)
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    guard !m.done else { return }
                    m.drag = (v.startLocation.x, v.startLocation.y, v.location.x, v.location.y)
                }
                .onEnded { v in
                    guard !m.done else { return }
                    m.done = true
                    let x0 = v.startLocation.x, y0 = v.startLocation.y, x1 = v.location.x, y1 = v.location.y
                    m.drag = nil
                    let w = abs(x1 - x0).rounded(), h = abs(y1 - y0).rounded()
                    Snip.shared.finish(w > Snip.clickSlop && h > Snip.clickSlop ? CGRect(x: min(x0, x1).rounded(), y: min(y0, y1).rounded(), width: w, height: h) : nil)
                })
            .onHover { _ in NSCursor.crosshair.set() }
        }
        .background(SnipKeyCatcher())
        .ignoresSafeArea()
        .testID("snip-overlay")
    }
}

private struct SnipKeyCatcher: NSViewRepresentable {
    func makeNSView(context: Context) -> KeyView { KeyView() }
    func updateNSView(_ v: KeyView, context: Context) {}
    final class KeyView: NSView {
        override var acceptsFirstResponder: Bool { true }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); window?.makeFirstResponder(self) }
        override func keyDown(with e: NSEvent) {
            if e.keyCode == 53 { Task { @MainActor in if !Snip.shared.model.done { Snip.shared.cancel() } } } else { super.keyDown(with: e) }
        }
        override func cursorUpdate(with event: NSEvent) { NSCursor.crosshair.set() }
    }
}
