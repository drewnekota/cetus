import AppKit
import Observation
import SwiftUI

// The global launcher (quick.rs, quick/panel.rs, quick/reply.rs, panel.rs and
// quick-panel.tsx): a warm, non-activating floating NSPanel with two surfaces —
// the launcher (prompt + optional screenshot/context → a conversation in the
// main window) and visual quick reply (screenshot + AX → one-shot draft →
// pasted into the app that had focus).

/// A launcher attachment (`QuickAttachment`): an image or file on disk.
struct QuickAttachment: Identifiable, Equatable {
    let id = UUID()
    var path: String
    var name: String
    var mimeType: String
    var size: Int
    var isImage: Bool { mimeType.hasPrefix("image/") }
}

/// What the reply surface shows (QuickReplyOpenPayload + result).
struct QuickReplyOpen: Equatable {
    var openId: Double
    var app: String
    var screenshotPermission: Bool
    var screenshot: QuickShot?
    var context: QuickAmbient?
    var axChars: Int
}

@MainActor
@Observable
final class QuickModel {
    enum Surface { case launcher, reply }
    var surface: Surface = .launcher
    var text = ""
    var textToken = 0
    var attachments: [QuickAttachment] = []
    var attachError: String?
    var screenshot: QuickShot?
    var screenshotDenied = false
    var includeScreenshot = false
    var context: QuickAmbient?
    var sessionMode = "new"
    var workspaceDir: String?
    var backend = "pi"
    var cliModel = ""
    var cliEffort = ""
    var piModel = "flash"
    var piEffort = "high"
    var submitting = false
    var keepOpen = UserDefaults.standard.string(forKey: "settings.quickKeepOpen") == "1"
    var openMain = UserDefaults.standard.string(forKey: "settings.quickOpenMain") != "0"
    var launchedTick = 0
    var hasLastChat = true
    var dragging = false
    var menu: String?
    var tooltip: String?
    // Reply surface
    var replyOpen: QuickReplyOpen?
    var replyResult: Result<String, QuickReplyError>?
    var replyDraft = ""
    var inserting = false
    var replyBackend = "pi"
    /// Bumped to (re)focus the text view.
    var focusToken = 0
}

@MainActor
final class QuickController: NSObject, NSWindowDelegate {
    static let shared = QuickController()
    let model = QuickModel()
    private(set) weak var app: AppState?
    private var panel: QuickLauncherPanel?
    private var effect: NSVisualEffectView?
    private var backdrop: NSView?
    private(set) var shown = false
    var recapturing = false
    private var lastOpenId: Double = 0
    private var replyRun = 0
    private var replyStash: (openId: Double, shot: QuickShot, context: QuickAmbient?, visibleText: String)?
    private var contentHeight: CGFloat = 0
    private var clickMonitor: Any?
    private var opening = false
    var snipActive = false

    /// Launcher geometry at 100% zoom.
    static let launcherBase = CGSize(width: 760, height: 240)
    static let replyBase = CGSize(width: 760, height: 400)
    static let launcherMaxH: CGFloat = 640

    /// Comparison runs (CETUS_CONTROL): never take focus or float over the
    /// user's windows; the panel sits behind, next to the main window.
    var testMode: Bool { Env.process["CETUS_CONTROL"] != nil }

