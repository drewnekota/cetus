import AppKit
import SwiftUI

// The floating global-dictation capsule (src/components/quick/voice-hud.tsx)
// in a never-key, non-activating panel (panel::configure_hud), presented at the
// bottom-center of the screen under the mouse without activating Cetus.

private let hudBars = 15
private let hudMinH: CGFloat = 3
private let hudMaxH: CGFloat = 20
private let hudEnvelope: [Double] = (0..<hudBars).map { i in
    let x = Double(i) / Double(hudBars - 1) * 2 - 1
    return 0.4 + 0.6 * cos(x * .pi / 2)
}
private let hudPhase: [Double] = (0..<hudBars).map { i in (Double(i) * 1.7).truncatingRemainder(dividingBy: .pi * 2) }
private let hudEmerald300 = Color(red: 94 / 255, green: 233 / 255, blue: 181 / 255)

/// quick.ts `dictation.*` (English UI copy).
private func hudNoticeText(_ code: String) -> String {
    switch code {
    case "targetChanged": "Input target changed"
    case "insertFailed": "Couldn’t insert text"
    case "rawFallback": "Original transcript used"
    case "copied": "Copied"
    case "copyFailed": "Couldn’t copy · try again"
    default: "Dictation failed · try again"
    }
}

final class VoiceHUDModel: ObservableObject {
    @Published var busy = false
    @Published var notice = ""
    @Published var recovery: [String] = []
    @Published var dismissed = false
    @Published var learnedTerms: [String] = []
    @Published var heights: [CGFloat] = Array(repeating: hudMinH, count: hudBars)
    /// Frozen spinner dash phase (offscreen renders); nil animates.
    var spinnerPhase: Double?

    // Equalizer loop state (voice-hud.tsx tick).
    var target: Double = 0
    var energy: Double = 0
    private var timer: Timer?
    private let t0 = Date()

    func startLoop() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func stopLoop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        let t = Date().timeIntervalSince(t0)
        let k = target > energy ? 0.4 : 0.12
        energy += (target - energy) * k
        heights = (0..<hudBars).map { i in
            let shimmer = 0.7 + 0.3 * sin(t * 8 + hudPhase[i])
            return CGFloat((Double(hudMinH) + energy * hudEnvelope[i] * shimmer * Double(hudMaxH - hudMinH) * 10).rounded() / 10)
        }
        if busy || (target == 0 && energy < 0.002) { stopLoop() }
    }
}

struct VoiceHUDView: View {
    @ObservedObject var model: VoiceHUDModel
    var onCopy: () -> Void = {}
    var onDismiss: () -> Void = {}

