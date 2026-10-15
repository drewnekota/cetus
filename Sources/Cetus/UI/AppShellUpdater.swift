import AppKit
import Foundation
import Sparkle

/// Sparkle updates for the Swift build: release bundles carry `SUFeedURL` (the
/// appcast on the drewnekota/cetus `swift` release), `SUPublicEDKey` and an
/// hourly `SUScheduledCheckInterval`; dev bundles from bundle.sh carry none of
/// them, so they never replace themselves.
@MainActor
enum AppShellUpdater {
    /// Present only in release bundles (release.sh).
    static var enabled: Bool { Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil }

    /// Drives the sidebar's "Restart to update" row (app-sidebar.tsx's `updateReadyVersion`).
    static let state = UpdateState()

    private static var controller: SPUStandardUpdaterController?
    /// The controller holds its delegate weakly.
    private static let delegate = UpdaterDelegate()

    /// Call once at launch. Settings → General → Automatic updates drives
    /// background checks and silent downloads.
    static func start() {
        guard enabled, controller == nil else { return }
        let c = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: delegate, userDriverDelegate: nil)
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

    /// Installs the downloaded update and relaunches into it.
    static func restartToUpdate() { state.install?() }
}

@MainActor
@Observable
final class UpdateState {
    /// Version of an update that's downloaded and waiting for a relaunch.
    fileprivate(set) var readyVersion: String?
    fileprivate var install: (() -> Void)?
}

private final class UpdaterDelegate: NSObject, SPUUpdaterDelegate {
    /// A silently downloaded update is staged: surface it instead of waiting
    /// for the user to happen to quit. Sparkle still installs on quit either way.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        AppShellUpdater.state.readyVersion = item.displayVersionString
        AppShellUpdater.state.install = immediateInstallHandler
        return true
    }
}
