import AppKit
import Carbon.HIToolbox

/// The configurable "Summon Cetus" global hotkey (apply_summon_hotkey +
/// toggle_main): a real OS hotkey (Carbon RegisterEventHotKey, no
/// Accessibility needed) that brings Cetus forward, or hides it when it is
/// already the visible frontmost app. Re-registered whenever settings change.
///
/// Comparison instances (CETUS_CONTROL) don't register it unless
/// CETUS_QUICK_HOTKEYS=1, so they never steal the user's live binding.
@MainActor
final class HotkeySummon {
    static let shared = HotkeySummon()
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var current = ""
    private var observer: NSObjectProtocol?
    private(set) var registered = ""

    var allowed: Bool { Env.process["CETUS_CONTROL"] == nil || Env.process["CETUS_QUICK_HOTKEYS"] == "1" }

    func start() {
        guard allowed else { return }
        installHandler()
        apply()
        observer = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in HotkeySummon.shared.apply() }
        }
    }

    func stop() {
        unregister()
        if let handler { RemoveEventHandler(handler) }
        handler = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    func apply() {
        let hk = QuickController.settings.summonHotkey.trimmingCharacters(in: .whitespaces)
        guard hk != current else { return }
        current = hk
        unregister()
        guard !hk.isEmpty else { return }
        guard let (code, mods) = Self.parse(hk) else { NSLog("cetus: invalid summon hotkey \(hk)"); return }
        let id = EventHotKeyID(signature: OSType(0x4354_5553), id: 1) // 'CTUS'
        var r: EventHotKeyRef?
        let status = RegisterEventHotKey(code, mods, id, GetApplicationEventTarget(), 0, &r)
        if status == noErr { ref = r; registered = hk } else { NSLog("cetus: failed to register summon hotkey \(hk): \(status)") }
    }

    private func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        registered = ""
    }

    private func installHandler() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { QuickController.shared.toggleMain() }
            return noErr
        }, 1, &spec, nil, &handler)
    }

    /// Accelerator ("Cmd+Shift+K") → (virtual key code, Carbon modifiers).
    static func parse(_ accel: String) -> (UInt32, UInt32)? {
        let parts = Shortcuts.normalize(accel).split(separator: "+").map(String.init)
        var mods: UInt32 = 0
        var key: String?
        for p in parts {
            switch p {
            case "Cmd", "Super", "Meta": mods |= UInt32(cmdKey)
            case "Shift": mods |= UInt32(shiftKey)
            case "Alt": mods |= UInt32(optionKey)
            case "Ctrl": mods |= UInt32(controlKey)
            default: key = p
            }
        }
        guard let key, let code = Shortcuts.keyNames.first(where: { $0.value == key })?.key else { return nil }
        return (UInt32(code), mods)
    }
}
