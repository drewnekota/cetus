import AppKit
import Foundation
import Sparkle

/// Sparkle updates for the Swift build: release bundles carry `SUFeedURL` (the
/// appcast on the drewnekota/cetus `swift` release) and `SUPublicEDKey`; dev
/// bundles from bundle.sh carry neither, so they never replace themselves.
@MainActor
enum AppShellUpdater {
    /// Present only in release bundles (release.sh).
    static var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil }

    private static var controller: SPUStandardUpdaterController?

    /// Call once at launch. Settings → General → Automatic updates drives
    /// background checks and silent installs.
    static func start() {
        guard enabled, controller == nil else { return }
        let c = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        controller = c
        applyAutoUpdate()
        c.startUpdater()
        NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { applyAutoUpdate() }
        }
    }

    private static func applyAutoUpdate() {
        guard let u = controller?.updater else { return }
        let on = UserDefaults.standard.object(forKey: "settings.autoUpdate") as? Bool ?? true
        if u.automaticallyChecksForUpdates != on { u.automaticallyChecksForUpdates = on }
        if u.automaticallyDownloadsUpdates != on { u.automaticallyDownloadsUpdates = on }
    }

    /// Sparkle's own check window (found / up to date / error).
    static func checkForUpdates() { controller?.checkForUpdates(nil) }

    static var canCheck: Bool { controller?.updater.canCheckForUpdates ?? false }
}
