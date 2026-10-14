import AppKit
import ServiceManagement

// App-shell behaviour ported from Cetus's Tauri host:
//  - lib.rs                 default app menu (+ custom Quit, View ▸ Reload), menu-bar tray
//  - app/window_lifecycle   close hides (app stays resident), confirm-before-quit, focus_main
//  - window_geom.rs         main window geometry: 90% of the monitor until the user moves it
//  - awake.rs               one idle-sleep assertion folded over agent turns + remote access
//  - notify.rs + use-app-events.tsx  which events notify (see NotifyCenter)
//  - autostart plugin       login item, `--autostart` launches into the tray

@MainActor
enum AppShell {
    static weak var state: AppState?
    static weak var controller: Controller?
    static weak var window: NSWindow?
    private static var statusItem: NSStatusItem?
    private static var observers: [NSObjectProtocol] = []
    private static let target = AppShellTarget()

    /// Comparison/test instances (driven over CETUS_CONTROL) keep out of the user's way.
    static var testMode: Bool { Env.process["CETUS_CONTROL"] != nil || Env.process["CETUS_DRIVE"] != nil }

    // MARK: Install

    /// Call once from `applicationDidFinishLaunching`, after the main window exists.
    static func install(state s: AppState, window w: NSWindow) {
        state = s
        controller = s.controller
        window = w
        NotifyCenter.prepare()
        NotifyCenter.onActivate = { cid in openFromNotification(cid) }
        buildMenu()
        AppShellUpdater.start()
        if !testMode || Env.process["CETUS_SHELL_TRAY"] != nil { installTray() }
        trackGeometry(w)
        Awake.initialize()
        CLIServer.start(controller: s.controller)
        RemoteAccess.initialize(s.controller)
        LoginItem.sync()
        observers.append(NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                Awake.setWorkPref(UserDefaults.standard.object(forKey: "settings.keepAwakeWhileWorking") as? Bool ?? true)
                LoginItem.sync()
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                WindowGeom.flush()
                CLIServer.stop()
                RemoteAccess.shutdown()
                Awake.releaseAll()
            }
        })
        // Started as a login item: stay resident in the tray instead of popping the window.
        if CommandLine.arguments.contains("--autostart") { w.orderOut(nil) }
    }

    /// Bring the main window forward (tray "Open cetus", Dock reopen, notification click).
    static func focusMain() {
        guard let w = window else { return }
        if w.isMiniaturized { w.deminiaturize(nil) }
        if testMode { w.orderFront(nil); return }
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// notification-activate: open the conversation; archived → unarchive first;
    /// gone → "That conversation no longer exists." toast.
    static func openFromNotification(_ cid: String?) {
        guard let cid, let s = state, let c = controller else { return }
        if c.conversations.contains(where: { $0.id == cid }) { s.openChat(cid); return }
        if c.store.get(cid) != nil {
            c.restore(cid)
            s.openChat(cid)
        } else {
            s.toast("That conversation no longer exists.", kind: .error)
        }
    }

    // MARK: Host events (use-app-events.tsx notifyForPiEvent + awake.rs listener)

    private struct Run { var running: Bool; var outcome: String }
    private static var runs: [String: Run] = [:]

    private static func title(_ cid: String) -> String {
        let t = controller?.conversation(cid)?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? "Untitled" : t
    }

    /// The user is looking at this chat right now (focus is checked by NotifyCenter).
    private static func watchingNow(_ cid: String) -> Bool {
        guard let s = state else { return false }
        return s.active == cid && s.page == .chats && !s.settings
    }

    /// Every agent-host message passes through here (on the main thread) before the Controller folds it.
    nonisolated static func hostMessage(_ m: JSON) {
        MainActor.assumeIsolated { handleHost(m) }
    }

    private static func handleHost(_ m: JSON) {
        RemoteAccess.broadcast(m)
        let cid = m["conv"].string
        switch m["type"].string {
        case "event":
            guard let cid else { return }
            piEvent(cid, m["event"])
        case "error", "exited":
            if let cid { Awake.workEnd(cid) }
            if m["type"].string == "exited", let cid, var r = runs[cid], r.running {
                // pi_exited: close the live run and say so.
                r.running = false
                runs[cid] = r
                NotifyCenter.dispatch(.taskFinished, title: title(cid), body: "Agent process exited (code \(m["code"].isNull ? "n/a" : m["code"].stringValue)).", conversationId: cid)
            } else if m["type"].string == "error", let cid, runs[cid]?.running == true {
                runs[cid]?.outcome = "errored"
            }
        case "turn_done":
            guard let cid else { return }
            Awake.workEnd(cid)
            // A runtime that never streamed an agent_end still settles here.
            if runs[cid]?.running == true {
                if m["aborted"].truthy { runs[cid]?.outcome = "aborted" }
                else if m["error"].string != nil && !m["streamed"].truthy { runs[cid]?.outcome = "errored" }
                finish(cid)
            }
        case "host_exited":
            for (id, r) in runs where r.running { runs[id]?.running = false; Awake.workEnd(id) }
        default: break
        }
    }

    private static func piEvent(_ cid: String, _ e: JSON) {
        switch e["type"].string {
        case "agent_start":
            runs[cid] = Run(running: true, outcome: "ok")
            Awake.workBegin(cid)
        case "message_update":
            let a = e["assistantMessageEvent"]
            if runs[cid]?.running == true, a["type"].string == "error" {
                runs[cid]?.outcome = a["reason"].string == "aborted" ? "aborted" : "errored"
            }
        case "agent_end":
            Awake.workEnd(cid)
            if e["willRetry"].truthy { return }
            finish(cid)
        case "cli_control_request":
            let body = e["toolName"].string == "AskUserQuestion" ? (e["input"]["questions"][0]["question"].string ?? "AskUserQuestion") : e["toolName"].stringValue
            NotifyCenter.dispatch(.awaitingInput, title: "The agent needs your input", body: body, suppressWhenFocused: true, conversationId: cid)
        case "extension_ui_request":
            if ["select", "confirm", "input", "editor"].contains(e["method"].string ?? "") {
                NotifyCenter.dispatch(.awaitingInput, title: "cetus needs your input", body: e["title"].stringValue, suppressWhenFocused: true, conversationId: cid)
            }
        default: break
        }
    }

    /// agent_end of a run we saw start: one task_finished notification unless the
    /// user aborted it or a queued follow-up is about to go out.
    private static func finish(_ cid: String) {
        guard var r = runs[cid], r.running else { return }
        r.running = false
        runs[cid] = r
        if r.outcome == "aborted" { return }
        if let q = controller?.chatIfLoaded(cid)?.queue, !q.isEmpty { return }
        NotifyCenter.dispatch(.taskFinished, title: title(cid),
                              body: r.outcome == "errored" ? "Finished with an error." : "Your task is ready.",
                              suppressWhenFocused: watchingNow(cid), conversationId: cid)
    }

    // MARK: Menu (tauri::menu::Menu::default on macOS + Quit/Reload overrides)

    static func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            main.addItem(item)
            let m = NSMenu(title: title)
            item.submenu = m
            return m
        }
        let app = submenu("Cetus")
        app.addItem(withTitle: "About Cetus", action: #selector(AppShellTarget.about), keyEquivalent: "").target = target
        if AppShellUpdater.enabled {
            app.addItem(withTitle: "Check for Updates…", action: #selector(AppShellTarget.checkForUpdates), keyEquivalent: "").target = target
        }
        app.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu(title: "Services")
        NSApp.servicesMenu = services.submenu
        app.addItem(services)
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Cetus", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Cetus", action: #selector(AppShellTarget.quit), keyEquivalent: "q").target = target

        let file = submenu("File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = submenu("Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = submenu("View")
        view.addItem(withTitle: "Reload", action: #selector(AppShellTarget.reload), keyEquivalent: "r").target = target
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]

        let win = submenu("Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        win.addItem(.separator())
        win.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.windowsMenu = win

        let help = submenu("Help")
        NSApp.helpMenu = help
        NSApp.mainMenu = main
    }

    // MARK: Tray

    static func installTray() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let url = Theme.resource("shell/tray.png"), let img = NSImage(contentsOf: url) {
            // tray-icon sizes the glyph to an 18pt-tall template image.
            let h: CGFloat = 18
            img.size = NSSize(width: img.size.width / max(img.size.height, 1) * h, height: h)
            img.isTemplate = true
            item.button?.image = img
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "Open cetus", action: #selector(AppShellTarget.trayOpen), keyEquivalent: "").target = target
        menu.addItem(withTitle: "Settings", action: #selector(AppShellTarget.traySettings), keyEquivalent: "").target = target
        menu.addItem(withTitle: "Quit cetus", action: #selector(AppShellTarget.quit), keyEquivalent: "").target = target
        item.menu = menu
        statusItem = item
    }

    // MARK: Quit

    /// window_lifecycle::request_quit: "Quit Cetus?" unless confirm-quit is off.
    static func requestQuit() {
        let confirm = UserDefaults.standard.object(forKey: "settings.confirmQuit") as? Bool ?? true
        if !confirm { NSApp.terminate(nil); return }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Quit Cetus?"
        alert.informativeText = "Running agent sessions and meeting captures will be interrupted."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { NSApp.terminate(nil) }
    }

    // MARK: Window geometry

    private static func trackGeometry(_ w: NSWindow) {
        let nc = NotificationCenter.default
        for name in [NSWindow.didMoveNotification, NSWindow.didResizeNotification] {
            observers.append(nc.addObserver(forName: name, object: w, queue: .main) { _ in
                MainActor.assumeIsolated { WindowGeom.record(w, userSet: true) }
            })
        }
        observers.append(nc.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { _ in
            MainActor.assumeIsolated {
                WindowGeom.record(w, userSet: false)
                WindowGeom.flush()
            }
        })
    }
}

/// Selector target for menu and tray items.
final class AppShellTarget: NSObject {
    @MainActor @objc func checkForUpdates() { AppShellUpdater.checkForUpdates() }

    @MainActor @objc func about() {
        var options: [NSApplication.AboutPanelOptionKey: Any] = [.applicationName: "Cetus", .applicationVersion: CLIServer.version]
        if Bundle.main.bundleURL.pathExtension != "app", let url = Theme.resource("icon.png"), let img = NSImage(contentsOf: url) {
            options[.applicationIcon] = img
        }
        NSApp.orderFrontStandardAboutPanel(options: options)
    }
    @MainActor @objc func quit() { AppShell.requestQuit() }
    /// View ▸ Reload: the UI re-hydrates from the durable stores.
    @MainActor @objc func reload() { AppShell.controller?.reload() }
    @MainActor @objc func trayOpen() { AppShell.focusMain() }
    @MainActor @objc func traySettings() {
        AppShell.focusMain()
        AppShell.state?.settings = true
    }
}

// MARK: - window_geom.rs

@MainActor
enum WindowGeom {
    struct Geom: Codable { var x: Double; var y: Double; var width: Double; var height: Double; var maximized = false; var userSet = false }
    private static var last: Geom?
    private static var restoring = false
    private static var file: URL { Env.dataDir.appendingPathComponent("window-geometry.json") }

    /// restore_or_default: the saved frame when the user placed it and it is still
    /// on a screen; otherwise 90% of the current monitor, centered.
    static func restore(_ w: NSWindow) {
        restoring = true
        defer { restoring = false }
        w.minSize = NSSize(width: 700, height: 480)
        if let data = try? Data(contentsOf: file), let g = try? JSONDecoder().decode(Geom.self, from: data), g.userSet, onSomeScreen(g) {
            w.setFrame(NSRect(x: g.x, y: g.y, width: g.width, height: g.height), display: false)
            if g.maximized && !w.isZoomed { w.zoom(nil) }
            last = g
            return
        }
        guard let screen = w.screen ?? NSScreen.main else { return }
        let f = screen.frame
        let width = (f.width * 0.9).rounded(), height = (f.height * 0.9).rounded()
        let rect = NSRect(x: f.minX + ((f.width - width) / 2).rounded(.down), y: f.minY + ((f.height - height) / 2).rounded(.down), width: width, height: height)
        w.setFrame(rect, display: false)
        last = Geom(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height)
    }

    static func record(_ w: NSWindow, userSet: Bool) {
        guard !restoring, !w.isMiniaturized, !w.styleMask.contains(.fullScreen), w.isVisible else { return }
        let f = w.frame
        last = Geom(x: f.minX, y: f.minY, width: f.width, height: f.height, maximized: w.isZoomed, userSet: userSet || (last?.userSet ?? false))
    }

    static func flush() {
        guard let g = last, let data = try? JSONEncoder().encode(g) else { return }
        try? FileManager.default.createDirectory(at: Env.dataDir, withIntermediateDirectories: true)
        try? data.write(to: file)
    }

    private static func onSomeScreen(_ g: Geom) -> Bool {
        let c = NSPoint(x: g.x + g.width / 2, y: g.y + g.height / 2)
        return NSScreen.screens.contains { $0.frame.contains(c) }
    }
}

// MARK: - awake.rs

@MainActor
enum Awake {
    private static var workPref = true
    private static var remotePref = false
    private static var work = Set<String>()
    private static var remoteActive = false
    private static var activity: NSObjectProtocol?

    static func initialize() {
        workPref = UserDefaults.standard.object(forKey: "settings.keepAwakeWhileWorking") as? Bool ?? true
        remotePref = RemoteAccess.keepAwakePref
        apply()
    }

    static func setWorkPref(_ on: Bool) { workPref = on; apply() }
    static func setRemotePref(_ on: Bool) { remotePref = on; apply() }
    static func setRemoteActive(_ on: Bool) { remoteActive = on; apply() }
    static func workBegin(_ id: String) { work.insert(id); apply() }
    static func workEnd(_ id: String) { work.remove(id); apply() }
    static func meetingBegin() { workBegin("meeting") }
    static func meetingEnd() { workEnd("meeting") }
    static var held: Bool { activity != nil }

    static func releaseAll() {
        if let a = activity { ProcessInfo.processInfo.endActivity(a); activity = nil }
    }

    /// One assertion folded over every reason (agent turns, meetings, remote access).
    private static func apply() {
        let want = (workPref && !work.isEmpty) || (remotePref && remoteActive)
        if want, activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .idleSystemSleepDisabled, reason: "cetus has work in flight")
        } else if !want, let a = activity {
            ProcessInfo.processInfo.endActivity(a)
            activity = nil
        }
    }
}

// MARK: - autostart (login item)

@MainActor
enum LoginItem {
    private static var applied: Bool?

    /// Mirror the "Launch on startup" toggle into the system login items. Only a
    /// bundled Cetus.app can register; the dev binary (and test instances) skip it.
    static func sync() {
        let want = UserDefaults.standard.object(forKey: "settings.launchOnStartup") as? Bool ?? true
        guard Bundle.main.bundleURL.pathExtension == "app", !AppShell.testMode, applied != want else { return }
        applied = want
        let service = SMAppService.mainApp
        if want { if service.status != .enabled { try? service.register() } }
        else if service.status == .enabled { try? service.unregister() }
    }
}
