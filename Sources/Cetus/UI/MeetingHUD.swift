import AppKit
import SwiftUI

// The floating meeting-recording pill (meeting-hud.tsx): a never-key panel at
// the top-center of the screen while a session is live — pulsing red dot,
// elapsed timer, one-click stop. Hovering (or pressing) the capsule grows the
// panel into a live-caption card; a cursor watchdog folds it back. The capsule
// is a drag region.

@MainActor
@Observable
final class MeetingHUDModel {
    struct Line: Equatable { var ts: Double; var source: String; var text: String }
    var expanded = false
    var stopping = false
    var finals: [Line] = []
    var partials: [String: Line] = [:]
    var meetingId: String?
    /// Bumped whenever the tail should follow new captions.
    var tick = 0
    static let maxFinals = 80
}

final class MeetingHUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Hosting view that turns a press on the capsule into "open + window drag",
/// and reports mouse movement (tracking areas stay live in a non-key panel).
final class MeetingHUDHostingView: NSHostingView<MeetingHUDView> {
    var onMove: (() -> Void)?
    var onPressCapsule: (() -> Void)?
    var expanded: () -> Bool = { false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for t in trackingAreas where t.userInfo?["meeting"] != nil { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeAlways, .inVisibleRect], owner: self, userInfo: ["meeting": true]))
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        onMove?()
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        // Top 52pt band = the capsule row; the stop button sits at its right end.
        let capsuleRow = p.y < 52
        let w = bounds.width
        let stopRect = CGRect(x: w / 2 + MeetingHUDView.capsuleWidth / 2 - 6 - 22, y: 15, width: 22, height: 22)
        if capsuleRow && !stopRect.contains(p) && event.buttonNumber == 0 {
            onPressCapsule?()
            window?.performDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }

}

@MainActor
final class MeetingHUD {
    static let shared = MeetingHUD()
    let model = MeetingHUDModel()
    private var panel: MeetingHUDPanel?
    private var host: MeetingHUDHostingView?
    private var hoverWork: DispatchWorkItem?
    private var opening = false
    private var watchdog: Timer?
    private var syncTimer: Timer?
    private var outsideSince: Date?
    private var listener: UUID?

    private func ensurePanel() -> MeetingHUDPanel {
        if let panel { return panel }
        let p = MeetingHUDPanel(contentRect: NSRect(origin: .zero, size: MeetingConst.hudCollapsed),
                                styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        p.hidesOnDeactivate = false
        p.isFloatingPanel = true
        p.hasShadow = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.isReleasedWhenClosed = false
        p.title = "Cetus"
        let h = MeetingHUDHostingView(rootView: MeetingHUDView(model: model, onStop: { MeetingHUD.shared.stop() }, onClose: { MeetingHUD.shared.collapseNow() }))
        h.onMove = { MeetingHUD.shared.mouseMoved() }
        h.onPressCapsule = { MeetingHUD.shared.openNow() }
        p.contentView = h
        host = h
        panel = p
        listener = UUID()
        MeetingEngine.shared.captionListeners[listener!] = { c in MeetingHUD.shared.onCaption(c) }
        return p
    }

    /// show_pill: collapsed, top-center of the mouse's screen, never key.
    func show() {
        let p = ensurePanel()
        resetForSession()
        collapseNow()
        resize(MeetingConst.hudCollapsed)
        let screen: NSScreen? = Env.process["CETUS_CONTROL"] != nil
            ? (NSApp.windows.first { $0.isVisible && $0 !== p }?.screen ?? NSScreen.main)
            : NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let v = screen?.visibleFrame {
            let f = p.frame
            p.setFrameOrigin(NSPoint(x: max(v.minX, v.minX + (v.width - f.width) / 2), y: v.maxY - f.height - 6))
        }
        p.orderFrontRegardless()
        if Env.process["CETUS_CONTROL"] != nil, let ctl = Env.process["CETUS_CONTROL"] {
            try? "\(p.windowNumber)".write(toFile: ctl + ".hud", atomically: true, encoding: .utf8)
            // Parity runs can't hover a background panel: open the card directly.
            if Env.process["CETUS_MEETING_HUD_EXPANDED"] != nil {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { MeetingHUD.shared.openNow() }
            }
        }
    }

    func hide() {
        collapseNow()
        panel?.orderOut(nil)
        model.stopping = false
        resetForSession()
    }

    private func resetForSession() {
        let id = MeetingEngine.shared.status.meetingId
        if id != model.meetingId {
            model.meetingId = id
            model.finals = []
            model.partials = [:]
        }
    }

    private func resize(_ size: CGSize) {
        guard let p = panel else { return }
        let f = p.frame
        p.setFrame(NSRect(x: f.midX - size.width / 2, y: f.maxY - size.height, width: size.width, height: size.height), display: true)
    }

    func stop() {
        model.stopping = true
        Task {
            await MeetingEngine.shared.stop(suppressAuto: true)
            model.stopping = false
        }
    }

    // MARK: captions

    private func onCaption(_ c: MeetingCaption) {
        if let id = model.meetingId, c.meetingId != id { return }
        if c.kind == "final" {
            model.partials[c.source] = nil
            if !c.text.isEmpty {
                model.finals.append(.init(ts: c.ts, source: c.source, text: c.text))
                if model.finals.count > MeetingHUDModel.maxFinals { model.finals.removeFirst(model.finals.count - MeetingHUDModel.maxFinals) }
            }
        } else if !c.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            model.partials[c.source] = .init(ts: c.ts, source: c.source, text: c.text)
        } else {
            model.partials[c.source] = nil
        }
        model.tick += 1
    }

