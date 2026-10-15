import AppKit
import SwiftUI

/// End-to-end driver: `CETUS_DRIVE=1 Cetus`. Clicks and types through the real
/// window with synthesized events, waits on the controller, and writes
/// screenshots plus report.json to $CETUS_DRIVE_OUT (default /tmp/cetus-swift-e2e).
/// Each step is independent: a failure is recorded and the run continues.
@MainActor
final class Driver {
    let app: AppState
    let window: NSWindow
    let out: URL
    let only: NSRegularExpression?
    var results: [[String: String]] = []

    static func start(app: AppState, window: NSWindow) {
        let d = Driver(app: app, window: window)
        Task { @MainActor in await d.run() }
    }

    init(app: AppState, window: NSWindow) {
        self.app = app
        self.window = window
        out = URL(fileURLWithPath: Env.process["CETUS_DRIVE_OUT"] ?? "/tmp/cetus-swift-e2e")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        only = Env.process["CETUS_DRIVE_ONLY"].flatMap { try? NSRegularExpression(pattern: $0) }
    }

    var controller: Controller { app.controller }

    struct Failure: Error, CustomStringConvertible { let description: String }

    func log(_ s: String) { FileHandle.standardError.write(Data("[drive] \(s)\n".utf8)) }
    func sleep(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }

    func waitFor<T>(_ what: String, timeout: Int = 10_000, _ probe: () -> T?) async throws -> T {
        let start = Date()
        while Date().timeIntervalSince(start) * 1000 < Double(timeout) {
            if let v = probe() { return v }
            await sleep(100)
        }
        throw Failure(description: "timed out waiting for \(what)")
    }

    func waitFor(_ what: String, timeout: Int = 10_000, _ probe: () -> Bool) async throws {
        _ = try await waitFor(what, timeout: timeout) { probe() ? true : nil }
    }

    func element(_ id: String) -> CGRect? {
        if id.hasPrefix("^") || id.hasSuffix("$") {
            return TestRegistry.shared.ids(matching: id).first.flatMap { TestRegistry.shared.frame($0) }
        }
        return TestRegistry.shared.frame(id)
    }

    func exists(_ id: String) -> Bool { element(id) != nil }

    // MARK: Input

    /// Bring the app forward before posting input (e2e runs). The control mode
    /// turns this off so driving a background window never takes the user's
    /// keyboard focus.
    var activates = true

    func click(_ id: String, count: Int = 1) async throws {
        let f = try await waitFor("element \(id)") { element(id) }
        clickAt(CGPoint(x: f.midX, y: f.midY), count: count)
        await sleep(250)
    }

