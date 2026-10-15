import AppKit
import ApplicationServices

/// The launcher's modifier-only gestures (hotkey.rs): hold both ⌘, hold both
/// ⌥, double-tap ⌘, double-tap right ⌥ — each mapped to plain launcher,
/// launcher + screenshot (via the snip overlay) or visual quick reply. Uses a
/// listen-only CGEventTap, which needs Accessibility; it waits for the grant.
///
/// Comparison instances (CETUS_CONTROL) never install the tap, so they cannot
/// fight the user's live Cetus over the same gestures — unless
/// CETUS_QUICK_HOTKEYS=1 is set explicitly.
@MainActor
final class HotkeyGesture {
    static let shared = HotkeyGesture()

    static let actNone = 0, actPlain = 1, actShot = 2, actReply = 3

    private static let lcmd: UInt64 = 0x08, rcmd: UInt64 = 0x10, lalt: UInt64 = 0x20, ralt: UInt64 = 0x40
    private static let maxTapHold: TimeInterval = 0.4, maxTapGap: TimeInterval = 0.5

    private struct Double_ { var down = false; var pressAt: Date?; var lastTap: Date?; var dirty = false }

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var trustTimer: Timer?
    private var prompted = false
    private var wasBoth = false, wasBothOpt = false
    private var dbl = Double_(), alt = Double_()
    private var enabled = true
    private var acts = (bothCmd: 0, bothOpt: 0, doubleCmd: 0, doubleOpt: 0)
    private var observer: NSObjectProtocol?

    var allowed: Bool { Env.process["CETUS_CONTROL"] == nil || Env.process["CETUS_QUICK_HOTKEYS"] == "1" }
    var active: Bool { tap != nil }

    /// `gesture_actions`.
    static func actions(_ s: CapQuickSettings) -> (bothCmd: Int, bothOpt: Int, doubleCmd: Int, doubleOpt: Int) {
        var a = (bothCmd: 0, bothOpt: 0, doubleCmd: 0, doubleOpt: 0)
        func assign(_ g: String, _ act: Int) {
            switch g {
            case "both_cmd": a.bothCmd = act
            case "both_opt": a.bothOpt = act
            case "double_cmd": a.doubleCmd = act
            case "double_opt": a.doubleOpt = act
            default: break
            }
        }
        assign(s.gesturePlain, actPlain)
        assign(s.gestureShot, actShot)
        assign(s.gestureReply, actReply)
        return a
    }

    func start() {
        apply()
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in HotkeyGesture.shared.apply() }
        }
        guard allowed else { return }
        waitForTrust()
    }

    func stop() {
        trustTimer?.invalidate()
        trustTimer = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    /// Live settings (no tap rebuild), like `QuickRuntime::apply`.
    func apply() {
        let s = QuickController.settings
        enabled = s.enabled
        acts = Self.actions(s)
    }

    /// `wait_for_trust`: prompt once while the launcher is enabled, keep polling silently.
    private func waitForTrust() {
        if AXIsProcessTrusted() { install(); return }
        if enabled && !prompted {
            prompted = true
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        }
        trustTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
            Task { @MainActor in
                guard AXIsProcessTrusted() else { return }
                HotkeyGesture.shared.trustTimer?.invalidate()
                HotkeyGesture.shared.trustTimer = nil
                HotkeyGesture.shared.install()
            }
        }
    }

    private func install() {
        guard tap == nil else { return }
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let cb: CGEventTapCallBack = { _, type, event, _ in
            let flags = event.flags.rawValue
            MainActor.assumeIsolated { HotkeyGesture.shared.handle(type, flags) }
            return Unmanaged.passUnretained(event)
        }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                        eventsOfInterest: CGEventMask(mask), callback: cb, userInfo: nil) else {
            NSLog("cetus: failed to create CGEventTap (Accessibility?)")
            return
        }
        let src = CFMachPortCreateRunLoopSource(nil, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        tap = t
        source = src
        NSLog("cetus: launcher gesture listener active")
    }

    private func handle(_ type: CGEventType, _ bits: UInt64) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            let live = CGEventSource.flagsState(.combinedSessionState).rawValue
            dbl = Double_(); alt = Double_()
            wasBoth = live & Self.lcmd != 0 && live & Self.rcmd != 0
            wasBothOpt = live & Self.lalt != 0 && live & Self.ralt != 0
            return
        }
        if !enabled { wasBoth = false; return }
        if type == .keyDown {
            // A real keystroke while ⌘/⌥ is held makes it a chord, not a tap.
            if dbl.down { dbl.dirty = true }
            if alt.down { alt.dirty = true }
            return
        }
        guard type == .flagsChanged else { return }
        var fire: Int?
        let both = bits & Self.lcmd != 0 && bits & Self.rcmd != 0
        if both && !wasBoth {
            wasBoth = true
            if acts.bothCmd != Self.actNone { fire = acts.bothCmd }
        } else if !both { wasBoth = false }
        let bothOpt = bits & Self.lalt != 0 && bits & Self.ralt != 0
        if bothOpt && !wasBothOpt {
            wasBothOpt = true
            if acts.bothOpt != Self.actNone { fire = acts.bothOpt }
        } else if !bothOpt { wasBothOpt = false }
        if acts.doubleCmd != Self.actNone, let hit = Self.step(&dbl, held: bits & (Self.lcmd | Self.rcmd) != 0, both: both) { if hit { fire = acts.doubleCmd } }
        if acts.doubleOpt != Self.actNone, let hit = Self.step(&alt, held: bits & Self.ralt != 0, both: bothOpt) { if hit { fire = acts.doubleOpt } }
        if let fire { trigger(fire) }
    }

    /// One edge of a clean double-tap tracker; returns true when the second tap lands.
    private static func step(_ d: inout Double_, held: Bool, both: Bool) -> Bool? {
        if both { d.dirty = true }
        if held && !d.down {
            d.down = true
            d.pressAt = Date()
            d.dirty = both
        } else if !held && d.down {
            d.down = false
            let brief = d.pressAt.map { Date().timeIntervalSince($0) < maxTapHold } ?? false
            if brief && !d.dirty {
                let now = Date()
                if let prev = d.lastTap, now.timeIntervalSince(prev) < maxTapGap {
                    d.lastTap = nil
                    return true
                }
                d.lastTap = now
            } else {
                d.lastTap = nil
            }
        } else if d.down {
            d.dirty = true
        }
        return false
    }

    /// `trigger`.
    func trigger(_ action: Int) {
        switch action {
        case Self.actReply: QuickController.shared.openReply()
        case Self.actShot: Snip.shared.begin()
        default: QuickController.shared.openPanel(capture: false)
        }
    }
}