    /// Reconcile the card with the durable transcript (missed captions repair).
    private func syncTranscript() {
        guard let id = model.meetingId else { return }
        var merged: [String: MeetingHUDModel.Line] = [:]
        for s in MeetingDB.shared.segments(id) { merged["\(s.ts):\(s.source):\(s.text)"] = .init(ts: s.ts, source: s.source, text: s.text) }
        for l in model.finals { merged["\(l.ts):\(l.source):\(l.text)"] = l }
        let next = Array(merged.values.sorted { $0.ts < $1.ts }.suffix(MeetingHUDModel.maxFinals))
        if next != model.finals { model.finals = next; model.tick += 1 }
    }

    // MARK: hover expand / collapse

    private func cursorInside() -> Bool {
        guard let f = panel?.frame else { return false }
        return f.insetBy(dx: -16, dy: -16).contains(NSEvent.mouseLocation)
    }

    private func mouseMoved() {
        if model.expanded || opening || hoverWork != nil { return }
        let w = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.hoverWork = nil
            if self.cursorInside() { self.openNow() }
        }
        hoverWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: w)
    }

    func openNow() {
        hoverWork?.cancel()
        hoverWork = nil
        if model.expanded || opening || model.meetingId == nil { return }
        opening = true
        resize(MeetingConst.hudExpanded)
        opening = false
        model.expanded = true
        syncTranscript()
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { _ in Task { @MainActor in MeetingHUD.shared.syncTranscript() } }
        outsideSince = nil
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in Task { @MainActor in MeetingHUD.shared.watch() } }
    }

    private func watch() {
        guard model.expanded, Env.process["CETUS_MEETING_HUD_EXPANDED"] == nil else { return }
        if cursorInside() { outsideSince = nil; return }
        if let t = outsideSince {
            if Date().timeIntervalSince(t) >= 0.3 { collapseNow() }
        } else {
            outsideSince = Date()
        }
    }

    func collapseNow() {
        hoverWork?.cancel()
        hoverWork = nil
        opening = false
        watchdog?.invalidate(); watchdog = nil
        syncTimer?.invalidate(); syncTimer = nil
        guard model.expanded else { return }
        model.expanded = false
        resize(MeetingConst.hudCollapsed)
    }
}

// MARK: - Views

struct MeetingHUDView: View {
    let model: MeetingHUDModel
    let onStop: () -> Void
    let onClose: () -> Void
    /// pl-3 + dot 8 + gap 8 + "m:ss" + gap 8 + 22 button + pr-1.5 (approx; only used for hit-testing).
    static let capsuleWidth: CGFloat = 12 + 8 + 8 + 28 + 8 + 22 + 6