    var body: some View {
        ZStack {
            if !model.dismissed {
                HStack(spacing: 8) {
                    if !model.notice.isEmpty {
                        Text(hudNoticeText(model.notice))
                            .font(.system(size: 12)).foregroundStyle(.white)
                            .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                    } else if !model.learnedTerms.isEmpty {
                        Glyph(name: "book-plus", size: 14, color: hudEmerald300)
                        Text("Added \(model.learnedTerms.joined(separator: ", ")) to your dictionary")
                            .font(.system(size: 12, weight: .medium)).tracking(0.12).foregroundStyle(.white)
                            .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                    } else if model.busy {
                        VoiceSpinner(phase: model.spinnerPhase).frame(width: 14, height: 14)
                    } else {
                        HStack(spacing: 2) {
                            ForEach(0..<hudBars, id: \.self) { i in
                                Capsule().fill(.white).frame(width: 2, height: model.heights[i])
                            }
                        }
                        .fixedSize()
                    }
                    if !model.recovery.isEmpty {
                        Button(action: onCopy) {
                            HStack(spacing: 4) {
                                Glyph(name: "copy", size: 12, color: .white)
                                Text("Copy result" + (model.recovery.count > 1 ? " (\(model.recovery.count))" : ""))
                                    .font(.system(size: 12)).foregroundStyle(.white).lineBox(16.2)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).fixedSize()
                        .help("Copy result")
                    }
                    if !model.notice.isEmpty {
                        Button(action: onDismiss) { Glyph(name: "x", size: 12, color: .white).contentShape(Rectangle()) }
                            .buttonStyle(.plain).fixedSize()
                            .accessibilityLabel("dismiss")
                    }
                }
                .padding(.horizontal, 12)
                .frame(height: 28)
                .background(Capsule().fill(.black).shadow(color: .black.opacity(0.45), radius: 5, y: 2))
                .frame(maxWidth: 368)
            }
        }
        .frame(width: 380, height: 52)
    }
}

/// components/ui/spinner.tsx — fixed geometry, only the dash phase moves.
struct VoiceSpinner: View {
    var phase: Double? = nil
    var body: some View {
        TimelineView(.animation(paused: phase != nil)) { ctx in
            let p = phase ?? (ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9)
            Canvas { g, size in
                let s = size.width / 24
                let circle = Path { $0.addArc(center: CGPoint(x: 12 * s, y: 12 * s), radius: 9 * s, startAngle: .zero, endAngle: .degrees(360), clockwise: false) }
                g.stroke(circle, with: .color(.white.opacity(0.25)), lineWidth: 2 * s)
                g.stroke(circle, with: .color(.white), style: StrokeStyle(lineWidth: 2 * s, lineCap: .round, dash: [14 * s, 43 * s], dashPhase: p * 57 * s))
            }
        }
    }
}

private final class VoiceHUDPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class VoiceHUDHostingView<V: View>: NSHostingView<V> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// Owner of the HUD panel + event handling (voice.rs show_hud / hide_hud /
/// show_notice / show_dictionary_toast / show_transcribing). Main thread only.
final class VoiceHUD {
    static let shared = VoiceHUD()
    let model = VoiceHUDModel()
    private var panel: NSPanel?
    private var sessionId: UInt64 = 0
    private var gen: UInt64 = 0

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        let p = VoiceHUDPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 52), styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        p.level = NSWindow.Level(rawValue: 25)
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        p.hidesOnDeactivate = false
        p.isFloatingPanel = true
        p.hasShadow = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.isReleasedWhenClosed = false
        p.title = "Cetus"
        let view = VoiceHUDView(model: model, onCopy: { [weak self] in self?.copyRecovery() }, onDismiss: { [weak self] in self?.dismiss() })
        let host = VoiceHUDHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 380, height: 52)
        p.contentView = host
        panel = p
        return p
    }

    var isVisible: Bool { panel?.isVisible ?? false }

    /// present_inactive at the bottom-center of the mouse's screen.
    private func present() {
        let p = ensurePanel()
        let mouse = NSEvent.mouseLocation
        if let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main {
            let f = screen.frame
            p.setFrameOrigin(NSPoint(x: max(f.minX + (f.width - p.frame.width) / 2, f.minX), y: f.minY + 36))
        }
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        p.orderFrontRegardless()
    }

    /// The dictation capsule appears (fresh session).
    func show(sessionId: UInt64) {
        gen &+= 1
        handle(.reset, sessionId: sessionId)
        if VoiceSettings.load().voiceStartSound {
            DispatchQueue.global().async { voiceRun("/usr/bin/afplay", ["-v", "0.35", "/System/Library/Sounds/Pop.aiff"]) }
        }
        present()
    }

    func hide() { panel?.orderOut(nil) }

    func showTranscribing() { handle(.transcribing, sessionId: nil) }

    func showNotice(_ code: String, text: String?) {
        gen &+= 1
        let g = gen
        handle(.notice(code: code, text: text), sessionId: nil)
        present()
        if text == nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                if self?.gen == g { self?.hide() }
            }
        }
    }

    func showDictionaryToast(_ terms: [String]) {
        gen &+= 1
        let g = gen
        handle(.dictionaryAdded(terms), sessionId: nil)
        present()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            if self?.gen == g { self?.hide() }
        }
    }

    /// The voice-* listeners of voice-hud.tsx.
    func handle(_ e: VoiceEvent, sessionId id: UInt64?) {
        if let id {
            if id < sessionId { return }
            sessionId = id
        }
        let m = model
        switch e {
        case .ready:
            if m.busy { return }
            m.learnedTerms = []
            m.busy = false
            m.target = 0
            m.startLoop()
        case .reset:
            m.dismissed = false
            m.notice = ""
            m.learnedTerms = []
            m.busy = false
            m.target = 0
            m.startLoop()
        case .transcribing:
            m.learnedTerms = []
            m.busy = true
            m.target = 0
        case let .level(l):
            if m.busy { return }
            m.target = min(1, max(0, l))
            m.startLoop()
        case .error:
            m.busy = false
            m.target = 0
            m.notice = "failed"
            m.dismissed = false
        case let .notice(code, text):
            m.busy = false
            m.target = 0
            m.learnedTerms = []
            m.notice = code.isEmpty ? "failed" : code
            m.dismissed = false
            if let text, !text.isEmpty { m.recovery.append(text) }
        case let .dictionaryAdded(terms):
            m.dismissed = false
            m.notice = ""
            m.busy = false
            m.target = 0
            m.learnedTerms = terms
        case .partial, .final:
            break
        }
    }

    private func copyRecovery() {
        guard let first = model.recovery.first else { return }
        if VoiceTextInput.copy(first) {
            model.recovery.removeFirst()
            model.notice = "copied"
        } else {
            model.notice = "copyFailed"
        }
    }

    private func dismiss() {
        model.dismissed = true
        model.notice = ""
        hide()
    }

    /// Offscreen render of the capsule (control harness pixel checks).
    @MainActor static func render(_ model: VoiceHUDModel, background: Color, spinnerPhase: Double = 0) -> NSImage? {
        model.spinnerPhase = spinnerPhase
        let view = ZStack {
            background
            VoiceHUDView(model: model)
        }
        .frame(width: 380, height: 52)
        .environment(\.colorScheme, .dark)
        let r = ImageRenderer(content: view)
        r.scale = 2
        return r.nsImage
    }
}
