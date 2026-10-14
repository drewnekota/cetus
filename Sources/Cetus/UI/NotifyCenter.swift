import AppKit
import ObjectiveC
import UserNotifications

// Port of Cetus's notification stack:
//  - src/lib/notifications.ts  (prefs gate, mute-when-focused, one-shot permission request)
//  - src-tauri/src/notify.rs   (NSUserNotificationCenter with a persistent delegate so a
//                               click routes back as "open this conversation", the cetus
//                               logo pinned via `_identityImage`, banners forced even
//                               while frontmost)
//  - src/app/home/use-app-events.tsx (which events notify, with which copy)

/// The by-event catalog (NotifyEvent).
enum NotifyEvent: String { case taskFinished = "task_finished", awaitingInput = "awaiting_input", meeting }

@MainActor
enum NotifyCenter {
    /// Click → open (or unarchive) the conversation; installed by AppShell.
    static var onActivate: ((String?) -> Void)?
    private static var autoRequested = false
    private static var permissionGranted: Bool?
    private static var delegate: NotifyDelegate?
    private static var prepared = false

    static var disabled: Bool { Env.process["CETUS_NO_NOTIFY"] != nil }
    private static var bundled: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    /// `notify::init`: register the persistent delegate once.
    static func prepare() {
        guard !prepared else { return }
        prepared = true
        if !bundled { NotifyBundleHook.install() }
        NotifyBundleHook.borrowing {
            let d = NotifyDelegate()
            delegate = d
            NSUserNotificationCenter.default.delegate = d
        }
    }

    /// `dispatchNotification(kind, opts)`.
    static func dispatch(_ kind: NotifyEvent, title: String, body: String = "", suppressWhenFocused: Bool = false, conversationId: String? = nil) {
        guard let prefs = AppShell.controller?.prefs.notifications else { return }
        guard prefs.enabled else { return }
        switch kind {
        case .taskFinished: if !prefs.taskFinished { return }
        case .awaitingInput: if !prefs.awaitingInput { return }
        case .meeting: if !(UserDefaults.standard.object(forKey: "settings.notifyMeeting") as? Bool ?? true) { return }
        }
        // document.hasFocus(): the main window is key and the app active.
        let focused = NSApp.isActive && (AppShell.window?.isKeyWindow ?? false)
        if focused && (prefs.muteWhenFocused || suppressWhenFocused) { return }
        if disabled { return }
        withPermission { granted in
            guard granted else { return }
            post(title: title, body: body, conversationId: conversationId)
        }
    }

    /// isPermissionGranted → requestPermission at most once per session.
    private static func withPermission(_ done: @escaping @MainActor (Bool) -> Void) {
        // The unbundled dev binary borrows Terminal's registration (as `tauri dev` does).
        guard bundled else { done(true); return }
        if let g = permissionGranted, g || autoRequested { done(g); return }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { s in
            let ok = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional
            Task { @MainActor in
                if ok || autoRequested { permissionGranted = ok; done(ok); return }
                autoRequested = true
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    Task { @MainActor in permissionGranted = granted; done(granted) }
                }
            }
        }
    }

    /// `post_notification` → `deliver`: one NSUserNotification on the main thread.
    static func post(title: String, body: String, conversationId: String?) {
        prepare()
        let note = NSUserNotification()
        note.title = title
        note.informativeText = body
        if let cid = conversationId { note.userInfo = ["conversationId": cid] }
        if let url = Theme.resource("shell/notify-icon.png"), let img = NSImage(contentsOf: url) {
            // Private keys (as mac-notification-sys) that swap the app badge for our logo.
            note.setValue(img, forKey: "_identityImage")
            note.setValue(false, forKey: "_identityImageHasBorder")
        }
        NotifyBundleHook.borrowing { NSUserNotificationCenter.default.deliver(note) }
    }
}

final class NotifyDelegate: NSObject, NSUserNotificationCenterDelegate {
    // Force banners even when Cetus is frontmost; dispatch() already decided.
    func userNotificationCenter(_ center: NSUserNotificationCenter, shouldPresent notification: NSUserNotification) -> Bool { true }

    func userNotificationCenter(_ center: NSUserNotificationCenter, didActivate notification: NSUserNotification) {
        let cid = (notification.userInfo?["conversationId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                AppShell.focusMain()
                NotifyCenter.onActivate?(cid)
            }
        }
    }
}

/// mac-notification-sys's `set_application` for the unbundled dev binary:
/// NSUserNotificationCenter only delivers for a registered bundle, so borrow
/// Terminal's identifier — but only around our own notification-center calls,
/// so nothing else in the process ever sees a fake bundle id.
enum NotifyBundleHook {
    nonisolated(unsafe) static var active = false
    nonisolated(unsafe) private static var installed = false
    nonisolated(unsafe) static var borrowed = "com.apple.Terminal"

    static func install() {
        guard !installed else { return }
        installed = true
        guard let original = class_getInstanceMethod(Bundle.self, #selector(getter: Bundle.bundleIdentifier)),
              let swapped = class_getInstanceMethod(Bundle.self, #selector(Bundle.cetusNotifyBundleIdentifier)) else { return }
        method_exchangeImplementations(original, swapped)
    }

    static func borrowing<T>(_ f: () -> T) -> T {
        let was = active
        active = installed
        defer { active = was }
        return f()
    }
}

extension Bundle {
    /// After the exchange this name points at the real `bundleIdentifier`.
    @objc func cetusNotifyBundleIdentifier() -> String? {
        if NotifyBundleHook.active, self == Bundle.main { return NotifyBundleHook.borrowed }
        return cetusNotifyBundleIdentifier()
    }
}