    func start(_ app: AppState) {
        guard self.app == nil else { return }
        self.app = app
        HotkeyGesture.shared.start()
        HotkeySummon.shared.start()
        // Global hooks die with the process anyway; unregister explicitly on quit.
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { QuickController.shared.stop() }
        }
    }

    func stop() {
        HotkeyGesture.shared.stop()
        HotkeySummon.shared.stop()
        removeOutsideClickMonitor()
    }

    // MARK: - Settings

    static var settings: CapQuickSettings {
        var s = CapStored<CapQuickSettings>(rawValue: UserDefaults.standard.string(forKey: "settings.quick") ?? "{}")?.value ?? .init()
        normalizeReplyGesture(&s)
        return s
    }

    /// `normalize_reply_gesture`.
    static func normalizeReplyGesture(_ s: inout CapQuickSettings) {
        if s.gestureReply == "off" || (s.gestureReply != s.gesturePlain && s.gestureReply != s.gestureShot) { return }
        s.gestureReply = ["double_opt", "double_cmd", "both_opt", "both_cmd"].first { $0 != s.gesturePlain && $0 != s.gestureShot } ?? "off"
    }

    static func saveSettings(_ mutate: (inout CapQuickSettings) -> Void) {
        var s = settings
        mutate(&s)
        normalizeReplyGesture(&s)
        UserDefaults.standard.set(CapStored(s).rawValue, forKey: "settings.quick")
    }

    // MARK: - Panel

    private var zoom: CGFloat { CGFloat(app?.prefs.zoom ?? 1).clamped(0.5, 2) }

    private func scaled(_ s: CGSize) -> CGSize { CGSize(width: (s.width * zoom).rounded(), height: (s.height * zoom).rounded()) }

    private func ensurePanel() -> QuickLauncherPanel {
        if let panel { return panel }
        let p = QuickLauncherPanel(contentRect: NSRect(origin: .zero, size: Self.launcherBase),
                                   styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.level = testMode ? .normal : .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        p.backgroundColor = .clear
        p.isOpaque = false
        p.hasShadow = true
        p.isReleasedWhenClosed = false
        p.isMovableByWindowBackground = false
        p.delegate = self
        let container = NSView(frame: NSRect(origin: .zero, size: Self.launcherBase))
        container.autoresizingMask = [.width, .height]
        let bd = NSView(frame: container.bounds)
        bd.autoresizingMask = [.width, .height]
        bd.wantsLayer = true
        bd.isHidden = true
        container.addSubview(bd)
        let fx = NSVisualEffectView(frame: container.bounds)
        fx.autoresizingMask = [.width, .height]
        fx.material = .hudWindow
        fx.state = .active
        fx.blendingMode = .behindWindow
        fx.maskImage = Self.roundedMask(16)
        container.addSubview(fx)
        let root = QuickRoot().environment(model).environment(app!)
        let host = NSHostingView(rootView: ZoomRootQuick { root }.environment(app!))
        host.frame = container.bounds
        host.autoresizingMask = [.width, .height]
        container.addSubview(host)
        p.contentView = container
        panel = p
        effect = fx
        backdrop = bd
        return p
    }

    static func roundedMask(_ r: CGFloat) -> NSImage {
        let img = NSImage(size: NSSize(width: r * 2 + 1, height: r * 2 + 1), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        return img
    }

    /// Comparison helper: replace the vibrancy with a flat color (nil restores it).
    func setBackdrop(_ color: NSColor?) {
        _ = ensurePanel()
        backdrop?.layer?.backgroundColor = color?.cgColor
        backdrop?.isHidden = color == nil
        effect?.isHidden = color != nil
    }

    var window: NSWindow? { panel }

    /// `place_on_mouse_screen`: size + place in one setFrame, centered
    /// horizontally and 3/4 of the way up the cursor's screen.
    private func place(_ size: CGSize) {
        guard let p = panel else { return }
        if testMode, let main = app?.window {
            // Overlap the (hidden-behind) main window's top-left so captures stay off the user's screen.
            let f = main.frame
            p.setFrame(NSRect(x: f.minX + 20, y: f.maxY - 60 - size.height, width: size.width, height: size.height), display: true)
            return
        }
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let frame = screen?.frame else { return }
        let rect = NSRect(x: frame.minX + (frame.width - size.width) / 2, y: frame.minY + (frame.height - size.height) * 0.75, width: size.width, height: size.height)
        p.setFrame(rect, display: true)
    }

    /// `panel::present`: order up and take key without activating Cetus.
    private func present() {
        guard let p = panel else { return }
        p.ignoresMouseEvents = false
        if testMode {
            if let main = app?.window { p.order(.above, relativeTo: main.windowNumber) } else { p.orderBack(nil) }
            return
        }
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        p.orderFrontRegardless()
        p.makeKey()
    }

    private func installOutsideClickMonitor() {
        removeOutsideClickMonitor()
        if testMode { return }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.park() }
        }
    }

    private func removeOutsideClickMonitor() {
        if let m = clickMonitor { NSEvent.removeMonitor(m) }
        clickMonitor = nil
    }

    /// `park_quick`: dismiss (Esc, blur, outside click, second gesture).
    func park() {
        if recapturing { return }
        shown = false
        replyStash = nil
        model.menu = nil
        model.tooltip = nil
        removeOutsideClickMonitor()
        panel?.orderOut(nil)
    }

    /// Re-hug the launcher's natural height, anchored at the top edge.
    func setContentHeight(_ h: CGFloat) {
        let h = h.rounded(.up)
        guard abs(contentHeight - h) > 0.5 else { return }
        contentHeight = h
        guard shown, model.surface == .launcher, let p = panel else { return }
        let size = launcherSize()
        var f = p.frame
        let top = f.maxY
        f.size = size
        f.origin.y = top - size.height
        p.setFrame(f, display: true)
    }

    private func launcherSize() -> CGSize {
        scaled(CGSize(width: Self.launcherBase.width, height: min(Self.launcherMaxH, max(Self.launcherBase.height, contentHeight))))
    }

    // MARK: - Open

    /// `open_panel`: show (or toggle off) the launcher.
    func openPanel(capture: Bool) {
        if recapturing { return }
        if snipActive { Snip.shared.cancel() }
        if shown { park(); return }
        shown = true
        if !capture {
            presentLauncher(shot: nil, context: nil, screenshotDefault: false)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let group = DispatchGroup()
            var shot: QuickShot?
            var ctx: QuickAmbient?
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async { ctx = QuickCapture.preFocusContext(); group.leave() }
            shot = QuickCapture.captureScreen()
            group.wait()
            DispatchQueue.main.async { self.presentLauncher(shot: shot, context: ctx, screenshotDefault: true) }
        }
    }

    /// `present_launcher`: shared tail of the plain open and the snip finish.
    func presentLauncher(shot: QuickShot?, context: QuickAmbient?, screenshotDefault: Bool) {
        let p = ensurePanel()
        _ = p
        contentHeight = 0
        let openId = nowMs()
        lastOpenId = openId
        shown = true
        let m = model
        m.surface = .launcher
        m.text = ""
        m.textToken += 1
        m.attachments = []
        m.attachError = nil
        m.submitting = false
        m.menu = nil
        m.screenshot = shot
        m.screenshotDenied = screenshotDefault && !QuickCapture.screenRecordingEffective
        m.includeScreenshot = screenshotDefault
        m.context = context
        reloadChoices()
        let convs = app?.controller.conversations ?? []
        m.hasLastChat = !convs.isEmpty
        m.sessionMode = m.hasLastChat ? Self.settings.sessionMode : "new"
        place(scaled(Self.launcherBase))
        present()
        m.focusToken += 1
        opening = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.opening = false }
        installOutsideClickMonitor()
        // Browser URL off the first-paint path, applied only to this open.
        if screenshotDefault, let bundle = context?.bundleId, !bundle.isEmpty {
            DispatchQueue.global(qos: .userInitiated).async {
                guard let (url, title) = QuickCapture.browserURL(bundle), !url.isEmpty else { return }
                DispatchQueue.main.async {
                    guard self.lastOpenId == openId, self.model.context != nil else { return }
                    self.model.context?.url = url
                    self.model.context?.title = title
                }
            }
        }
    }

    /// Re-read the shared runtime/model choices (the main window may have changed them).
    func reloadChoices() {
        guard let app else { return }
        let p = app.prefs
        let m = model
        var backend = p.runtime
        if p.disabledRuntimes.contains(backend) || !Runtimes.all.contains(where: { $0.id == backend }) { backend = "pi" }
        m.backend = backend
        let t = p.tuning[backend] ?? Tuning(model: p.model, effort: p.effort)
        m.cliModel = backend == "pi" ? "" : t.model
        m.cliEffort = backend == "pi" ? "" : t.effort
        let pi = p.tuning["pi"] ?? (p.runtime == "pi" ? Tuning(model: p.model, effort: p.effort) : Tuning(model: "flash", effort: "high"))
        m.piModel = pi.model.isEmpty ? "flash" : pi.model
        m.piEffort = pi.effort.isEmpty ? "high" : pi.effort
        m.workspaceDir = UserDefaults.standard.string(forKey: "settings.quickWorkspace")
    }

    /// Persist a runtime pick the way `saveBackendChoice` shares it with the main window.
    func saveBackend(_ id: String, model mdl: String, effort: String) {
        guard let app else { return }
        app.controller.setPrefs { p in
            p.runtime = id
            p.model = mdl
            p.effort = effort
            p.tuning[id] = Tuning(model: mdl, effort: effort)
        }
        if app.activeConversation == nil {
            app.selection.runtime = id
            app.selection.model = mdl
            app.selection.effort = effort
        }
    }

    func selectBackend(_ id: String) {
        let m = model
        guard let app else { return }
        let t = id == "pi" ? Tuning(model: m.piModel, effort: m.piEffort) : (app.prefs.tuning[id] ?? Tuning(model: "", effort: ""))
        m.backend = id
        m.cliModel = id == "pi" ? "" : t.model
        m.cliEffort = id == "pi" ? "" : t.effort
        saveBackend(id, model: t.model, effort: t.effort)
    }

    func setTuning(model mdl: String? = nil, effort: String? = nil) {
        let m = model
        if m.backend == "pi" {
            if let mdl { m.piModel = mdl }
            if let effort { m.piEffort = effort }
            saveBackend("pi", model: m.piModel, effort: m.piEffort)
        } else {
            if let mdl { m.cliModel = mdl }
            if let effort { m.cliEffort = effort }
            saveBackend(m.backend, model: m.cliModel, effort: m.cliEffort)
        }
    }

    func enabledRuntimes() -> [Runtime] { app.map { Runtimes.ordered($0.prefs) } ?? [] }

    /// Tab: next runtime in picker order.
    func cycleBackend() {
        let list = enabledRuntimes()
        guard !list.isEmpty else { return }
        let i = list.firstIndex { $0.id == model.backend } ?? -1
        selectBackend(list[(i + 1) % list.count].id)
    }

    func setWorkspace(_ dir: String) {
        model.workspaceDir = dir
        UserDefaults.standard.set(dir, forKey: "settings.quickWorkspace")
    }

    func setKeepOpen(_ v: Bool) {
        model.keepOpen = v
        UserDefaults.standard.set(v ? "1" : "0", forKey: "settings.quickKeepOpen")
    }

    func setOpenMain(_ v: Bool) {
        model.openMain = v
        UserDefaults.standard.set(v ? "1" : "0", forKey: "settings.quickOpenMain")
    }

    /// Esc / blur.
    func dismiss() {
        park()
        model.screenshot = nil
        model.screenshotDenied = false
        model.includeScreenshot = false
        model.context = nil
    }

    func windowDidResignKey(_ notification: Notification) {
        if testMode || model.submitting || opening || picking { return }
        if model.surface == .launcher { dismiss() }
    }

    var picking = false

    // MARK: - Attachments

    func addPaths(_ paths: [String]) {
        model.attachError = nil
        var referenced: [String] = []
        for path in paths {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { continue }
            let url = URL(fileURLWithPath: path)
            let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
            let mime = Attachment.imageTypes[url.pathExtension.lowercased()] ?? "application/octet-stream"
            if isDir.boolValue || (!mime.hasPrefix("image/") && size > Attachment.maxBytes) { referenced.append(path); continue }
            model.attachments.append(QuickAttachment(path: path, name: url.lastPathComponent, mimeType: mime, size: size))
        }
        if !referenced.isEmpty { insertPathRefs(referenced) }
    }

    func addImage(_ img: NSImage) {
        guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return }
        let dir = Env.dataDir.appendingPathComponent("quick-attachments")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("pasted-\(Int(nowMs())).png")
        guard (try? png.write(to: url)) != nil else { return }
        model.attachments.append(QuickAttachment(path: url.path, name: "Pasted image", mimeType: "image/png", size: png.count))
    }

    private func insertPathRefs(_ paths: [String]) {
        var head = model.text
        while let l = head.last, l.isWhitespace { head.removeLast() }
        model.text = (head.isEmpty ? "" : head + "\n") + paths.joined(separator: "\n") + " "
        model.textToken += 1
    }

    func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        picking = true
        let done: (NSApplication.ModalResponse) -> Void = { r in
            self.picking = false
            if r == .OK { self.addPaths(panel.urls.map(\.path)) }
            self.model.focusToken += 1
        }
        if let p = self.panel, !testMode { panel.beginSheetModal(for: p, completionHandler: done) } else { done(panel.runModal()) }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        picking = true
        let r = panel.runModal()
        picking = false
        if r == .OK, let url = panel.url {
            setWorkspace(url.path)
            app?.controller.setPrefs { p in
                if !p.recentWorkspaces.contains(url.path) { p.recentWorkspaces.insert(url.path, at: 0) }
            }
        }
        model.focusToken += 1
    }

    // MARK: - Submit

    /// `quick_submit` + the main window's `quickLaunch`.
    func submit() {
        let m = model
        let text = m.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !(text.isEmpty && m.attachments.isEmpty), !m.submitting, let app else { return }
        m.submitting = true
        let shot = m.includeScreenshot ? m.screenshot : nil
        let context = m.includeScreenshot ? m.context : nil
        launch(text: text, shot: shot, attachments: m.attachments, context: context, sessionMode: m.sessionMode, workspaceDir: m.workspaceDir,
               backend: m.backend, cliModel: m.backend == "pi" ? "" : m.cliModel, cliEffort: m.backend == "pi" ? "" : m.cliEffort,
               piModel: m.piModel, piEffort: m.piEffort, app: app)
        m.text = ""
        m.textToken += 1
        m.attachments = []
        m.screenshot = nil
        m.screenshotDenied = false
        m.includeScreenshot = false
        m.context = nil
        if m.keepOpen {
            m.hasLastChat = true
            m.launchedTick += 1
            let tick = m.launchedTick
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { if self.model.launchedTick == tick { self.model.launchedTick = 0 } }
            m.submitting = false
            m.focusToken += 1
            return
        }
        if m.openMain { focusMain() }
        park()
        m.submitting = false
    }

    private func launch(text: String, shot: QuickShot?, attachments: [QuickAttachment], context: QuickAmbient?, sessionMode: String,
                        workspaceDir: String?, backend: String, cliModel: String, cliEffort: String, piModel: String, piEffort: String, app: AppState) {
        let c = app.controller
        var files: [Attachment] = []
        // A huge selection rides inline up to its budget; the full text goes along as a file.
        var ctx = context
        if let sel = ctx?.selection, sel.count > 4_000 {
            ctx?.selection = QuickReplyPrompt.clipLines(sel, 4_000, "selected text")
            if let path = writeTemp("selection.txt", Data(sel.utf8)) {
                files.append(Attachment(path: path, name: "selection.txt", mimeType: "text/plain", size: sel.utf8.count))
            }
        }
        if let shot, let path = writeTemp("Screenshot.jpg", shot.data) {
            files.append(Attachment(path: path, name: "Screenshot.jpg", mimeType: shot.mimeType, size: shot.data.count))
        }
        files += attachments.map { Attachment(path: $0.path, name: $0.name, mimeType: $0.mimeType, size: $0.size) }
        let composed = Self.composeWithContext(text, ctx)
        var target: Conversation?
        if sessionMode == "last" {
            target = c.conversation(app.active) ?? c.conversations.first
        }
        let id: String
        if let t = target {
            // Reusing "last" keeps that conversation's own runtime; the pi model choice applies to pi chats.
            let isPi = t.backend == "pi"
            id = c.send(SendOptions(conversationId: t.id, text: composed, backend: t.backend, model: isPi ? piModel : t.cliModel,
                                    effort: isPi ? piEffort : t.cliEffort, workspaceDir: t.workspaceDir, attachments: files))
        } else {
            let isPi = backend == "pi"
            id = c.send(SendOptions(conversationId: nil, text: composed, backend: backend, model: isPi ? piModel : cliModel,
                                    effort: isPi ? piEffort : cliEffort, workspaceDir: workspaceDir ?? Env.chatDir, attachments: files))
        }
        if !id.isEmpty { app.openChat(id) }
    }

    private func writeTemp(_ name: String, _ data: Data) -> String? {
        let dir = Env.dataDir.appendingPathComponent("quick-attachments").appendingPathComponent(String(Int(nowMs())))
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        return (try? data.write(to: url)) != nil ? url.path : nil
    }

    /// `composeWithContext` / `buildContextFence` (lib/quick-context.ts).
    static func composeWithContext(_ text: String, _ ctx: QuickAmbient?) -> String {
        guard let c = ctx, !(c.app.isEmpty && c.url.isEmpty && c.title.isEmpty && c.selection.isEmpty) else { return text }
        var lines: [String] = []
        if !c.app.isEmpty { lines.append("Active app: \(c.app)") }
        if !c.url.isEmpty { lines.append("Browser URL: \(c.url)") }
        if !c.title.isEmpty { lines.append("Page title: \(c.title)") }
        if !c.selection.isEmpty {
            lines.append("Selected text:\n\(c.selection)")
            if c.selection.contains("[… selected text truncated:") { lines.append("(full selection attached as selection.txt)") }
        }
        return "\(QuickContext.quickOpen)\n\(lines.joined(separator: "\n"))\n\(QuickContext.close)\n\n\(text)"
    }

    /// `focus_main`: bring the main window forward (never in comparison runs).
    func focusMain() {
        if testMode { return }
        AppShell.focusMain()
    }

    /// Summon hotkey: bring Cetus forward, or hide it when it is already in front.
    func toggleMain() {
        guard let w = app?.window else { return }
        if NSApp.isActive && w.isVisible && w.isOnActiveSpace { NSApp.hide(nil) } else { focusMain() }
    }

    // MARK: - Visual quick reply

    /// `open_reply`.
    func openReply() {
        if recapturing { return }
        if snipActive { Snip.shared.cancel() }
        if shown { park(); return }
        _ = ensurePanel()
        let openId = nowMs()
        lastOpenId = openId
        shown = true
        let requested = Self.settings.replyBackend
        DispatchQueue.global(qos: .userInitiated).async {
            let group = DispatchGroup()
            var identity: (QuickAmbient?, pid_t) = (nil, 0)
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async { identity = QuickCapture.replyIdentity(); group.leave() }
            let shot = QuickCapture.captureScreen()
            group.wait()
            DispatchQueue.main.async { self.presentReply(openId: openId, shot: shot, identity: identity, requested: requested) }
        }
    }

    private func presentReply(openId: Double, shot: QuickShot?, identity: (QuickAmbient?, pid_t), requested: String) {
        guard lastOpenId == openId, let app else { return }
        var context = identity.0
        let pid = identity.1
        let m = model
        m.surface = .reply
        m.menu = nil
        let backend = QuickReplyRunner.resolve(requested, prefs: app.prefs)
        m.replyOpen = QuickReplyOpen(openId: openId, app: context?.app ?? "", screenshotPermission: QuickCapture.screenRecordingEffective,
                                     screenshot: shot, context: context, axChars: 0)
        m.replyBackend = backend
        m.replyResult = nil
        m.replyDraft = ""
        m.inserting = false
        place(scaled(Self.replyBase))
        present()
        m.focusToken += 1
        opening = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.opening = false }
        installOutsideClickMonitor()
        let bundle = context?.bundleId ?? ""
        DispatchQueue.global(qos: .userInitiated).async {
            let details = QuickCapture.sandboxed ? QuickCapture.ReplyDetails() : QuickCapture.replyDetails(pid: pid, bundle: bundle)
            DispatchQueue.main.async {
                guard self.lastOpenId == openId else { return }
                if context != nil {
                    context?.title = details.title
                    context?.url = details.url
                }
                if self.model.replyOpen?.openId == openId {
                    self.model.replyOpen?.context = context
                    self.model.replyOpen?.axChars = details.visibleText.count
                }
                guard let shot else {
                    self.replyStash = nil
                    self.finishReply(openId: openId, run: self.nextRun(), .failure(.init(QuickCapture.screenRecordingEffective
                        ? "Could not capture the current screen."
                        : "Screen Recording permission is required for visual quick reply. macOS may have paused a previous grant — re-enable Cetus in System Settings → Privacy & Security → Screen Recording.")))
                    return
                }
                self.replyStash = (openId, shot, context, details.visibleText)
                self.runReply(openId: openId, shot: shot, context: context, visibleText: details.visibleText, backend: backend)
            }
        }
    }

    private func nextRun() -> Int { replyRun += 1; return replyRun }

    /// Comparison runs: show the reply surface without capturing or running a turn.
    func presentReplyForTest() {
        _ = ensurePanel()
        shown = true
        model.surface = .reply
        place(scaled(Self.replyBase))
        present()
    }

    private func runReply(openId: Double, shot: QuickShot, context: QuickAmbient?, visibleText: String, backend: String) {
        let run = nextRun()
        QuickReplyRunner.shared.generate(backend: backend, shot: shot, ambient: context, visibleText: visibleText, bypass: app?.prefs.bypassApprovals ?? true,
            onDelta: { [weak self] delta in
                guard let self, self.replyRun == run, self.model.replyOpen?.openId == openId, self.model.replyResult == nil else { return }
                self.model.replyDraft += delta
            },
            done: { [weak self] result in self?.finishReply(openId: openId, run: run, result) })
    }

    private func finishReply(openId: Double, run: Int, _ result: Result<String, QuickReplyError>) {
        guard replyRun == run, lastOpenId == openId || model.replyOpen?.openId == openId, model.replyOpen?.openId == openId else { return }
        model.replyResult = result
        if case .success(let r) = result { model.replyDraft = r } else { model.replyDraft = "" }
    }

    /// `quick_reply_regenerate`: re-draft the same capture on another runtime.
    func regenerateReply(_ backend: String) {
        let m = model
        guard backend != m.replyBackend else { return }
        m.replyBackend = backend
        m.replyResult = nil
        m.replyDraft = ""
        Self.saveSettings { $0.replyBackend = backend }
        if let s = replyStash {
            runReply(openId: s.openId, shot: s.shot, context: s.context, visibleText: s.visibleText, backend: backend)
            return
        }
        // No stash (the open-time capture failed): hide, recapture, re-present.
        recapturing = true
        panel?.orderOut(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            DispatchQueue.global(qos: .userInitiated).async {
                let identity = QuickCapture.replyIdentity()
                let shot = QuickCapture.captureScreen()
                DispatchQueue.main.async {
                    self.present()
                    self.recapturing = false
                    guard let shot else {
                        self.finishReply(openId: m.replyOpen?.openId ?? 0, run: self.nextRun(), .failure(.init(QuickCapture.screenRecordingEffective
                            ? "Could not capture the current screen."
                            : "Screen Recording permission is required for visual quick reply. macOS may have paused a previous grant — re-enable Cetus in System Settings → Privacy & Security → Screen Recording.")))
                        return
                    }
                    let openId = nowMs()
                    self.lastOpenId = openId
                    var ctx = identity.0
                    let bundle = ctx?.bundleId ?? ""
                    DispatchQueue.global(qos: .userInitiated).async {
                        let d = QuickCapture.sandboxed ? QuickCapture.ReplyDetails() : QuickCapture.replyDetails(pid: identity.1, bundle: bundle)
                        DispatchQueue.main.async {
                            if ctx != nil { ctx?.title = d.title; ctx?.url = d.url }
                            m.replyOpen = QuickReplyOpen(openId: openId, app: ctx?.app ?? "", screenshotPermission: QuickCapture.screenRecordingEffective,
                                                         screenshot: shot, context: ctx, axChars: d.visibleText.count)
                            self.replyStash = (openId, shot, ctx, d.visibleText)
                            self.runReply(openId: openId, shot: shot, context: ctx, visibleText: d.visibleText, backend: backend)
                        }
                    }
                }
            }
        }
    }

    /// `quick_reply_insert`: park, let AppKit restore the previous key window, paste.
    func insertReply() {
        let m = model
        let value = m.replyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !m.inserting, case .success = m.replyResult else { return }
        guard value.count <= 4000 else { return }
        m.inserting = true
        m.submitting = true
        park()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
            if QuickCapture.sandboxed {
                NSLog("quick reply: would insert \(value.count) chars (sandboxed)")
            } else {
                DispatchQueue.global(qos: .userInitiated).async { QuickCapture.pasteText(value) }
            }
            m.replyDraft = ""
            m.replyResult = nil
            m.replyOpen = nil
            m.inserting = false
            m.submitting = false
        }
    }
}

/// The non-activating launcher panel: can become key (typing) but never main.
final class QuickLauncherPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Follows the main window's ⌘+/⌘− zoom like the launcher webview does.
struct ZoomRootQuick<Content: View>: View {
    @Environment(AppState.self) private var app
    @ViewBuilder var content: Content
    var body: some View {
        let z = CGFloat(app.prefs.zoom)
        GeometryReader { g in
            content
                .frame(width: g.size.width / z, height: g.size.height / z)
                .scaleEffect(z, anchor: .topLeading)
                .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
    }
}

extension CGFloat {
    fileprivate func clamped(_ lo: CGFloat, _ hi: CGFloat) -> CGFloat { Swift.min(hi, Swift.max(lo, self)) }
}