    var body: some View {
        let engine = MeetingEngine.shared
        VStack(spacing: 0) {
            if let started = engine.status.startedTs, engine.status.recording {
                capsule(started).frame(maxWidth: .infinity).frame(height: 52)
                if model.expanded { card.padding(.bottom, 16) }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private func capsule(_ started: Double) -> some View {
        HStack(spacing: 8) {
            MeetingPingDot()
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                Text(MeetingFormat.elapsed(started, now: ctx.date))
                    .font(.system(size: 12, weight: .medium).monospacedDigit())
                    .foregroundStyle(.white)
                    .lineBox(16.2)
            }
            Button(action: onStop) {
                ZStack {
                    if model.stopping {
                        Spinner(size: 12, color: .white)
                    } else {
                        RoundedRectangle(cornerRadius: 1.5).fill(.white.opacity(0.8)).frame(width: 7.5, height: 7.5)
                    }
                }
                .frame(width: 22, height: 22)
                .modifier(MeetingHoverCircle())
            }
            .buttonStyle(.plain)
            .disabled(model.stopping)
            .help("Stop & save")
            .testID("meeting-hud-stop")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(height: 32)
        .background(Capsule().fill(.black).shadow(color: .black.opacity(0.45), radius: 5, y: 2))
    }

    private var card: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Circle().fill(Theme.destructive).frame(width: 6, height: 6)
                Text("LIVE TRANSCRIPT").font(.system(size: 11, weight: .medium)).tracking(0.275).foregroundStyle(.white.opacity(0.5)).lineBox(15.4)
                Spacer(minLength: 0)
                Button(action: onClose) {
                    Glyph(name: "x", size: 12, color: .white.opacity(0.4)).frame(width: 20, height: 20).modifier(MeetingHoverRect())
                }
                .buttonStyle(.plain)
                .help("Close captions")
            }
            .padding(.horizontal, 14).padding(.top, 11.5).padding(.bottom, 2.5)
            ScrollViewReader { proxy in
                ScrollView {
                    let partials = model.partials.values.sorted { $0.ts < $1.ts }
                    if model.finals.isEmpty && partials.isEmpty {
                        Text("Listening for the first words…").font(.system(size: 12)).foregroundStyle(.white.opacity(0.4)).lineBox(16.2)
                            .frame(maxWidth: .infinity).padding(.top, 24)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(Array(model.finals.enumerated()), id: \.offset) { i, line in
                                MeetingCaptionRow(line: line, partial: false, showLabel: i == 0 || model.finals[i - 1].source != line.source)
                            }
                            ForEach(partials, id: \.source) { line in MeetingCaptionRow(line: line, partial: true, showLabel: true) }
                            Color.clear.frame(height: 0).id("tail")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .scrollIndicators(.never)
                .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 12)
                .onChange(of: model.tick) { proxy.scrollTo("tail", anchor: .bottom) }
                .onAppear { proxy.scrollTo("tail", anchor: .bottom) }
            }
        }
        .frame(width: 400)
        .frame(maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 14).fill(.black.opacity(0.95)).shadow(color: .black.opacity(0.5), radius: 6, y: 4))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.1), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

struct MeetingCaptionRow: View {
    let line: MeetingHUDModel.Line
    let partial: Bool
    let showLabel: Bool
    var body: some View {
        let you = line.source == "mic"
        var label = AttributedString(showLabel ? (you ? "You" : "Them") + "\u{2002}" : "")
        label.font = .system(size: 12, weight: .semibold)
        label.foregroundColor = you ? Theme.primary : .white.opacity(0.5)
        var text = AttributedString(line.text)
        text.font = .system(size: 12)
        text.foregroundColor = .white.opacity(partial ? 0.55 : 0.9)
        return HStack(alignment: .lastTextBaseline, spacing: 2) {
            Text(label + text).lineSpacing(4.1).fixedSize(horizontal: false, vertical: true).padding(.vertical, 2.05)
            if partial { MeetingCaret() }
        }
    }
}

private struct MeetingCaret: View {
    @State private var on = false
    var body: some View {
        RoundedRectangle(cornerRadius: 1).fill(.white.opacity(0.6)).frame(width: 2, height: 12)
            .opacity(on ? 0.5 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 1).repeatForever()) { on = true } }
    }
}

/// `animate-ping` halo behind a solid destructive dot (size-2).
struct MeetingPingDot: View {
    @State private var ping = false
    var body: some View {
        ZStack {
            Circle().fill(Theme.destructive).opacity(ping ? 0 : 0.6).scaleEffect(ping ? 2 : 1)
            Circle().fill(Theme.destructive)
        }
        .frame(width: 8, height: 8)
        .onAppear { withAnimation(.timingCurve(0, 0, 0.2, 1, duration: 1).repeatForever(autoreverses: false)) { ping = true } }
    }
}

private struct MeetingHoverCircle: ViewModifier {
    @State private var hover = false
    func body(content: Content) -> some View {
        content.background(Circle().fill(.white.opacity(hover ? 0.15 : 0))).contentShape(Circle()).onHover { hover = $0 }
    }
}

private struct MeetingHoverRect: ViewModifier {
    @State private var hover = false
    func body(content: Content) -> some View {
        content.background(RoundedRectangle(cornerRadius: 4).fill(.white.opacity(hover ? 0.1 : 0))).contentShape(Rectangle()).onHover { hover = $0 }
    }
}

enum MeetingFormat {
    /// format.ts formatElapsed: "m:ss".
    static func elapsed(_ startedTs: Double, now: Date = Date()) -> String {
        let secs = max(0, Int((now.timeIntervalSince1970 * 1000 - startedTs) / 1000))
        return "\(secs / 60):" + String(format: "%02d", secs % 60)
    }
}
