import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var controller: Controller!
    var state: AppState!
    private var cmdTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Theme.registerFonts()
        Env.adoptLoginShell()
        CLIServer.prepareEnvironment()
        controller = Controller()
        state = AppState(controller: controller)
        ChatExtensionDialogs.app = state
        controller.startScheduler()
        MeetingEngine.shared.boot(state)
        applyTheme()

        let root = ZoomRoot { RootView() }.environment(state)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Cetus"
        window.minSize = NSSize(width: 860, height: 560)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = NSHostingView(rootView: root)
        if AppShell.testMode {
            window.setFrameAutosaveName(Env.process["CETUS_DRIVE"] == nil ? "CetusMain" : "CetusDrive")
            if window.frame.width < 900 { window.center() }
        } else {
            WindowGeom.restore(window)
        }
        // Fixed size for side-by-side comparison with the Tauri build, e.g. "1555x1006".
        if let size = Env.process["CETUS_WINDOW_SIZE"]?.split(separator: "x").compactMap({ Double($0) }), size.count == 2 {
            window.setContentSize(NSSize(width: size[0], height: size[1]))
        }
        state.window = window
        if Env.process["CETUS_CONTROL"] == nil {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        } else {
            // Remote-controlled comparison runs stay behind the user's windows
            // and never take keyboard focus.
            window.orderBack(nil)
        }
        AppShell.install(state: state, window: window)
        QuickController.shared.start(state)
        VoiceRuntime.shared.start()
        installKeyMonitor()
        state.focusComposer()

        if let path = Env.process["CETUS_CONTROL"] {
            Control.start(app: state, window: window, path: path)
        }
        if Env.process["CETUS_DRIVE"] != nil {
            Driver.start(app: state, window: window)
        }
    }

    func applyTheme() {
        switch controller.prefs.theme {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
        withObservationTracking { _ = controller.prefs.theme } onChange: { [weak self] in
            DispatchQueue.main.async { self?.applyTheme() }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        MeetingEngine.shared.shutdown()
        VoiceRuntime.shared.shutdown()
        controller.dispose()
    }

    private func installKeyMonitor() {
        NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { [weak self] event in
            guard let self, event.window === self.window || event.window == nil else { return event }
            if event.type == .flagsChanged {
                let f = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                if !f.contains(.control), self.state.switcher != nil { self.state.commitSwitcher() }
                if f == .command {
                    self.cmdTimer?.invalidate()
                    self.cmdTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { _ in self.state.showNumberHints = true }
                } else {
                    self.cmdTimer?.invalidate()
                    if self.state.showNumberHints { self.state.showNumberHints = false }
                }
                return event
            }
            self.cmdTimer?.invalidate()
            if self.state.showNumberHints { self.state.showNumberHints = false }
            return self.state.handleKey(event) ? nil : event
        }
    }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Cetus", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Cetus", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Cetus", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "New Chat", action: #selector(newChat), keyEquivalent: "")
        file.addItem(withTitle: "Command Palette", action: #selector(palette), keyEquivalent: "")
        file.addItem(.separator())
        let close = file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        close.keyEquivalentModifierMask = [.command, .shift]
        fileItem.submenu = file

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Toggle Sidebar", action: #selector(toggleSidebar), keyEquivalent: "")
        view.addItem(withTitle: "Toggle Terminal", action: #selector(toggleTerminal), keyEquivalent: "")
        let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }

    @objc private func openSettings() { state.settings = true }
    @objc private func newChat() { state.newChat() }
    @objc private func palette() { state.palette = true }
    @objc private func toggleSidebar() { state.runShortcut("toggleSidebar") }
    @objc private func toggleTerminal() { state.toggleTerminal() }
}

// `Cetus cli …`: the `cetus` CLI (the <data>/bin/cetus shim execs this).
if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "cli" { exit(CLIClient.run(Array(CommandLine.arguments.dropFirst(2)))) }
// Match the web build's `-webkit-font-smoothing: antialiased` (no stem darkening).
UserDefaults.standard.set(0, forKey: "AppleFontSmoothing")
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