    func clickAt(_ p: CGPoint, count: Int = 1, button: Int = 0) {
        guard let cv = window.contentView else { return }
        // Clicks into an inactive window only activate it; make it key first.
        if activates && !window.isKeyWindow { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
        let pt = NSPoint(x: p.x, y: cv.frame.height - p.y)
        for n in 1 ... count {
            for t in button == 0 ? [NSEvent.EventType.leftMouseDown, .leftMouseUp] : [.rightMouseDown, .rightMouseUp] {
                if let e = NSEvent.mouseEvent(with: t, location: pt, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: n, pressure: 1) {
                    NSApp.postEvent(e, atStart: false)
                }
            }
        }
    }

    /// Mouse down at `p`, dragged in small steps by `delta`, then released.
    func dragAt(_ p: CGPoint, by delta: CGSize, steps: Int = 12) async {
        guard let cv = window.contentView else { return }
        func post(_ t: NSEvent.EventType, _ q: CGPoint) {
            if let e = NSEvent.mouseEvent(with: t, location: NSPoint(x: q.x, y: cv.frame.height - q.y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                NSApp.postEvent(e, atStart: false)
            }
        }
        post(.leftMouseDown, p)
        await sleep(50)
        for i in 1 ... steps {
            let k = CGFloat(i) / CGFloat(steps)
            post(.leftMouseDragged, CGPoint(x: p.x + delta.width * k, y: p.y + delta.height * k))
            await sleep(30)
        }
        post(.leftMouseUp, CGPoint(x: p.x + delta.width, y: p.y + delta.height))
        await sleep(250)
    }

    static let codes: [String: UInt16] = {
        var m: [String: UInt16] = [:]
        for (code, name) in Shortcuts.keyNames { m[name.lowercased()] = code }
        m["enter"] = 36; m["return"] = 36; m["escape"] = 53; m["esc"] = 53; m["tab"] = 48; m["space"] = 49; m["backspace"] = 51
        m["up"] = 126; m["down"] = 125; m["left"] = 123; m["right"] = 124
        m[","] = 43; m["\\"] = 42; m["["] = 33; m["]"] = 30; m["="] = 24; m["-"] = 27; m["/"] = 44; m["."] = 47
        return m
    }()

    /// "cmd-n", "alt-cmd-3", "ctrl-2", "shift-tab", "enter".
    func keys(_ combo: String, wait: Int = 250) async {
        var parts = combo.split(separator: "-").map(String.init)
        if combo.hasSuffix("--") { parts = combo.dropLast(2).split(separator: "-").map(String.init) + ["-"] }
        let key = parts.last ?? ""
        var flags: NSEvent.ModifierFlags = []
        for m in parts.dropLast() {
            switch m {
            case "cmd": flags.insert(.command)
            case "ctrl": flags.insert(.control)
            case "alt": flags.insert(.option)
            case "shift": flags.insert(.shift)
            default: break
            }
        }
        let code = Self.codes[key.lowercased()] ?? 0
        var chars: String
        switch key {
        case "enter": chars = "\r"
        case "escape": chars = "\u{1b}"
        case "tab": chars = flags.contains(.shift) ? "\u{19}" : "\t"
        case "space": chars = " "
        case "backspace": chars = "\u{7f}"
        case "up": chars = String(Character(UnicodeScalar(NSUpArrowFunctionKey)!))
        case "down": chars = String(Character(UnicodeScalar(NSDownArrowFunctionKey)!))
        case "left": chars = String(Character(UnicodeScalar(NSLeftArrowFunctionKey)!))
        case "right": chars = String(Character(UnicodeScalar(NSRightArrowFunctionKey)!))
        default: chars = key.count == 1 ? key.lowercased() : key
        }
        if ["up", "down", "left", "right"].contains(key) { flags.insert([.numericPad, .function]) }
        post(chars: chars, ignoring: chars, code: code, flags: flags)
        await sleep(wait)
    }

    func post(chars: String, ignoring: String, code: UInt16, flags: NSEvent.ModifierFlags) {
        // Menu key equivalents (⌘V…) only fire while the app is active.
        if activates && (!NSApp.isActive || !window.isKeyWindow) { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
        for t in [NSEvent.EventType.keyDown, .keyUp] {
            if let e = NSEvent.keyEvent(with: t, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                        windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: ignoring,
                                        isARepeat: false, keyCode: code) {
                NSApp.postEvent(e, atStart: false)
            }
        }
    }

    func type(_ text: String) async {
        for c in text {
            if c == "\n" { await keys("enter", wait: 40); continue }
            let s = String(c)
            let code = Self.codes[s.lowercased()] ?? 0
            post(chars: s, ignoring: s, code: code, flags: c.isUppercase ? .shift : [])
            await sleep(25)
        }
        await sleep(150)
    }

    func focusComposer() async {
        app.focusComposer()
        await sleep(250)
    }

    func shot(_ name: String) async {
        await sleep(350)
        capture(out.appendingPathComponent("\(name).png"))
        await sleep(100)
    }

    func capture(_ url: URL) {
        guard let v = window.contentView?.superview ?? window.contentView,
              let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
        v.cacheDisplay(in: v.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    func waitIdle(_ conv: () -> String?, timeout: Int = 180_000) async throws -> String {
        await sleep(1200)
        return try await waitFor("turn to finish", timeout: timeout) {
            guard let id = conv() else { return nil }
            let m = controller.chat(id)
            return !m.isStreaming && controller.store.get(id)?.runState != .running ? id : nil
        }
    }

    var newest: String? { controller.conversations.first?.id }

    func step(_ name: String, _ body: () async throws -> String) async {
        if let only, only.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) == nil { return }
        log("▶ \(name)")
        do {
            let detail = try await body()
            results.append(["step": name, "ok": "true", "detail": detail])
        } catch {
            results.append(["step": name, "ok": "false", "detail": "\(error)"])
            capture(out.appendingPathComponent("fail-\(name.replacingOccurrences(of: "[^A-Za-z0-9]+", with: "-", options: .regularExpression)).png"))
            log("✗ \(name): \(error)")
            app.palette = false
            app.settings = false
            app.popup = nil
            await keys("escape")
        }
    }

    func lastText(_ id: String) -> String {
        controller.chat(id).state.messages.last(where: { $0.role == .assistant })?.plainText ?? ""
    }

    // MARK: Scenario

    func run() async {
        await sleep(2000)
        await shot("01-empty")
        var first = ""

        await step("ctrl+2 switches runtime to Codex, ctrl+1 back") {
            await focusComposer()
            await keys("ctrl-2")
            try await waitFor("Codex selected") { controller.prefs.runtime == "codex" }
            await shot("02-runtime-codex")
            await keys("ctrl-1")
            try await waitFor("Claude Code selected") { controller.prefs.runtime == "claude-code" }
            return "ok"
        }

        await step("Tab cycles runtime in composer") {
            await focusComposer()
            await keys("tab")
            let after = controller.prefs.runtime
            await keys("shift-tab")
            let back = controller.prefs.runtime
            guard after == "codex", back == "claude-code" else { throw Failure(description: "tab \(after) shift-tab \(back)") }
            return "tab → \(after), shift-tab → \(back)"
        }

        await step("slash menu opens and filters") {
            await focusComposer()
            await type("/co")
            try await waitFor("slash menu") { exists("slash-menu") }
            await shot("03-slash-menu")
            await keys("down")
            await keys("escape")
            try await waitFor("menu closed") { !exists("slash-menu") }
            for _ in 0 ..< 3 { await keys("backspace", wait: 60) }
            return "ok"
        }

        await step("@ mention menu inserts @goal") {
            await focusComposer()
            await type("@go")
            try await waitFor("mention menu") { exists("mention-menu") }
            await shot("04-mention-menu")
            await keys("enter")
            try await waitFor("menu closed") { !exists("mention-menu") }
            let text = (app.composerView?.string ?? "")
            await keys("cmd-a")
            await keys("backspace")
            guard text == "@goal " else { throw Failure(description: "composer was \(text.debugDescription)") }
            return text
        }

        await step("send a Claude turn with a tool call") {
            await focusComposer()
            await type("use the bash tool to run: echo e2e-swift-ok. then reply in one short sentence\n")
            await sleep(1500)
            await shot("05-streaming")
            first = try await waitIdle { newest }
            await shot("06-turn-done")
            let tool = controller.chat(first).state.messages.flatMap(\.blocks).first { $0.kind == .toolUse }
            guard tool != nil else { throw Failure(description: "no tool call") }
            try await waitFor("activity row") { exists("activity") }
            return "title=\(controller.store.get(first)?.title ?? "") tool=\(tool!.name)"
        }

        await step("expand activity and tool card") {
            try await click("activity")
            try await click("^tool-")
            await shot("07-activity-expanded")
            return "ok"
        }

        await step("cmd+F finds text in the conversation") {
            await keys("cmd-f")
            try await waitFor("find bar") { exists("find-bar") }
            await sleep(200)
            await type("e2e")
            await sleep(600)
            await shot("08-find")
            let count = app.find?.count ?? 0
            await keys("enter")
            let active = app.find?.active ?? -1
            await keys("escape")
            guard count > 0 else { throw Failure(description: "no matches") }
            return "matches=\(count) active=\(active)"
        }

        await step("queue a message while streaming, then steer") {
            await focusComposer()
            await type("run this bash command in the foreground and wait for it: python3 -c 'import time; time.sleep(25)'\n")
            try await waitFor("running", timeout: 15_000) { controller.chat(first).isStreaming }
            await sleep(2500)
            await focusComposer()
            await type("never mind. reply with exactly: steered-ok\n")
            try await waitFor("queue") { exists("queue") }
            await shot("09-queued")
            try await click("steer-0")
            await sleep(2000)
            _ = try await waitIdle({ first }, timeout: 120_000)
            await shot("10-steered")
            let text = lastText(first)
            guard text.contains("steered-ok") else { throw Failure(description: "last reply \(text.prefix(80))") }
            return text
        }

        await step("bash mode runs a local command") {
            await focusComposer()
            await type("!echo bash-mode-ok\n")
            try await waitFor("bash card", timeout: 15_000) {
                controller.chat(first).state.messages.contains { m in m.blocks.contains { $0.customType == "bash_exec" && $0.details["result"]["stdout"].stringValue.contains("bash-mode-ok") } }
            }
            await shot("11-bash-mode")
            return "ok"
        }

        await step("cmd+J opens a terminal in the workspace") {
            await keys("cmd-j")
            try await waitFor("terminal", timeout: 5000) { exists("^workspace-terminal-") }
            await sleep(1500)
            let marker = "/tmp/cetus-swift-term-\(ProcessInfo.processInfo.processIdentifier)"
            FileHandle.standardError.write(Data("term fr=\(String(describing: window.firstResponder))\n".utf8))
            await type("echo term-ok | tee \(marker)\n")
            for _ in 0..<20 where !FileManager.default.fileExists(atPath: marker) { await sleep(300) }
            await shot("12-terminal")
            // cacheDisplay can't see SwiftTerm's layer drawing; grab real window pixels too.
            _ = System.run(["/usr/sbin/screencapture", "-x", "-o", "-l", "\(window.windowNumber)", out.appendingPathComponent("12b-terminal-window.png").path])
            await keys("cmd-j")
            let text = (try? String(contentsOfFile: marker, encoding: .utf8)) ?? ""
            guard text.contains("term-ok") else { throw Failure(description: "terminal did not run the command") }
            return "ok"
        }

        await step("cmd+P opens the files tab") {
            await keys("cmd-p")
            try await waitFor("files", timeout: 5000) { exists("^workspace-[0-9]+-files$") }
            await sleep(600)
            try await click("^workspace-[0-9]+-file-Package\\.swift$")
            await sleep(600)
            await shot("13-files")
            await keys("cmd-\\")
            return "ok"
        }

        await step("cmd+N new chat then cmd+1 reopens the first") {
            await keys("cmd-n")
            try await waitFor("hero") { exists("hero") }
            await keys("cmd-1")
            try await waitFor("first chat open") { app.active != nil && exists("transcript") ? true : nil }
            return "ok"
        }

        await step("cmd+K palette searches content") {
            await keys("cmd-k")
            try await waitFor("palette") { exists("palette-input") }
            await sleep(300)
            await type("steered")
            await sleep(600)
            await shot("14-palette")
            await keys("enter")
            try await waitFor("palette closed") { !exists("palette-input") }
            guard app.active == first else { throw Failure(description: "opened \(app.active ?? "nil")") }
            return "ok"
        }

        await step("cmd+D archives and Settings restores") {
            let id = first
            await keys("cmd-d")
            try await waitFor("archived") { controller.store.get(id)?.archivedAt != nil }
            await keys("cmd-,")
            try await click("settings-Archived chats")
            await shot("15-archived")
            try await click("restore-\(id)")
            try await waitFor("restored") { controller.store.get(id)?.archivedAt == nil }
            return "ok"
        }

        await step("settings: keyboard shortcuts page") {
            if !app.settings { await keys("cmd-,") }
            try await click("settings-Keyboard shortcuts")
            await shot("16-shortcuts")
            await keys("escape")
            try await waitFor("settings closed") { !app.settings }
            return "ok"
        }

        await step("ctrl+tab switches to the previous chat") {
            app.openChat(first)
            await sleep(300)
            await keys("cmd-n")
            await sleep(200)
            let before = app.active
            post(chars: "\t", ignoring: "\t", code: 48, flags: .control)
            await sleep(300)
            let shown = app.switcher != nil
            await shot("16b-switcher")
            if let e = NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 59) {
                NSApp.postEvent(e, atStart: false)
            }
            await sleep(400)
            guard app.active == first else { throw Failure(description: "active \(app.active ?? "nil") before \(before ?? "nil") switcher \(shown)") }
            return "switcher=\(shown)"
        }

        await step("question card answers AskUserQuestion") {
            await keys("cmd-n")
            try await waitFor("hero") { exists("hero") }
            await focusComposer()
            await type("use the AskUserQuestion tool to ask me to pick a color, options red and blue. then reply with exactly the color I picked\n")
            try await waitFor("control card", timeout: 90_000) { exists("control-card") }
            await shot("17-question")
            try await click("control-option-1")
            if exists("control-next") { try await click("control-next") }
            let id = try await waitIdle({ newest }, timeout: 120_000)
            await shot("18-answered")
            let text = lastText(id)
            guard text.lowercased().contains("blue") else { throw Failure(description: "reply \(text.prefix(120))") }
            return text
        }

        await step("automation: create and run now") {
            await keys("alt-cmd-3")
            try await click("new-automation")
            try await click("automation-name")
            await type("e2e automation")
            try await click("automation-prompt")
            await type("reply with exactly: automation-ok")
            try await click("automation-save")
            try await waitFor("automation saved") { !controller.automations.isEmpty }
            await shot("19-automations")
            let a = controller.automations[0]
            try await click("run-\(a.id)")
            let id = try await waitIdle({ newest }, timeout: 120_000)
            await shot("20-automation-run")
            return "title=\(controller.store.get(id)?.title ?? "") reply=\(lastText(id).prefix(40))"
        }

        await step("kanban view") {
            await keys("alt-cmd-2")
            try await waitFor("kanban") { exists("kanban") }
            await shot("21-kanban")
            await keys("alt-cmd-1")
            return "ok"
        }

        await step("paste an image into the composer") {
            await keys("cmd-n")
            await focusComposer()
            let img = NSImage(size: NSSize(width: 40, height: 40))
            img.lockFocus(); NSColor.systemPurple.setFill(); NSRect(x: 0, y: 0, width: 40, height: 40).fill(); img.unlockFocus()
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects([img])
            await keys("cmd-v")
            try await waitFor("attachment chip") { exists("attachment-chip") }
            await shot("22-pasted-image")
            controller.prefStore.setDraft("new", nil)
            return "ok"
        }

        await step("cmd+= zooms the whole window, cmd+0 resets") {
            await keys("cmd-n")
            await keys("cmd-=")
            await keys("cmd-=")
            guard controller.prefs.zoom == 1.25 else { throw Failure(description: "zoom \(controller.prefs.zoom)") }
            try await waitFor("zoom hud") { app.zoomHud?.pct == 125 ? true : nil }
            await sleep(300)
            _ = System.run(["/usr/sbin/screencapture", "-x", "-o", "-l", "\(window.windowNumber)", out.appendingPathComponent("23-zoom-125.png").path])
            // Hit-testing must follow the zoom: open Automations by clicking it.
            try await click("nav-automations")
            try await waitFor("automations page") { app.page == .automations ? true : nil }
            await keys("alt-cmd-1")
            // The composer (an AppKit text view) must take clicks and typing while zoomed.
            await keys("cmd-n")
            window.makeFirstResponder(nil)
            try await click("composer")
            await type("zoomed")
            guard app.composerView?.string == "zoomed" else { throw Failure(description: "composer text \(app.composerView?.string ?? "nil")") }
            app.composerView?.string = ""
            controller.prefStore.setDraft("new", nil)
            await keys("cmd--")
            await keys("cmd--")
            await keys("cmd--")
            guard controller.prefs.zoom == 0.9 else { throw Failure(description: "zoom down \(controller.prefs.zoom)") }
            await keys("cmd-0")
            guard controller.prefs.zoom == 1 else { throw Failure(description: "zoom reset \(controller.prefs.zoom)") }
            await keys("alt-cmd-1")
            return "ok"
        }

        finish()
    }

    func finish() {
        let data = (try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted])) ?? Data()
        try? data.write(to: out.appendingPathComponent("report.json"))
        let passed = results.filter { $0["ok"] == "true" }.count
        log("done: \(passed)/\(results.count) passed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
}
